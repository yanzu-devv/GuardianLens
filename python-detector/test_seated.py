"""Synthetic upper-body checks: no hips, webcam, raw recordings, or SDK required."""
from __future__ import annotations

from dataclasses import replace
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import math
import unittest

from config import DetectorConfig
from check_in import CheckInPrompt
from detector import DetectionState, FallDetector, Keypoint
from events import EventType, FallEvent


def seated(*, tilt: float = 0, neck_angle: float = 0, head_drop: float = 0,
           shoulder_drop: float = 0, shift_x: float = 0, shift_y: float = 0,
           visibility: float = 0.95, short: bool = False) -> list[Keypoint]:
    """Head and shoulder geometry with all hip/leg confidence deliberately zero."""
    points = [Keypoint(0, 0, visibility=0) for _ in range(13 if short else 33)]
    roll = math.radians(tilt)
    center_x, center_y = 0.5 + shift_x, 0.55 + shoulder_drop + shift_y
    half_width = 0.16
    points[11] = Keypoint(center_x - half_width * math.cos(roll),
                          center_y - half_width * math.sin(roll), visibility=visibility)
    points[12] = Keypoint(center_x + half_width * math.cos(roll),
                          center_y + half_width * math.sin(roll), visibility=visibility)
    neck = math.radians(neck_angle)
    points[0] = Keypoint(center_x + 0.27 * math.sin(neck),
                         center_y - 0.27 * math.cos(neck) + head_drop, visibility=visibility)
    return points


class Sequence:
    def __init__(self, detector: FallDetector):
        self.detector = detector
        self.time = -0.1
        self.events = []
        detector.on_event(self.events.append)

    def frame(self, points, *, gap=0.1):
        self.time = round(self.time + gap, 8)
        return self.detector.process_keypoints(points, self.time)

    def hold(self, points, seconds):
        return [self.frame(points) for _ in range(round(seconds * 10))]

    def calibrate(self, points=None):
        output = self.hold(seated() if points is None else points, 2.0)[-1]
        if not output.pose_visible:
            raise AssertionError("Seated fixture should provide a usable upper-body view")
        return output


class SeatedDetectionTests(unittest.TestCase):
    def setUp(self):
        self.detector = FallDetector()
        self.sequence = Sequence(self.detector)
        self.addCleanup(self.detector.close)

    def test_seated_is_the_default_mode_and_hip_features_are_unavailable(self):
        self.assertEqual(self.detector.config.mode, "seated")
        output = self.sequence.calibrate()
        self.assertIsNone(output.features.torso_angle)
        self.assertIsNone(output.features.hip_y)
        self.assertIsNone(output.features.hip_drop)
        self.assertEqual(self.sequence.events, [])

    def test_thirteen_landmarks_are_enough_without_hips_or_legs(self):
        self.sequence.calibrate(seated(short=True))
        self.sequence.hold(seated(tilt=40, short=True), 2.5)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertEqual(self.sequence.events[0].type, EventType.POSSIBLE_FALL)

    def test_left_shoulder_tilt_prompts_after_the_hold(self):
        self._assert_tilt_prompts(-40)

    def test_right_shoulder_tilt_prompts_after_the_hold(self):
        self._assert_tilt_prompts(40)

    def _assert_tilt_prompts(self, tilt):
        self.sequence.calibrate()
        self.sequence.hold(seated(tilt=tilt), 1.8)
        self.assertEqual(self.sequence.events, [])
        outputs = self.sequence.hold(seated(tilt=tilt), 1.0)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertTrue(any(result.confirmed for result in outputs))
        event = self.sequence.events[0]
        self.assertEqual(event.type, EventType.POSSIBLE_FALL)
        self.assertIsNone(event.torso_angle)
        self.assertIsNotNone(event.shoulder_tilt)
        self.assertTrue(event.evidence)

    def test_personal_reference_accepts_naturally_uneven_shoulders(self):
        normal = seated(tilt=18)
        self.sequence.calibrate(normal)
        self.sequence.hold(normal, 10)
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(seated(tilt=50), 2.5)
        self.assertEqual(len(self.sequence.events), 1)

    def test_calibration_waits_for_shoulder_rotation_to_stop(self):
        for index in range(25):
            result = self.sequence.frame(seated(tilt=0 if index % 2 == 0 else 40))
            self.assertIsNone(result.features.posture_deviation,
                              "Moving shoulders must not become an averaged seated reference")
        stable = self.sequence.hold(seated(tilt=40), 2)[-1]
        self.assertIsNotNone(stable.features.posture_deviation)
        self.assertEqual(self.sequence.events, [])

    def test_a_tilt_below_the_configured_boundary_does_not_prompt(self):
        self.sequence.calibrate()
        self.sequence.hold(seated(tilt=24), 4)
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(seated(tilt=27), 2.5)
        self.assertEqual(len(self.sequence.events), 1)

    def test_forward_head_drop_with_level_shoulders_can_prompt(self):
        self.sequence.calibrate()
        self.sequence.hold(seated(head_drop=0.13), 2.5)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertEqual(self.sequence.events[0].type, EventType.POSSIBLE_FALL)
        self.assertIsNone(self.sequence.events[0].torso_angle)

    def test_sideways_head_neck_change_can_prompt_with_level_shoulders(self):
        self.sequence.calibrate()
        self.sequence.hold(seated(neck_angle=40), 2.5)
        self.assertEqual(len(self.sequence.events), 1)

    def test_sustained_abnormal_position_does_not_need_a_fast_drop(self):
        self.sequence.calibrate()
        for index in range(1, 31):
            self.sequence.frame(seated(tilt=40 * index / 30))
        self.sequence.hold(seated(tilt=40), 2.5)
        self.assertEqual(len(self.sequence.events), 1)

    def test_abnormal_position_does_not_need_complete_stillness(self):
        self.sequence.calibrate()
        for index in range(35):
            self.sequence.frame(seated(tilt=40, shift_x=0.035 * math.sin(index)))
        self.assertEqual(len(self.sequence.events), 1)

    def test_brief_abnormal_lean_recovers_without_a_prompt(self):
        self.sequence.calibrate()
        self.sequence.hold(seated(tilt=40), 1.3)
        recovered = self.sequence.hold(seated(), 4)[-1]
        self.assertEqual(self.sequence.events, [])
        self.assertEqual(recovered.state, DetectionState.NORMAL)

    def test_small_normal_movement_does_not_prompt(self):
        self.sequence.calibrate()
        for index in range(120):
            self.sequence.frame(seated(tilt=5 * math.sin(index / 10),
                                       shift_x=0.012 * math.sin(index / 7),
                                       shift_y=0.012 * math.cos(index / 8)))
        self.assertEqual(self.sequence.events, [])

    def test_each_shoulder_is_required_for_an_observed_pose(self):
        self.sequence.calibrate()
        for index in (11, 12):
            hidden = seated(tilt=40)
            hidden[index] = replace(hidden[index], visibility=0.1)
            outputs = self.sequence.hold(hidden, 3)
            self.assertTrue(all(not output.pose_visible for output in outputs))
        self.assertEqual(self.sequence.events, [])

    def test_shoulder_only_tracking_and_tilt_do_not_need_a_visible_nose(self):
        normal = seated()
        normal[0] = replace(normal[0], visibility=0)
        self.sequence.calibrate(normal)
        self.assertTrue(self.sequence.frame(normal).pose_visible)
        tilted = seated(tilt=40)
        tilted[0] = replace(tilted[0], visibility=0)
        self.sequence.hold(tilted, 2.5)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertEqual(self.sequence.events[0].type, EventType.POSSIBLE_FALL)

    def test_a_shoulder_only_reference_cannot_invent_head_drop_measurements(self):
        normal = seated()
        normal[0] = replace(normal[0], visibility=0)
        self.sequence.calibrate(normal)
        self.sequence.hold(seated(head_drop=0.13), 3)
        self.assertEqual(self.sequence.events, [])

    def test_leaving_and_returning_preserves_reference_without_counting_absence(self):
        self.sequence.calibrate()
        self.sequence.hold(seated(tilt=40), 1.0)
        self.sequence.hold(None, 5)
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(seated(tilt=40), 1.5)
        self.assertEqual(self.sequence.events, [], "Unobserved time must not complete the hold")
        self.sequence.hold(seated(tilt=40), 1.0)
        self.assertEqual(len(self.sequence.events), 1, "Returning should use the original reference")

    def test_long_frame_gap_cannot_complete_a_pending_check(self):
        self.sequence.calibrate()
        self.sequence.hold(seated(tilt=40), 1.0)
        result = self.sequence.frame(seated(tilt=40), gap=5)
        self.assertIsNone(result.event)
        self.assertLessEqual(result.hold_elapsed, 0.1)
        self.sequence.hold(seated(tilt=40), 1.4)
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(seated(tilt=40), 1.0)
        self.assertEqual(len(self.sequence.events), 1)

    def test_a_missing_person_alone_never_prompts(self):
        self.sequence.calibrate()
        self.sequence.hold(None, 40)
        self.assertEqual(self.sequence.events, [])
        self.sequence.hold(seated(), 3)
        self.assertEqual(self.sequence.events, [])

    def test_cooldown_and_continuous_episode_do_not_repeat_the_question(self):
        self.sequence.calibrate()
        self.sequence.hold(seated(tilt=40), 4)
        self.assertEqual(len(self.sequence.events), 1)
        first_time = self.sequence.events[0].source_time
        self.sequence.hold(seated(tilt=40), 32)
        self.assertEqual(len(self.sequence.events), 1)
        self.sequence.hold(seated(), 1)
        self.sequence.hold(seated(tilt=40), 2.5)
        self.assertEqual(len(self.sequence.events), 2)
        self.assertGreater(self.sequence.events[1].source_time - first_time, 30)

    def test_confidence_uses_the_required_head_and_shoulders_only(self):
        self.sequence.calibrate()
        points = seated(tilt=40)
        points[0] = replace(points[0], visibility=0.72)
        self.sequence.hold(points, 2.5)
        self.assertEqual(len(self.sequence.events), 1)
        self.assertAlmostEqual(self.sequence.events[0].confidence, 0.72)

    def test_reset_requires_a_new_personal_reference(self):
        self.sequence.calibrate()
        self.detector.reset()
        self.sequence.hold(seated(tilt=40), 4)
        self.assertEqual(self.sequence.events, [], "An explicit reset starts a new baseline")


class CheckInTests(unittest.TestCase):
    def event(self):
        return FallEvent(datetime.now(timezone.utc), EventType.POSSIBLE_FALL, 0.9, None, 2.5)

    def test_detector_callback_opens_the_question_and_okay_records_a_response(self):
        prompt = CheckInPrompt()
        with FallDetector() as detector, redirect_stdout(io.StringIO()) as output:
            sequence = Sequence(detector)
            detector.on_event(prompt.on_event)
            sequence.calibrate()
            sequence.hold(seated(tilt=40), 2.5)
            self.assertTrue(prompt.active)
            self.assertIn("Are you okay?", prompt.message)
            prompt.respond("okay")
            self.assertFalse(prompt.active)
            self.assertEqual(prompt.response, "okay")
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(messages[0]["question"], "Are you okay?")
        self.assertFalse(messages[0]["help_dispatched"])
        self.assertEqual(messages[-1]["check_in_response"], "okay")

    def test_help_response_never_claims_a_contact_or_dispatch(self):
        prompt = CheckInPrompt()
        with redirect_stdout(io.StringIO()) as output:
            prompt.on_event(self.event())
            message = prompt.respond("help")
        self.assertIn("no help was dispatched", message)
        self.assertFalse(prompt.active)
        response = json.loads(output.getvalue().splitlines()[-1])
        self.assertFalse(response["help_dispatched"])

    def test_headless_question_is_nonblocking_and_does_not_advertise_gui_keys(self):
        prompt = CheckInPrompt(interactive=False)
        with redirect_stdout(io.StringIO()) as output:
            prompt.on_event(self.event())
            prompt.on_event(self.event())
        messages = output.getvalue().splitlines()
        self.assertEqual(len(messages), 1)
        self.assertEqual(json.loads(messages[0])["response_keys"], {})

    def test_invalid_and_inactive_responses_cannot_create_a_check_in(self):
        prompt = CheckInPrompt()
        self.assertIsNone(prompt.respond("okay"))
        with self.assertRaises(ValueError):
            prompt.respond("dispatch")
        self.assertFalse(prompt.active)


if __name__ == "__main__":
    unittest.main(verbosity=2)
