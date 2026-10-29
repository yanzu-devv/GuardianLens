"""Integration contracts using in-memory frames and fake capture/Pose results.

No webcam is opened, no video is written, and no model is downloaded.
Run after installing requirements: python -m unittest test_runtime -v
"""
from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

try:
    import numpy as np
    import cv2
except ImportError:
    np = cv2 = None

from config import DetectorConfig
from detector import FallDetector
from test_synthetic import person
import main


class ConfigTests(unittest.TestCase):
    def test_invalid_and_nonfinite_thresholds_fail_early(self):
        for change in ({"fall_hold_seconds": 0}, {"cooldown_seconds": -1},
                       {"visibility_threshold": float("nan")}, {"model_complexity": 0},
                       {"slump_angle": 80}, {"baseline_min_samples": 2.5}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                DetectorConfig(**change)

    def test_unknown_json_field_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text('{"fall_hold_second": 4}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Unknown"):
                DetectorConfig.from_json(path)


@unittest.skipIf(np is None or cv2 is None, "Install requirements.txt for frame integration tests")
class RuntimeTests(unittest.TestCase):
    def test_process_frame_converts_bgr_without_retaining_or_mutating_input(self):
        class FakePose:
            closed = False
            def process(self, rgb):
                self_pixel = tuple(int(value) for value in rgb[0, 0])
                if self_pixel != (30, 20, 10) or rgb.flags.writeable:
                    raise AssertionError("Expected read-only RGB input")
                return SimpleNamespace(pose_landmarks=SimpleNamespace(landmark=person()))
            def close(self):
                self.closed = True

        pose = FakePose()
        frame = np.full((48, 64, 3), [10, 20, 30], dtype=np.uint8)
        with FallDetector(pose_factory=lambda: pose) as detector:
            result = detector.process_frame(frame, timestamp=0)
            self.assertTrue(result.pose_visible)
            self.assertEqual(tuple(frame[0, 0]), (10, 20, 30))
            self.assertFalse(any(isinstance(value, np.ndarray) for value in vars(detector).values()))
        self.assertTrue(pose.closed)

    def test_invalid_frame_fails_before_loading_model(self):
        with FallDetector(pose_factory=lambda: self.fail("Should not load the model")) as detector:
            with self.assertRaises(ValueError):
                detector.process_frame(np.zeros((4, 4), dtype=np.uint8))

    def test_clip_runner_is_headless_and_uses_source_time_without_writing_frames(self):
        class FakeCapture:
            def __init__(self):
                self.index = 0
                self.released = False
            def isOpened(self): return True
            def get(self, key): return 10.0
            def read(self):
                self.index += 1
                return (True, np.zeros((8, 8, 3), dtype=np.uint8)) if self.index <= 3 else (False, None)
            def release(self): self.released = True

        seen = []
        class FakeDetector:
            def __init__(self, config): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def on_event(self, callback): pass
            def process_frame(self, frame, timestamp=None):
                seen.append(timestamp)
                with FallDetector() as detector:
                    result = detector.process_keypoints(person(), timestamp)
                return result

        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "input.mp4"
            clip.touch()  # Empty fixture; FakeCapture supplies frames entirely in memory.
            output = Path(directory) / "features.csv"
            args = argparse.Namespace(config=None, video=clip, camera=0, fps=None,
                                      debug=False, csv=None, no_display=True)
            capture = FakeCapture()
            open_calls = []
            def open_capture(*arguments):
                open_calls.append((arguments, os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")))
                return capture
            with patch.object(cv2, "VideoCapture", side_effect=open_capture), \
                 patch("detector.FallDetector", FakeDetector), \
                 patch.object(cv2, "namedWindow", side_effect=AssertionError("GUI call")), \
                 patch.object(cv2, "waitKey", side_effect=AssertionError("GUI call")), \
                 patch.object(cv2, "imwrite", side_effect=AssertionError("Frame write")), \
                 patch.object(cv2, "VideoWriter", side_effect=AssertionError("Video write")):
                self.assertEqual(main.run(args), 0)
            self.assertEqual(seen, [0.0, 0.1, 0.2])
            self.assertEqual(open_calls, [((str(clip.resolve()), cv2.CAP_FFMPEG), "protocol_whitelist;file,crypto,data")])
            self.assertTrue(capture.released)
            self.assertEqual(list(Path(directory).iterdir()), [clip])
            seen.clear()
            args.debug, args.csv = True, output
            capture = FakeCapture()
            with patch.object(cv2, "VideoCapture", return_value=capture), patch("detector.FallDetector", FakeDetector):
                self.assertEqual(main.run(args), 0)
            with output.open(newline="", encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                rows = list(reader)
                self.assertEqual(set(reader.fieldnames), set(main.CSV_FIELDS))
            self.assertEqual(len(rows), 3)
            self.assertEqual([row["source_time"] for row in rows], ["0.0", "0.1", "0.2"])
            self.assertEqual(set(Path(directory).iterdir()), {clip, output})
            with patch.object(cv2, "VideoCapture", return_value=FakeCapture()), patch("detector.FallDetector", FakeDetector):
                with self.assertRaises(FileExistsError):
                    main.run(args)
            args.csv = clip
            with self.assertRaisesRegex(ValueError, "cannot overwrite"):
                main.run(args)

    def test_invalid_pose_debug_row_keeps_source_timestamp(self):
        with FallDetector() as detector:
            result = detector.process_keypoints(None, 1.25)
        row = main._feature_row(5, result, 1.25)
        self.assertEqual(row["source_time"], 1.25)
        self.assertNotIn("landmarks", row)
        self.assertNotIn("frame", row)


if __name__ == "__main__":
    unittest.main(verbosity=2)
