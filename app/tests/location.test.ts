import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/server/engine.js';
import { parseCommand, projectSnapshot, validateSavedSnapshot } from '../src/server/security.js';
import { createInitialSnapshot, type Config, type LocationFix } from '../src/shared/domain.js';
import { LOCATION_STALE_MS, fixMovementMeters, locationForIncident, locationReady, validLocationFix } from '../src/shared/location.js';

function harness() {
  let now = 1_000_000;
  const engine = new Engine({ now: () => now });
  const config: Config = { room: 'Travel laptop', address: '', consent: true, contacts: [{ id: 'a', name: 'Alex', optedIn: true }], checkInSeconds: 30, callSeconds: 30, locationMode: 'device' };
  engine.command({ type: 'configure', config });
  const fix = (latitude = 40, longitude = -74, accuracy = 10): LocationFix => ({ latitude, longitude, accuracy, capturedAt: now });
  const advance = (ms: number) => { now += ms; };
  const track = () => engine.command({ type: 'location_tracking', enabled: true });
  const sendFix = (value = fix()) => engine.command({ type: 'location_fix', fix: value });
  const trigger = () => engine.command({ type: 'trigger', source: 'example' });
  return { engine, config, fix, advance, track, sendFix, trigger, now: () => now };
}

test('new setup defaults to device location and a laptop label; legacy missing mode stays manual', () => {
  const initial = createInitialSnapshot();
  assert.equal(initial.config.locationMode, 'device');
  assert.equal(initial.config.room, 'My laptop');
  const legacy = structuredClone(initial);
  delete legacy.config.locationMode;
  delete legacy.location;
  legacy.config.address = 'Legacy configured address';
  assert.doesNotThrow(() => validateSavedSnapshot(legacy));
  const restored = new Engine({ snapshot: legacy });
  assert.equal(restored.snapshot.config.locationMode, undefined);
  assert.equal(locationForIncident(restored.snapshot).mode, 'manual');
  assert.equal(locationForIncident(restored.snapshot).address, 'Legacy configured address');
  assert.deepEqual(restored.snapshot.location, { tracking: false, fix: null, error: null });
});

test('device mode permits detection without GPS or a manual address and records the unknown location', () => {
  const { engine, track, trigger } = harness();
  track();
  engine.command({ type: 'location_error', message: 'Location permission denied.' });
  assert.doesNotThrow(() => engine.command({ type: 'monitoring', enabled: true }));
  assert.doesNotThrow(trigger);
  assert.equal(engine.snapshot.incident!.location!.availability, 'unavailable');
  assert.equal(engine.snapshot.incident!.location!.fix, null);
  assert.equal(engine.snapshot.incident!.location!.address, '');
  assert.match(engine.snapshot.incident!.location!.note!, /permission denied/);
});

test('manual and legacy modes still require a configured address', () => {
  for (const mode of ['manual', undefined] as const) {
    const { engine, config, trigger } = harness();
    engine.command({ type: 'configure', config: { ...config, locationMode: mode } });
    assert.throws(trigger, /manual address/);
    engine.command({ type: 'configure', config: { ...config, locationMode: mode, address: 'A configured manual address' } });
    trigger();
    assert.equal(engine.snapshot.incident!.location!.availability, 'manual');
    assert.equal(engine.snapshot.incident!.location!.address, 'A configured manual address');
  }
});

test('device fixes require tracking and reject invalid coordinates, accuracy, and future timestamps', () => {
  const { engine, fix, track, now } = harness();
  assert.throws(() => engine.command({ type: 'location_fix', fix: fix() }), /Enable device location/);
  track();
  const bad = [{ latitude: 91 }, { longitude: -181 }, { accuracy: 0 }, { accuracy: 10_000_001 }, { latitude: Number.NaN }, { capturedAt: now() + 10_001 }, { capturedAt: -1 }];
  for (const patch of bad) {
    const value = { ...fix(), ...patch };
    assert.equal(validLocationFix(value, now()), false);
    assert.throws(() => engine.command({ type: 'location_fix', fix: value }), /Invalid device location/);
  }
  assert.equal(engine.snapshot.location!.fix, null);
});

test('older or replayed fixes cannot overwrite the latest fix or move the camera', () => {
  const { engine, track, fix, sendFix, advance } = harness();
  track(); sendFix();
  const previous = structuredClone(engine.snapshot.location!.fix);
  advance(1_000);
  sendFix({ ...fix(60, 100), capturedAt: previous!.capturedAt - 1 });
  sendFix({ ...fix(60, 100), capturedAt: previous!.capturedAt });
  assert.deepEqual(engine.snapshot.location!.fix, previous);
});

test('incident location freezes the fix, accuracy, timestamp, and device label at detection', () => {
  const { engine, track, fix, sendFix, trigger, advance, config } = harness();
  track(); sendFix(); trigger();
  const frozen = structuredClone(engine.snapshot.incident!.location);
  advance(1_000); sendFix(fix(41, -75, 15));
  engine.command({ type: 'location_tracking', enabled: false });
  assert.deepEqual(engine.snapshot.incident!.location, frozen);
  assert.equal(frozen!.label, 'Travel laptop');
  assert.equal(frozen!.fix!.accuracy, 10);
  assert.equal(frozen!.availability, 'current');
  engine.command({ type: 'respond', incidentId: engine.snapshot.incident!.id, actor: 'desktop', action: 'okay' });
  engine.command({ type: 'configure', config: { ...config, room: 'Different laptop', address: 'A later address', locationMode: 'manual' } });
  assert.deepEqual(engine.snapshot.incident!.location, frozen);
});

test('manual incident addresses remain frozen after configuration edits', () => {
  const { engine, config, trigger } = harness();
  engine.command({ type: 'configure', config: { ...config, locationMode: 'manual', address: 'Original address' } });
  trigger();
  const id = engine.snapshot.incident!.id;
  engine.command({ type: 'respond', incidentId: id, actor: 'desktop', action: 'okay' });
  engine.command({ type: 'configure', config: { ...config, locationMode: 'manual', address: 'New address' } });
  assert.equal(engine.snapshot.incident!.location!.address, 'Original address');
});

test('the two-minute threshold labels old fixes stale without discarding timestamp or accuracy', () => {
  const { engine, track, sendFix, advance, now, trigger } = harness();
  track(); sendFix();
  assert.equal(locationReady(engine.snapshot, now()), true);
  advance(LOCATION_STALE_MS);
  assert.equal(locationForIncident(engine.snapshot, now()).availability, 'current');
  advance(1);
  assert.equal(locationReady(engine.snapshot, now()), false);
  trigger();
  assert.equal(engine.snapshot.incident!.location!.availability, 'stale');
  assert.equal(engine.snapshot.incident!.location!.fix!.capturedAt, 1_000_000);
  assert.equal(engine.snapshot.incident!.location!.fix!.accuracy, 10);
  assert.match(engine.snapshot.incident!.location!.note!, /older than two minutes/);
});

test('location errors preserve the last fix and retry preserves it; stopping clears only live state', () => {
  const { engine, track, sendFix, trigger } = harness();
  track(); sendFix(); trigger();
  const frozen = structuredClone(engine.snapshot.incident!.location);
  engine.command({ type: 'location_error', message: 'Provider unavailable.' });
  assert.ok(engine.snapshot.location!.fix);
  assert.equal(engine.snapshot.location!.error, 'Provider unavailable.');
  track();
  assert.ok(engine.snapshot.location!.fix);
  assert.equal(engine.snapshot.location!.error, null);
  engine.command({ type: 'location_tracking', enabled: false });
  assert.deepEqual(engine.snapshot.location, { tracking: false, fix: null, error: null });
  assert.deepEqual(engine.snapshot.incident!.location, frozen);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
});

test('first fix and accuracy-range jitter do not pause camera monitoring', () => {
  const { engine, track, sendFix, fix, advance } = harness();
  engine.command({ type: 'monitoring', enabled: true });
  track(); sendFix(fix(0, 0, 100));
  assert.equal(engine.snapshot.monitoring.enabled, true);
  advance(1_000); sendFix(fix(0.001, 0, 100)); // 111m movement, 200m combined uncertainty.
  assert.equal(engine.snapshot.monitoring.enabled, true);
});

test('device movement beyond uncertainty plus 50m pauses camera, records a fact, and preserves response', () => {
  const { engine, track, sendFix, fix, advance, trigger } = harness();
  track(); sendFix(fix(0, 0, 10));
  engine.command({ type: 'monitoring', enabled: true });
  trigger();
  const frozen = structuredClone(engine.snapshot.incident!.location);
  advance(1_000); sendFix(fix(0.001, 0, 10));
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.match(engine.snapshot.monitoring.interruption!, /Device moved/);
  assert.equal(engine.snapshot.location!.tracking, true);
  assert.equal(engine.snapshot.incident!.status, 'check_in');
  assert.deepEqual(engine.snapshot.incident!.location, frozen);
  const event = engine.snapshot.incident!.events.at(-1)!;
  assert.equal(event.kind, 'device_moved');
  assert.match(event.message, /does not establish patient movement/);
});

test('restoration discards current tracking fixes but preserves frozen incident location', () => {
  const { engine, track, sendFix, trigger } = harness();
  track(); sendFix(); trigger();
  const frozen = structuredClone(engine.snapshot.incident!.location);
  assert.doesNotThrow(() => validateSavedSnapshot(engine.snapshot));
  const restored = new Engine({ snapshot: engine.snapshot });
  assert.deepEqual(restored.snapshot.location, { tracking: false, fix: null, error: null });
  assert.deepEqual(restored.snapshot.incident!.location, frozen);
});

test('legacy incident records remain unknown instead of borrowing the current address', () => {
  const { engine, config, trigger } = harness();
  trigger();
  const legacy = structuredClone(engine.snapshot);
  delete legacy.location;
  delete legacy.config.locationMode;
  delete legacy.incident!.location;
  legacy.config.address = 'Current address, unrelated to historical event';
  assert.doesNotThrow(() => validateSavedSnapshot(legacy));
  const restored = new Engine({ snapshot: legacy });
  assert.equal(restored.snapshot.incident!.location, undefined);
  assert.equal(restored.snapshot.config.address, 'Current address, unrelated to historical event');
});

test('phone projection receives frozen incident location and no continuous laptop-location feed', () => {
  const { engine, track, sendFix, trigger } = harness();
  track(); sendFix(); trigger();
  const phone = projectSnapshot(engine.snapshot, 'phone');
  assert.deepEqual(phone.location, { tracking: false, fix: null, error: null });
  assert.deepEqual(phone.incident!.location, engine.snapshot.incident!.location);
  for (const command of [{ type: 'location_tracking', enabled: true }, { type: 'location_fix', fix: engine.snapshot.location!.fix }, { type: 'location_error', message: 'fake' }]) {
    assert.throws(() => parseCommand(command, 'phone'), /only respond/);
  }
});

test('saved validation accepts optional legacy fields and rejects corrupt location additions', () => {
  const { engine, track, sendFix, trigger } = harness();
  track(); sendFix(); trigger();
  assert.doesNotThrow(() => validateSavedSnapshot(engine.snapshot));
  const badMode = structuredClone(engine.snapshot) as unknown as Record<string, unknown>;
  badMode.location = { tracking: true, fix: { latitude: 91, longitude: 0, accuracy: 1, capturedAt: 1 }, error: null };
  assert.throws(() => validateSavedSnapshot(badMode), /snapshot.location.fix/);
  const badIncident = structuredClone(engine.snapshot);
  badIncident.incident!.location!.availability = 'manual';
  assert.throws(() => validateSavedSnapshot(badIncident), /snapshot.incident.location/);
});

test('distance helper handles same-point, known separation, and opposite-side coordinates', () => {
  const { fix } = harness();
  assert.equal(fixMovementMeters(fix(), fix()), 0);
  assert.ok(Math.abs(fixMovementMeters(fix(0, 0), fix(0.001, 0)) - 111.195) < 0.1);
  assert.ok(Number.isFinite(fixMovementMeters(fix(90, 0), fix(-90, 180))));
});

test('switching to manual location immediately clears live fixes and prevents location tracking', () => {
  const { engine, config, track, sendFix, trigger } = harness();
  track(); sendFix(); trigger();
  const id = engine.snapshot.incident!.id;
  const frozen = structuredClone(engine.snapshot.incident!.location);
  engine.command({ type: 'respond', incidentId: id, action: 'okay', actor: 'desktop' });
  engine.command({ type: 'reset' });
  engine.command({ type: 'configure', config: { ...config, room: 'A new label', locationMode: 'manual', address: 'A new manual address' } });
  assert.deepEqual(engine.snapshot.location, { tracking: false, fix: null, error: null });
  assert.throws(track, /Choose device location mode/);
  assert.deepEqual(engine.snapshot.history[0]!.location, frozen);
  assert.equal(engine.snapshot.history[0]!.location!.label, 'Travel laptop');
});

test('gradual movement is compared with the monitoring start location, not the previous fix', () => {
  const { engine, track, sendFix, fix, advance } = harness();
  track(); sendFix(fix(0, 0, 5));
  engine.command({ type: 'monitoring', enabled: true });
  advance(1_000); sendFix(fix(0.0003, 0, 5)); // 33m from anchor.
  assert.equal(engine.snapshot.monitoring.enabled, true);
  engine.command({ type: 'monitoring', enabled: true }); // Repeated enable must not move the anchor.
  advance(1_000); sendFix(fix(0.0006, 0, 5)); // Another 33m; 67m from anchor exceeds 60m.
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.match(engine.snapshot.monitoring.interruption!, /Device moved/);
  engine.command({ type: 'monitoring', enabled: true }); // Explicit re-enable after repositioning starts a new anchor.
  advance(1_000); sendFix(fix(0.0009, 0, 5));
  assert.equal(engine.snapshot.monitoring.enabled, true);
});

test('camera stop leaves travel unmonitored and re-enable anchors to the new device position', () => {
  const { engine, track, sendFix, fix, advance, config } = harness();
  engine.command({ type: 'configure', config: { ...config, detectionMode: 'full_body' } });
  track(); sendFix(fix(0, 0, 5));
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  engine.command({ type: 'monitoring', enabled: true });
  engine.command({ type: 'camera', camera: 'off', poseReady: false, personInView: false });
  advance(1_000); sendFix(fix(0.01, 0, 5));
  assert.equal(engine.snapshot.monitoring.enabled, false);
  assert.doesNotMatch(engine.snapshot.monitoring.interruption!, /Device moved/);
  engine.command({ type: 'camera', camera: 'connected', poseReady: true, personInView: true });
  assert.equal(engine.snapshot.monitoring.enabled, false);
  engine.command({ type: 'monitoring', enabled: true });
  advance(1_000); sendFix(fix(0.0103, 0, 5));
  assert.equal(engine.snapshot.monitoring.enabled, true);
});
