/** Experimental movement rules, not medical classification or validated fall detection. */
export interface Landmark {
  x: number;
  y: number;
  visibility?: number;
}

export interface DetectionObservation {
  personInView: boolean;
  rapidDownward: boolean;
  nearFloor: boolean;
  limitedMovement: boolean;
  possibleCollapse: boolean;
}

export const DETECTOR_THRESHOLDS = {
  minimumVisibility: 0.55,
  uprightHistoryMs: 2500,
  minimumUprightMs: 500,
  minimumDownwardSpeed: 0.45,
  minimumHipDrop: 0.18,
  lowHipY: 0.72,
  lowShoulderY: 0.65,
  horizontalTorsoRatio: 1.25,
  settlingMovement: 0.025,
  stillnessMs: 1500,
  candidateExpiryMs: 6000,
  maximumFrameGapMs: 600,
} as const;

interface Point { x: number; y: number }
interface Sample { at: number; hip: Point; shoulder: Point }
interface Candidate { startedAt: number; stillSince: number; anchor: Sample }

const empty = (): DetectionObservation => ({
  personInView: false, rapidDownward: false, nearFloor: false,
  limitedMovement: false, possibleCollapse: false,
});

function midpoint(a: Landmark, b: Landmark): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Requires a visible upright baseline, rapid descent, a low horizontal torso,
 * then sustained limited movement. Coordinates are image-relative, so the
 * fixed camera/room must be evaluated and tuned. A missing pose resets evidence.
 */
export class CollapseDetector {
  private previous: Sample | null = null;
  private upright: Sample[] = [];
  private candidate: Candidate | null = null;
  private latched = false;

  reset(): void {
    this.previous = null;
    this.upright = [];
    this.candidate = null;
    this.latched = false;
  }

  update(landmarks: readonly Landmark[] | null | undefined, at: number): DetectionObservation {
    const keys = [11, 12, 23, 24];
    if (!Number.isFinite(at) || !landmarks || keys.some((key) => {
      const p = landmarks[key];
      return !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1
        || (p.visibility ?? 1) < DETECTOR_THRESHOLDS.minimumVisibility;
    })) {
      this.reset();
      return empty();
    }

    if (this.previous && (at <= this.previous.at || at - this.previous.at > DETECTOR_THRESHOLDS.maximumFrameGapMs)) {
      this.reset();
    }

    const hip = midpoint(landmarks[23]!, landmarks[24]!);
    const shoulder = midpoint(landmarks[11]!, landmarks[12]!);
    const sample: Sample = { at, hip, shoulder };
    this.upright = this.upright.filter((p) => at - p.at <= DETECTOR_THRESHOLDS.uprightHistoryMs);
    const vertical = hip.y - shoulder.y;
    const horizontal = Math.abs(hip.x - shoulder.x);
    const upright = vertical > 0.12 && hip.y < 0.7 && horizontal < vertical * 0.8;
    const nearFloor = hip.y >= DETECTOR_THRESHOLDS.lowHipY
      && shoulder.y >= DETECTOR_THRESHOLDS.lowShoulderY
      && horizontal >= Math.abs(vertical) * DETECTOR_THRESHOLDS.horizontalTorsoRatio
      && horizontal > 0.1;

    let rapidDownward = false;
    if (this.previous && this.upright.length > 1 && !this.latched) {
      const baseline = this.upright.reduce((best, p) => p.hip.y < best.hip.y ? p : best);
      const visibleUprightMs = this.upright[this.upright.length - 1]!.at - this.upright[0]!.at;
      const velocity = (hip.y - this.previous.hip.y) / ((at - this.previous.at) / 1000);
      rapidDownward = visibleUprightMs >= DETECTOR_THRESHOLDS.minimumUprightMs
        && velocity >= DETECTOR_THRESHOLDS.minimumDownwardSpeed
        && hip.y - baseline.hip.y >= DETECTOR_THRESHOLDS.minimumHipDrop;
      if (rapidDownward && !this.candidate) {
        this.candidate = { startedAt: at, stillSince: at, anchor: sample };
      }
    }

    if (upright) this.upright.push(sample);
    if (this.candidate && at - this.candidate.startedAt > DETECTOR_THRESHOLDS.candidateExpiryMs) {
      this.candidate = null;
    }

    let limitedMovement = false;
    let possibleCollapse = false;
    if (this.candidate) {
      const moving = Math.max(distance(hip, this.candidate.anchor.hip), distance(shoulder, this.candidate.anchor.shoulder))
        > DETECTOR_THRESHOLDS.settlingMovement;
      if (!nearFloor || moving) {
        this.candidate.stillSince = at;
        this.candidate.anchor = sample;
      }
      limitedMovement = nearFloor && at - this.candidate.stillSince >= DETECTOR_THRESHOLDS.stillnessMs;
      if (limitedMovement && !this.latched) {
        possibleCollapse = true;
        this.latched = true;
      }
      rapidDownward = true;
    }

    this.previous = sample;
    return { personInView: true, rapidDownward, nearFloor, limitedMovement, possibleCollapse };
  }
}
