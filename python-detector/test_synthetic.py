"""Synthetic rule/state tests. These are not real-world accuracy measurements.

Run with ``python test_synthetic.py``; no webcam, model, or GUI is needed.
"""

from __future__ import annotations

import math
import unittest
from dataclasses import replace

from config import DetectorConfig
from detector import DetectionState, FallDetector, Keypoint


def person(
    angle: float = 0.0,
    hip_y: float = 0.55,
    head_drop: float = 0.0,
    visibility: float = 0.95,
    shift_x: float = 0.0,
) -> list[Keypoint]:
    """One geometrically consistent person with an optional head-only droop."""
    radians = math.radians(angle)
    up_x, up_y = math.sin(radians), -math.cos(radians)
    side_x, side_y = math.cos(radians), math.sin(radians)
    hip_x = 0.5 + shift_x
    shoulder_x, shoulder_y = hip_x + 0.25 * up_x, hip_y + 0.25 * up_y
    nose_x = shoulder_x + 0.16 * up_x
    nose_y = shoulder_y + 0.16 * up_y + head_drop
    points = [Keypoint(0.5, 0.5, visibility=0.0) for _ in range(33)]

    def point(x: float, y: float) -> Keypoint:
        return Keypoint(x, y, visibility=visibility)

    points[0] = point(nose_x, nose_y)
    points[7] = point(nose_x - 0.035 * side_x, nose_y - 0.035 * side_y)
    points[8] = point(nose_x + 0.035 * side_x, nose_y + 0.035 * side_y)
    for left, right, center_x, center_y, half_width in (
        (11, 12, shoulder_x, shoulder_y, 0.06),
        (23, 24, hip_x, hip_y, 0.05),
        (25, 26, hip_x - 0.15 * up_x, hip_y - 0.15 * up_y, 0.04),
        (27, 28, hip_x - 0.30 * up_x, hip_y - 0.30 * up_y, 0.04),
    ):
        points[left] = point(center_x - half_width * side_x, center_y - half_width * side_y)
        points[right] = point(center_x + half_width * side_x, center_y + half_width * side_y)
    return points


class Sequence:
    """A deterministic 10 Hz source clock, independent of test execution speed."""

    def __init__(self, detector: FallDetector):
        self.detector = detector
        self.time = -0.1
        self.outputs = []
        self.events = []
        detector.on_event(self.events.append)

    def frame(self, points: list[Keypoint] | None, *, gap: float = 0.1):
        self.time = round(self.time + gap, 8)
        result = self.detector.process_keypoints(points, self.time)
        self.outputs.append(result)
        return result

    def hold(self, points: list[Keypoint] | None, seconds: float):
        return [self.frame(points) for _ in range(round(seconds * 10))]

    def upright(self, seconds: float = 2.0):
        return self.hold(person(), seconds)


class SyntheticDetectionTests(unittest.TestCase):
    def setUp(self):
        self.detector = FallDetector(DetectorConfig(mode="full_body"))
        self.sequence = Sequence(self.detector)
        self.addCleanup(self.detector.close)

    def test_upright_remains_normal_without_an_event(self):
        outputs = self.sequence.upright(12)
        self.assertTrue(all(result.state is DetectionState.NORMAL for result in outputs))
        self.assertEqual(self.sequence.events, [])
        self.assertAlmostEqual(outputs[-1].features.torso_angle, 0.0)

    def test_quick_fall_requires_four_seconds_then_emits_once(self):
        self.sequence.upright()
        first = self.sequence.frame(person(angle=80, hip_y=0.76))
        self.assertEqual(first.state, DetectionState.POSSIBLE_FALL)
        self.assertGreater(first.features.hip_drop, 0.15)
        self.sequence.hold(person(angle=80, hip_y=0.76), 3.8)
        self.assertEqual(self.sequence.events, [])
        outputs = self.sequence.hold(person(angle=80, hip_y=0.76), 5.0)
        self.assertEqual(outputs[-1].state, DetectionState.CONFIRMED_FALL)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertEqual(self.sequence.events[0].type.value, "FALL")

    def test_rapid_hip_drop_can_trigger_below_the_sixty_degree_angle(self):
        self.sequence.upright()
        first = self.sequence.frame(person(angle=45, hip_y=0.76))
        self.assertEqual(first.state, DetectionState.POSSIBLE_FALL)
        self.sequence.hold(person(angle=45, hip_y=0.76), 4.5)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertEqual(self.sequence.events[0].type.value, "FALL")

    def test_slow_sit_with_upright_torso_does_not_alert(self):
        self.sequence.upright()
        for index in range(1, 31):
            result = self.sequence.frame(person(hip_y=0.55 + 0.23 * index / 30))
            self.assertEqual(result.state, DetectionState.NORMAL)
        self.sequence.hold(person(hip_y=0.78), 10)
        self.assertEqual(self.sequence.events, [])

    def test_picking_something_up_then_recovering_cancels_a_possible_fall(self):
        self.sequence.upright()
        self.sequence.hold(person(angle=75), 2.0)
        recovered = self.sequence.upright(2.0)[-1]
        self.assertEqual(recovered.state, DetectionState.NORMAL)
        self.assertEqual(self.sequence.events, [])
        self.assertEqual(recovered.hold_elapsed, 0.0)

    def test_recovery_before_four_seconds_cancels_a_quick_fall(self):
        self.sequence.upright()
        self.sequence.hold(person(angle=80, hip_y=0.76), 3.5)
        recovered = self.sequence.upright(1.0)[-1]
        self.assertEqual(recovered.state, DetectionState.NORMAL)
        self.assertEqual(self.sequence.events, [])

    def test_gradual_slump_needs_a_long_quiet_hold(self):
        self.sequence.upright()
        for index in range(1, 51):
            self.sequence.frame(person(angle=45 * index / 50))
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(person(angle=45), 6.0)
        self.assertEqual(self.sequence.events, [])
        last = self.sequence.hold(person(angle=45), 4.0)[-1]
        self.assertEqual(last.state, DetectionState.SLUMP)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertEqual(self.sequence.events[0].type.value, "SLUMP")

    def test_head_only_slump_uses_a_stable_upright_reference(self):
        self.sequence.upright()
        for index in range(1, 51):
            self.sequence.frame(person(head_drop=0.13 * index / 50))
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(person(head_drop=0.13), 9.0)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertEqual(self.sequence.events[0].type.value, "SLUMP")
        self.assertAlmostEqual(self.sequence.events[0].torso_angle, 0.0)

    def test_sustained_motion_resets_the_slump_quiet_timer(self):
        self.sequence.upright()
        for index in range(150):
            self.sequence.frame(person(angle=45, shift_x=0.035 * math.sin(index)))
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(person(angle=45), 9.0)
        self.assertEqual(len(self.sequence.events), 1)

    def test_slump_recovery_cancels_the_hold(self):
        self.sequence.upright()
        self.sequence.hold(person(angle=45), 5.0)
        last = self.sequence.upright(2.0)[-1]
        self.assertEqual(last.state, DetectionState.NORMAL)
        self.assertEqual(self.sequence.events, [])

    def test_low_confidence_frames_cannot_accumulate_a_fall_hold(self):
        self.sequence.upright()
        self.sequence.hold(person(angle=80, hip_y=0.76), 2.0)
        hidden = person(angle=80, hip_y=0.76)
        hidden[11] = replace(hidden[11], visibility=0.1)
        ignored = self.sequence.hold(hidden, 5.0)
        self.assertTrue(all(not result.pose_visible for result in ignored))
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(person(angle=80, hip_y=0.76), 3.0)
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(person(angle=80, hip_y=0.76), 2.0)
        self.assertEqual(len(self.sequence.events), 1)

    def test_missing_person_does_not_become_a_fall(self):
        self.sequence.upright()
        missing = self.sequence.hold(None, 12)
        self.assertEqual(self.sequence.events, [])
        self.assertTrue(all(not result.pose_visible for result in missing))
        self.assertEqual(self.sequence.upright()[-1].state, DetectionState.NORMAL)

    def test_frame_gap_does_not_count_as_observed_down_time(self):
        self.sequence.upright()
        self.sequence.hold(person(angle=80, hip_y=0.76), 2.0)
        after_gap = self.sequence.frame(person(angle=80, hip_y=0.76), gap=10)
        self.assertIsNone(after_gap.event)
        self.assertLessEqual(after_gap.hold_elapsed, 0.1)
        self.sequence.hold(person(angle=80, hip_y=0.76), 3.0)
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(person(angle=80, hip_y=0.76), 2.0)
        self.assertEqual(len(self.sequence.events), 1)

    def test_cooldown_blocks_a_second_event_and_then_allows_a_new_fall(self):
        self.sequence.upright()
        self.sequence.hold(person(angle=80, hip_y=0.76), 4.5)
        first_event_time = self.sequence.events[0].source_time
        self.sequence.upright(1.0)
        self.sequence.hold(person(angle=80, hip_y=0.76), 5.0)
        self.assertEqual(len(self.sequence.events), 1)
        while self.sequence.time < first_event_time + 31:
            self.sequence.frame(person())
        self.sequence.hold(person(angle=80, hip_y=0.76), 4.5)
        self.assertEqual(len(self.sequence.events), 2)

    def test_an_event_has_source_time_utc_time_and_a_bounded_visibility_score(self):
        self.sequence.upright()
        outputs = self.sequence.hold(person(angle=80, hip_y=0.76, visibility=0.9), 4.5)
        event_result = next(result for result in outputs if result.event is not None)
        event = event_result.event
        self.assertIsNotNone(event.timestamp.tzinfo)
        self.assertEqual(event.timestamp.utcoffset().total_seconds(), 0)
        self.assertEqual(event.source_time, event_result.features.timestamp)
        self.assertGreaterEqual(event.confidence, 0.0)
        self.assertLessEqual(event.confidence, 1.0)
        self.assertAlmostEqual(event.confidence, 0.9)

    def test_non_square_frames_use_pixel_geometry_for_torso_angle(self):
        result = self.detector.process_keypoints(person(angle=45), 0.0, image_size=(640, 480))
        expected = math.degrees(math.atan2(640, 480))
        self.assertAlmostEqual(result.features.torso_angle, expected, places=5)

    def test_invisible_outlier_does_not_distort_the_person_box(self):
        original = person()
        first = self.detector.process_keypoints(original, 0.0)
        with_outlier = list(original)
        with_outlier[31] = Keypoint(1.0, 0.0, visibility=0.01)
        second = self.detector.process_keypoints(with_outlier, 0.1)
        self.assertAlmostEqual(first.features.aspect_ratio, second.features.aspect_ratio)

    def test_non_monotonic_or_non_finite_source_time_is_rejected(self):
        self.detector.process_keypoints(person(), 1.0)
        for value in (1.0, 0.5, float("nan"), float("inf")):
            with self.subTest(timestamp=value):
                with self.assertRaises(ValueError):
                    self.detector.process_keypoints(person(), value)


if __name__ == "__main__":
    unittest.main(verbosity=2)
