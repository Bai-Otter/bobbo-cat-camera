import unittest
from unittest.mock import patch

import numpy as np

from src.video import (
    BowlRoiConsensus,
    apply_feeding_verification,
    assess_scene_quality,
    detect_frame_batch,
    fixed_bottom_bowl_roi,
    is_plausible_bowl_roi,
    read_video_frames,
    promote_face_presence,
    stabilize_cat_presence,
)


class BowlRoiTests(unittest.TestCase):
    def test_fixed_bottom_roi_uses_center_half_and_bottom_third(self):
        self.assertEqual(
            fixed_bottom_bowl_roi(1440, 2560),
            {"x": 360, "y": 1707, "width": 720, "height": 853},
        )

    def test_rejects_auto_roi_that_covers_a_large_part_of_the_frame(self):
        self.assertFalse(
            is_plausible_bowl_roi(
                {"x": 68, "y": 897, "width": 1013, "height": 1013},
                frame_width=2560,
                frame_height=1440,
            )
        )

    def test_accepts_a_small_roi_fully_inside_the_frame(self):
        self.assertTrue(
            is_plausible_bowl_roi(
                {"x": 1900, "y": 1000, "width": 220, "height": 160},
                frame_width=2560,
                frame_height=1440,
            )
        )

    def test_auto_roi_requires_three_consistent_observations(self):
        tracker = BowlRoiConsensus(required_observations=3)

        self.assertIsNone(tracker.add({"x": 100, "y": 800, "width": 180, "height": 140}))
        self.assertIsNone(tracker.add({"x": 106, "y": 796, "width": 176, "height": 144}))
        confirmed = tracker.add({"x": 102, "y": 802, "width": 182, "height": 138})

        self.assertEqual(confirmed, {"x": 102, "y": 800, "width": 180, "height": 140})

    def test_auto_roi_discards_a_position_jump(self):
        tracker = BowlRoiConsensus(required_observations=3)
        tracker.add({"x": 100, "y": 800, "width": 180, "height": 140})
        tracker.add({"x": 104, "y": 804, "width": 180, "height": 140})

        self.assertIsNone(tracker.add({"x": 900, "y": 300, "width": 180, "height": 140}))
        self.assertIsNone(tracker.add({"x": 904, "y": 304, "width": 180, "height": 140}))
        confirmed = tracker.add({"x": 896, "y": 296, "width": 180, "height": 140})

        self.assertEqual(confirmed, {"x": 900, "y": 300, "width": 180, "height": 140})

    def test_frame_batch_prefers_detector_batch_api(self):
        class BatchDetector:
            def __init__(self):
                self.calls = []

            def detect(self, frame):
                raise AssertionError("single-frame detection should not run")

            def detect_many(self, frames):
                self.calls.append(frames)
                return [[{"frame": frame}] for frame in frames]

        detector = BatchDetector()
        result = detect_frame_batch(detector, ["frame-1", "frame-2"])

        self.assertEqual(detector.calls, [["frame-1", "frame-2"]])
        self.assertEqual(result, [[{"frame": "frame-1"}], [{"frame": "frame-2"}]])


class SceneQualityTests(unittest.TestCase):
    def test_promotes_reliable_cat_face_when_yolo_box_is_missing(self):
        frames = [
            {"hasCat": True, "catBoxes": [{"confidence": 0.8}]},
            {
                "hasCat": False,
                "behaviorEvidence": {"faceObserved": True},
                "cuteEvidence": {
                    "modelConfidence": 0.65,
                    "faceWidthRatio": 0.31,
                    "faceAreaRatio": 0.04,
                },
            },
        ]

        result = promote_face_presence(frames)

        self.assertTrue(result[1]["hasCat"])
        self.assertEqual(result[1]["presenceSource"], "face_landmark")
        self.assertFalse(result[1].get("nearBowl", False))

    def test_does_not_promote_tiny_or_low_confidence_face(self):
        frames = [
            {"hasCat": True},
            {
                "hasCat": False,
                "behaviorEvidence": {"faceObserved": True},
                "cuteEvidence": {
                    "modelConfidence": 0.49,
                    "faceWidthRatio": 0.24,
                    "faceAreaRatio": 0.02,
                },
            },
        ]

        result = promote_face_presence(frames)

        self.assertFalse(result[1]["hasCat"])

    def test_promotes_occluded_face_from_strong_geometry_without_model_score(self):
        frames = [
            {"hasCat": True},
            {
                "hasCat": False,
                "behaviorEvidence": {"faceObserved": True},
                "cuteEvidence": {
                    "modelConfidence": 0,
                    "faceWidthRatio": 0.40,
                    "faceAreaRatio": 0.05,
                },
            },
        ]

        result = promote_face_presence(frames)

        self.assertTrue(result[1]["hasCat"])
        self.assertEqual(result[1]["presenceSource"], "face_landmark")

    def test_stabilizes_weak_boxes_around_a_reliable_anchor(self):
        frames = [
            {"offsetSec": 0.0, "_presenceBoxes": [{"x": 0, "y": 0, "width": 90, "height": 90, "confidence": 0.8}]},
            {"offsetSec": 0.5, "_presenceBoxes": [{"x": 2, "y": 1, "width": 90, "height": 90, "confidence": 0.18}]},
            {"offsetSec": 1.0, "_presenceBoxes": []},
            {"offsetSec": 1.5, "_presenceBoxes": [{"x": 8, "y": 4, "width": 90, "height": 90, "confidence": 0.22}]},
            {"offsetSec": 2.0, "_presenceBoxes": [{"x": 10, "y": 5, "width": 90, "height": 90, "confidence": 0.75}]},
        ]

        result = stabilize_cat_presence(frames)

        self.assertTrue(all(item["hasCat"] for item in result))
        self.assertEqual(result[1]["presenceSource"], "yolo")
        self.assertEqual(result[2]["presenceSource"], "temporal_bridge")
        self.assertTrue(result[2]["presenceStabilized"])

    def test_does_not_start_presence_from_weak_boxes_without_anchor(self):
        frames = [
            {"offsetSec": 0.0, "_presenceBoxes": [{"x": 0, "y": 0, "width": 90, "height": 90, "confidence": 0.18}]},
            {"offsetSec": 0.5, "_presenceBoxes": [{"x": 2, "y": 1, "width": 90, "height": 90, "confidence": 0.22}]},
        ]

        result = stabilize_cat_presence(frames)

        self.assertEqual([item["hasCat"] for item in result], [False, False])
        self.assertEqual([item["presenceSource"] for item in result], ["none", "none"])

    def test_keeps_long_negative_gap_absent(self):
        frames = [
            {"offsetSec": 0.0, "_presenceBoxes": [{"x": 0, "y": 0, "width": 90, "height": 90, "confidence": 0.8}]},
            {"offsetSec": 0.5, "_presenceBoxes": []},
            {"offsetSec": 1.0, "_presenceBoxes": []},
            {"offsetSec": 1.5, "_presenceBoxes": []},
            {"offsetSec": 2.0, "_presenceBoxes": []},
            {"offsetSec": 2.5, "_presenceBoxes": []},
            {"offsetSec": 3.0, "_presenceBoxes": [{"x": 0, "y": 0, "width": 90, "height": 90, "confidence": 0.8}]},
        ]

        result = stabilize_cat_presence(frames)

        self.assertEqual([item["hasCat"] for item in result], [True, False, False, False, False, False, True])

    def test_sampling_seconds_follow_source_time_for_fractional_fps(self):
        frame = np.zeros((12, 16, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class FractionalFpsCapture:
            def __init__(self):
                self.index = 0

            def isOpened(self):
                return True

            def get(self, property_id):
                import cv2

                if property_id == cv2.CAP_PROP_FPS:
                    return 19.85256027097031
                if property_id == cv2.CAP_PROP_FRAME_WIDTH:
                    return 16
                if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
                    return 12
                return 0

            def read(self):
                if self.index > 3200:
                    return False, None
                self.index += 1
                return True, frame

            def release(self):
                return None

        class EmptyDetector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [[] for _frame in frames]

        with patch("cv2.VideoCapture", return_value=FractionalFpsCapture()), patch(
            "src.video.create_target_detector",
            return_value=EmptyDetector(),
        ):
            result = read_video_frames("fractional-fps.mp4", sample_seconds=1.0)

        self.assertEqual([item["second"] for item in result["frames"][:4]], [0, 1, 2, 3])
        self.assertEqual(result["frames"][160]["second"], 161)

    def test_half_second_sampling_includes_sample_position_metadata(self):
        frame = np.zeros((12, 16, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class TwoFpsCapture:
            def __init__(self):
                self.index = 0

            def isOpened(self):
                return True

            def get(self, property_id):
                import cv2

                if property_id == cv2.CAP_PROP_FPS:
                    return 2
                if property_id == cv2.CAP_PROP_FRAME_WIDTH:
                    return 16
                if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
                    return 12
                return 0

            def read(self):
                if self.index >= 3:
                    return False, None
                self.index += 1
                return True, frame

            def release(self):
                return None

        class EmptyDetector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [[] for _frame in frames]

        with patch("cv2.VideoCapture", return_value=TwoFpsCapture()), patch(
            "src.video.create_target_detector",
            return_value=EmptyDetector(),
        ):
            result = read_video_frames("two-fps.mp4", sample_seconds=0.5)

        self.assertEqual(
            [
                (item["sampleIndex"], item["offsetSec"], item["second"])
                for item in result["frames"]
            ],
            [(0, 0.0, 0), (1, 0.5, 0), (2, 1.0, 1)],
        )

    def test_sparse_sampling_can_start_between_whole_second_boundaries(self):
        frame = np.zeros((12, 16, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class FourFpsCapture:
            def __init__(self):
                self.index = 0

            def isOpened(self):
                return True

            def get(self, property_id):
                import cv2

                if property_id == cv2.CAP_PROP_FPS:
                    return 4
                if property_id == cv2.CAP_PROP_FRAME_WIDTH:
                    return 16
                if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
                    return 12
                return 0

            def read(self):
                if self.index >= 12:
                    return False, None
                self.index += 1
                return True, frame

            def release(self):
                return None

        class EmptyDetector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [[] for _frame in frames]

        with patch("cv2.VideoCapture", return_value=FourFpsCapture()), patch(
            "src.video.create_target_detector",
            return_value=EmptyDetector(),
        ):
            result = read_video_frames(
                "offset.mp4",
                sample_seconds=2.0,
                sample_offset_seconds=0.5,
            )

        self.assertEqual(
            [item["offsetSec"] for item in result["frames"]],
            [0.5, 2.5],
        )

    def test_stops_reading_after_requested_recording_duration(self):
        frame = np.zeros((12, 16, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class LongCapture:
            def __init__(self):
                self.index = 0

            def isOpened(self):
                return True

            def get(self, property_id):
                import cv2

                if property_id == cv2.CAP_PROP_FPS:
                    return 2
                if property_id == cv2.CAP_PROP_FRAME_WIDTH:
                    return 16
                if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
                    return 12
                return 0

            def read(self):
                if self.index >= 100:
                    return False, None
                self.index += 1
                return True, frame

            def release(self):
                return None

        capture = LongCapture()

        class EmptyDetector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [[] for _frame in frames]

        with patch("cv2.VideoCapture", return_value=capture), patch(
            "src.video.create_target_detector",
            return_value=EmptyDetector(),
        ):
            result = read_video_frames(
                "long-playlist.m3u8",
                sample_seconds=0.5,
                max_duration_sec=2,
            )

        self.assertEqual([item["offsetSec"] for item in result["frames"]], [0.0, 0.5, 1.0, 1.5])
        self.assertLessEqual(capture.index, 5)

    def test_marks_infrared_grayscale_samples_as_dark(self):
        frames = [np.full((12, 16, 3), 89, dtype=np.uint8) for _ in range(8)]

        quality = assess_scene_quality(frames)

        self.assertTrue(quality["isDark"])
        self.assertEqual(quality["darkSampleCount"], 8)

    def test_keeps_dim_color_samples_for_analysis(self):
        frame = np.zeros((12, 16, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        quality = assess_scene_quality([frame] * 8)

        self.assertFalse(quality["isDark"])
        self.assertGreater(quality["meanChroma"], 4)

    def test_dark_clip_skips_before_loading_target_detector(self):
        class FakeCapture:
            def __init__(self):
                self.frames = [np.full((12, 16, 3), 89, dtype=np.uint8) for _ in range(8)]
                self.index = 0

            def isOpened(self):
                return True

            def get(self, _property):
                return 1

            def read(self):
                if self.index >= len(self.frames):
                    return False, None
                frame = self.frames[self.index]
                self.index += 1
                return True, frame

            def release(self):
                return None

        with patch("cv2.VideoCapture", return_value=FakeCapture()), patch(
            "src.video.create_target_detector"
        ) as create_detector:
            result = read_video_frames("infrared.mp4")

        self.assertTrue(result["skipped"])
        self.assertEqual(result["skipReason"], "DARK_RECORDING")
        self.assertEqual(result["frames"], [])
        self.assertEqual(result["error"], "")
        create_detector.assert_not_called()

    def test_empty_open_clip_reports_read_failure_without_loading_target_detector(self):
        class EmptyCapture:
            def isOpened(self):
                return True

            def get(self, _property):
                return 1

            def read(self):
                return False, None

            def release(self):
                return None

        with patch("cv2.VideoCapture", return_value=EmptyCapture()), patch(
            "src.video.create_target_detector"
        ) as create_detector:
            result = read_video_frames("empty.mp4", detector_backend="auto")

        self.assertEqual(result["frames"], [])
        self.assertEqual(result["detectorBackend"], "auto")
        self.assertEqual(result["detectorError"], "")
        self.assertEqual(result["error"], "VIDEO_READ_FAILED")
        create_detector.assert_not_called()

    def test_low_confidence_target_boxes_do_not_mark_cat_present(self):
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class FakeCapture:
            def __init__(self):
                self.frames = [frame.copy() for _ in range(8)]
                self.index = 0

            def isOpened(self):
                return True

            def get(self, _property):
                return 1

            def read(self):
                if self.index >= len(self.frames):
                    return False, None
                value = self.frames[self.index]
                self.index += 1
                return True, value

            def release(self):
                return None

        class LowConfidenceDetector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [
                    [
                        {
                            "x": 20,
                            "y": 10,
                            "width": 90,
                            "height": 100,
                            "confidence": 0.44,
                        }
                    ]
                    for _frame in frames
                ]

        with patch("cv2.VideoCapture", return_value=FakeCapture()), patch(
            "src.video.create_target_detector",
            return_value=LowConfidenceDetector(),
        ):
            result = read_video_frames(
                "false-positive.mp4",
                bowl_roi={"x": 120, "y": 0, "width": 40, "height": 120},
                feeding_verifier=lambda *_args: {},
            )

        self.assertTrue(result["frames"])
        self.assertTrue(all(not item["hasCat"] for item in result["frames"]))
        self.assertTrue(all(item["catBoxes"] == [] for item in result["frames"]))

    def test_keeps_weak_profile_boxes_when_clip_has_reliable_cat_anchor(self):
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class FakeCapture:
            def __init__(self):
                self.frames = [frame.copy() for _ in range(8)]
                self.index = 0

            def isOpened(self):
                return True

            def get(self, _property):
                return 1

            def read(self):
                if self.index >= len(self.frames):
                    return False, None
                value = self.frames[self.index]
                self.index += 1
                return True, value

            def release(self):
                return None

        class MixedConfidenceDetector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [
                    [
                        {
                            "x": 20,
                            "y": 10,
                            "width": 90,
                            "height": 100,
                            "confidence": 0.8 if index == len(frames) - 1 else 0.4,
                        }
                    ]
                    for index, _frame in enumerate(frames)
                ]

        with patch("cv2.VideoCapture", return_value=FakeCapture()), patch(
            "src.video.create_target_detector",
            return_value=MixedConfidenceDetector(),
        ):
            result = read_video_frames(
                "profile-cat.mp4",
                bowl_roi={"x": 120, "y": 0, "width": 40, "height": 120},
                feeding_verifier=lambda *_args: {},
            )

        self.assertTrue(all(item["hasCat"] for item in result["frames"]))
        self.assertEqual(result["frames"][0]["catBoxes"][0]["confidence"], 0.4)


class FeedingVerificationTests(unittest.TestCase):
    def test_adaptive_feeding_reuses_buffered_frames_without_reopening_source(self):
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class FakeCapture:
            def __init__(self):
                self.frames = [frame.copy() for _ in range(16)]
                self.index = 0

            def isOpened(self):
                return True

            def get(self, property_id):
                return 8 if int(property_id) == 5 else 160 if int(property_id) == 3 else 120

            def read(self):
                if self.index >= len(self.frames):
                    return False, None
                value = self.frames[self.index]
                self.index += 1
                return True, value

            def release(self):
                return None

        class Detector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [
                    [{"x": 10, "y": 10, "width": 120, "height": 100, "confidence": 0.8}]
                    for _frame in frames
                ]

        verifier_reads = []

        def fake_verify(_source_url, sampled_frames, _bowl_roi, capture_factory=None, **_options):
            buffered = capture_factory("ignored")
            while True:
                ok, buffered_frame = buffered.read()
                if not ok:
                    break
                verifier_reads.append(buffered_frame.shape)
            return {
                int(item["sampleIndex"]): {
                    "eatingVerified": True,
                    "confidence": 0.9,
                    "reason": "",
                }
                for item in sampled_frames
                if item.get("nearBowl")
            }

        with patch("cv2.VideoCapture", return_value=FakeCapture()) as open_capture, patch(
            "src.video.create_target_detector",
            return_value=Detector(),
        ), patch("src.feeding_behavior.verify_candidate_behavior", side_effect=fake_verify):
            result = read_video_frames(
                "adaptive.mp4",
                bowl_roi={"x": 120, "y": 20, "width": 30, "height": 80},
                sample_seconds=2,
                adaptive_feeding=True,
            )

        self.assertEqual(open_capture.call_count, 1)
        self.assertEqual(len(verifier_reads), 16)
        self.assertTrue(result["frames"][0]["eatingVerified"])

    def test_screen_only_reader_never_runs_feeding_verifier(self):
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        frame[..., 0] = 82
        frame[..., 1] = 98
        frame[..., 2] = 112

        class FakeCapture:
            def __init__(self):
                self.frames = [frame.copy() for _ in range(2)]
                self.index = 0

            def isOpened(self):
                return True

            def get(self, _property):
                return 1

            def read(self):
                if self.index >= len(self.frames):
                    return False, None
                value = self.frames[self.index]
                self.index += 1
                return True, value

            def release(self):
                return None

        class Detector:
            backend = "yolo"
            fallback_error = ""

            def detect_many(self, frames):
                return [
                    [{"x": 10, "y": 10, "width": 80, "height": 80, "confidence": 0.8}]
                    for _frame in frames
                ]

        def fail_verifier(*_args, **_kwargs):
            raise AssertionError("screen-only analysis must not run feeding verification")

        with patch("cv2.VideoCapture", return_value=FakeCapture()), patch(
            "src.video.create_target_detector",
            return_value=Detector(),
        ):
            result = read_video_frames(
                "screening.mp4",
                screen_only=True,
                feeding_verifier=fail_verifier,
            )

        self.assertTrue(result["frames"])
        self.assertTrue(result["frames"][0]["hasCat"])

    def test_does_not_run_for_face_detection(self):
        calls = []
        frames = [{"second": 1, "nearBowl": True}]

        result = apply_feeding_verification(
            "clip.mp4",
            frames,
            {"x": 1, "y": 2, "width": 3, "height": 4},
            target="face",
            verifier=lambda *args: calls.append(args),
        )

        self.assertEqual(calls, [])
        self.assertFalse(result[0]["eatingVerified"])

    def test_runs_only_when_cat_has_a_near_bowl_candidate(self):
        calls = []
        frames = [
            {"second": 0, "nearBowl": False},
            {"second": 1, "nearBowl": True},
        ]

        def verifier(source_url, sampled_frames, bowl_roi):
            calls.append((source_url, sampled_frames, bowl_roi))
            return {
                1: {
                    "eatingVerified": True,
                    "confidence": 0.82,
                    "reason": "",
                    "cuteEvidence": {
                        "closeup": True,
                        "closeupScore": 0.88,
                        "front": True,
                        "frontScore": 0.91,
                    },
                }
            }

        result = apply_feeding_verification(
            "clip.mp4",
            frames,
            {"x": 1, "y": 2, "width": 3, "height": 4},
            target="cat",
            verifier=verifier,
        )

        self.assertEqual(len(calls), 1)
        self.assertFalse(result[0]["eatingVerified"])
        self.assertTrue(result[1]["eatingVerified"])
        self.assertEqual(result[1]["behaviorEvidence"]["confidence"], 0.82)
        self.assertEqual(result[1]["cuteEvidence"]["frontScore"], 0.91)

    def test_runs_for_cat_positive_candidate_before_near_bowl_is_known(self):
        calls = []
        frames = [{"second": 0, "hasCat": True, "nearBowl": False}]

        def verifier(source_url, sampled_frames, bowl_roi):
            calls.append((source_url, sampled_frames, bowl_roi))
            return {
                0: {
                    "eatingVerified": False,
                    "confidence": 0.4,
                    "reason": "MUZZLE_STATIC",
                }
            }

        result = apply_feeding_verification(
            "clip.mp4",
            frames,
            {"x": 25, "y": 66, "width": 50, "height": 34},
            target="cat",
            verifier=verifier,
        )

        self.assertEqual(len(calls), 1)
        self.assertEqual(result[0]["behaviorEvidence"]["reason"], "MUZZLE_STATIC")

    def test_maps_behavior_evidence_by_sample_index(self):
        frames = [
            {"sampleIndex": 0, "offsetSec": 0.0, "second": 0, "nearBowl": True},
            {"sampleIndex": 1, "offsetSec": 0.5, "second": 0, "nearBowl": True},
        ]

        def verifier(_source_url, _sampled_frames, _bowl_roi):
            return {
                0: {
                    "eatingVerified": True,
                    "confidence": 0.8,
                    "reason": "",
                    "cuteEvidence": {"cuteScore": 0.81},
                },
                1: {
                    "eatingVerified": False,
                    "confidence": 0.6,
                    "reason": "MUZZLE_STATIC",
                    "cuteEvidence": {"cuteScore": 0.92},
                },
            }

        result = apply_feeding_verification(
            "clip.mp4",
            frames,
            {"x": 1, "y": 2, "width": 3, "height": 4},
            target="cat",
            verifier=verifier,
        )

        self.assertEqual([frame["cuteEvidence"]["cuteScore"] for frame in result], [0.81, 0.92])
        self.assertEqual([frame["eatingVerified"] for frame in result], [True, False])


if __name__ == "__main__":
    unittest.main()
