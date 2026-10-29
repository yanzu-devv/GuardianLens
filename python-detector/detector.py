"""Local pose features and temporal rules. No frame storage or alerting services."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import math
from pathlib import Path
import time
from typing import Any, Callable, Sequence

from config import DetectorConfig
from events import EventCallback, EventHook, EventType, FallEvent


class DetectionState(str, Enum):
    NORMAL = "NORMAL"
    POSSIBLE_FALL = "POSSIBLE_FALL"
    CONFIRMED_FALL = "CONFIRMED_FALL"
    SLUMP = "SLUMP"


@dataclass(frozen=True)
class Keypoint:
    x: float
    y: float
    z: float = 0.0
    visibility: float = 1.0


@dataclass(frozen=True)
class PoseFeatures:
    timestamp: float
    torso_angle: float | None
    hip_y: float | None
    hip_drop: float | None
    aspect_ratio: float | None
    visibility: float
    motion: float
    head_drop: float | None
    shoulder_tilt: float | None = None
    head_shoulder_angle: float | None = None
    posture_deviation: float | None = None


@dataclass(frozen=True)
class DetectionResult:
    state: DetectionState
    features: PoseFeatures | None
    landmarks: tuple[Keypoint, ...] | None
    pose_visible: bool
    hold_elapsed: float = 0.0
    hold_required: float = 0.0
    cooldown_remaining: float = 0.0
    event: FallEvent | None = None
    confirmed: bool = False
    message: str = ""


@dataclass(frozen=True)
class _Sample:
    timestamp: float
    points: tuple[Keypoint, ...]
    hip_y: float
    head_gap: float | None


@dataclass(frozen=True)
class _UpperBody:
    timestamp: float
    shoulder: tuple[float, float]
    width: float
    tilt: float
    head: tuple[float, float] | None
    neck_angle: float | None


CORE = (11, 12, 23, 24)
MOTION_POINTS = (0, *CORE)


class FallDetector:
    """One fixed camera, one consenting person. Call sequentially from one thread.

    process_frame runs pretrained Pose lazily. process_keypoints exposes the same
    temporal rules for reproducible tests without a camera or third-party packages.
    """

    def __init__(self, config: DetectorConfig | None = None, *,
                 pose_factory: Callable[[], Any] | None = None) -> None:
        self.config = config or DetectorConfig()
        self.state = DetectionState.NORMAL
        self._pose_factory = pose_factory
        self._pose: Any = None
        self._closed = False
        self._events = EventHook()
        self._history: deque[_Sample] = deque()
        self._baseline: deque[tuple[float, float]] = deque()
        self._head_reference: float | None = None
        self._last_timestamp: float | None = None
        self._hold_started: float | None = None
        self._confirmed = False
        self._cooldown_until = -math.inf
        self._seated_reference: _UpperBody | None = None
        self._seated_samples: list[_UpperBody] = []
        self._upper_history: deque[_UpperBody] = deque()

    def on_event(self, callback: EventCallback) -> Callable[[], None]:
        return self._events.on_event(callback)

    def reset(self) -> None:
        """Explicitly restart a session, including baseline and cooldown."""
        self._history.clear()
        self._baseline.clear()
        self._head_reference = None
        self._last_timestamp = None
        self._cooldown_until = -math.inf
        self._seated_reference = None
        self._seated_samples.clear()
        self._upper_history.clear()
        self._clear_pending()

    def _clear_pending(self) -> None:
        self.state = DetectionState.NORMAL
        self._hold_started = None
        self._confirmed = False

    def _visible(self, point: Keypoint) -> bool:
        return (all(math.isfinite(value) for value in (point.x, point.y, point.z, point.visibility))
                and 0 <= point.x <= 1 and 0 <= point.y <= 1
                and self.config.visibility_threshold <= point.visibility <= 1)

    def _features(self, points: tuple[Keypoint, ...], at: float,
                  image_size: tuple[int, int]) -> PoseFeatures | None:
        if len(points) < 25 or any(not self._visible(points[i]) for i in CORE):
            return None
        shoulder_x = (points[11].x + points[12].x) / 2
        shoulder_y = (points[11].y + points[12].y) / 2
        hip_x = (points[23].x + points[24].x) / 2
        hip_y = (points[23].y + points[24].y) / 2
        if math.hypot(shoulder_x - hip_x, hip_y - shoulder_y) < self.config.min_torso_length:
            return None
        width, height = image_size
        angle = math.degrees(math.atan2(abs(shoulder_x - hip_x) * width, (hip_y - shoulder_y) * height))
        visible_points = [point for point in points if self._visible(point)]
        box_width = max(p.x for p in visible_points) - min(p.x for p in visible_points)
        box_height = max(p.y for p in visible_points) - min(p.y for p in visible_points)
        if box_height < self.config.bbox_min_height:
            return None
        head_gap = points[0].y - shoulder_y if self._visible(points[0]) else None
        self._history.append(_Sample(at, points, hip_y, head_gap))
        window = max(self.config.hip_drop_window, self.config.motion_window)
        while self._history and at - self._history[0].timestamp > window + 1e-9:
            self._history.popleft()
        hip_samples = [s for s in self._history if at - s.timestamp <= self.config.hip_drop_window + 1e-9]
        hip_drop = max(0.0, hip_y - min(s.hip_y for s in hip_samples))
        motion_samples = [s for s in self._history if at - s.timestamp <= self.config.motion_window + 1e-9]
        motion = math.inf
        if len(motion_samples) >= 2:
            ranges = []
            for index in MOTION_POINTS:
                tracked = [s.points[index] for s in motion_samples]
                if all(self._visible(p) for p in tracked):
                    ranges.append(math.hypot(max(p.x for p in tracked) - min(p.x for p in tracked),
                                             max(p.y for p in tracked) - min(p.y for p in tracked)))
            motion = max(ranges, default=math.inf)
        # Capture once, rather than following a slowly dropping head downward.
        if self._head_reference is None:
            if angle <= self.config.upright_angle and head_gap is not None and motion <= self.config.max_slump_motion:
                if self._baseline and abs(head_gap - self._baseline[0][1]) > self.config.max_slump_motion:
                    self._baseline.clear()
                self._baseline.append((at, head_gap))
                if (len(self._baseline) >= self.config.baseline_min_samples
                        and at - self._baseline[0][0] + 1e-9 >= self.config.baseline_seconds):
                    self._head_reference = sum(gap for _, gap in self._baseline) / len(self._baseline)
                    self._baseline.clear()
            else:
                self._baseline.clear()
        head_drop = head_gap - self._head_reference if head_gap is not None and self._head_reference is not None else None
        return PoseFeatures(at, angle, hip_y, hip_drop, box_width * width / (box_height * height),
                            min(points[i].visibility for i in CORE), motion, head_drop)

    @staticmethod
    def _angle_change(first: float, second: float) -> float:
        return abs((first - second + 180.0) % 360.0 - 180.0)

    def _upper_body(self, points: tuple[Keypoint, ...], at: float,
                    image_size: tuple[int, int]) -> _UpperBody | None:
        if len(points) < 13 or any(not self._visible(points[i]) for i in (11, 12)):
            return None
        aspect = image_size[0] / image_size[1]
        left, right = sorted((points[11], points[12]), key=lambda point: point.x)
        width = math.hypot((right.x - left.x) * aspect, right.y - left.y)
        if width < self.config.seated_min_shoulder_width * aspect:
            return None
        shoulder = ((left.x + right.x) * aspect / 2, (left.y + right.y) / 2)
        tilt = math.degrees(math.atan2(right.y - left.y, (right.x - left.x) * aspect))
        head = (points[0].x * aspect, points[0].y) if self._visible(points[0]) else None
        neck = math.degrees(math.atan2(head[0] - shoulder[0], shoulder[1] - head[1])) if head else None
        return _UpperBody(at, shoulder, width, tilt, head, neck)

    def _process_seated(self, points: tuple[Keypoint, ...] | None, at: float,
                        image_size: tuple[int, int]) -> DetectionResult:
        config = self.config
        cooldown = max(0.0, self._cooldown_until - at)
        current = self._upper_body(points, at, image_size) if points else None
        if current is None:
            self._upper_history.clear()
            self._seated_samples.clear()
            self._clear_pending()
            saved = " Saved seated reference retained." if self._seated_reference else ""
            return DetectionResult(self.state, None, points, False, cooldown_remaining=cooldown,
                                   message="Shoulder tracking unavailable. Pending check cleared." + saved)

        self._upper_history.append(current)
        while self._upper_history and at - self._upper_history[0].timestamp > config.motion_window + 1e-9:
            self._upper_history.popleft()
        oldest = self._upper_history[0]
        motion = max(math.dist(sample.shoulder, oldest.shoulder) for sample in self._upper_history)
        if all(sample.head is not None for sample in self._upper_history):
            motion = max(motion, max(math.dist(sample.head, oldest.head) for sample in self._upper_history))
        if self._seated_reference is None:
            anchor = self._seated_samples[0] if self._seated_samples else current
            moved = math.dist(current.shoulder, anchor.shoulder) / anchor.width
            if current.head is not None and anchor.head is not None:
                moved = max(moved, math.dist(current.head, anchor.head) / anchor.width)
            if (moved > config.seated_calibration_motion
                    or abs(current.width - anchor.width) / anchor.width > config.seated_calibration_motion
                    or self._angle_change(current.tilt, anchor.tilt) > config.seated_calibration_tilt):
                self._seated_samples.clear()
            self._seated_samples.append(current)
            duration = at - self._seated_samples[0].timestamp
            if duration + 1e-9 >= config.seated_calibration_seconds and len(self._seated_samples) >= config.seated_min_samples:
                samples = self._seated_samples
                count = len(samples)
                shoulder = tuple(sum(sample.shoulder[i] for sample in samples) / count for i in (0, 1))
                heads = [sample.head for sample in samples if sample.head is not None]
                head = tuple(sum(point[i] for point in heads) / len(heads) for i in (0, 1)) if len(heads) >= config.seated_min_samples else None
                neck = math.degrees(math.atan2(head[0] - shoulder[0], shoulder[1] - head[1])) if head else None
                self._seated_reference = _UpperBody(at, shoulder, sum(s.width for s in samples) / count,
                                                   sum(s.tilt for s in samples) / count, head, neck)
                self._seated_samples.clear()

        reference = self._seated_reference
        tilt_change = self._angle_change(current.tilt, reference.tilt) if reference else None
        head_angle = self._angle_change(current.neck_angle, reference.neck_angle) if reference and current.neck_angle is not None and reference.neck_angle is not None else None
        head_drop = ((current.head[1] - current.shoulder[1]) - (reference.head[1] - reference.shoulder[1])) if reference and current.head and reference.head else None
        shoulder_drop = (current.shoulder[1] - reference.shoulder[1]) / reference.width if reference else 0.0
        reasons = []
        ratios = []
        if reference:
            for ratio, description in (
                (tilt_change / config.seated_tilt_angle, "shoulder tilt changed from the seated reference"),
                ((head_angle or 0.0) / config.seated_head_angle, "head-to-shoulder angle changed from the seated reference"),
                ((head_drop or 0.0) / reference.width / config.seated_head_drop, "head lowered relative to the shoulders"),
                (shoulder_drop / config.seated_shoulder_drop, "shoulder position lowered from the seated reference"),
            ):
                ratios.append(ratio)
                if ratio + 1e-9 >= 1:
                    reasons.append(description)
        deviation = max(ratios, default=0.0)
        tracked = [points[i] for i in (0, 11, 12) if self._visible(points[i])]
        visible = [point for point in points if self._visible(point)]
        box_height = max(p.y for p in visible) - min(p.y for p in visible)
        aspect = image_size[0] / image_size[1]
        box_ratio = (max(p.x for p in visible) - min(p.x for p in visible)) * aspect / box_height if box_height >= config.bbox_min_height else None
        features = PoseFeatures(at, None, None, None, box_ratio, min(p.visibility for p in tracked),
                                motion, head_drop, tilt_change, head_angle, deviation if reference else None)
        event = None
        if reference is None:
            self._clear_pending()
            message = f"Sit normally and hold steady for {config.seated_calibration_seconds:g}s; capturing your seated reference."
        elif not reasons:
            self._clear_pending()
            message = "Seated position saved. Watching shoulder tilt and head position; hips are not required."
        elif self._confirmed:
            message = "Check-in requested for a possible fall or posture change; cause unknown."
        elif cooldown > 0:
            self._clear_pending()
            message = "Posture change observed; event cooldown is active."
        else:
            if self.state != DetectionState.POSSIBLE_FALL:
                self.state = DetectionState.POSSIBLE_FALL
                self._hold_started = at
            elapsed = at - self._hold_started
            message = f"Abnormal seated posture: checking {min(elapsed, config.seated_hold_seconds):.1f}/{config.seated_hold_seconds:g}s."
            if elapsed + 1e-9 >= config.seated_hold_seconds:
                self.state = DetectionState.CONFIRMED_FALL
                self._confirmed = True
                self._cooldown_until = at + config.cooldown_seconds
                event = FallEvent(datetime.now(timezone.utc), EventType.POSSIBLE_FALL, features.visibility,
                                  None, at, "; ".join(reasons), tilt_change)
                message = "Possible fall or posture change. Are you okay?"
        required = config.seated_hold_seconds if self._hold_started is not None else 0.0
        elapsed = min(required, at - self._hold_started) if self._hold_started is not None else 0.0
        result = DetectionResult(self.state, features, points, True, elapsed, required,
                                 max(0.0, self._cooldown_until - at), event, self._confirmed, message)
        if event is not None:
            self._events.emit(event)
        return result

    def process_keypoints(self, keypoints: Sequence[Any] | None, timestamp: float,
                          image_size: tuple[int, int] = (1, 1)) -> DetectionResult:
        if self._closed:
            raise RuntimeError("Detector is closed")
        if not math.isfinite(timestamp) or (self._last_timestamp is not None and timestamp <= self._last_timestamp):
            raise ValueError("Timestamps must be finite and strictly increasing")
        if len(image_size) != 2 or any(not math.isfinite(v) or v <= 0 for v in image_size):
            raise ValueError("image_size must contain positive width and height")
        if self._last_timestamp is not None and timestamp - self._last_timestamp > self.config.max_frame_gap:
            self._history.clear()
            self._baseline.clear()
            self._seated_samples.clear()
            self._upper_history.clear()
            self._clear_pending()
        self._last_timestamp = timestamp
        points = None if keypoints is None else tuple(
            Keypoint(float(p.x), float(p.y), float(getattr(p, "z", 0.0)), float(getattr(p, "visibility", 0.0)))
            for p in keypoints
        )
        if self.config.mode == "seated":
            return self._process_seated(points, timestamp, image_size)
        features = self._features(points, timestamp, image_size) if points else None
        cooldown = max(0.0, self._cooldown_until - timestamp)
        if features is None:
            self._history.clear()
            self._baseline.clear()
            self._upper_history.clear()
            self._seated_samples.clear()
            self._clear_pending()
            return DetectionResult(self.state, None, points, False, cooldown_remaining=cooldown,
                                   message="Pose unavailable: show both shoulders and hips. Pending evidence cleared.")

        config = self.config
        head_changed = features.head_drop is not None and features.head_drop >= config.head_drop_threshold
        slumped = features.torso_angle >= config.slump_angle or head_changed
        upright = features.torso_angle <= config.upright_angle
        recovered = upright if self.state in (DetectionState.POSSIBLE_FALL, DetectionState.CONFIRMED_FALL) else not slumped
        if recovered:
            self._clear_pending()
        event = None
        if self._confirmed:
            pass  # One event for a continuous down/slumped episode.
        elif cooldown > 0:
            self._clear_pending()
        else:
            fall_signal = features.hip_drop > config.hip_drop_threshold or features.torso_angle > config.fall_angle
            if (fall_signal and not upright) or self.state == DetectionState.POSSIBLE_FALL:
                if self.state != DetectionState.POSSIBLE_FALL:
                    self.state = DetectionState.POSSIBLE_FALL
                    self._hold_started = timestamp
                if timestamp - self._hold_started + 1e-9 >= config.fall_hold_seconds:
                    self.state = DetectionState.CONFIRMED_FALL
                    event = self._confirm(EventType.FALL, features)
            elif slumped:
                if self.state != DetectionState.SLUMP:
                    self.state = DetectionState.SLUMP
                    self._hold_started = None
                if features.motion <= config.max_slump_motion:
                    if self._hold_started is None:
                        self._hold_started = timestamp
                    if timestamp - self._hold_started + 1e-9 >= config.slump_hold_seconds:
                        event = self._confirm(EventType.SLUMP, features)
                else:
                    self._hold_started = None
            else:
                self._clear_pending()
        required = config.fall_hold_seconds if self.state in (DetectionState.POSSIBLE_FALL, DetectionState.CONFIRMED_FALL) else config.slump_hold_seconds if self.state == DetectionState.SLUMP else 0.0
        elapsed = min(required, timestamp - self._hold_started) if self._hold_started is not None else 0.0
        message = "Possible movement event; cause unknown." if event else "Confirmed rule episode; waiting for recovery." if self._confirmed else "Checking sustained posture." if required else "Cooldown active." if cooldown > 0 else "Tracking."
        result = DetectionResult(self.state, features, points, True, elapsed, required,
                                 max(0.0, self._cooldown_until - timestamp), event, self._confirmed, message)
        if event is not None:
            self._events.emit(event)
        return result

    def _confirm(self, event_type: EventType, features: PoseFeatures) -> FallEvent:
        self._confirmed = True
        self._cooldown_until = features.timestamp + self.config.cooldown_seconds
        return FallEvent(datetime.now(timezone.utc), event_type, features.visibility,
                         features.torso_angle, features.timestamp)

    def _load_pose(self) -> Any:
        if self._pose_factory is not None:
            return self._pose_factory()
        try:
            import mediapipe as mp
        except ImportError as exc:
            raise RuntimeError("Install requirements.txt in Python 3.10–3.12 to use webcam inference") from exc
        if not hasattr(mp, "solutions"):
            raise RuntimeError("This module uses mediapipe==0.10.21 and Python 3.10–3.12 (legacy Pose)")
        package = Path(mp.__file__).resolve().parent
        for relative in ("modules/pose_landmark/pose_landmark_full.tflite",
                         "modules/pose_landmark/pose_landmark_cpu.binarypb",
                         "modules/pose_detection/pose_detection.tflite"):
            if not (package / relative).is_file():
                raise RuntimeError(f"Bundled MediaPipe asset missing: {relative}. Reinstall offline assets; no download attempted.")
        try:
            return mp.solutions.pose.Pose(static_image_mode=False, model_complexity=1,
                                         smooth_landmarks=True, enable_segmentation=False,
                                         min_detection_confidence=self.config.min_detection_confidence,
                                         min_tracking_confidence=self.config.min_tracking_confidence)
        except RuntimeError as exc:
            if "NSOpenGLPixelFormat" in str(exc) or "kGpuService" in str(exc):
                raise RuntimeError(
                    "MediaPipe could not create its graphics context. On macOS the legacy wheel may "
                    "need a regular logged-in desktop Terminal, even with --no-display; truly headless "
                    "hosts need a CPU-only MediaPipe build. No frame was saved."
                ) from exc
            raise

    def process_frame(self, frame: Any, timestamp: float | None = None) -> DetectionResult:
        if self._closed:
            raise RuntimeError("Detector is closed")
        import numpy as np
        import cv2
        if not isinstance(frame, np.ndarray) or frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8 or not frame.size:
            raise ValueError("Expected a nonempty uint8 BGR webcam frame with three channels")
        if self._pose is None:
            self._pose = self._load_pose()
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        pose = self._pose.process(rgb)
        landmarks = pose.pose_landmarks.landmark if pose.pose_landmarks else None
        return self.process_keypoints(landmarks, time.monotonic() if timestamp is None else timestamp,
                                      (frame.shape[1], frame.shape[0]))

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            if self._pose is not None:
                self._pose.close()
                self._pose = None
            self._history.clear()
            self._baseline.clear()
            self._upper_history.clear()
            self._seated_samples.clear()
            self._seated_reference = None

    def __enter__(self) -> FallDetector:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
