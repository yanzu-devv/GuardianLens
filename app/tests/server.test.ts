import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { connect } from 'node:net';
import { createGuardianServer } from '../src/server/index.js';
import { validateSavedSnapshot } from '../src/server/security.js';
import { createInitialSnapshot } from '../src/shared/domain.js';
import type { Command, Config, Snapshot } from '../src/shared/domain.js';

type App = Awaited<ReturnType<typeof createGuardianServer>>;
const config: Config = {
  room: 'Test room', address: 'Private configured test address', consent: true,
  contacts: [{ id: 'a', name: 'Private caregiver Alex', optedIn: true }, { id: 'b', name: 'Private caregiver Blair', optedIn: true }],
  checkInSeconds: 30, callSeconds: 30,
};

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'guardianlens-server-test-'));
  const app = await createGuardianServer({ port: 0, dataDir, quiet: true });
  const additionalServers: App[] = [];
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); for (const other of additionalServers) await other.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, close, additionalServers };
}

async function request(app: App, route: string, options: { token?: string | null; method?: string; body?: unknown; origin?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? app.ownerToken}`;
  if (options.body !== undefined || options.raw !== undefined) headers['Content-Type'] = 'application/json';
  if (options.origin) headers.Origin = options.origin;
  const response = await fetch(`${app.origin}${route}`, { method: options.method ?? 'GET', headers, body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)) });
  const data = await response.json();
  return { status: response.status, data };
}

async function command(app: App, body: Command, token?: string) {
  return request(app, '/api/command', { method: 'POST', body, token });
}

async function pair(app: App): Promise<string> {
  const response = await request(app, '/api/pair', { method: 'POST' });
  assert.equal(response.status, 200);
  const url = new URL(response.data.url);
  assert.equal(url.searchParams.get('view'), 'phone');
  assert.ok(response.data.expiresAt > Date.now());
  return new URLSearchParams(url.hash.slice(1)).get('token')!;
}

async function openSocket(app: App, token: string) {
  const ws = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws', ['guardianlens', `auth.${token}`], { origin: app.origin });
  const messages: { snapshot: Snapshot }[] = [];
  ws.on('message', raw => { messages.push(JSON.parse(raw.toString())); });
  ws.on('error', () => {});
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const wait = async (predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> => {
    const existing = messages.find(message => predicate(message.snapshot));
    if (existing) return existing.snapshot;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('Expected WebSocket snapshot did not arrive.')); }, 3_000);
      const listener = (raw: Buffer) => {
        const data = JSON.parse(raw.toString());
        if (data.snapshot && predicate(data.snapshot)) { clearTimeout(timer); ws.off('message', listener); resolve(data.snapshot); }
      };
      ws.on('message', listener);
    });
  };
  return { ws, wait, messages };
}

test('state and command routes require private bearer authentication', async t => {
  const { app } = await fixture(t);
  assert.equal((await request(app, '/api/state', { token: null })).status, 401);
  assert.equal((await request(app, '/api/state', { token: 'wrong' })).status, 401);
  assert.equal((await request(app, '/api/command', { method: 'POST', token: null, body: { type: 'reset' } })).status, 401);
  const owner = await request(app, '/api/state');
  assert.equal(owner.status, 200);
  assert.equal(owner.data.role, 'owner');
});

test('foreign origins are denied even with a valid owner token', async t => {
  const { app } = await fixture(t);
  const response = await request(app, '/api/state', { origin: 'https://untrusted.example' });
  assert.equal(response.status, 403);
  assert.match(response.data.error, /origin/i);
  assert.equal((await request(app, '/api/state', { origin: app.origin })).status, 200);
});

test('malformed WebSocket request targets cannot crash the local server', async t => {
  const { app } = await fixture(t);
  const url = new URL(app.origin);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(url.port), '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Malformed socket was not closed.')); }, 2000);
    socket.on('connect', () => socket.write(`GET //% HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal((await request(app, '/api/health', { token: null })).status, 200);
});

test('malformed, oversized, unknown, and backend-only commands are denied', async t => {
  const { app } = await fixture(t);
  for (const body of [null, [], {}, { type: 'monitoring', enabled: 'yes' }, { type: 'reset', extra: true }, { type: 'phone_presence', connected: true }, { type: 'respond', action: 'okay', actor: 'phone' }]) {
    assert.equal((await request(app, '/api/command', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request(app, '/api/command', { method: 'POST', raw: '{broken' })).status, 400);
  assert.equal((await request(app, '/api/command', { method: 'POST', body: { data: 'a'.repeat(33_000) } })).status, 400);
  assert.equal(app.engine.snapshot.incident, null);
});

test('invalid persisted text is denied and valid padded text survives a server restart', async t => {
  const { app, dataDir, close, additionalServers } = await fixture(t);
  const before = structuredClone(app.engine.snapshot);
  const camera = { type: 'camera', camera: 'connected', poseReady: true, personInView: true } as const;
  for (const text of ['', ' ', '\t\n', '\u00a0']) {
    const invalid: Command[] = [
      { type: 'configure', config: { ...config, contacts: [{ id: text, name: 'Alex', optedIn: true }] } },
      { type: 'interrupt', reason: text },
      { ...camera, interruption: text },
      { ...camera, coverageMessage: text },
    ];
    for (const body of invalid) {
      assert.equal((await command(app, body)).status, 400, JSON.stringify(body));
      assert.deepEqual(app.engine.snapshot, before);
    }
  }
  const validConfig = { ...config, contacts: [{ id: ' contact-1 ', name: ' Alex ', optedIn: true, phone: '+15555550123', relationship: ' Friend ' }] };
  for (const body of [
    { type: 'configure', config: validConfig },
    { ...camera, interruption: null, coverageMessage: null },
    { ...camera, interruption: ' Camera warming up. ', coverageMessage: ' Shoulders visible. ' },
    { type: 'interrupt', reason: ' Manual pause. ' },
  ] satisfies Command[]) {
    assert.equal((await command(app, body)).status, 200);
    assert.doesNotThrow(() => validateSavedSnapshot(app.engine.snapshot));
  }
  await close();
  const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.doesNotThrow(() => validateSavedSnapshot(saved));
  const restored = await createGuardianServer({ port: 0, dataDir, quiet: true });
  additionalServers.push(restored);
  assert.deepEqual(restored.engine.snapshot.config, validConfig);
});

test('paired phone can only respond, and cannot configure, trigger, pair, or unpair', async t => {
  const { app } = await fixture(t);
  const token = await pair(app);
  const state = await request(app, '/api/state', { token });
  assert.equal(state.data.role, 'phone');
  for (const body of [{ type: 'configure', config }, { type: 'trigger', source: 'example' }, { type: 'reset' }, { type: 'call_outcome', attemptId: 'a', outcome: 'acknowledged' }]) {
    assert.equal((await request(app, '/api/command', { method: 'POST', token, body })).status, 400);
  }
  assert.equal((await request(app, '/api/pair', { method: 'POST', token })).status, 403);
  assert.equal((await request(app, '/api/pair', { method: 'DELETE', token })).status, 403);
});

test('phone projection withholds contacts, history, attempts, caregiver names, and event logs', async t => {
  const { app } = await fixture(t);
  await command(app, { type: 'configure', config });
  await command(app, { type: 'trigger', source: 'example' });
  const priorId = app.engine.snapshot.incident!.id;
  await command(app, { type: 'respond', incidentId: priorId, action: 'okay', actor: 'desktop' });
  await command(app, { type: 'trigger', source: 'example' });
  await command(app, { type: 'respond', incidentId: app.engine.snapshot.incident!.id, action: 'help', actor: 'desktop' });
  const token = await pair(app);
  const response = await request(app, '/api/state', { token });
  const snapshot: Snapshot = response.data.snapshot;
  assert.equal(snapshot.config.contacts.length, 0);
  assert.equal(snapshot.history.length, 0);
  assert.equal(snapshot.incident!.contactPlan.length, 0);
  assert.equal(snapshot.incident!.attempts.length, 0);
  assert.equal(snapshot.incident!.events.length, 0);
  assert.ok(!JSON.stringify(response.data).includes('Private caregiver'));
  assert.equal(snapshot.config.address, config.address);
  assert.equal(app.engine.snapshot.history.length, 1);
  assert.equal(app.engine.snapshot.incident!.attempts.length, 1);
});

test('new pairing and explicit unpair invalidate earlier phone HTTP tokens', async t => {
  const { app } = await fixture(t);
  const first = await pair(app);
  const second = await pair(app);
  assert.notEqual(first, second);
  assert.equal((await request(app, '/api/state', { token: first })).status, 401);
  assert.equal((await request(app, '/api/state', { token: second })).status, 200);
  assert.equal((await request(app, '/api/pair', { method: 'DELETE' })).status, 200);
  assert.equal((await request(app, '/api/state', { token: second })).status, 401);
});

test('delayed phone responses cannot cancel a newer incident', async t => {
  const { app } = await fixture(t);
  await command(app, { type: 'configure', config });
  await command(app, { type: 'trigger', source: 'example' });
  const previousId = app.engine.snapshot.incident!.id;
  await command(app, { type: 'respond', incidentId: previousId, action: 'okay', actor: 'desktop' });
  await command(app, { type: 'trigger', source: 'example' });
  const currentId = app.engine.snapshot.incident!.id;
  const token = await pair(app);
  const stale = await command(app, { type: 'respond', incidentId: previousId, action: 'okay', actor: 'desktop' }, token);
  assert.equal(stale.status, 200);
  assert.equal(stale.data.snapshot.incident.id, currentId);
  assert.equal(stale.data.snapshot.incident.status, 'check_in');
  const valid = await command(app, { type: 'respond', incidentId: currentId, action: 'okay', actor: 'desktop' }, token);
  assert.equal(valid.data.snapshot.incident.status, 'cancelled');
  assert.match(app.engine.snapshot.incident!.events.at(-1)!.message, /on phone/);
});

test('WebSocket upgrades require a private token and recognized origin', async t => {
  const { app } = await fixture(t);
  async function denied(token: string, origin: string) {
    const ws = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws', ['guardianlens', `auth.${token}`], { origin });
    ws.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => { ws.terminate(); reject(new Error('Unauthorized WebSocket opened.')); });
      ws.once('error', () => resolve());
    });
  }
  await denied('wrong-token', app.origin);
  await denied(app.ownerToken, 'https://untrusted.example');
  const valid = await openSocket(app, app.ownerToken);
  const snapshot = await valid.wait(s => s.revision >= 0);
  assert.equal(snapshot.incident, null);
});

test('WebSockets synchronize phone presence, projected state, and cancellation to the owner', async t => {
  const { app } = await fixture(t);
  await command(app, { type: 'configure', config });
  const desktop = await openSocket(app, app.ownerToken);
  const token = await pair(app);
  const phone = await openSocket(app, token);
  await desktop.wait(s => s.phoneConnected);
  await phone.wait(s => s.phoneConnected);
  await command(app, { type: 'trigger', source: 'example' });
  const phoneState = await phone.wait(s => s.incident?.status === 'check_in');
  assert.equal(phoneState.config.contacts.length, 0);
  await command(app, { type: 'respond', incidentId: phoneState.incident!.id, action: 'okay', actor: 'phone' }, token);
  await desktop.wait(s => s.incident?.status === 'cancelled');
  await phone.wait(s => s.incident?.status === 'cancelled');
  phone.ws.close();
  await desktop.wait(s => !s.phoneConnected && s.incident?.status === 'cancelled');
});

test('replacing a pairing closes the former phone WebSocket', async t => {
  const { app } = await fixture(t);
  const token = await pair(app);
  const phone = await openSocket(app, token);
  const closed = new Promise<number>(resolve => phone.ws.once('close', code => resolve(code)));
  await pair(app);
  assert.equal(await closed, 4001);
});

test('persistence restores the audit trail and stops in-flight timed actions', async t => {
  const { app, dataDir, close, additionalServers } = await fixture(t);
  await command(app, { type: 'configure', config });
  await command(app, { type: 'trigger', source: 'example' });
  const incidentId = app.engine.snapshot.incident!.id;
  await command(app, { type: 'respond', incidentId, action: 'help', actor: 'desktop' });
  await close();
  const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.incident.id, incidentId);
  assert.equal(saved.incident.attempts.length, 1);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dataDir, 'state.json'))).mode & 0o777, 0o600);
  const restored = await createGuardianServer({ port: 0, dataDir, quiet: true });
  additionalServers.push(restored);
  assert.equal(restored.engine.snapshot.incident!.id, incidentId);
  assert.equal(restored.engine.snapshot.incident!.status, 'escalation_simulated');
  assert.equal(restored.engine.snapshot.incident!.attempts.length, 1);
  assert.equal(restored.engine.snapshot.incident!.deadline, null);
  assert.equal(restored.engine.snapshot.monitoring.enabled, false);
  assert.notEqual(restored.ownerToken, app.ownerToken);
  assert.ok(restored.engine.snapshot.incident!.events.some(e => e.kind === 'restart_interruption'));
});

test('malformed saved JSON refuses startup rather than silently discarding incident history', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'guardianlens-corrupt-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'state.json'), '{broken');
  await assert.rejects(createGuardianServer({ port: 0, dataDir, quiet: true }), /Saved state cannot be read/);
});

test('saved-state validation rejects incomplete and corrupt nested snapshots', () => {
  const valid = createInitialSnapshot();
  assert.doesNotThrow(() => validateSavedSnapshot(valid));
  const mutations = [
    () => ({}),
    () => ({ ...valid, revision: -1 }),
    () => ({ ...valid, revision: Number.NaN }),
    () => ({ ...valid, history: Array.from({ length: 21 }, () => ({})) }),
    () => ({ ...valid, monitoring: { ...valid.monitoring, camera: 'pretend-active' } }),
    () => ({ ...valid, monitoring: { ...valid.monitoring, lastHeartbeat: Infinity } }),
    () => ({ ...valid, config: { ...valid.config, checkInSeconds: 1 } }),
    () => ({ ...valid, config: { ...valid.config, contacts: [{ id: 'a', name: 'Alex', optedIn: 'yes' }] } }),
    () => ({ ...valid, incident: { id: 'incomplete' } }),
  ];
  for (const mutate of mutations) assert.throws(() => validateSavedSnapshot(mutate()), /Saved state has an invalid structure/);
  const configured = structuredClone(valid);
  configured.config = config;
  assert.doesNotThrow(() => validateSavedSnapshot(configured));
});

test('valid JSON with an invalid saved-state shape refuses startup', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'guardianlens-invalid-shape-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'state.json'), '{}');
  await assert.rejects(createGuardianServer({ port: 0, dataDir, quiet: true }), /Saved state/);
});

test('only the owner can publish device location and phones receive incident location without a live feed', async t => {
  const { app } = await fixture(t);
  await command(app, { type: 'configure', config: { ...config, address: '', locationMode: 'device' } });
  const token = await pair(app);
  const fix = { latitude: 40.1, longitude: -74.1, accuracy: 25, capturedAt: Date.now() };
  for (const body of [{ type: 'location_tracking', enabled: true }, { type: 'location_fix', fix }, { type: 'location_error', message: 'Permission denied.' }]) {
    assert.equal((await request(app, '/api/command', { method: 'POST', token, body })).status, 400);
  }
  assert.equal((await command(app, { type: 'location_fix', fix })).status, 400);
  assert.equal((await command(app, { type: 'location_tracking', enabled: true })).status, 200);
  assert.equal((await command(app, { type: 'location_fix', fix })).status, 200);
  assert.equal((await request(app, '/api/command', { method: 'POST', body: { type: 'location_fix', fix: { ...fix, latitude: 91 } } })).status, 400);
  await command(app, { type: 'trigger', source: 'example' });
  const response = await request(app, '/api/state', { token });
  assert.deepEqual(response.data.snapshot.location, { tracking: false, fix: null, error: null });
  assert.equal(response.data.snapshot.incident.location.availability, 'current');
  assert.deepEqual(response.data.snapshot.incident.location.fix, fix);
  await command(app, { type: 'location_tracking', enabled: false });
  const after = await request(app, '/api/state', { token });
  assert.deepEqual(after.data.snapshot.incident.location.fix, fix);
  assert.equal(after.data.snapshot.incident.status, 'check_in');
});

test('device location failure is explicit and does not block an incident without a manual address', async t => {
  const { app } = await fixture(t);
  await command(app, { type: 'configure', config: { ...config, address: '', locationMode: 'device' } });
  await command(app, { type: 'location_tracking', enabled: true });
  await command(app, { type: 'location_error', message: 'Location permission denied.' });
  const response = await command(app, { type: 'trigger', source: 'example' });
  assert.equal(response.status, 200);
  assert.equal(response.data.snapshot.incident.location.availability, 'unavailable');
  assert.match(response.data.snapshot.incident.location.note, /permission denied/);
});

test('reported accounts remain private to owner, preserve status, and cannot accept client timestamps', async t => {
  const { app } = await fixture(t);
  await command(app, { type: 'configure', config });
  await command(app, { type: 'trigger', source: 'example' });
  const incidentId = app.engine.snapshot.incident!.id;
  const report = { reportedBy: 'witness' as const, context: 'Private witness narrative.', symptomsBefore: 'Person reported feeling dizzy.', injury: '', recovery: '' };
  const token = await pair(app);
  assert.equal((await command(app, { type: 'incident_report', incidentId, report }, token)).status, 400);
  assert.equal((await request(app, '/api/command', { method: 'POST', body: { type: 'incident_report', incidentId, report: { ...report, recordedAt: 1 } } })).status, 400);
  const before = Date.now();
  const result = await command(app, { type: 'incident_report', incidentId, report });
  assert.equal(result.status, 200);
  assert.equal(result.data.snapshot.incident.status, 'check_in');
  assert.equal(result.data.snapshot.incident.source, 'example');
  assert.equal(result.data.snapshot.incident.report.context, report.context);
  assert.ok(result.data.snapshot.incident.report.recordedAt >= before);
  const phone = await request(app, '/api/state', { token });
  assert.equal(phone.data.snapshot.incident.report, undefined);
  assert.ok(!JSON.stringify(phone.data).includes('Private witness narrative'));
  assert.ok(!JSON.stringify(phone.data).includes('dizzy'));
  const log = app.engine.snapshot.incident!.events.at(-1)!;
  assert.equal(log.kind, 'account_recorded');
  assert.ok(!log.message.includes('dizzy'));
  const saved = structuredClone(app.engine.snapshot);
  assert.doesNotThrow(() => validateSavedSnapshot(saved));
  saved.incident!.report!.recordedAt = -1;
  assert.throws(() => validateSavedSnapshot(saved), /report.recordedAt/);
});

test('seated camera API requires calibrated ready coverage and matching pipeline evidence', async t => {
  const { app } = await fixture(t);
  await command(app, { type: 'configure', config: { ...config, detectionMode: 'seated' } });
  const camera: Extract<Command, { type: 'camera' }> = { type: 'camera', camera: 'connected', poseReady: true, personInView: true, detectionMode: 'seated', coverage: 'partial', calibratedAt: Date.now(), coverageMessage: 'Head and both shoulders must remain visible.' };
  assert.equal((await command(app, camera)).status, 200);
  await command(app, { type: 'monitoring', enabled: true });
  assert.equal((await command(app, { type: 'trigger', source: 'camera', evidence: 'seated_still_slump' })).status, 400);
  await command(app, { ...camera, coverage: 'ready', calibratedAt: null });
  assert.equal((await command(app, { type: 'trigger', source: 'camera', evidence: 'seated_still_slump' })).status, 400);
  await command(app, { ...camera, coverage: 'ready', calibratedAt: Date.now(), coverageMessage: 'Seated reference ready.' });
  assert.equal((await command(app, { type: 'trigger', source: 'camera', evidence: 'full_body_collapse' })).status, 400);
  const detected = await command(app, { type: 'trigger', source: 'camera', evidence: 'seated_still_slump' });
  assert.equal(detected.status, 200);
  assert.equal(detected.data.snapshot.incident.detectionMode, 'seated');
  assert.match(detected.data.snapshot.incident.observations.join(' '), /head.*shoulder midpoint/i);
  assert.ok(!detected.data.snapshot.incident.observations.join(' ').includes('floor'));
  const token = await pair(app);
  assert.equal((await command(app, camera, token)).status, 400);
});
