import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/server/engine.js';
import { createInitialSnapshot, type Config, type CallOutcome, type Command } from '../src/shared/domain.js';
import { validateSavedSnapshot } from '../src/server/security.js';

function harness() {
  let now = 1_000_000;
  const engine = new Engine({ now: () => now });
  const config: Config = {
    room: 'Study', address: 'Example room location', consent: true,
    contacts: [{ id: 'a', name: 'Alex', optedIn: true }, { id: 'x', name: 'Skipped', optedIn: false }, { id: 'b', name: 'Blair', optedIn: true }],
    checkInSeconds: 10, callSeconds: 8, detectionMode: 'full_body',
  };
  engine.command({ type: 'configure', config });
  const trigger = () => engine.command({ type: 'trigger', source: 'example' });
  const help = () => engine.command({ type: 'respond', incidentId: engine.snapshot.incident!.id, action: 'help', actor: 'desktop' });
  const outcome = (value: CallOutcome, attemptId = engine.snapshot.incident!.attempts.at(-1)!.id) => engine.command({ type: 'call_outcome', outcome: value, attemptId });
  const advance = (ms: number) => { now += ms; return engine.tick(); };
  return { engine, config, trigger, help, outcome, advance };
}

test('invalid persisted text is rejected before changing engine state', () => {
  const { engine, config } = harness();
  const camera = { type: 'camera', camera: 'connected', poseReady: true, personInView: true } as const;
  const before = structuredClone(engine.snapshot);
  const invalid: Command[] = [];
  for (const text of ['', ' ', '\t\n', '\u00a0']) {
    invalid.push(
      { type: 'configure', config: { ...config, contacts: [{ id: text, name: 'Alex', optedIn: true }] } },
      { type: 'interrupt', reason: text },
      { ...camera, interruption: text },
      { ...camera, coverageMessage: text },
    );
  }
  invalid.push(
    { type: 'configure', config: { ...config, contacts: [{ id: 'a'.repeat(101), name: 'Alex', optedIn: true }] } },
    { type: 'interrupt', reason: 'a'.repeat(501) },
    { ...camera, interruption: 'a'.repeat(501) },
    { ...camera, coverageMessage: 'a'.repeat(501) },
  );
  for (const command of invalid) {
    assert.throws(() => engine.command(command), JSON.stringify(command));
    assert.deepEqual(engine.snapshot, before);
    assert.doesNotThrow(() => validateSavedSnapshot(engine.snapshot));
  }
});

test('consent can be withdrawn during an incident without changing its response plan', () => {
  const { engine, config, trigger, advance } = harness();
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  engine.command({ type: 'monitoring', enabled: true });
  trigger();
  const id = engine.snapshot.incident!.id;
  engine.command({ type: 'configure', config: { ...config, consent: false } });
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.equal(engine.snapshot.config.consent, false);
  assert.equal(engine.snapshot.incident!.id, id);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.ok(engine.snapshot.incident!.events.some(event => event.kind === 'monitoring_consent_withdrawn'));
  assert.throws(() => engine.command({ type: 'configure', config: { ...config, consent: false, address: 'Changed address' } }));
  advance(10_000);
  assert.equal(engine.snapshot.incident!.checkInStage, 'help');
  assert.equal(engine.snapshot.incident!.attempts.length, 0);
  advance(10_000);
  assert.equal(engine.snapshot.incident!.status, 'calling');
  assert.equal(engine.snapshot.incident!.attempts[0].name, 'Alex');
});

test('requires setup before monitoring and examples', () => {
  const engine = new Engine();
  assert.throws(() => engine.command({ type: 'monitoring', enabled: true }), /Complete setup/);
  assert.throws(() => engine.command({ type: 'trigger', source: 'example' }), /Complete setup/);
  assert.equal(engine.snapshot.incident, null);
});

test('consent, address, room, and opted-in contacts are individually required', () => {
  const { config } = harness();
  for (const patch of [{ consent: false }, { room: '' }, { address: '' }, { contacts: config.contacts.map(c => ({ ...c, optedIn: false })) }]) {
    const engine = new Engine();
    engine.command({ type: 'configure', config: { ...config, ...patch } });
    assert.throws(() => engine.command({ type: 'trigger', source: 'example' }), /Complete setup/);
  }
});

test('repeat detections create only one incident and no extra events', () => {
  const { engine, trigger } = harness();
  trigger();
  const id = engine.snapshot.incident!.id;
  const revision = engine.snapshot.revision;
  trigger();
  assert.equal(engine.snapshot.incident!.id, id);
  assert.equal(engine.snapshot.revision, revision);
  assert.equal(engine.snapshot.incident!.attempts.length, 0);
  assert.equal(engine.snapshot.incident!.source, 'example');
});

test('first check-in asks about help at ten seconds and the second deadline starts one simulated call', () => {
  const { engine, trigger, advance, outcome } = harness();
  trigger();
  assert.equal(engine.snapshot.incident!.checkInStage, 'okay');
  assert.equal(engine.snapshot.incident!.deadline, engine.snapshot.incident!.createdAt + 10_000);
  advance(9_999);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  advance(1);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.equal(engine.snapshot.incident!.checkInStage, 'help');
  assert.equal(engine.snapshot.incident!.attempts.length, 0);
  assert.equal(engine.snapshot.incident!.events.filter(event => event.kind === 'okay_check_in_unanswered').length, 1);
  assert.equal(engine.snapshot.incident!.events.filter(event => event.kind === 'help_check_in').length, 1);
  const revision = engine.snapshot.revision;
  engine.tick();
  assert.equal(engine.snapshot.revision, revision);
  advance(9_999);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  advance(1);
  assert.equal(engine.snapshot.incident!.status, 'calling');
  assert.equal(engine.snapshot.incident!.attempts.length, 1);
  assert.equal(engine.snapshot.incident!.attempts[0]!.name, 'Alex');
  engine.tick();
  assert.equal(engine.snapshot.incident!.attempts.length, 1);
  outcome('voicemail');
  assert.equal(engine.snapshot.incident!.attempts[1]!.name, 'Blair');
});

test('Get help now bypasses either question and duplicate help does not duplicate calls', () => {
  for (const stage of ['okay', 'help'] as const) {
    const { engine, trigger, help, advance } = harness();
    trigger();
    if (stage === 'help') advance(10_000);
    assert.equal(engine.snapshot.incident!.checkInStage, stage);
    help(); help();
    assert.equal(engine.snapshot.incident!.status, 'calling');
    assert.equal(engine.snapshot.incident!.attempts.length, 1);
  }
});

test('desktop and phone cancellation stop either check-in stage', () => {
  for (const actor of ['desktop', 'phone'] as const) for (const stage of ['okay', 'help'] as const) {
    const { engine, trigger, advance } = harness();
    trigger();
    if (stage === 'help') advance(10_000);
    assert.equal(engine.snapshot.incident!.checkInStage, stage);
    engine.command({ type: 'respond', incidentId: engine.snapshot.incident!.id, action: 'okay', actor });
    advance(100_000);
    assert.equal(engine.snapshot.incident!.status, 'cancelled');
    assert.equal(engine.snapshot.incident!.attempts.length, 0);
    assert.match(engine.snapshot.incident!.events.at(-1)!.message, new RegExp(actor));
  }
});

test('a delayed first tick gives the help question its full configured response window', () => {
  const { engine, config, trigger, advance } = harness();
  trigger();
  const startedAt = engine.snapshot.incident!.createdAt;
  advance(120_000);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.equal(engine.snapshot.incident!.checkInStage, 'help');
  assert.equal(engine.snapshot.incident!.deadline, startedAt + 120_000 + config.checkInSeconds * 1_000);
  assert.equal(engine.snapshot.incident!.attempts.length, 0);
  advance(config.checkInSeconds * 1_000 - 1);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  advance(1);
  assert.equal(engine.snapshot.incident!.status, 'calling');
  assert.equal(engine.snapshot.incident!.attempts.length, 1);
});

test('legacy check-ins without a stage retain their existing single deadline', () => {
  const { engine, trigger, advance } = harness();
  trigger();
  delete engine.snapshot.incident!.checkInStage;
  advance(10_000);
  assert.equal(engine.snapshot.incident!.status, 'calling');
  assert.equal(engine.snapshot.incident!.attempts.length, 1);
  assert.equal(engine.snapshot.incident!.events.some(event => event.kind === 'help_check_in'), false);
});

test('cancelling an in-progress call retains placement and ignores late acknowledgment', () => {
  const { engine, trigger, help, outcome, advance } = harness();
  trigger(); help();
  const attemptId = engine.snapshot.incident!.attempts[0]!.id;
  engine.command({ type: 'respond', incidentId: engine.snapshot.incident!.id, action: 'okay', actor: 'phone' });
  const revision = engine.snapshot.revision;
  outcome('acknowledged', attemptId); advance(100_000);
  assert.equal(engine.snapshot.incident!.status, 'cancelled');
  assert.equal(engine.snapshot.incident!.attempts.length, 1);
  assert.equal(engine.snapshot.incident!.attempts[0]!.status, 'cancelled');
  assert.equal(engine.snapshot.revision, revision);
  assert.match(engine.snapshot.incident!.events.at(-1)!.message, /already been attempted/);
});

test('connected is not acknowledged and does not resolve an incident', () => {
  const { engine, trigger, help, outcome } = harness();
  trigger(); help(); outcome('connected');
  assert.equal(engine.snapshot.incident!.status, 'calling');
  assert.equal(engine.snapshot.incident!.attempts[0]!.status, 'connected');
  assert.throws(() => engine.command({ type: 'resolve' }), /Resolve an acknowledged/);
  outcome('acknowledged');
  assert.equal(engine.snapshot.incident!.status, 'acknowledged');
  assert.equal(engine.snapshot.incident!.deadline, null);
  engine.command({ type: 'resolve' });
  assert.equal(engine.snapshot.incident!.status, 'resolved');
});

test('explicit acknowledgment stops all timers and repeated triggers', () => {
  const { engine, trigger, help, outcome, advance } = harness();
  trigger(); help(); outcome('acknowledged');
  const revision = engine.snapshot.revision;
  const id = engine.snapshot.incident!.id;
  advance(100_000); trigger(); outcome('no_answer');
  assert.equal(engine.snapshot.incident!.status, 'acknowledged');
  assert.equal(engine.snapshot.incident!.id, id);
  assert.equal(engine.snapshot.incident!.attempts.length, 1);
  assert.equal(engine.snapshot.revision, revision);
});

for (const failure of ['no_answer', 'declined', 'wrong_digit', 'voicemail', 'network_error'] as const) {
  test(`${failure} advances once, duplicate callback cannot skip a contact`, () => {
    const { engine, trigger, help, outcome } = harness();
    trigger(); help();
    const firstId = engine.snapshot.incident!.attempts[0]!.id;
    outcome(failure, firstId);
    const revision = engine.snapshot.revision;
    outcome(failure, firstId);
    assert.equal(engine.snapshot.incident!.attempts.length, 2);
    assert.equal(engine.snapshot.incident!.attempts[1]!.contactId, 'b');
    assert.equal(engine.snapshot.incident!.attempts[0]!.status, failure);
    assert.equal(engine.snapshot.revision, revision);
    assert.ok(engine.snapshot.incident!.events.some(e => e.kind === failure));
  });
}

test('call deadline after answering without acknowledgment fails the attempt', () => {
  const { engine, trigger, help, outcome, advance } = harness();
  trigger(); help(); outcome('connected'); advance(8_000);
  assert.equal(engine.snapshot.incident!.attempts[0]!.status, 'no_answer');
  assert.equal(engine.snapshot.incident!.attempts.length, 2);
});

test('exhausted contacts enter simulated emergency escalation without claiming dispatch', () => {
  const { engine, trigger, help, outcome, advance } = harness();
  trigger(); help(); outcome('wrong_digit'); outcome('voicemail');
  assert.equal(engine.snapshot.incident!.status, 'escalation_simulated');
  assert.equal(engine.snapshot.incident!.deadline, null);
  assert.match(engine.snapshot.incident!.events.at(-1)!.message, /SIMULATED/);
  assert.match(engine.snapshot.incident!.events.at(-1)!.message, /no emergency call was placed/);
  advance(100_000); trigger();
  assert.equal(engine.snapshot.incident!.attempts.length, 2);
  engine.command({ type: 'resolve' });
  assert.equal(engine.snapshot.incident!.status, 'resolved');
});

test('stale attempt IDs do nothing', () => {
  const { engine, trigger, help, outcome } = harness();
  trigger(); help();
  const revision = engine.snapshot.revision;
  outcome('acknowledged', 'not-the-current-attempt');
  assert.equal(engine.snapshot.incident!.status, 'calling');
  assert.equal(engine.snapshot.revision, revision);
});

test('a delayed phone response to a previous incident cannot cancel the current incident', () => {
  const { engine, trigger } = harness();
  trigger();
  const previousId = engine.snapshot.incident!.id;
  engine.command({ type: 'respond', incidentId: previousId, action: 'okay', actor: 'phone' });
  trigger();
  const revision = engine.snapshot.revision;
  const currentId = engine.snapshot.incident!.id;
  engine.command({ type: 'respond', incidentId: previousId, action: 'okay', actor: 'phone' });
  engine.command({ type: 'respond', incidentId: previousId, action: 'help', actor: 'phone' });
  assert.equal(engine.snapshot.incident!.id, currentId);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.equal(engine.snapshot.revision, revision);
});

test('camera trigger requires enabled healthy camera and a recent heartbeat', () => {
  const { engine, advance } = harness();
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' }), /interrupted/);
  engine.command({ type: 'monitoring', enabled: true });
  assert.match(engine.snapshot.monitoring.interruption!, /Camera/);
  engine.command({ type: 'camera', camera: 'connected', poseReady: false, personInView: false });
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' }), /interrupted/);
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  assert.equal(engine.snapshot.monitoring.enabled, false);
  engine.command({ type: 'monitoring', enabled: true });
  assert.equal(engine.snapshot.monitoring.interruption, null);
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: false });
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' }), /interrupted/);
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  advance(5_001);
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.match(engine.snapshot.monitoring.interruption!, /heartbeat lost/);
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' }), /interrupted/);
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  engine.command({ type: 'monitoring', enabled: true });
  engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' });
  assert.equal(engine.snapshot.incident!.source, 'camera');
});

test('camera loss and interruption are visible and do not dismiss a pending incident', () => {
  const { engine, trigger, advance } = harness();
  engine.command({ type: 'monitoring', enabled: true });
  trigger();
  engine.command({ type: 'camera', camera: 'disconnected', poseReady: false, personInView: false });
  assert.match(engine.snapshot.monitoring.interruption!, /disconnected/);
  engine.command({ type: 'interrupt', reason: 'Computer sleeping.' });
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.match(engine.snapshot.incident!.events.at(-1)!.message, /Existing incident response remains active/);
  advance(10_000);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.equal(engine.snapshot.incident!.checkInStage, 'help');
  advance(10_000);
  assert.equal(engine.snapshot.incident!.status, 'calling');
});

test('active incident prevents configuration changes and destructive reset', () => {
  const { engine, config, trigger } = harness();
  trigger();
  assert.throws(() => engine.command({ type: 'configure', config: { ...config, room: 'Other room' } }), /active incident/);
  assert.throws(() => engine.command({ type: 'reset' }), /active incident/);
  assert.equal(engine.snapshot.config.room, 'Study');
});

test('new incidents archive cancelled or resolved incident history', () => {
  const { engine, trigger } = harness();
  trigger();
  const firstId = engine.snapshot.incident!.id;
  engine.command({ type: 'respond', incidentId: engine.snapshot.incident!.id, action: 'okay', actor: 'desktop' });
  trigger();
  assert.notEqual(engine.snapshot.incident!.id, firstId);
  assert.equal(engine.snapshot.history.length, 1);
  assert.equal(engine.snapshot.history[0]!.status, 'cancelled');
  engine.command({ type: 'respond', incidentId: engine.snapshot.incident!.id, action: 'okay', actor: 'desktop' });
  engine.command({ type: 'reset' });
  assert.equal(engine.snapshot.incident, null);
  assert.equal(engine.snapshot.history.length, 2);
});

test('restoration interrupts pending work without replaying calls', () => {
  const { engine, trigger, help } = harness();
  trigger(); help();
  const restored = new Engine({ now: () => 9_000_000, snapshot: engine.snapshot });
  restored.tick();
  assert.equal(restored.snapshot.incident!.status, 'escalation_simulated');
  assert.equal(restored.snapshot.incident!.attempts.length, 1);
  assert.equal(restored.snapshot.incident!.attempts[0]!.status, 'network_error');
  assert.equal(restored.snapshot.incident!.deadline, null);
  assert.equal(restored.snapshot.monitoring.enabled, false);
  assert.equal(restored.snapshot.monitoring.camera, 'off');
  assert.equal(restored.snapshot.phoneConnected, false);
  assert.ok(restored.snapshot.incident!.events.some(e => e.kind === 'restart_interruption'));
  assert.equal(engine.snapshot.incident!.status, 'calling');
});

test('invalid timer and contact plans are rejected', () => {
  const { engine, config } = harness();
  for (const patch of [{ checkInSeconds: 0 }, { callSeconds: 2.5 }, { callSeconds: 121 }, { contacts: [config.contacts[0]!, config.contacts[0]!] }]) {
    assert.throws(() => engine.command({ type: 'configure', config: { ...config, ...patch } }));
  }
});

test('phone presence is a separate observed connection flag', () => {
  const { engine } = harness();
  engine.command({ type: 'phone_presence', connected: true });
  assert.equal(engine.snapshot.phoneConnected, true);
  engine.command({ type: 'phone_presence', connected: false });
  assert.equal(engine.snapshot.phoneConnected, false);
});

test('initial snapshot has no invented incident or clinical data', () => {
  const initial = createInitialSnapshot();
  assert.equal(initial.config.consent, false);
  assert.equal(initial.config.address, '');
  assert.equal(initial.incident, null);
  assert.equal(initial.monitoring.enabled, false);
});

test('reported account preserves source, location, incident status, and response timers', () => {
  const { engine, trigger } = harness();
  trigger();
  const incident = engine.snapshot.incident!;
  const deadline = incident.deadline;
  const location = structuredClone(incident.location);
  engine.command({ type: 'incident_report', incidentId: incident.id, report: { reportedBy: 'witness', context: '  Person said they slipped.  ', symptomsBefore: '', injury: 'Reported sore elbow.', recovery: '' } });
  assert.equal(incident.status, 'check_in');
  assert.equal(incident.source, 'example');
  assert.equal(incident.deadline, deadline);
  assert.deepEqual(incident.location, location);
  assert.equal(incident.report!.context, 'Person said they slipped.');
  assert.equal(incident.report!.recordedAt, 1_000_000);
  assert.equal(incident.events.at(-1)!.kind, 'account_recorded');
  assert.match(incident.events.at(-1)!.message, /reported, not verified/);
  assert.ok(!incident.events.at(-1)!.message.includes('sore elbow'));
});

test('archived accounts can be added and updated without changing resolution', () => {
  const { engine, trigger, advance } = harness();
  trigger();
  const id = engine.snapshot.incident!.id;
  engine.command({ type: 'respond', incidentId: id, action: 'okay', actor: 'desktop' });
  engine.command({ type: 'reset' });
  const report = { reportedBy: 'person' as const, context: 'Reported tripping.', symptomsBefore: '', injury: '', recovery: '' };
  engine.command({ type: 'incident_report', incidentId: id, report });
  advance(1_000);
  engine.command({ type: 'incident_report', incidentId: id, report: { ...report, recovery: 'Reported walking afterward.' } });
  const archived = engine.snapshot.history[0]!;
  assert.equal(archived.status, 'cancelled');
  assert.equal(archived.report!.recordedAt, 1_001_000);
  assert.equal(archived.report!.recovery, 'Reported walking afterward.');
  assert.match(archived.events.at(-1)!.message, /updated/);
  assert.equal(engine.snapshot.incident, null);
});

test('reported accounts reject unknown incident IDs, blank narratives, and oversized fields', () => {
  const { engine, trigger } = harness();
  trigger();
  const id = engine.snapshot.incident!.id;
  const blank = { reportedBy: 'caregiver' as const, context: '  ', symptomsBefore: '', injury: '', recovery: '' };
  assert.throws(() => engine.command({ type: 'incident_report', incidentId: 'missing', report: { ...blank, context: 'One statement' } }), /not available/);
  assert.throws(() => engine.command({ type: 'incident_report', incidentId: id, report: blank }), /at least one/);
  assert.throws(() => engine.command({ type: 'incident_report', incidentId: id, report: { ...blank, context: 'a'.repeat(1001) } }), /1,000/);
  assert.equal(engine.snapshot.incident!.report, undefined);
});

test('camera stop or disconnection requires explicit monitoring re-enable after frames return', () => {
  for (const camera of ['off', 'disconnected'] as const) {
    const { engine } = harness();
    engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
    engine.command({ type: 'monitoring', enabled: true });
    engine.command({ type: 'camera', camera, poseReady: false, personInView: false });
    assert.equal(engine.snapshot.monitoring.enabled, false);
    assert.match(engine.snapshot.monitoring.interruption!, /paused/);
    engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
    assert.equal(engine.snapshot.monitoring.enabled, false);
    assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' }), /interrupted/);
    engine.command({ type: 'monitoring', enabled: true });
    engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' });
    assert.equal(engine.snapshot.incident!.status, 'check_in');
  }
});

test('pose processing not ready pauses monitoring and a later warmup completion cannot auto-enable it', () => {
  const { engine } = harness();
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  engine.command({ type: 'monitoring', enabled: true });
  engine.command({ type: 'camera', camera: 'connected', poseReady: false, personInView: true });
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.equal(engine.snapshot.monitoring.personInView, false);
  assert.match(engine.snapshot.monitoring.interruption!, /Pose processing is not ready/);
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  engine.command({ type: 'heartbeat' });
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.equal(engine.snapshot.incident, null);
});

test('camera loss logs one monitoring interruption while retaining the active response timer', () => {
  const { engine, trigger, advance } = harness();
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  engine.command({ type: 'monitoring', enabled: true });
  trigger();
  engine.command({ type: 'camera', camera: 'disconnected', poseReady: false, personInView: false });
  engine.command({ type: 'camera', camera: 'disconnected', poseReady: false, personInView: false });
  const incident = engine.snapshot.incident!;
  assert.equal(incident.status, 'check_in');
  assert.equal(incident.events.filter(event => event.kind === 'monitoring_interrupted').length, 1);
  assert.match(incident.events.at(-1)!.message, /Existing incident response remains active/);
  advance(10_000);
  assert.equal(incident.status, 'check_in');
  assert.equal(incident.checkInStage, 'help');
  advance(10_000);
  assert.equal(incident.status, 'calling');
  assert.equal(engine.snapshot.monitoring.enabled, false);
});
