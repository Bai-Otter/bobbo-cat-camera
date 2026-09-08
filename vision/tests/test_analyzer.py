import unittest
from unittest.mock import patch

from src.analyzer import analyze_recording


class AnalyzerTests(unittest.TestCase):
    def test_analyze_recording_returns_structured_error_for_missing_source(self):
        result = analyze_recording({"sourceUrl": "", "recordingKey": "clip-1"})

        self.assertFalse(result["hasCat"])
        self.assertFalse(result["hasFeeding"])
        self.assertEqual(result["analysisConfidence"], 0)
        self.assertEqual(result["markers"], [])
        self.assertEqual(result["cuteTimeline"], [])
        self.assertEqual(result["framesSampled"], 0)
        self.assertEqual(result["error"], "SOURCE_MISSING")
        self.assertEqual(result["recordingKey"], "clip-1")
        self.assertEqual(result["target"], "cat")
        self.assertIsInstance(result["durationMs"], int)

    def test_analyze_recording_summarizes_frames_from_reader(self):
        captured_options = {}

        def fake_reader(source_url, bowl_roi=None, **options):
            captured_options.update(options)
            return {
                "frames": [
                    {"second": 0, "hasCat": True, "nearBowl": False, "confidence": 0.8},
                    {"second": 1, "hasCat": True, "nearBowl": False, "confidence": 0.8},
                    {"second": 2, "hasCat": True, "nearBowl": False, "confidence": 0.8},
                ],
                "bowlRoi": bowl_roi,
                "error": "",
            }

        result = analyze_recording(
            {
                "sourceUrl": "memory://clip",
                "recordingKey": "clip-2",
                "beginTime": "2026-07-06 08:30:00",
                "bowlRoi": {"x": 1, "y": 2, "width": 3, "height": 4},
                "detectionTarget": "cat",
                "orientation": "clockwise-90",
            },
            video_reader=fake_reader,
        )

        self.assertTrue(result["hasCat"])
        self.assertFalse(result["hasFeeding"])
        self.assertEqual(result["analysisConfidence"], 0.8)
        self.assertEqual(result["framesSampled"], 3)
        self.assertEqual(result["error"], "")
        self.assertEqual(result["bowlRoi"], {"x": 1, "y": 2, "width": 3, "height": 4})
        self.assertEqual([item["markerType"] for item in result["markers"]], ["cat_enter"])
        self.assertEqual(result["markers"][0]["beginTime"], "2026-07-06 08:30:00")
        self.assertEqual(captured_options["orientation"], "clockwise-90")

    def test_analyze_recording_returns_compact_cute_timeline_in_source_order(self):
        def fake_reader(source_url, bowl_roi=None, **options):
            return {
                "frames": [
                    {
                        "offsetSec": 0.5,
                        "hasCat": False,
                        "cuteEvidence": {
                            "cuteScore": 0.72,
                            "modelConfidence": 0.85,
                            "cuteReasons": ["front", "front", "head_up"],
                            "detectorInternals": {"secret": True},
                        },
                        "sourceUrl": "https://private.example/clip",
                        "catBoxes": [{"x": 1}],
                    },
                    {
                        "offsetSec": 1.0,
                        "hasCat": True,
                        "cuteEvidence": {
                            "cuteScore": 1.4,
                            "modelConfidence": -0.2,
                            "cuteReasons": ["closeup", "closeup", "front"],
                        },
                    },
                ],
                "bowlRoi": bowl_roi,
                "error": "",
            }

        result = analyze_recording(
            {
                "sourceUrl": "memory://cute-clip",
                "recordingKey": "clip-cute",
                "beginTime": "2026-07-06 08:30:00",
            },
            video_reader=fake_reader,
        )

        self.assertEqual(
            result["cuteTimeline"],
            [
                {
                    "offsetSec": 0.5,
                    "cuteScore": 0.72,
                    "modelConfidence": 0.85,
                    "cuteReasons": ["front", "head_up"],
                    "hasCat": False,
                },
                {
                    "offsetSec": 1.0,
                    "cuteScore": 1.0,
                    "modelConfidence": 0.0,
                    "cuteReasons": ["closeup", "front"],
                    "hasCat": True,
                },
            ],
        )
        self.assertTrue(all(set(item) == {
            "offsetSec",
            "cuteScore",
            "modelConfidence",
            "cuteReasons",
            "hasCat",
        } for item in result["cuteTimeline"]))

    def test_analyze_recording_returns_empty_cute_timeline_for_reader_errors_and_skips(self):
        def error_reader(source_url, bowl_roi=None, **options):
            return {
                "frames": [{"offsetSec": 0.0, "cuteEvidence": {"cuteScore": 1}}],
                "error": "VIDEO_READ_FAILED",
            }

        def skipped_reader(source_url, bowl_roi=None, **options):
            return {
                "frames": [{"offsetSec": 0.0, "cuteEvidence": {"cuteScore": 1}}],
                "skipped": True,
                "skipReason": "DARK_RECORDING",
                "error": "",
            }

        payload = {
            "sourceUrl": "memory://clip",
            "recordingKey": "clip-error",
            "beginTime": "2026-07-06 08:30:00",
        }
        self.assertEqual(analyze_recording(payload, video_reader=error_reader)["cuteTimeline"], [])
        self.assertEqual(analyze_recording(payload, video_reader=skipped_reader)["cuteTimeline"], [])

    def test_analyze_recording_normalizes_malformed_cute_reasons_for_timeline_and_markers(self):
        def analyze_with_reasons(cute_reasons):
            def fake_reader(source_url, bowl_roi=None, **options):
                return {
                    "frames": [
                        {
                            "offsetSec": 0.0,
                            "hasCat": True,
                            "cuteEvidence": {
                                "closeup": True,
                                "closeupScore": 0.9,
                                "modelConfidence": 0.9,
                                "cuteScore": 0.9,
                                "cuteReasons": cute_reasons,
                                "cuteEligible": True,
                            },
                        }
                    ],
                    "error": "",
                }

            return analyze_recording(
                {
                    "sourceUrl": "memory://malformed-cute-reasons",
                    "beginTime": "2026-07-06 08:30:00",
                },
                video_reader=fake_reader,
            )

        for malformed_reasons in (123, {"reason": "front"}, None):
            with self.subTest(malformed_reasons=malformed_reasons):
                result = analyze_with_reasons(malformed_reasons)
                self.assertEqual(result["cuteTimeline"][0]["cuteReasons"], [])
                cute_markers = [
                    marker for marker in result["markers"]
                    if marker["markerType"].startswith("cute_")
                ]
                self.assertEqual(len(cute_markers), 1)
                self.assertEqual(cute_markers[0]["cuteReasons"], [])

        result = analyze_with_reasons(("front", 123, "front", "head_up"))
        self.assertEqual(result["cuteTimeline"][0]["cuteReasons"], ["front", "head_up"])
        cute_markers = [
            marker for marker in result["markers"]
            if marker["markerType"].startswith("cute_")
        ]
        self.assertEqual(cute_markers[0]["cuteReasons"], ["front", "head_up"])

    def test_analyze_recording_forwards_detection_target_to_reader_and_markers(self):
        calls = []

        def fake_reader(source_url, bowl_roi=None, **options):
            calls.append({"sourceUrl": source_url, "bowlRoi": bowl_roi, **options})
            return {
                "frames": [
                    {"second": 0, "hasCat": True, "nearBowl": False, "confidence": 0.8},
                    {"second": 1, "hasCat": True, "nearBowl": False, "confidence": 0.8},
                    {"second": 2, "hasCat": True, "nearBowl": False, "confidence": 0.8},
                ],
                "bowlRoi": bowl_roi,
                "detectorBackend": "opencv-face",
                "error": "",
            }

        result = analyze_recording(
            {
                "sourceUrl": "memory://face-clip",
                "recordingKey": "clip-face",
                "beginTime": "2026-07-06 08:30:00",
                "detectionTarget": "face",
                "detectorBackend": "auto",
            },
            video_reader=fake_reader,
        )

        self.assertEqual(calls[0]["detection_target"], "face")
        self.assertEqual(result["target"], "face")
        self.assertEqual(result["markers"][0]["markerType"], "face_enter")
        self.assertEqual(result["markers"][0]["target"], "face")

    def test_analyze_recording_passes_detector_options_to_default_reader(self):
        with patch("src.video.read_video_frames") as read_video_frames:
            read_video_frames.return_value = {"frames": [], "bowlRoi": None, "error": ""}

            analyze_recording(
                {
                    "sourceUrl": "memory://clip",
                    "recordingKey": "clip-3",
                    "beginTime": "2026-07-06 08:30:00",
                    "detectorBackend": "yolo",
                    "yoloModel": "custom.pt",
                    "detectionTarget": "cat",
                    "durationSec": 120,
                }
            )

        read_video_frames.assert_called_once_with(
            "memory://clip",
            bowl_roi=None,
            sample_seconds=0.5,
            detector_backend="yolo",
            yolo_model="custom.pt",
            detection_target="cat",
            auto_bowl_detection=False,
            screen_only=False,
            orientation="none",
            adaptive_feeding=False,
            fixed_bottom_bowl_region=False,
            max_duration_sec=120,
        )

    def test_analyze_recording_forwards_fixed_bottom_bowl_region(self):
        calls = []

        def fake_reader(source_url, bowl_roi=None, **options):
            calls.append(options)
            return {"frames": [], "bowlRoi": bowl_roi, "error": ""}

        analyze_recording(
            {
                "sourceUrl": "memory://fixed-bowl",
                "recordingKey": "fixed-bowl",
                "beginTime": "2026-08-22 08:00:00",
                "fixedBottomBowlRegion": True,
            },
            video_reader=fake_reader,
        )

        self.assertTrue(calls[0]["fixed_bottom_bowl_region"])

    def test_analyze_recording_forwards_sparse_sample_interval(self):
        calls = []

        def fake_reader(source_url, bowl_roi=None, **options):
            calls.append(options)
            return {"frames": [], "bowlRoi": bowl_roi, "error": ""}

        analyze_recording(
            {
                "sourceUrl": "memory://screening",
                "recordingKey": "screening",
                "beginTime": "2026-08-22 08:00:00",
                "sampleSeconds": 2,
            },
            video_reader=fake_reader,
        )

        self.assertEqual(calls[0]["sample_seconds"], 2)

    def test_analyze_recording_forwards_adaptive_feeding_mode(self):
        calls = []

        def fake_reader(source_url, bowl_roi=None, **options):
            calls.append(options)
            return {"frames": [], "bowlRoi": bowl_roi, "error": ""}

        analyze_recording(
            {
                "sourceUrl": "memory://adaptive",
                "recordingKey": "adaptive",
                "beginTime": "2026-08-22 08:00:00",
                "sampleSeconds": 2,
                "adaptiveFeeding": True,
            },
            video_reader=fake_reader,
        )

        self.assertTrue(calls[0]["adaptive_feeding"])

    def test_analyze_recording_forwards_sparse_sample_offset(self):
        calls = []

        def fake_reader(source_url, bowl_roi=None, **options):
            calls.append(options)
            return {"frames": [], "bowlRoi": bowl_roi, "error": ""}

        analyze_recording(
            {
                "sourceUrl": "memory://screening",
                "recordingKey": "screening",
                "beginTime": "2026-08-22 08:00:00",
                "sampleSeconds": 2,
                "sampleOffsetSeconds": 0.5,
            },
            video_reader=fake_reader,
        )

        self.assertEqual(calls[0]["sample_seconds"], 2)
        self.assertEqual(calls[0]["sample_offset_seconds"], 0.5)

    def test_analyze_recording_forwards_screen_only_and_omits_cute_timeline(self):
        calls = []

        def fake_reader(source_url, bowl_roi=None, **options):
            calls.append(options)
            return {
                "frames": [
                    {
                        "sampleIndex": 0,
                        "offsetSec": 0,
                        "second": 0,
                        "hasCat": True,
                        "confidence": 0.8,
                        "cuteScore": 0.9,
                    }
                ],
                "bowlRoi": bowl_roi,
                "error": "",
            }

        result = analyze_recording(
            {
                "sourceUrl": "memory://screening",
                "recordingKey": "screening",
                "beginTime": "2026-08-22 08:00:00",
                "screenOnly": True,
            },
            video_reader=fake_reader,
        )

        self.assertTrue(calls[0]["screen_only"])
        self.assertEqual(result["cuteTimeline"], [])

    def test_analyze_recording_summarizes_feeding_behavior_evidence(self):
        def fake_reader(source_url, bowl_roi=None, **options):
            return {
                "frames": [
                    {
                        "second": 0,
                        "hasCat": True,
                        "nearBowl": True,
                        "eatingVerified": False,
                        "confidence": 0.8,
                        "behaviorEvidence": {
                            "eatingVerified": False,
                            "confidence": 0,
                            "reason": "MUZZLE_STATIC",
                        },
                    },
                    {
                        "second": 1,
                        "hasCat": True,
                        "nearBowl": True,
                        "eatingVerified": True,
                        "confidence": 0.9,
                        "behaviorEvidence": {
                            "eatingVerified": True,
                            "confidence": 0.82,
                            "reason": "",
                        },
                    },
                ],
                "bowlRoi": bowl_roi,
                "error": "",
            }

        result = analyze_recording(
            {
                "sourceUrl": "memory://clip",
                "recordingKey": "clip-behavior",
                "beginTime": "2026-07-06 08:30:00",
                "bowlRoi": {"x": 1, "y": 2, "width": 3, "height": 4},
                "detectionTarget": "cat",
            },
            video_reader=fake_reader,
        )

        self.assertEqual(
            result["feedingEvidence"],
            {
                "candidateSeconds": 2,
                "verifiedSeconds": 1,
                "maxConfidence": 0.82,
                "rejectionReasons": {"MUZZLE_STATIC": 1},
            },
        )

    def test_feeding_evidence_summary_counts_unique_integer_seconds_at_two_fps(self):
        def fake_reader(source_url, bowl_roi=None, **options):
            frames = []
            for sample_index in range(4):
                second = sample_index // 2
                eating_verified = second == 1
                frames.append(
                    {
                        "sampleIndex": sample_index,
                        "offsetSec": sample_index * 0.5,
                        "second": second,
                        "hasCat": True,
                        "nearBowl": True,
                        "eatingVerified": eating_verified,
                        "confidence": 0.9,
                        "behaviorEvidence": {
                            "eatingVerified": eating_verified,
                            "confidence": 0.82 if eating_verified else 0.0,
                            "reason": "" if eating_verified else "MUZZLE_STATIC",
                        },
                    }
                )
            return {"frames": frames, "bowlRoi": bowl_roi, "error": ""}

        result = analyze_recording(
            {
                "sourceUrl": "memory://two-fps-clip",
                "recordingKey": "clip-two-fps-behavior",
                "beginTime": "2026-07-06 08:30:00",
                "bowlRoi": {"x": 1, "y": 2, "width": 3, "height": 4},
                "detectionTarget": "cat",
            },
            video_reader=fake_reader,
        )

        self.assertEqual(
            result["feedingEvidence"],
            {
                "candidateSeconds": 2,
                "verifiedSeconds": 1,
                "maxConfidence": 0.82,
                "rejectionReasons": {"MUZZLE_STATIC": 1},
            },
        )

    def test_feeding_evidence_summary_includes_fine_evaluated_non_bowl_slot(self):
        def fake_reader(source_url, bowl_roi=None, **options):
            return {
                "frames": [
                    {
                        "sampleIndex": 0,
                        "offsetSec": 1.0,
                        "second": 1,
                        "hasCat": False,
                        "nearBowl": False,
                        "eatingVerified": True,
                        "confidence": 0.0,
                        "behaviorEvidence": {
                            "eatingVerified": True,
                            "faceAtBowl": True,
                            "confidence": 0.76,
                            "reason": "",
                        },
                    }
                ],
                "bowlRoi": bowl_roi,
                "error": "",
            }

        result = analyze_recording(
            {
                "sourceUrl": "memory://fine-slot",
                "recordingKey": "fine-slot",
                "beginTime": "2026-07-06 08:30:00",
                "bowlRoi": {"x": 1, "y": 2, "width": 3, "height": 4},
                "detectionTarget": "cat",
            },
            video_reader=fake_reader,
        )

        self.assertEqual(result["feedingEvidence"]["candidateSeconds"], 1)
        self.assertEqual(result["feedingEvidence"]["verifiedSeconds"], 1)
        self.assertEqual(result["feedingEvidence"]["maxConfidence"], 0.76)


if __name__ == "__main__":
    unittest.main()
