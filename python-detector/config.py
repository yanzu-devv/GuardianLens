"""All tunable detector thresholds. Units are seconds, degrees, or image fractions."""
from __future__ import annotations

from dataclasses import dataclass, fields
import json
import math
from pathlib import Path


@dataclass(frozen=True)
class DetectorConfig:
    mode: str = "seated"
    visibility_threshold: float = 0.6
    hip_drop_threshold: float = 0.15
    hip_drop_window: float = 0.5
    fall_angle: float = 60.0
    upright_angle: float = 25.0
    fall_hold_seconds: float = 4.0
    slump_angle: float = 35.0
    head_drop_threshold: float = 0.10
    slump_hold_seconds: float = 8.0
    motion_window: float = 0.5
    max_slump_motion: float = 0.025
    cooldown_seconds: float = 30.0
    max_frame_gap: float = 0.6
    baseline_seconds: float = 0.75
    baseline_min_samples: int = 3
    bbox_min_height: float = 0.02
    min_torso_length: float = 0.03
    min_detection_confidence: float = 0.5
    min_tracking_confidence: float = 0.5
    # The full model is bundled in the pinned MediaPipe wheel. Lite/heavy may download.
    model_complexity: int = 1
    seated_calibration_seconds: float = 1.0
    seated_min_samples: int = 5
    seated_calibration_motion: float = 0.06
    seated_calibration_tilt: float = 5.0
    seated_tilt_angle: float = 25.0
    seated_head_angle: float = 25.0
    seated_head_drop: float = 0.30
    seated_shoulder_drop: float = 0.35
    seated_hold_seconds: float = 2.0
    seated_min_shoulder_width: float = 0.06

    def __post_init__(self) -> None:
        if self.mode not in ("seated", "full_body"):
            raise ValueError("mode must be seated or full_body")
        for field in fields(self):
            if field.name == "mode":
                continue
            value = getattr(self, field.name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{field.name} must be a finite number")
        for name in ("visibility_threshold", "min_detection_confidence", "min_tracking_confidence"):
            if not 0 < getattr(self, name) <= 1:
                raise ValueError(f"{name} must be in (0, 1]")
        if not 0 <= self.upright_angle < self.slump_angle < self.fall_angle <= 180:
            raise ValueError("Require 0 <= upright_angle < slump_angle < fall_angle <= 180")
        for name in ("hip_drop_threshold", "hip_drop_window", "fall_hold_seconds", "head_drop_threshold",
                     "slump_hold_seconds", "motion_window", "max_slump_motion", "max_frame_gap",
                     "baseline_seconds", "bbox_min_height", "min_torso_length"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        for name in ("seated_calibration_seconds", "seated_calibration_motion", "seated_calibration_tilt", "seated_tilt_angle",
                     "seated_head_angle", "seated_head_drop", "seated_shoulder_drop", "seated_hold_seconds",
                     "seated_min_shoulder_width"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        if self.seated_calibration_tilt >= 90 or self.seated_tilt_angle >= 90 or self.seated_head_angle >= 180:
            raise ValueError("seated_tilt_angle must be <90 and seated_head_angle <180 degrees")
        if not isinstance(self.seated_min_samples, int) or self.seated_min_samples < 2:
            raise ValueError("seated_min_samples must be an integer >=2")
        if self.cooldown_seconds < 0:
            raise ValueError("cooldown_seconds cannot be negative")
        if not isinstance(self.baseline_min_samples, int) or self.baseline_min_samples < 2:
            raise ValueError("baseline_min_samples must be an integer >= 2")
        if self.model_complexity != 1:
            raise ValueError("Use model_complexity=1: its bundled model requires no runtime download")

    @classmethod
    def from_json(cls, path: str | Path) -> DetectorConfig:
        with Path(path).open(encoding="utf-8") as handle:
            values = json.load(handle)
        if not isinstance(values, dict):
            raise ValueError("Configuration must be a JSON object")
        unknown = set(values) - {field.name for field in fields(cls)}
        if unknown:
            raise ValueError(f"Unknown configuration fields: {', '.join(sorted(unknown))}")
        return cls(**values)
