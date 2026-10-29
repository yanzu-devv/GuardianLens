import test from 'node:test';
import assert from 'node:assert/strict';
import type { Landmark } from '../src/shared/detector.ts';
import { SeatedDetector } from '../src/shared/seatedDetector.ts';

/** Synthetic geometry/transition tests only; no real-person accuracy claims. */
function seated(options: { headX?: number; headY?: number; shoulderX?: number; shoulderY?: number; roll?: number; width?: number; ears?: boolean } = {}): Landmark[] {
  const { headX = 0.5, headY = 0.28, shoulderX = 0.5, shoulderY = 0.55, roll = 0, width = 0.32, ears = false } = options;
  const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const halfX = Math.cos(roll) * width / 2, halfY = Math.sin(roll) * width / 2;
  pose[0] = { x: headX, y: headY, visibility: 0.98 };
  pose[11] = { x: shoulderX - halfX, y: shoulderY - halfY, visibility: 0.98 };
  pose[12] = { x: shoulderX + halfX, y: shoulderY + halfY, visibility: 0.98 };
  if (ears) {
    pose[7] = { x: headX - 0.05, y: headY - 0.02, visibility: 0.95 };
    pose[8] = { x: headX + 0.05, y: headY - 0.02, visibility: 0.95 };
  }
  return pose;
}

function calibrate(detector: SeatedDetector, start = 0, pose = seated(), aspectRatio = 1) {
  detector.beginCalibration();
  let output = detector.update(pose, start, aspectRatio);
  for (let at = start + 100; at <= start + 2200; at += 100) output = detector.update(pose, at, aspectRatio);
  assert.equal(output.calibration, 'ready');
  return start + 2200;
}

function countHeldEvents(detector: SeatedDetector, pose: Landmark[], start: number, duration = 4000, aspectRatio = 1) {
  let count = 0;
  for (let at = start + 100; at <= start + duration; at += 100) if (detector.update(pose, at, aspectRatio).possibleEvent) count++;
  return count;
}

/** Project the same centered physical pose into differently shaped images. */
function inAspectRatio(pose: Landmark[], aspectRatio: number): Landmark[] {
  return pose.map(point => ({ ...point, x: 0.5 + (point.x - 0.5) / aspectRatio }));
}

test('a usable seated view is tracking-ready but never calibrates automatically', () => {
  const detector = new SeatedDetector();
  for (let at = 0; at <= 5000; at += 100) {
    const output = detector.update(seated(), at);
    assert.equal(output.trackingReady, true);
    assert.equal(output.coverage, 'uncalibrated');
    assert.equal(output.calibration, 'none');
    assert.equal(output.possibleEvent, false);
  }
});

test('calibration needs continuous stability and reports progress with no hips', () => {
  const detector = new SeatedDetector();
  detector.beginCalibration();
  for (let at = 0; at <= 1000; at += 100) detector.update(seated(), at);
  assert.equal(detector.update(seated(), 1100).calibrationProgress, 0.55);
  const moved = detector.update(seated({ headX: 0.54, shoulderX: 0.54 }), 1200);
  assert.equal(moved.calibrationProgress, 0);
  assert.equal(moved.calibration, 'collecting');
  let output = moved;
  for (let at = 1300; at <= 3400; at += 100) output = detector.update(seated({ headX: 0.54, shoulderX: 0.54 }), at);
  assert.equal(output.calibration, 'ready');
  assert.equal(output.coverage, 'ready');
  assert.equal(output.calibratedAt, 3200);
  assert.equal(detector.calibrated, true);
});

test('small tracking jitter can calibrate without moving the reference continuously', () => {
  const detector = new SeatedDetector();
  detector.beginCalibration();
  let output = detector.update(seated(), 0);
  for (let at = 100; at <= 2300; at += 100) {
    const jitter = Math.sin(at / 100) * 0.003;
    output = detector.update(seated({ headX: 0.5 + jitter, headY: 0.28 - jitter, shoulderX: 0.5 + jitter, shoulderY: 0.55 - jitter }), at);
  }
  assert.equal(output.calibration, 'ready');
  const calibratedAt = output.calibratedAt;
  assert.equal(detector.update(seated({ headY: 0.31 }), 2400).calibratedAt, calibratedAt);
});

test('an explicit calibration request waits through five seconds without a pose, then requires two valid stable seconds', () => {
  const detector = new SeatedDetector();
  detector.beginCalibration();
  for (let at = 0; at <= 5000; at += 100) {
    const output = detector.update(null, at);
    assert.equal(output.calibration, 'collecting');
    assert.equal(output.calibrationProgress, 0);
    assert.equal(output.trackingReady, false);
    assert.equal(output.calibratedAt, null);
    assert.equal(output.possibleEvent, false);
  }
  for (let at = 5100; at < 7100; at += 100) {
    const output = detector.update(seated(), at);
    assert.equal(output.calibration, 'collecting');
    assert.equal(output.calibratedAt, null);
    assert.equal(output.possibleEvent, false);
  }
  const ready = detector.update(seated(), 7100);
  assert.equal(ready.calibration, 'ready');
  assert.equal(ready.calibratedAt, 7100);
  assert.equal(ready.possibleEvent, false);
});

test('partial framing during collection resets progress but preserves the request until the view becomes stable', () => {
  const detector = new SeatedDetector();
  detector.beginCalibration();
  for (let at = 0; at <= 1500; at += 100) detector.update(seated(), at);
  const partial = seated(); partial[0]!.visibility = 0.1;
  for (let at = 1600; at <= 6600; at += 100) {
    const output = detector.update(partial, at);
    assert.equal(output.coverage, 'partial');
    assert.equal(output.calibration, 'collecting');
    assert.equal(output.calibrationProgress, 0);
    assert.equal(output.calibratedAt, null);
  }
  for (let at = 6700; at < 8700; at += 100) {
    assert.equal(detector.update(seated(), at).calibration, 'collecting');
  }
  assert.equal(detector.update(seated(), 8700).calibration, 'ready');
});

test('a long frame gap during a pending calibration clears progress without cancelling the explicit request', () => {
  const detector = new SeatedDetector();
  detector.beginCalibration();
  for (let at = 0; at <= 1000; at += 100) detector.update(seated(), at);
  const afterGap = detector.update(seated(), 4000);
  assert.equal(afterGap.calibration, 'collecting');
  assert.equal(afterGap.calibrationProgress, 0);
  assert.equal(afterGap.calibratedAt, null);
  for (let at = 4100; at < 6000; at += 100) {
    const output = detector.update(seated(), at);
    assert.equal(output.calibration, 'collecting');
    assert.equal(output.possibleEvent, false);
  }
  assert.equal(detector.update(seated(), 6000).calibration, 'ready');
});

test('reset cancels a pending request and a later valid view cannot restart it implicitly', () => {
  const detector = new SeatedDetector();
  detector.beginCalibration();
  detector.update(null, 0);
  detector.update(null, 100);
  detector.reset();
  for (let at = 200; at <= 3000; at += 100) {
    const output = detector.update(seated(), at);
    assert.equal(output.calibration, 'none');
    assert.equal(output.calibratedAt, null);
    assert.equal(output.possibleEvent, false);
  }
});

// Each hold starts on the first usable sample in the changed posture.
function expectTenSecondHold(detector: SeatedDetector, pose: Landmark[], start: number, aspectRatio = 1) {
  for (let offset = 0; offset < 10_000; offset += 100) {
    const output = detector.update(pose, start + offset, aspectRatio);
    assert.equal(output.possibleEvent, false, `Unexpected event at ${offset} ms`);
    assert.equal(output.measurements?.holdMs, offset);
    assert.equal(output.measurements?.holdRequiredMs, 10_000);
  }
  const output = detector.update(pose, start + 10_000, aspectRatio);
  assert.equal(output.possibleEvent, true);
  assert.equal(output.eventEvidence, 'seated_still_slump');
  assert.equal(output.limitedMovement, true);
  assert.equal(output.measurements?.holdMs, 10_000);
  return output;
}

test('a brief head-down writing posture followed by recovery never prompts', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ headY: 0.43 }), at, 9000), 0);
  assert.equal(countHeldEvents(detector, seated(), at + 9000, 12_000), 0);
});

test('fast forward slump waits ten quiet seconds after the movement stops', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  detector.update(seated({ headY: 0.35, shoulderY: 0.57 }), at + 100);
  const moving = detector.update(seated({ headY: 0.47, shoulderY: 0.6 }), at + 200);
  assert.equal(moving.possibleEvent, false);
  assert.equal(moving.rapidMovement, true);
  expectTenSecondHold(detector, seated({ headY: 0.52, shoulderY: 0.61 }), at + 300);
  assert.equal(countHeldEvents(detector, seated({ headY: 0.52, shoulderY: 0.61 }), at + 10_300, 12_000), 0);
});

for (const direction of [-1, 1]) test(`a sustained ${direction < 0 ? 'left' : 'right'} slump also waits ten quiet seconds`, () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  expectTenSecondHold(detector, seated({ headX: 0.5 + direction * 0.16 }), at + 100);
});

for (const direction of [-1, 1]) test(`a quick sideways motion ${direction} and return does not prompt`, () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ headX: 0.5 + direction * 0.16 }), at, 500), 0);
  assert.equal(countHeldEvents(detector, seated(), at + 500, 12_000), 0);
});

test('a fast downward pulse below the posture threshold never prompts even when held', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ headY: 0.28 + 0.32 * 0.24 }), at, 12_000), 0);
});

test('the ten-second threshold is inclusive with valid 400 ms inference intervals', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  const lowered = seated({ headY: 0.43 });
  for (let offset = 400; offset < 10_400; offset += 400) {
    assert.equal(detector.update(lowered, at + offset).possibleEvent, false);
  }
  assert.equal(detector.update(lowered, at + 10_400).possibleEvent, true);
});

test('motion while still lowered restarts the quiet timer rather than accumulating holds', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ headY: 0.43 }), at, 9000), 0);
  expectTenSecondHold(detector, seated({ headY: 0.46 }), at + 9100);
});

test('slow continuous movement cannot complete the hold through small frame-to-frame steps', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  for (let offset = 100; offset <= 15_000; offset += 100) {
    const output = detector.update(seated({ headY: 0.43 + 0.00001 * offset }), at + offset);
    assert.equal(output.possibleEvent, false);
    assert.ok(output.measurements!.holdMs < 2000);
  }
});

test('head translation with the body resets the timer even if relative head height stays lowered', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ headY: 0.43 }), at, 9000), 0);
  expectTenSecondHold(detector, seated({ headY: 0.46, shoulderY: 0.58 }), at + 9100);
});

test('small landmark jitter within the quiet tolerance does not reset the hold', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  for (let offset = 100; offset <= 10_000; offset += 100) {
    const jitter = Math.sin(offset / 100) * 0.002;
    const output = detector.update(seated({ headX: 0.5 + jitter, headY: 0.43 + jitter, shoulderY: 0.55 - jitter }), at + offset);
    assert.equal(output.possibleEvent, false);
  }
  assert.equal(detector.update(seated({ headY: 0.43 }), at + 10_100).possibleEvent, true);
});

test('returning upright resets a pending hold', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ headY: 0.43 }), at, 9000), 0);
  detector.update(seated(), at + 9100);
  expectTenSecondHold(detector, seated({ headY: 0.43 }), at + 9200);
});

test('the quarter-width entry is inclusive while 0.249 widths stays below it', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ headY: 0.28 + 0.32 * 0.249 }), at, 12_000), 0);
  expectTenSecondHold(detector, seated({ headY: 0.28 + 0.32 * 0.25 }), at + 12_100);
});

test('a near-shoulder-line posture also requires ten quiet seconds', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, seated({ headY: 0.47 }));
  expectTenSecondHold(detector, seated({ headY: 0.51 }), at + 100);
});

for (const resetPending of [false, true]) test(`a completed episode stays latched${resetPending ? ' when pending evidence is cleared' : ''} until recovery`, () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  const lowered = seated({ headY: 0.43 });
  expectTenSecondHold(detector, lowered, at + 100);
  if (resetPending) detector.resetEvidence();
  assert.equal(countHeldEvents(detector, lowered, at + 10_100, 12_000), 0);
  assert.equal(countHeldEvents(detector, seated(), at + 22_100, 1500), 0);
  expectTenSecondHold(detector, lowered, at + 23_700);
});

for (const loss of ['brief', 'long', 'alternate head source'] as const) test(`${loss} tracking loss resets the quiet hold and retains calibration`, () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  const lowered = seated({ headY: 0.43 });
  assert.equal(countHeldEvents(detector, lowered, at, 9000), 0);
  const alternate = seated({ headY: 0.43, ears: true }); alternate[0]!.visibility = 0.1;
  const duration = loss === 'long' ? 600 : 100;
  for (let offset = 100; offset <= duration; offset += 100) {
    const missing = detector.update(loss === 'alternate head source' ? alternate : null, at + 9000 + offset);
    assert.equal(missing.possibleEvent, false);
    assert.equal(missing.calibration, 'ready');
  }
  expectTenSecondHold(detector, lowered, at + 9100 + duration);
});

test('tracking loss after an event preserves the episode latch', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  const lowered = seated({ headY: 0.43 });
  expectTenSecondHold(detector, lowered, at + 100);
  detector.update(null, at + 10_200);
  assert.equal(countHeldEvents(detector, lowered, at + 10_200, 12_000), 0);
});

test('medium frame gaps restart the hold and long frame gaps invalidate calibration', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  const lowered = seated({ headY: 0.43 });
  assert.equal(countHeldEvents(detector, lowered, at, 9000), 0);
  expectTenSecondHold(detector, lowered, at + 9800);
  assert.equal(detector.update(lowered, at + 21_400).calibration, 'none');
});

test('switching between calibrated nose and ear landmarks does not invent motion or reset the hold', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, seated({ ears: true }));
  let events = 0;
  for (let offset = 100; offset <= 10_100; offset += 100) {
    const pose = seated({ headY: 0.43, ears: true });
    if (offset % 200 === 0) pose[0]!.visibility = 0.1;
    const output = detector.update(pose, at + offset);
    assert.equal(output.coverage, 'ready');
    assert.equal(output.possibleEvent, offset === 10_100);
    if (output.possibleEvent) events++;
  }
  assert.equal(events, 1);
});

test('head-source confidence changes at the reference do not create an event', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, seated({ ears: true }));
  for (let offset = 100; offset <= 12_000; offset += 100) {
    const pose = seated({ ears: true });
    if (offset % 200 === 0) pose[0]!.visibility = 0.1;
    assert.equal(detector.update(pose, at + offset).possibleEvent, false);
  }
});

test('paired ears can be calibrated directly without a visible nose', () => {
  const detector = new SeatedDetector();
  const pose = seated({ ears: true }); pose[0]!.visibility = 0.1;
  const at = calibrate(detector, 0, pose);
  assert.equal(detector.update(pose, at + 100).coverage, 'ready');
});

test('missing head, covered face, clipped shoulders and invalid confidence block detection', () => {
  const detector = new SeatedDetector();
  calibrate(detector);
  const poses = [seated(), seated(), seated(), seated({ width: 0.06 }), seated({ shoulderX: 0.17 }), seated(), seated()];
  poses[0]![0]!.visibility = 0.1;
  poses[1]![15] = { x: 0.5, y: 0.29, visibility: 0.95 };
  poses[2]![13] = { x: 0.35, y: 0.28, visibility: 0.95 }; poses[2]![15] = { x: 0.66, y: 0.28, visibility: 0.95 };
  delete poses[5]![11]!.visibility;
  poses[6]![0]!.x = Number.NaN;
  for (const pose of poses) {
    for (let index = 0; index <= 120; index++) {
      const output = detector.update(pose, 2300 + poses.indexOf(pose) * 12_100 + index * 100);
      assert.equal(output.trackingReady, false);
      assert.equal(output.possibleEvent, false);
      assert.equal(output.calibration, 'ready');
    }
  }
});

test('leaving the view keeps calibration without accumulating quiet time', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  for (let offset = 100; offset <= 12_000; offset += 100) {
    const output = detector.update(null, at + offset);
    assert.equal(output.calibration, 'ready');
    assert.equal(output.possibleEvent, false);
  }
  expectTenSecondHold(detector, seated({ headY: 0.43 }), at + 12_100);
});

test('whole-body translation and shoulder roll alone do not create a slump', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  for (let offset = 100; offset <= 12_000; offset += 100) {
    const shift = Math.sin(offset / 1000) * 0.05;
    const output = detector.update(seated({ headX: 0.5 + shift, shoulderX: 0.5 + shift, headY: 0.28 + shift, shoulderY: 0.55 + shift, roll: Math.PI / 4 }), at + offset);
    assert.equal(output.possibleEvent, false);
    assert.ok(Math.abs(output.measurements!.headDropWidths) < 1e-9);
  }
});

test('width scaling at the calibrated relative head height cannot invent a slump', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(countHeldEvents(detector, seated({ width: 0.22, headY: 0.55 - 0.84375 * 0.22 }), at, 12_000), 0);
});

for (const aspectRatio of [16 / 10, 16 / 9, 3 / 4]) test(`the quiet hold is consistent at aspect ratio ${aspectRatio}`, () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, inAspectRatio(seated(), aspectRatio), aspectRatio);
  expectTenSecondHold(detector, inAspectRatio(seated({ headY: 0.43 }), aspectRatio), at + 100, aspectRatio);
});

test('changed aspect ratio or substantial shoulder scale invalidates calibration', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, inAspectRatio(seated(), 16 / 10), 16 / 10);
  assert.equal(detector.update(inAspectRatio(seated(), 3 / 4), at + 100, 3 / 4).calibration, 'none');
  calibrate(detector, at + 200);
  assert.equal(detector.update(seated({ width: 0.6 }), at + 2500).calibration, 'none');
});

test('raised shoulders can resemble a lowered head but still require the quiet hold', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  const output = expectTenSecondHold(detector, seated({ shoulderY: 0.43 }), at + 100);
  assert.match(output.message, /relative to shoulders/);
  assert.doesNotMatch(output.message, /confirmed fall|physical descent|fainted/i);
});

test('reset and non-monotonic time require explicit calibration again', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector);
  assert.equal(detector.update(seated(), at).calibration, 'none');
  calibrate(detector, at + 100);
  detector.reset();
  assert.equal(detector.update(seated(), at + 2400).calibration, 'none');
});

function tiltedHead(degrees: number, shoulderRoll = 0): Landmark[] {
  const pose = seated({ ears: true, roll: shoulderRoll });
  const radians = degrees * Math.PI / 180;
  pose[7] = { x: 0.5 - Math.cos(radians) * 0.05, y: 0.26 - Math.sin(radians) * 0.05, visibility: 0.98 };
  pose[8] = { x: 0.5 + Math.cos(radians) * 0.05, y: 0.26 + Math.sin(radians) * 0.05, visibility: 0.98 };
  return pose;
}

for (const direction of [-1, 1]) test(`sideways head tilt ${direction} triggers after ten quiet seconds without head displacement`, () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, tiltedHead(0));
  const result = expectTenSecondHold(detector, tiltedHead(direction * 30), at + 100);
  assert.ok(Math.abs(result.measurements!.headDropWidths) < 1e-9);
  assert.ok(Math.abs(result.measurements!.headTiltDegrees! - 30) < 1e-6);
});

test('brief head tilt and return do not trigger and reset pending time', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, tiltedHead(0));
  assert.equal(countHeldEvents(detector, tiltedHead(30), at, 9000), 0);
  assert.equal(countHeldEvents(detector, tiltedHead(0), at + 9000, 1000), 0);
  expectTenSecondHold(detector, tiltedHead(30), at + 10_100);
});

test('head rotation while tilted restarts the ten-second timer', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, tiltedHead(0));
  assert.equal(countHeldEvents(detector, tiltedHead(25), at, 9000), 0);
  expectTenSecondHold(detector, tiltedHead(35), at + 9100);
});

test('a missing ear restarts a tilt-only hold without inventing a head angle', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, tiltedHead(0));
  assert.equal(countHeldEvents(detector, tiltedHead(30), at, 9000), 0);
  const missing = tiltedHead(30); missing[7]!.visibility = 0.1;
  const result = detector.update(missing, at + 9100);
  assert.equal(result.possibleEvent, false);
  assert.equal(result.slumped, false);
  assert.equal(result.measurements?.headTiltDegrees, null);
  expectTenSecondHold(detector, tiltedHead(30), at + 9200);
});

test('head angle requires a measured baseline and ignores small angles', () => {
  const noEars = new SeatedDetector();
  const at = calibrate(noEars);
  assert.equal(countHeldEvents(noEars, tiltedHead(30), at, 12_000), 0);
  const detector = new SeatedDetector();
  const next = calibrate(detector, 0, tiltedHead(0));
  assert.equal(countHeldEvents(detector, tiltedHead(14), next, 12_000), 0);
  expectTenSecondHold(detector, tiltedHead(15), next + 12_100);
});

test('equal head and shoulder rotation does not invent a relative head tilt', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, tiltedHead(0));
  const pose = tiltedHead(30, Math.PI / 6);
  assert.equal(countHeldEvents(detector, pose, at, 12_000), 0);
});

for (const aspectRatio of [16 / 9, 3 / 4]) test(`head tilt uses physical image geometry at aspect ratio ${aspectRatio}`, () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, inAspectRatio(tiltedHead(0), aspectRatio), aspectRatio);
  const result = expectTenSecondHold(detector, inAspectRatio(tiltedHead(30), aspectRatio), at + 100, aspectRatio);
  assert.ok(Math.abs(result.measurements!.headTiltDegrees! - 30) < 1e-6);
});

test('tilt episodes stay latched through cancellation and require visible angular recovery', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, tiltedHead(0));
  expectTenSecondHold(detector, tiltedHead(30), at + 100);
  detector.resetEvidence();
  assert.equal(countHeldEvents(detector, tiltedHead(30), at + 10_100, 12_000), 0);
  const missing = tiltedHead(30); missing[7]!.visibility = 0.1;
  assert.equal(countHeldEvents(detector, missing, at + 22_100, 1000), 0);
  assert.equal(countHeldEvents(detector, tiltedHead(30), at + 23_100, 12_000), 0);
  assert.equal(countHeldEvents(detector, tiltedHead(0), at + 35_100, 1500), 0);
  expectTenSecondHold(detector, tiltedHead(30), at + 36_700);
});


test('a moderate 18-degree head tilt qualifies after the quiet hold', () => {
  const detector = new SeatedDetector();
  const at = calibrate(detector, 0, tiltedHead(0));
  expectTenSecondHold(detector, tiltedHead(18), at + 100);
});

test('head rotation during calibration restarts stability capture', () => {
  const detector = new SeatedDetector();
  detector.beginCalibration();
  for (let at = 0; at <= 1500; at += 100) detector.update(tiltedHead(0), at);
  const moved = detector.update(tiltedHead(10), 1600);
  assert.equal(moved.calibration, 'collecting');
  assert.equal(moved.calibrationProgress, 0);
  for (let at = 1700; at < 3600; at += 100) assert.equal(detector.update(tiltedHead(10), at).calibration, 'collecting');
  assert.equal(detector.update(tiltedHead(10), 3600).calibration, 'ready');
});


for (const change of ['translation', 'width', 'roll', 'tilted head'] as const) test(`shoulder ${change} does not reset quiet time when the head stays still`, () => {
  const detector = new SeatedDetector();
  const tilt = change === 'tilted head';
  const at = calibrate(detector, 0, tilt ? tiltedHead(0) : seated());
  for (let offset = 0; offset <= 10_000; offset += 100) {
    const movement = Math.sin(offset / 600);
    let pose = tilt ? tiltedHead(30) : seated({ headY: 0.43 });
    if (change === 'translation') pose = seated({ headY: 0.43, shoulderX: 0.5 + movement * 0.03, shoulderY: 0.55 + movement * 0.02 });
    if (change === 'width') pose = seated({ headY: 0.43, width: 0.32 + movement * 0.02 });
    if (change === 'roll' || tilt) {
      const shoulders = seated({ roll: movement * 0.15 });
      pose[11] = shoulders[11]!; pose[12] = shoulders[12]!;
    }
    const output = detector.update(pose, at + 100 + offset);
    assert.equal(output.slumped, true);
    assert.equal(output.measurements?.holdMs, offset);
    assert.equal(output.possibleEvent, offset === 10_000);
  }
});
