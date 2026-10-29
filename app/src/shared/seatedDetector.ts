import type { Landmark } from './detector';

export interface SeatedObservation {
  personInView: boolean;
  trackingReady: boolean;
  coverage: 'ready' | 'partial' | 'absent' | 'uncalibrated';
  message: string;
  calibration: 'none' | 'collecting' | 'ready';
  calibrationProgress: number;
  calibratedAt: number | null;
  rapidMovement: boolean;
  slumped: boolean;
  limitedMovement: boolean;
  possibleEvent: boolean;
  eventEvidence?: 'seated_still_slump';
  measurements?: { headToShoulderWidths: number; baselineHeadToShoulderWidths: number; headDropWidths: number; headTiltDegrees: number | null; headVelocityWidthsPerSecond: number; headSideVelocityWidthsPerSecond: number; holdMs: number; holdRequiredMs: number };
}

/** Experimental, image-relative rules. These values have no clinical validation. */
export const SEATED_THRESHOLDS = {
  minimumVisibility: 0.55,
  frameMargin: 0.03,
  minimumShoulderWidth: 0.12,
  maximumShoulderWidth: 0.8,
  calibrationMs: 2000,
  calibrationMinimumSamples: 10,
  calibrationMovement: 0.08,
  evidenceFrameGapMs: 500,
  invalidateFrameGapMs: 1500,
  rapidWindowMs: 700,
  confirmationMs: 10_000,
  quietMovementWidths: 0.05,
  headSideWidths: 0.35,
  headSideReleaseWidths: 0.25,
  headTiltDegrees: 15,
  headTiltReleaseDegrees: 10,
  quietHeadRoll: 0.08,
  confirmationMinimumSamples: 3,
  rapidSideVelocityWidthsPerSecond: 1,
  rapidMinimumHistorySamples: 2,
  recoveryMinimumSamples: 3,
  recoveryDistanceWidths: 0.18,
  headDropWidths: 0.25,
  headDropReleaseWidths: 0.18,
  nearShoulderLineWidths: -0.15,
  nearShoulderLineReleaseWidths: -0.2,
  nearLineMinimumDropWidths: 0.1,
  nearLineReleaseDropWidths: 0.05,
  rapidVelocityWidthsPerSecond: 0.8,
  rapidMinimumDropWidths: 0.15,
  velocityMinimumWindowMs: 50,
  trackingGraceMs: 300,
} as const;

interface Point { x: number; y: number }
interface Sample {
  at: number;
  head: Point;
  shoulder: Point;
  width: number;
  roll: number;
  headRoll: number | null;
  headSource: 'nose' | 'ears';
  noseToEars: Point | null;
}
interface Candidate {
  at: number;
  elapsedMs: number;
  validFrames: number;
  anchor: Sample;
}
interface Framing { sample: Sample | null; personInView: boolean; message: string }

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const angleDistance = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
// Ear/shoulder lines have no direction: reversing endpoints is the same line.
const lineAngleDistance = (a: number, b: number) => Math.acos(Math.min(1, Math.abs(Math.cos(a - b))));
// Positive y points down. Normalize each sample by its own physical shoulder
// width so uniform scale changes do not alter the calibrated relationship.
const headHeight = (sample: Sample) => (sample.head.y - sample.shoulder.y) / sample.width;
const headSide = (sample: Sample) => (sample.head.x - sample.shoulder.x) / sample.width;
// Calibration averages and normalized geometry can round an exact boundary down.
const atLeast = (value: number, threshold: number) => value >= threshold - 1e-9;
const visible = (p: Landmark | undefined): p is Landmark => Boolean(p
  && Number.isFinite(p.x) && Number.isFinite(p.y)
  && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
  && typeof p.visibility === 'number' && Number.isFinite(p.visibility) && p.visibility >= SEATED_THRESHOLDS.minimumVisibility);
const inside = (p: Point) => p.x > SEATED_THRESHOLDS.frameMargin && p.x < 1 - SEATED_THRESHOLDS.frameMargin
  && p.y > SEATED_THRESHOLDS.frameMargin && p.y < 1 - SEATED_THRESHOLDS.frameMargin;

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  if (!length) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length));
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function frame(landmarks: readonly Landmark[] | null, at: number, aspectRatio = 1): Framing {
  // MediaPipe normalizes x and y by different image dimensions. Compare
  // geometry in height units so camera shape cannot change physical angles.
  const metric = (point: Point): Point => ({ x: point.x * aspectRatio, y: point.y });
  const pointDistance = (a: Point, b: Point) => distance(metric(a), metric(b));
  const personInView = Boolean(landmarks?.some(visible));
  const missing = (message: string): Framing => ({ sample: null, personInView, message });
  if (!landmarks || !personInView) return missing('No usable pose is visible. Keep your head and both shoulders inside the camera view.');
  const left = landmarks[11], right = landmarks[12];
  if (!visible(left) || !visible(right)) return missing('Both shoulders must be clearly visible. Adjust the fixed camera framing.');
  if (!inside(left) || !inside(right)) return missing('A shoulder is too close to the frame edge. Include both shoulders with space around them.');
  const width = pointDistance(left, right);
  if (width / aspectRatio < SEATED_THRESHOLDS.minimumShoulderWidth) return missing('Your shoulders are too small in the frame. Use a closer, fixed camera view.');
  if (width / aspectRatio > SEATED_THRESHOLDS.maximumShoulderWidth) return missing('The camera view is too tight. Include your head and both shoulders with space around them.');

  const nose = landmarks[0], earA = landmarks[7], earB = landmarks[8];
  const ears = visible(earA) && visible(earB) && pointDistance(earA, earB) > 0.02 * aspectRatio && pointDistance(earA, earB) < width * 0.85
    ? midpoint(earA, earB) : null;
  const noseToEars = visible(nose) && ears ? { x: (nose.x - ears.x) * aspectRatio, y: nose.y - ears.y } : null;
  let head: Point, headSource: Sample['headSource'];
  if (visible(nose)) {
    head = nose; headSource = 'nose';
  } else if (ears) {
    head = ears; headSource = 'ears';
  } else return missing('Your shoulders are visible, but your head is not clear. Keep your face uncovered and in view.');
  if (!inside(head)) return missing('Your head is too close to the frame edge. Keep your whole head inside the camera view.');

  for (const [elbowIndex, wristIndex] of [[13, 15], [14, 16]]) {
    const elbow = landmarks[elbowIndex!], wrist = landmarks[wristIndex!];
    if (visible(wrist) && pointDistance(wrist, head) / width < 0.32) return missing('A hand is near your head. Keep your face clear for head tracking.');
    if (visible(elbow) && visible(wrist) && pointDistance(elbow, wrist) / width > 0.15
      && segmentDistance(metric(head), metric(elbow), metric(wrist)) / width < 0.17) return missing('An arm may cover your head. Keep your face clear for head tracking.');
  }
  const a = left.x < right.x ? left : right, b = left.x < right.x ? right : left;
  let headRoll: number | null = null;
  if (ears) headRoll = Math.atan2(earB!.y - earA!.y, (earB!.x - earA!.x) * aspectRatio);
  return { sample: { at, head: metric(head), shoulder: metric(midpoint(left, right)), width, roll: Math.atan2(b.y - a.y, (b.x - a.x) * aspectRatio), headRoll, headSource, noseToEars }, personInView: true, message: '' };
}

/**
 * A seated check-in heuristic requiring explicit, stable calibration. Hips and
 * floor visibility are not required. It cannot diagnose fainting, detect eye
 * closure alone, see off-camera events, or reliably distinguish an intentional
 * sudden slump from a medical event. Intentional head lowering, reading, or a
 * shoulder shrug can also prompt a check-in. Confident but incorrect model landmarks
 * can also defeat the occlusion guards. Every event is only a possible event.
 */
export class SeatedDetector {
  private reference: Sample | null = null;
  private collecting = false;
  private calibrationSamples: Sample[] = [];
  private calibrationTime: number | null = null;
  private lastAt: number | null = null;
  private history: Sample[] = [];
  private candidate: Candidate | null = null;
  private rapidFrames = 0;
  private rapidDirection: 'down' | 'left' | 'right' | null = null;
  private rapidPulse: { anchor: Sample; end: Sample; direction: 'down' | 'left' | 'right'; at: number } | null = null;
  private recoveryFrames = 0;
  private latched = false;
  private lastHeadSource: Sample['headSource'] | null = null;
  private referenceLostReason: string | null = null;
  private missingSince: number | null = null;
  private aspectRatio: number | null = null;

  get calibrated(): boolean { return this.reference !== null; }

  beginCalibration(): void {
    this.reset();
    this.collecting = true;
  }

  reset(): void {
    this.reference = null;
    this.collecting = false;
    this.calibrationSamples = [];
    this.calibrationTime = null;
    this.lastAt = null;
    this.latched = false;
    this.referenceLostReason = null;
    this.aspectRatio = null;
    this.resetEvidence();
  }

  /** Clear pending evidence while retaining calibration and a completed-episode latch. */
  resetEvidence(): void {
    this.history = [];
    this.candidate = null;
    this.rapidFrames = 0;
    this.rapidDirection = null;
    this.rapidPulse = null;
    this.recoveryFrames = 0;
    this.lastHeadSource = null;
    this.missingSince = null;
  }

  private pauseTracking(at: number): void {
    // A quiet hold must be continuous; even a short unusable pose restarts it.
    this.candidate = null;
    const missingStarted = this.missingSince ?? at;
    if (at - missingStarted > SEATED_THRESHOLDS.trackingGraceMs) this.resetEvidence();
    this.missingSince = missingStarted;
    this.history = [];
    this.rapidFrames = 0;
    this.rapidDirection = null;
    this.rapidPulse = null;
    this.recoveryFrames = 0;
    this.calibrationSamples = [];
  }

  private resumeTracking(at: number): boolean {
    const returning = this.missingSince !== null;
    if (this.missingSince !== null && at - this.missingSince > SEATED_THRESHOLDS.trackingGraceMs) this.resetEvidence();
    this.missingSince = null;
    return returning;
  }

  private invalidate(reason: string): void {
    this.reference = null;
    this.collecting = false;
    this.calibrationSamples = [];
    this.calibrationTime = null;
    this.referenceLostReason = reason;
    this.latched = false;
    this.resetEvidence();
  }

  private feedback(personInView: boolean, trackingReady: boolean, coverage: SeatedObservation['coverage'], message: string): SeatedObservation {
    const progress = this.reference ? 1 : this.calibrationSamples.length > 1
      ? Math.min(1, (this.calibrationSamples.at(-1)!.at - this.calibrationSamples[0]!.at) / SEATED_THRESHOLDS.calibrationMs) : 0;
    return {
      personInView, trackingReady, coverage, message,
      calibration: this.reference ? 'ready' : this.collecting ? 'collecting' : 'none',
      calibrationProgress: progress, calibratedAt: this.calibrationTime,
      rapidMovement: false, slumped: false, limitedMovement: false, possibleEvent: false,
    };
  }

  update(landmarks: readonly Landmark[] | null, at: number, imageAspectRatio = 1): SeatedObservation {
    let timingMessage = '';
    if (!Number.isFinite(imageAspectRatio) || imageAspectRatio <= 0) throw new Error('Camera aspect ratio must be positive and finite.');
    if (this.aspectRatio !== null && Math.abs(imageAspectRatio - this.aspectRatio) > 0.001) {
      this.invalidate('Camera dimensions changed. Calibrate again before monitoring seated movement.');
    }
    this.aspectRatio = imageAspectRatio;
    const previousAt = this.lastAt;
    if (!Number.isFinite(at) || (this.lastAt !== null && at <= this.lastAt)) {
      this.reset();
      const framing = frame(landmarks, Number.isFinite(at) ? at : 0, imageAspectRatio);
      return this.feedback(framing.personInView, Boolean(framing.sample), framing.sample ? 'uncalibrated' : framing.personInView ? 'partial' : 'absent', 'Frame timing changed. Calibrate again before monitoring seated movement.');
    }
    if (this.lastAt !== null && at - this.lastAt > SEATED_THRESHOLDS.invalidateFrameGapMs) {
      // A user-requested calibration may wait for usable frames. Missing time
      // never counts toward stability, but does not cancel that explicit request.
      if (this.collecting) { this.calibrationSamples = []; this.resetEvidence(); }
      else this.invalidate('Video frames were interrupted. Calibrate again before monitoring seated movement.');
      timingMessage = 'Video frames were interrupted. Calibrate again before monitoring seated movement.';
    } else if (this.lastAt !== null && at - this.lastAt > SEATED_THRESHOLDS.evidenceFrameGapMs) {
      this.resetEvidence();
      this.calibrationSamples = [];
    }
    this.lastAt = at;
    let framing = frame(landmarks, at, imageAspectRatio);
    if (framing.sample && this.reference && (framing.sample.width / this.reference.width < 0.65 || framing.sample.width / this.reference.width > 1.6)) {
      this.invalidate('Your distance or camera framing changed. Set a new seated reference before monitoring.');
      framing = { sample: null, personInView: true, message: 'Your distance or camera framing changed. Restore the seated view and calibrate again.' };
    }
    if (!framing.sample) {
      // Short confidence losses pause confirmation. Missing frames are never evidence.
      this.pauseTracking(at);
      return this.feedback(framing.personInView, false, framing.personInView ? 'partial' : 'absent', `${framing.message}${this.reference ? ' Seated reference saved. Movement checks resume when you return to a clear view; no recalibration is needed if the camera has stayed in place.' : this.referenceLostReason ? ` ${this.referenceLostReason}` : ''}`);
    }

    let current = framing.sample;
    if (this.collecting) {
      this.resumeTracking(at);
      const headGap = (current.shoulder.y - current.head.y) / current.width;
      const headSide = Math.abs(current.head.x - current.shoulder.x) / current.width;
      if (headGap < 0.25 || headGap > 2.5 || headSide > 0.65 || Math.abs(current.roll) > 0.35) {
        this.calibrationSamples = [];
        return this.feedback(true, true, 'uncalibrated', 'Sit comfortably upright with your head above your shoulders, then hold still for calibration.');
      }
      const anchor = this.calibrationSamples[0];
      if (anchor && (current.headSource !== anchor.headSource
        || Math.max(distance(current.head, anchor.head), distance(current.shoulder, anchor.shoulder)) / anchor.width > SEATED_THRESHOLDS.calibrationMovement
        || Math.abs(current.width / anchor.width - 1) > 0.1 || angleDistance(current.roll, anchor.roll) > 0.08
        || (current.headRoll !== null && anchor.headRoll !== null && lineAngleDistance(current.headRoll, anchor.headRoll) > SEATED_THRESHOLDS.quietHeadRoll))) this.calibrationSamples = [];
      this.calibrationSamples.push(current);
      const duration = current.at - this.calibrationSamples[0]!.at;
      if (duration < SEATED_THRESHOLDS.calibrationMs || this.calibrationSamples.length < SEATED_THRESHOLDS.calibrationMinimumSamples) {
        return this.feedback(true, true, 'uncalibrated', 'Hold your usual seated posture still for two seconds. Your head and both shoulders must remain visible.');
      }
      const average = (get: (sample: Sample) => number) => this.calibrationSamples.reduce((sum, sample) => sum + get(sample), 0) / this.calibrationSamples.length;
      const paired = this.calibrationSamples.filter(sample => sample.noseToEars);
      const headAngles = this.calibrationSamples.filter(sample => sample.headRoll !== null);
      this.reference = {
        at, head: { x: average(s => s.head.x), y: average(s => s.head.y) },
        shoulder: { x: average(s => s.shoulder.x), y: average(s => s.shoulder.y) },
        width: average(s => s.width), roll: average(s => s.roll), headSource: current.headSource,
        headRoll: headAngles.length >= SEATED_THRESHOLDS.calibrationMinimumSamples
          ? Math.atan2(headAngles.reduce((sum, s) => sum + Math.sin(2 * s.headRoll!), 0), headAngles.reduce((sum, s) => sum + Math.cos(2 * s.headRoll!), 0)) / 2 : null,
        noseToEars: paired.length >= SEATED_THRESHOLDS.calibrationMinimumSamples ? {
          x: paired.reduce((sum, s) => sum + s.noseToEars!.x, 0) / paired.length,
          y: paired.reduce((sum, s) => sum + s.noseToEars!.y, 0) / paired.length,
        } : null,
      };
      this.collecting = false;
      this.calibrationSamples = [];
      this.calibrationTime = at;
      this.referenceLostReason = null;
      this.resetEvidence();
    }
    if (!this.reference) return this.feedback(true, true, 'uncalibrated', this.referenceLostReason || timingMessage || 'Head and shoulders are visible. Calibrate your usual seated posture to enable seated movement checks.');

    // Compare like landmarks. A nose/ear confidence change is not body movement.
    if (current.headSource !== this.reference.headSource) {
      const offset = this.reference.noseToEars;
      if (!offset) {
        this.pauseTracking(at);
        return this.feedback(true, false, 'partial', 'Waiting for the head landmarks used by your saved reference. Face the camera again, or recalibrate if the camera moved.');
      }
      const direction = this.reference.headSource === 'nose' ? 1 : -1;
      const scale = current.width / this.reference.width;
      current = { ...current, headSource: this.reference.headSource, head: {
        x: current.head.x + direction * offset.x * scale,
        y: current.head.y + direction * offset.y * scale,
      } };
    }
    const returningFromOcclusion = this.resumeTracking(at);
    if (this.lastHeadSource && current.headSource !== this.lastHeadSource) this.resetEvidence();
    this.lastHeadSource = current.headSource;
    const reference = this.reference;
    const baselineHeadToShoulderWidths = headHeight(reference);
    const headToShoulderWidths = headHeight(current);
    const currentSide = headSide(current);
    const baselineSide = headSide(reference);
    const headDropWidths = headToShoulderWidths - baselineHeadToShoulderWidths;
    const holding = Boolean(this.candidate) || this.latched;
    const headTiltDegrees = current.headRoll !== null && reference.headRoll !== null
      ? lineAngleDistance(current.headRoll - current.roll, reference.headRoll - reference.roll) * 180 / Math.PI : null;
    const headTilted = headTiltDegrees !== null && atLeast(headTiltDegrees, holding ? SEATED_THRESHOLDS.headTiltReleaseDegrees : SEATED_THRESHOLDS.headTiltDegrees);
    const slumped = headTilted
      || atLeast(Math.abs(currentSide - baselineSide), holding ? SEATED_THRESHOLDS.headSideReleaseWidths : SEATED_THRESHOLDS.headSideWidths)
      || atLeast(headDropWidths, holding ? SEATED_THRESHOLDS.headDropReleaseWidths : SEATED_THRESHOLDS.headDropWidths)
      || (atLeast(headToShoulderWidths, holding ? SEATED_THRESHOLDS.nearShoulderLineReleaseWidths : SEATED_THRESHOLDS.nearShoulderLineWidths)
        && atLeast(headDropWidths, holding ? SEATED_THRESHOLDS.nearLineReleaseDropWidths : SEATED_THRESHOLDS.nearLineMinimumDropWidths));

    this.history = this.history.filter(sample => at - sample.at <= SEATED_THRESHOLDS.rapidWindowMs);
    let headVelocityWidthsPerSecond = 0;
    let headSideVelocityWidthsPerSecond = 0;
    let downwardAnchors = 0;
    let leftAnchors = 0;
    let rightAnchors = 0;
    let rapidSideDirection: 'left' | 'right' | null = null;
    let nextPulse: typeof this.rapidPulse = null;
    for (const sample of this.history) {
      const dt = (at - sample.at) / 1000;
      if (dt * 1000 < SEATED_THRESHOLDS.velocityMinimumWindowMs) continue;
      const drop = headToShoulderWidths - headHeight(sample);
      const side = currentSide - headSide(sample);
      const downVelocity = drop / dt;
      const sideVelocity = Math.abs(side) / dt;
      headVelocityWidthsPerSecond = Math.max(headVelocityWidthsPerSecond, downVelocity);
      if (atLeast(drop, SEATED_THRESHOLDS.rapidMinimumDropWidths)
        && atLeast(downVelocity, SEATED_THRESHOLDS.rapidVelocityWidthsPerSecond)) downwardAnchors++;
      if (atLeast(Math.abs(side), SEATED_THRESHOLDS.rapidMinimumDropWidths)
        && atLeast(sideVelocity, SEATED_THRESHOLDS.rapidSideVelocityWidthsPerSecond)) {
        if (side < 0) leftAnchors++; else rightAnchors++;
        if (sideVelocity >= headSideVelocityWidthsPerSecond) rapidSideDirection = side < 0 ? 'left' : 'right';
      }
      headSideVelocityWidthsPerSecond = Math.max(headSideVelocityWidthsPerSecond, sideVelocity);
      // A pre-movement position must have an earlier corroborating sample.
      // This rejects a one-frame outlier being mistaken for a fast return.
      const stableAnchor = this.history.some(earlier => earlier.at < sample.at
        && Math.hypot(headHeight(earlier) - headHeight(sample), headSide(earlier) - headSide(sample)) <= 0.05);
      if (stableAnchor) {
        const direction = atLeast(drop, SEATED_THRESHOLDS.rapidMinimumDropWidths) && atLeast(downVelocity, SEATED_THRESHOLDS.rapidVelocityWidthsPerSecond) ? 'down'
          : atLeast(Math.abs(side), SEATED_THRESHOLDS.rapidMinimumDropWidths) && atLeast(sideVelocity, SEATED_THRESHOLDS.rapidSideVelocityWidthsPerSecond) ? side < 0 ? 'left' : 'right' : null;
        if (direction) nextPulse = { anchor: sample, end: current, direction, at };
      }
    }
    // At slower inference rates the window can contain only one prior frame.
    // Two same-direction current frames still corroborate a real trajectory;
    // at higher rates multiple anchors reject a single stale landmark spike.
    const minimumAnchors = previousAt !== null && at - previousAt > SEATED_THRESHOLDS.rapidWindowMs / 2
      ? 1 : SEATED_THRESHOLDS.rapidMinimumHistorySamples;
    const sideSupported = rapidSideDirection === 'left' ? leftAnchors : rightAnchors;
    const rapidDirection = downwardAnchors >= minimumAnchors ? 'down'
      : sideSupported >= minimumAnchors ? rapidSideDirection : null;
    this.history.push(current);
    this.rapidFrames = rapidDirection ? this.rapidDirection === rapidDirection ? this.rapidFrames + 1 : 1 : 0;
    this.rapidDirection = rapidDirection;
    const pulse = this.rapidPulse;
    const axisPosition = (sample: Sample, direction: 'down' | 'left' | 'right') => direction === 'down' ? headHeight(sample) : headSide(sample) * (direction === 'left' ? -1 : 1);
    const pulseConfirmed = Boolean(pulse && at - pulse.at <= SEATED_THRESHOLDS.trackingGraceMs
      && atLeast(axisPosition(current, pulse.direction) - axisPosition(pulse.anchor, pulse.direction),
        Math.max(SEATED_THRESHOLDS.rapidMinimumDropWidths, 0.7 * (axisPosition(pulse.end, pulse.direction) - axisPosition(pulse.anchor, pulse.direction)))));
    this.rapidPulse = nextPulse;
    const rapidConfirmed = this.rapidFrames >= 2 || pulseConfirmed;

    // A completed episode stays latched through a held posture, cancellation,
    // and brief tracking loss. Rearm only after a usable return to the reference.
    const recovered = !slumped && (reference.headRoll === null || (headTiltDegrees !== null && headTiltDegrees < SEATED_THRESHOLDS.headTiltReleaseDegrees))
      && Math.abs(currentSide - baselineSide) <= SEATED_THRESHOLDS.recoveryDistanceWidths
      && Math.abs(headDropWidths) <= SEATED_THRESHOLDS.recoveryDistanceWidths
      && headVelocityWidthsPerSecond < SEATED_THRESHOLDS.rapidVelocityWidthsPerSecond
      && headSideVelocityWidthsPerSecond < SEATED_THRESHOLDS.rapidSideVelocityWidthsPerSecond;
    this.recoveryFrames = recovered ? this.recoveryFrames + 1 : 0;
    if (this.latched && this.recoveryFrames >= SEATED_THRESHOLDS.recoveryMinimumSamples) {
      this.latched = false;
      this.candidate = null;
    }

    let possibleEvent = false;
    let eventEvidence: SeatedObservation['eventEvidence'];
    let holdMs = 0;
    let holdRequiredMs: number = SEATED_THRESHOLDS.confirmationMs;
    let limitedMovement = false;
    if (!this.latched) {
      if (slumped) {
        const anchor = this.candidate?.anchor;
        // Only head position/rotation controls quiet time. Use the interval's
        // fixed scale so shoulder motion cannot change the movement measurement.
        // Comparing with its start also catches slow cumulative head motion.
        limitedMovement = Boolean(anchor && !returningFromOcclusion
          && distance(current.head, anchor.head) / anchor.width <= SEATED_THRESHOLDS.quietMovementWidths
          && ((current.headRoll === null && anchor.headRoll === null) || (current.headRoll !== null && anchor.headRoll !== null
            && lineAngleDistance(current.headRoll, anchor.headRoll) <= SEATED_THRESHOLDS.quietHeadRoll)));
        if (!this.candidate || !limitedMovement) this.candidate = { at, elapsedMs: 0, validFrames: 1, anchor: current };
        else {
          this.candidate.validFrames++;
          if (!returningFromOcclusion && previousAt !== null) this.candidate.elapsedMs += at - previousAt;
        }
        holdMs = this.candidate.elapsedMs;
      } else this.candidate = null;
      if (this.candidate && this.candidate.validFrames >= SEATED_THRESHOLDS.confirmationMinimumSamples
        && this.candidate.elapsedMs >= SEATED_THRESHOLDS.confirmationMs) {
        possibleEvent = true;
        eventEvidence = 'seated_still_slump';
      }
      if (possibleEvent) {
        this.latched = true;
        this.candidate = null;
        this.recoveryFrames = 0;
      }
    }
    const message = possibleEvent
      ? 'Lowered, tilted, or slumped head relative to shoulders with little head movement for 10 seconds. Check-in requested. Cause is unknown.'
      : this.latched ? 'Check-in already requested for this head-motion episode. Return to your calibrated head position to reset detection.'
        : this.candidate ? `Head lowered, tilted, or slumped relative to shoulders. Quiet hold: ${(holdMs / 1000).toFixed(1)} / 10.0 seconds. Head movement restarts the timer.`
          : this.rapidFrames ? 'Head movement observed. A check-in requires a slumped posture with little movement for 10 seconds.'
            : 'Seated view calibrated. Keep your head and both shoulders visible.';
    return {
      ...this.feedback(true, true, 'ready', message),
      rapidMovement: rapidConfirmed, slumped, limitedMovement, possibleEvent,
      measurements: { headToShoulderWidths, baselineHeadToShoulderWidths, headDropWidths, headTiltDegrees, headVelocityWidthsPerSecond, headSideVelocityWidthsPerSecond, holdMs, holdRequiredMs },
      ...(possibleEvent ? { eventEvidence } : {}),
    };
  }
}
