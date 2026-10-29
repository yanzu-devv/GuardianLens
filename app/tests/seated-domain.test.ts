import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/server/engine.js';
import { configuredDetectionMode, createInitialSnapshot, type Config, type Command } from '../src/shared/domain.js';
import { parseCommand, projectSnapshot, validateSavedSnapshot } from '../src/server/security.js';

function harness() {
  let now = 1_000_000;
  const engine = new Engine({ now: () => now });
  const config: Config = { room: 'Desk laptop', address: '', consent: true, contacts: [{ id: 'a', name: 'Alex', optedIn: true }], checkInSeconds: 15, callSeconds: 20, locationMode: 'device', detectionMode: 'seated' };
  engine.command({ type: 'configure', config });
  const camera = (patch: Partial<Extract<Command, {type:'camera'}>> = {}) => engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true, detectionMode: 'seated', coverage: 'ready', calibratedAt: now, coverageMessage: 'Seated reference ready.', ...patch });
  const enable = () => engine.command({ type: 'monitoring', enabled: true });
  const trigger = () => engine.command({ type: 'trigger', source: 'camera', evidence: 'seated_still_slump' });
  const advance = (ms: number) => { now += ms; };
  return { engine, config, camera, enable, trigger, advance, now: () => now };
}

test('new and legacy missing detection mode select seated monitoring', () => {
  assert.equal(createInitialSnapshot().config.detectionMode, 'seated');
  const legacyConfig = { ...createInitialSnapshot().config };
  delete legacyConfig.detectionMode;
  assert.equal(configuredDetectionMode(legacyConfig), 'seated');
  const legacy = createInitialSnapshot();
  delete legacy.config.detectionMode;
  delete legacy.monitoring.detectionMode;
  delete legacy.monitoring.coverage;
  delete legacy.monitoring.calibratedAt;
  delete legacy.monitoring.coverageMessage;
  assert.doesNotThrow(() => validateSavedSnapshot(legacy));
  const restored = new Engine({ snapshot: legacy });
  assert.equal(restored.snapshot.monitoring.detectionMode, 'seated');
  assert.equal(restored.snapshot.monitoring.coverage, 'uncalibrated');
  assert.equal(restored.snapshot.monitoring.calibratedAt, null);
});

test('visible partial upper-body pose is reported as partial and cannot trigger an incident', () => {
  const { engine, camera, enable, trigger } = harness();
  camera({ coverage: 'partial', coverageMessage: 'Head and both shoulders must remain visible.' });
  enable();
  assert.equal(engine.snapshot.monitoring.personInView, true);
  assert.equal(engine.snapshot.monitoring.coverage, 'partial');
  assert.match(engine.snapshot.monitoring.interruption!, /partial/);
  assert.throws(trigger, /interrupted|coverage/);
  engine.command({ type: 'heartbeat' });
  assert.match(engine.snapshot.monitoring.interruption!, /partial/);
  assert.equal(engine.snapshot.incident, null);
});

test('ready without seated calibration is normalized to uncalibrated and cannot trigger', () => {
  const { engine, camera, enable, trigger } = harness();
  camera({ calibratedAt: null, coverage: 'ready' });
  enable();
  assert.equal(engine.snapshot.monitoring.coverage, 'uncalibrated');
  assert.throws(trigger, /interrupted|coverage/);
  assert.equal(engine.snapshot.incident, null);
});

test('seated camera incidents preserve relative-head evidence without claiming floor position or diagnosis', () => {
  const { engine, camera, enable, trigger } = harness();
  camera(); enable(); trigger();
  const incident = engine.snapshot.incident!;
  assert.equal(incident.source, 'camera');
  assert.equal(incident.detectionMode, 'seated');
  assert.equal(incident.observations[0], 'Lowered, tilted, or slumped head posture observed relative to the shoulder midpoint and a calibrated seated reference.');
  assert.equal(incident.observations[1], 'Little head movement observed in that posture for 10 seconds before the check-in.');
  assert.equal(incident.observations[2], 'Cause unknown. Breathing not assessed.');
  assert.ok(!incident.observations.join(' ').match(/floor|unconscious|fainted|stroke detected|Rapid downward/i));
  assert.match(incident.events[0]!.message, /Possible seated slump/);
  assert.equal(incident.status, 'check_in');
  assert.equal(incident.checkInStage, 'okay');
  const phone = projectSnapshot(engine.snapshot, 'phone');
  assert.equal(phone.incident!.detectionMode, 'seated');
});

test('stale pipeline evidence and missing evidence cannot create camera incidents', () => {
  const { engine, camera, enable } = harness();
  camera(); enable();
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' }), /evidence does not match/);
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera' }), /evidence does not match/);
  for (const evidence of ['seated_slump', 'seated_sustained_slump'] as const) {
    assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence }), /evidence does not match/);
  }
  assert.equal(engine.snapshot.incident, null);
});

test('quiet seated evidence records the ten-second hold without claiming rapid onset', () => {
  const { engine, camera, enable } = harness();
  camera(); enable();
  const command = { type: 'trigger', source: 'camera', evidence: 'seated_still_slump' };
  assert.deepEqual(parseCommand(command, 'owner'), command);
  engine.command(command as Command);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.match(engine.snapshot.incident!.observations[0]!, /Lowered, tilted, or slumped.*shoulder midpoint.*calibrated seated reference/);
  assert.match(engine.snapshot.incident!.observations[1]!, /Little head movement.*10 seconds/);
  assert.doesNotMatch(engine.snapshot.incident!.observations.join(' '), /Rapid head lowering|floor|unconscious|fainted|stroke detected|limited movement/);
});

test('seated example head evidence remains explicitly simulated', () => {
  const { engine } = harness();
  engine.command({ type: 'trigger', source: 'example' });
  const incident = engine.snapshot.incident!;
  assert.equal(incident.source, 'example');
  assert.equal(incident.detectionMode, 'seated');
  assert.match(incident.observations[0]!, /^Example incident data: lowered, tilted, or slumped head posture relative to the shoulder midpoint/);
  assert.match(incident.observations[1]!, /^Example incident data: little head movement for 10 seconds/);
  assert.match(incident.events[0]!.message, /example data, not a camera detection/);
});

test('temporary absence keeps calibration and enabled intent while blocking detections until return', () => {
  const { engine, camera, enable, trigger } = harness();
  camera(); enable();
  const original = engine.snapshot.monitoring.calibratedAt;
  camera({ personInView: false, coverage: 'absent' });
  assert.equal(engine.snapshot.monitoring.enabled, true);
  assert.equal(engine.snapshot.monitoring.calibratedAt, original);
  assert.throws(trigger, /interrupted/);
  camera();
  assert.equal(engine.snapshot.monitoring.interruption, null);
  assert.equal(engine.snapshot.monitoring.calibratedAt, original);
  assert.doesNotThrow(trigger);
});

test('camera mode must match the saved mode even when its own coverage is ready', () => {
  const { engine, camera, enable, trigger } = harness();
  camera({ detectionMode: 'full_body', coverage: 'ready', calibratedAt: null });
  enable();
  assert.match(engine.snapshot.monitoring.interruption!, /mode does not match/);
  assert.throws(trigger, /interrupted|configured/);
  assert.equal(engine.snapshot.incident, null);
});

test('explicit full-body mode supports legacy camera health fields with matching full-body evidence', () => {
  const { engine, config } = harness();
  engine.command({ type: 'configure', config: { ...config, detectionMode: 'full_body' } });
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  engine.command({ type: 'monitoring', enabled: true });
  engine.command({ type: 'trigger', source: 'camera', evidence: 'full_body_collapse' });
  assert.equal(engine.snapshot.incident!.detectionMode, 'full_body');
  assert.match(engine.snapshot.incident!.observations.join(' '), /Low posture/);
});

test('detection mode edits pause monitoring and discard the old seated calibration', () => {
  const { engine, config, camera, enable, advance } = harness();
  camera(); enable(); advance(1_000);
  engine.command({ type: 'configure', config: { ...config, detectionMode: 'full_body' } });
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.equal(engine.snapshot.monitoring.coverage, 'uncalibrated');
  assert.equal(engine.snapshot.monitoring.calibratedAt, null);
  assert.match(engine.snapshot.monitoring.interruption!, /Detection mode changed/);
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'seated_still_slump' }), /interrupted/);
});

test('mode edits remain blocked during an active incident and later edits cannot rewrite history mode', () => {
  const { engine, config, camera, enable, trigger } = harness();
  camera(); enable(); trigger();
  const id = engine.snapshot.incident!.id;
  assert.throws(() => engine.command({ type: 'configure', config: { ...config, detectionMode: 'full_body' } }), /active incident/);
  engine.command({ type: 'respond', incidentId: id, action: 'okay', actor: 'desktop' });
  engine.command({ type: 'reset' });
  engine.command({ type: 'configure', config: { ...config, detectionMode: 'full_body' } });
  assert.equal(engine.snapshot.history[0]!.detectionMode, 'seated');
  assert.match(engine.snapshot.history[0]!.observations.join(' '), /head.*shoulder midpoint/);
});

test('restart and camera interruption invalidate calibration and reject an older queued reference', () => {
  const { engine, camera, enable, advance, now } = harness();
  camera(); enable();
  const calibratedAt = now();
  advance(1_000);
  engine.command({ type: 'interrupt', reason: 'Screen locked.' });
  assert.equal(engine.snapshot.monitoring.calibratedAt, null);
  camera({ calibratedAt }); enable();
  assert.equal(engine.snapshot.monitoring.coverage, 'uncalibrated');
  assert.throws(() => engine.command({ type: 'trigger', source: 'camera', evidence: 'seated_still_slump' }), /interrupted|coverage/);
  camera(); enable();
  assert.equal(engine.snapshot.monitoring.coverage, 'ready');
  const restored = new Engine({ now, snapshot: engine.snapshot });
  assert.equal(restored.snapshot.monitoring.calibratedAt, null);
  assert.equal(restored.snapshot.monitoring.coverage, 'uncalibrated');
  assert.equal(restored.snapshot.monitoring.enabled, false);
});

test('heartbeat loss clears calibration before monitoring can resume', () => {
  const { engine, camera, enable, advance } = harness();
  camera(); enable(); advance(5_001); engine.tick();
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.equal(engine.snapshot.monitoring.calibratedAt, null);
  assert.equal(engine.snapshot.monitoring.coverage, 'uncalibrated');
});

test('camera commands reject invalid enums, future calibration, long text, and unsupported clinical claims', () => {
  const base = { type: 'camera', camera: 'connected', poseReady: true, personInView: true, detectionMode: 'seated', coverage: 'ready', calibratedAt: Date.now(), coverageMessage: 'Seated reference ready.' };
  assert.doesNotThrow(() => parseCommand(base, 'owner'));
  for (const patch of [{ coverage: 'healthy' }, { detectionMode: 'stroke' }, { calibratedAt: -1 }, { calibratedAt: Date.now() + 100_000 }, { coverageMessage: 'a'.repeat(501) }, { breathing: 'normal' }, { diagnosis: 'no stroke' }]) {
    assert.throws(() => parseCommand({ ...base, ...patch }, 'owner'), /Invalid command fields/);
  }
  assert.throws(() => parseCommand(base, 'phone'), /only respond/);
});

test('saved-state validation accepts legacy omitted fields but rejects malformed new detector metadata', () => {
  const { engine, camera } = harness();
  camera();
  assert.doesNotThrow(() => validateSavedSnapshot(engine.snapshot));
  for (const patch of [{ detectionMode: 'stroke' }, { coverage: 'healthy' }, { calibratedAt: -1 }, { calibratedAt: Infinity }, { coverageMessage: 'a'.repeat(501) }]) {
    const saved = structuredClone(engine.snapshot);
    Object.assign(saved.monitoring, patch);
    assert.throws(() => validateSavedSnapshot(saved), /snapshot.monitoring/);
  }
});

test('both check-in questions reach the phone without exposing private response data', () => {
  const { engine, camera, enable, trigger, advance } = harness();
  camera(); enable(); trigger();
  assert.equal(projectSnapshot(engine.snapshot, 'phone').incident!.checkInStage, 'okay');
  advance(10_000); engine.tick();
  const phone = projectSnapshot(engine.snapshot, 'phone');
  assert.equal(phone.incident!.status, 'check_in');
  assert.equal(phone.incident!.checkInStage, 'help');
  assert.equal(phone.incident!.deadline, engine.snapshot.incident!.deadline);
  assert.deepEqual(phone.incident!.contactPlan, []);
  assert.deepEqual(phone.incident!.attempts, []);
  assert.deepEqual(phone.incident!.events, []);
  assert.deepEqual(phone.config.contacts, []);
});

test('check-in stage survives saved-state validation, history, and restart without replaying questions', () => {
  const { engine, camera, enable, trigger, advance } = harness();
  camera(); enable(); trigger();
  advance(10_000); engine.tick();
  const pending = JSON.parse(JSON.stringify(engine.snapshot));
  assert.doesNotThrow(() => validateSavedSnapshot(pending));
  const restored = new Engine({ snapshot: pending });
  assert.equal(restored.snapshot.incident!.checkInStage, 'help');
  assert.equal(restored.snapshot.incident!.status, 'escalation_simulated');
  assert.equal(restored.snapshot.incident!.deadline, null);
  assert.equal(restored.snapshot.incident!.attempts.length, 0);
  assert.equal(restored.snapshot.incident!.events.filter(event => event.kind === 'help_check_in').length, 1);
  engine.command({ type: 'respond', incidentId: engine.snapshot.incident!.id, action: 'okay', actor: 'desktop' });
  engine.command({ type: 'reset' });
  const archived = JSON.parse(JSON.stringify(engine.snapshot));
  assert.doesNotThrow(() => validateSavedSnapshot(archived));
  assert.equal(new Engine({ snapshot: archived }).snapshot.history[0]!.checkInStage, 'help');
});

test('saved check-ins accept missing legacy stages and reject unknown stages in live or archived incidents', () => {
  const { engine, camera, enable, trigger } = harness();
  camera(); enable(); trigger();
  const legacy = structuredClone(engine.snapshot);
  delete legacy.incident!.checkInStage;
  assert.doesNotThrow(() => validateSavedSnapshot(legacy));
  const restored = new Engine({ snapshot: legacy });
  assert.equal(restored.snapshot.incident!.checkInStage, undefined);
  assert.equal(restored.snapshot.incident!.attempts.length, 0);
  for (const stage of ['unconscious', null, 10]) {
    const corrupt = structuredClone(engine.snapshot);
    Object.assign(corrupt.incident!, { checkInStage: stage });
    assert.throws(() => validateSavedSnapshot(corrupt), /snapshot.incident.checkInStage/);
    const archived = structuredClone(engine.snapshot);
    archived.history.push(corrupt.incident!);
    archived.incident = null;
    assert.throws(() => validateSavedSnapshot(archived), /snapshot.history\[0\].checkInStage/);
  }
});
