"""Local webcam/clip runner. It never records images or video."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import csv
from dataclasses import replace
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sys
import time
import textwrap
from typing import Any


# MediaPipe's standard Pose connections. Drawing does not run another model.
POSE_CONNECTIONS = (
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6),
    (6, 8), (9, 10), (11, 12), (11, 13), (13, 15), (15, 17),
    (15, 19), (15, 21), (17, 19), (12, 14), (14, 16), (16, 18),
    (16, 20), (16, 22), (18, 20), (11, 23), (12, 24), (23, 24),
    (23, 25), (24, 26), (25, 27), (26, 28), (27, 29), (28, 30),
    (29, 31), (30, 32), (27, 31), (28, 32),
)

CSV_FIELDS = (
    "frame_index", "source_time", "state", "pose_visible", "confirmed",
    "hold_elapsed", "hold_required", "cooldown_remaining", "torso_angle",
    "hip_y", "hip_drop", "aspect_ratio", "visibility", "motion", "head_drop",
    "shoulder_tilt", "head_shoulder_angle", "posture_deviation", "event_type",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="GuardianLens: local fall/slump rules and check-in; no video recording or calls."
    )
    parser.add_argument("--camera", type=int, default=0, help="Webcam index (default: 0).")
    parser.add_argument("--video", type=Path, help="Read an existing local clip instead of a webcam.")
    parser.add_argument("--fps", type=float, help="Override clip FPS if metadata is missing or incorrect.")
    parser.add_argument("--config", type=Path, help="JSON overrides for DetectorConfig.")
    parser.add_argument("--mode", choices=("seated", "full_body"), help="Override config mode (default: seated).")
    parser.add_argument("--debug", action="store_true", help="Show feature values and write a features-only CSV.")
    parser.add_argument("--csv", type=Path, help="New CSV output path; requires --debug and must not exist.")
    parser.add_argument("--no-display", action="store_true", help="Disable all GUI calls; use Ctrl+C to quit a webcam run.")
    return parser


def _event_type(value: Any) -> str:
    return str(getattr(value, "value", value))


def print_event(event: Any) -> None:
    """A demo callback only. Plug alerting into a separate subscriber."""
    print(json.dumps({
        "timestamp": event.timestamp.isoformat(),
        "type": _event_type(event.type),
        "confidence": round(event.confidence, 3),
        "torso_angle": round(event.torso_angle, 2) if event.torso_angle is not None else None,
        "shoulder_tilt": round(event.shoulder_tilt, 2) if getattr(event, "shoulder_tilt", None) is not None else None,
        "evidence": getattr(event, "evidence", ""),
        "source_time": round(event.source_time, 3),
    }), flush=True)


def _feature_row(frame_index: int, result: Any, source_time: float | None = None) -> dict[str, Any]:
    row: dict[str, Any] = {
        "frame_index": frame_index,
        "source_time": source_time,
        "state": _event_type(result.state),
        "pose_visible": result.pose_visible,
        "confirmed": result.confirmed,
        "hold_elapsed": round(result.hold_elapsed, 4),
        "hold_required": round(result.hold_required, 4),
        "cooldown_remaining": round(result.cooldown_remaining, 4),
        "event_type": _event_type(result.event.type) if result.event else "",
    }
    if result.features is not None:
        row["source_time"] = result.features.timestamp
        for name in ("torso_angle", "hip_y", "hip_drop", "aspect_ratio", "visibility", "motion", "head_drop",
                     "shoulder_tilt", "head_shoulder_angle", "posture_deviation"):
            value = getattr(result.features, name, None)
            row[name] = round(value, 6) if value is not None else ""
    return row


def _number(value: float | None, digits: int = 2) -> str:
    return "--" if value is None else f"{value:.{digits}f}"


def draw_overlay(frame: Any, result: Any, cv2: Any, visibility_threshold: float, debug: bool,
                 prompt: Any = None, mode: str | None = None) -> None:
    """Draw into the in-memory display frame only; no encoding or file writes."""
    height, width = frame.shape[:2]
    points = result.landmarks
    if points:
        def pixel(index: int) -> tuple[int, int] | None:
            if index >= len(points):
                return None
            point = points[index]
            if point.visibility < visibility_threshold or not all(math.isfinite(v) for v in (point.x, point.y)):
                return None
            if not (0 <= point.x <= 1 and 0 <= point.y <= 1):
                return None
            return min(width - 1, int(point.x * width)), min(height - 1, int(point.y * height))

        connections = ((11, 12),) if mode == "seated" else POSE_CONNECTIONS
        for start, end in connections:
            a, b = pixel(start), pixel(end)
            if a is not None and b is not None:
                cv2.line(frame, a, b, (59, 255, 182), 2)
        for index in range(min(13, len(points)) if mode == "seated" else len(points)):
            point = pixel(index)
            if point is not None:
                cv2.circle(frame, point, 3, (59, 255, 182), -1)

    features = result.features
    shoulder_tilt = getattr(features, "shoulder_tilt", None) if features else None
    seated_completed = shoulder_tilt is not None and result.confirmed
    lines = [
        "GuardianLens | Check-in requested" if seated_completed else f"GuardianLens | {_event_type(result.state)}" + (" | rule completed" if result.confirmed else ""),
        f"Torso: {_number(features.torso_angle if features else None, 1)} deg",
        f"Hold: {result.hold_elapsed:.1f}/{result.hold_required:.1f}s" if result.hold_required else "Hold: --",
        f"Cooldown: {result.cooldown_remaining:.1f}s | q: quit",
    ]
    if shoulder_tilt is not None:
        lines[1] = f"Shoulder tilt change: {_number(shoulder_tilt, 1)} deg | hips not required"
    if getattr(result, "message", ""):
        lines.extend(textwrap.wrap(result.message, width=max(20, width // 8)))
    if prompt is not None and prompt.active:
        lines[1:1] = ["POSSIBLE FALL / POSTURE CHANGE", "ARE YOU OKAY?  O: I'm okay | H: Need help"]
    elif prompt is not None and prompt.message:
        lines.extend(textwrap.wrap(prompt.message, width=max(20, width // 8)))
    if debug:
        lines.extend([
            f"Hip y: {_number(features.hip_y if features else None, 3)}  drop: {_number(features.hip_drop if features else None, 3)}",
            f"Aspect: {_number(features.aspect_ratio if features else None)}  visibility: {_number(features.visibility if features else None)}",
            f"Motion: {_number(features.motion if features else None, 3)}  head drop: {_number(features.head_drop if features else None, 3)}",
            f"Head angle: {_number(getattr(features, 'head_shoulder_angle', None) if features else None, 1)}  posture delta: {_number(getattr(features, 'posture_deviation', None) if features else None, 3)}",
        ])
    if not result.pose_visible:
        lines.append("Pose not clear: pending evidence is reset")
    cv2.rectangle(frame, (0, 0), (width, min(height, 12 + 23 * len(lines))), (15, 22, 16), -1)
    for index, text in enumerate(lines):
        color = (100, 210, 255) if prompt is not None and prompt.active and index in (1, 2) else (235, 245, 235)
        cv2.putText(frame, text, (10, 23 + index * 23), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv2.LINE_AA)


def run(args: argparse.Namespace) -> int:
    # Delay dependencies until after argument parsing so --help always works.
    import cv2
    from config import DetectorConfig
    from detector import FallDetector
    from check_in import CheckInPrompt

    config = DetectorConfig.from_json(args.config) if args.config else DetectorConfig()
    if getattr(args, "mode", None) is not None:
        config = replace(config, mode=args.mode)
    video = args.video.expanduser().resolve(strict=True) if args.video else None
    if video is not None and not video.is_file():
        raise ValueError("--video must name an existing local regular file.")
    output = args.csv.expanduser().resolve() if args.csv else None
    if args.debug and output is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        output = Path(f"features-{stamp}.csv").resolve()
    if output is not None and video is not None and output == video:
        raise ValueError("The feature CSV cannot overwrite the input video.")

    with ExitStack() as stack:
        # A video argument has already been resolved and checked as a local file.
        if video:
            # Local playlists may contain remote URLs. Restrict nested protocols.
            old_options = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "protocol_whitelist;file,crypto,data"
            try:
                capture = cv2.VideoCapture(str(video), cv2.CAP_FFMPEG)
            finally:
                if old_options is None:
                    os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
                else:
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = old_options
        else:
            capture = cv2.VideoCapture(args.camera)
        stack.callback(capture.release)
        if not capture.isOpened():
            raise RuntimeError("Cannot open the local video. An FFmpeg-enabled OpenCV build is required; network protocols are disabled." if video else "Cannot open the webcam. Check its index and camera permission.")

        fps = args.fps or (float(capture.get(cv2.CAP_PROP_FPS)) if video else None)
        if video and (fps is None or not math.isfinite(fps) or fps <= 0):
            raise ValueError("The clip has no usable FPS metadata. Pass its correct frame rate with --fps.")
        detector = stack.enter_context(FallDetector(config))
        detector.on_event(print_event)
        prompt = CheckInPrompt(interactive=not args.no_display)
        detector.on_event(prompt.on_event)

        writer = None
        feature_file = None
        if output is not None:
            # Exclusive creation also prevents overwriting existing files/hardlinks.
            feature_file = stack.enter_context(output.open("x", encoding="utf-8", newline=""))
            writer = csv.DictWriter(feature_file, fieldnames=CSV_FIELDS)
            writer.writeheader()
            print(f"Feature-only CSV: {output}", file=sys.stderr)
        if not args.no_display:
            cv2.namedWindow("GuardianLens", cv2.WINDOW_NORMAL)
            stack.callback(cv2.destroyAllWindows)

        frame_index = 0
        try:
            while True:
                available, frame = capture.read()
                if not available:
                    if video and frame_index:
                        break
                    raise RuntimeError("No decodable video frames." if video else "The webcam stopped returning frames.")
                # Recorded clips use source time, even when processed faster than real time.
                timestamp = frame_index / fps if video else time.monotonic()
                result = detector.process_frame(frame, timestamp=timestamp)
                if writer is not None:
                    writer.writerow(_feature_row(frame_index, result, timestamp))
                    feature_file.flush()
                frame_index += 1
                if not args.no_display:
                    draw_overlay(frame, result, cv2, config.visibility_threshold, args.debug, prompt, config.mode)
                    cv2.imshow("GuardianLens", frame)
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord("q"):
                        break
                    if key in (ord("o"), ord("h")):
                        prompt.respond("okay" if key == ord("o") else "help")
        except KeyboardInterrupt:
            print("Stopped. Camera and local model released.", file=sys.stderr)
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.camera < 0:
        parser.error("--camera must be a non-negative device index.")
    if args.fps is not None and (not math.isfinite(args.fps) or args.fps <= 0 or not args.video):
        parser.error("--fps requires --video and a positive, finite frame rate.")
    if args.csv and not args.debug:
        parser.error("--csv requires --debug; normal runs never write feature logs.")
    try:
        return run(args)
    except ImportError as error:
        print(f"GuardianLens dependency error: {error}. Use Python 3.10-3.12 and install requirements.txt.", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"GuardianLens: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
