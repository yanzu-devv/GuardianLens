import test from 'node:test';
import assert from 'node:assert/strict';
import { CollapseDetector, type Landmark } from '../src/shared/detector.ts';

/** Synthetic rule tests only. These do not measure accuracy on real people. */
function pose(hipY: number, shoulderY: number, hipX = 0.5, shoulderX = 0.5): Landmark[] {
  const result = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  result[11] = { x: shoulderX - 0.04, y: shoulderY, visibility: 1 };
  result[12] = { x: shoulderX + 0.04, y: shoulderY, visibility: 1 };
  result[23] = { x: hipX - 0.04, y: hipY, visibility: 1 };
  result[24] = { x: hipX + 0.04, y: hipY, visibility: 1 };
  return result;
}

function baseline(detector: CollapseDetector) {
  for (let at = 0; at <= 1000; at += 100) detector.update(pose(0.52, 0.28), at);
}

function fall(detector: CollapseDetector) {
  detector.update(pose(0.58, 0.37, 0.5, 0.43), 1100);
  detector.update(pose(0.7, 0.62, 0.55, 0.36), 1200);
  return detector.update(pose(0.82, 0.79, 0.58, 0.35), 1300);
}

test('rapid descent, low horizontal posture, and stillness trigger once', () => {
  const detector = new CollapseDetector();
  baseline(detector);
  assert.equal(fall(detector).possibleCollapse, false);
  let detections = 0;
  for (let at = 1400; at <= 5000; at += 100) {
    if (detector.update(pose(0.82, 0.79, 0.58, 0.35), at).possibleCollapse) detections++;
  }
  assert.equal(detections, 1);
});

test('sitting quickly keeps a vertical torso and does not trigger', () => {
  const detector = new CollapseDetector();
  baseline(detector);
  detector.update(pose(0.73, 0.45), 1100);
  for (let at = 1200; at <= 8000; at += 100) {
    assert.equal(detector.update(pose(0.75, 0.48), at).possibleCollapse, false);
  }
});

test('bending without hip descent does not trigger', () => {
  const detector = new CollapseDetector();
  baseline(detector);
  for (let at = 1100; at <= 7000; at += 100) {
    assert.equal(detector.update(pose(0.55, 0.69, 0.6, 0.35), at).possibleCollapse, false);
  }
});

test('a slow intentional transition to lying down does not trigger', () => {
  const detector = new CollapseDetector();
  baseline(detector);
  for (let at = 1100; at <= 6000; at += 100) {
    const progress = (at - 1000) / 5000;
    assert.equal(detector.update(pose(0.52 + 0.3 * progress, 0.28 + 0.51 * progress, 0.5 + 0.08 * progress, 0.5 - 0.15 * progress), at).possibleCollapse, false);
  }
  for (let at = 6100; at <= 8500; at += 100) {
    assert.equal(detector.update(pose(0.82, 0.79, 0.58, 0.35), at).possibleCollapse, false);
  }
});

test('starting near the floor lacks an upright baseline and does not trigger', () => {
  const detector = new CollapseDetector();
  for (let at = 0; at <= 7000; at += 100) {
    assert.equal(detector.update(pose(0.82, 0.79, 0.58, 0.35), at).possibleCollapse, false);
  }
});

test('missing or occluded pose resets descent and stillness evidence', () => {
  const detector = new CollapseDetector();
  baseline(detector);
  fall(detector);
  assert.equal(detector.update(null, 1400).personInView, false);
  for (let at = 1500; at <= 5000; at += 100) {
    assert.equal(detector.update(pose(0.82, 0.79, 0.58, 0.35), at).possibleCollapse, false);
  }
  const occluded = pose(0.82, 0.79, 0.58, 0.35);
  occluded[23]!.visibility = 0.1;
  assert.equal(detector.update(occluded, 5100).personInView, false);
});

test('stalled video time does not accumulate stillness', () => {
  const detector = new CollapseDetector();
  baseline(detector);
  fall(detector);
  assert.equal(detector.update(pose(0.82, 0.79, 0.58, 0.35), 5000).possibleCollapse, false);
});

test('movement resets stillness until a continuous quiet interval', () => {
  const detector = new CollapseDetector();
  baseline(detector);
  fall(detector);
  for (let at = 1400; at <= 3500; at += 100) {
    const shift = Math.floor(at / 300) % 2 ? 0.05 : 0;
    assert.equal(detector.update(pose(0.82, 0.79, 0.58 + shift, 0.35 + shift), at).possibleCollapse, false);
  }
});
