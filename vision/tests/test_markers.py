import unittest


from src.markers import build_markers, parse_begin_ms


class MarkerTests(unittest.TestCase):
    def test_build_markers_keeps_spaced_peaks_during_a_long_closeup(self):
        scores = {
            10: 0.70,
            11: 0.76,
            12: 0.82,
            13: 0.98,
            14: 0.85,
            15: 0.74,
            16: 0.80,
            17: 0.94,
            18: 0.83,
            19: 0.77,
            20: 0.91,
        }
        frames = [
            {
                "second": second,
                "hasCat": True,
                "nearBowl": False,
                "cuteEvidence": {
                    "closeup": second in scores,
                    "closeupScore": scores.get(second, 0.0),
                },
            }
            for second in range(25)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        closeups = [item for item in summary["markers"] if item["markerType"] == "cute_closeup"]
        offsets = [item["offsetSec"] for item in closeups]
        self.assertGreaterEqual(len(offsets), 3)
        self.assertIn(13, offsets)
        self.assertTrue(all(right - left >= 3 for left, right in zip(offsets, offsets[1:])))

    def test_build_markers_emits_left_and_right_profile_peaks(self):
        frames = [
            {
                "second": second,
                "hasCat": True,
                "nearBowl": False,
                "cuteEvidence": (
                    {
                        "profile": True,
                        "profileSide": "left" if second == 5 else "right",
                        "profileScore": 0.91 if second == 5 else 0.87,
                    }
                    if second in {5, 12}
                    else None
                ),
            }
            for second in range(15)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        profiles = [item for item in summary["markers"] if item["markerType"].startswith("cute_profile_")]
        self.assertEqual(
            [(item["markerType"], item["offsetSec"], item["confidence"]) for item in profiles],
            [("cute_profile_left", 5, 0.91), ("cute_profile_right", 12, 0.87)],
        )

    def test_build_markers_emits_head_up_peaks(self):
        frames = [
            {
                "second": second,
                "hasCat": True,
                "nearBowl": False,
                "cuteEvidence": (
                    {"headUp": True, "headUpScore": 0.91}
                    if second == 7
                    else None
                ),
            }
            for second in range(15)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        head_up = [item for item in summary["markers"] if item["markerType"] == "cute_head_up"]
        self.assertEqual(
            [(item["offsetSec"], item["confidence"]) for item in head_up],
            [(7, 0.91)],
        )

    def test_build_markers_emits_explainable_cute_score_fields(self):
        evidence = {
            "extremeCloseup": True,
            "extremeCloseupScore": 0.91,
            "headUp": True,
            "headUpScore": 0.86,
            "profile": False,
            "profileSide": "",
            "profileScore": 0.0,
            "modelConfidence": 0.9,
            "cuteScore": 0.91,
            "cuteReasons": ["extreme_closeup", "head_up"],
            "cuteEligible": True,
        }
        rejected = {
            **evidence,
            "modelConfidence": 0.64,
            "cuteScore": 1.0,
            "cuteEligible": False,
        }
        frames = [
            {
                "second": second,
                "hasCat": True,
                "nearBowl": False,
                "cuteEvidence": evidence if second == 5 else rejected if second == 12 else None,
            }
            for second in range(18)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        cute = [item for item in summary["markers"] if item["markerType"].startswith("cute_")]
        self.assertEqual(
            [item["markerType"] for item in cute],
            ["cute_extreme_closeup", "cute_head_up"],
        )
        self.assertTrue(all(item["modelConfidence"] == 0.9 for item in cute))
        self.assertTrue(all(item["cuteScore"] == 0.91 for item in cute))
        self.assertTrue(all(item["cuteReasons"] == ["extreme_closeup", "head_up"] for item in cute))

    def test_build_markers_keeps_spaced_cute_hits_and_confidence(self):
        evidence_by_second = {
            10: {"closeup": True, "closeupScore": 0.72, "front": True, "frontScore": 0.74},
            13: {"closeup": True, "closeupScore": 0.93, "front": True, "frontScore": 0.88},
            17: {"closeup": True, "closeupScore": 0.81, "front": False, "frontScore": 0.4},
            24: {"closeup": True, "closeupScore": 0.84, "front": True, "frontScore": 0.79},
        }
        frames = [
            {
                "second": second,
                "hasCat": True,
                "nearBowl": False,
                "cuteEvidence": evidence_by_second.get(second),
            }
            for second in range(25)
        ]

        begin_ms = parse_begin_ms("2026-07-06 08:30:00")
        summary = build_markers(begin_ms, frames)

        closeups = [item for item in summary["markers"] if item["markerType"] == "cute_closeup"]
        fronts = [item for item in summary["markers"] if item["markerType"] == "cute_front"]
        self.assertEqual([item["offsetSec"] for item in closeups], [10, 13, 17, 24])
        self.assertEqual([item["confidence"] for item in closeups], [0.72, 0.93, 0.81, 0.84])
        self.assertEqual([item["offsetSec"] for item in fronts], [10, 13, 24])
        self.assertEqual([item["confidence"] for item in fronts], [0.74, 0.88, 0.79])
        self.assertEqual(closeups[1]["markerTsMs"], parse_begin_ms("2026-07-06 08:30:13"))
        self.assertEqual(closeups[1]["beginTime"], "2026-07-06 08:30:13")

    def test_cute_spacing_uses_fractional_offset_while_feeding_stays_on_seconds(self):
        frames = []
        for sample_index in range(40):
            offset_sec = sample_index * 0.5
            second = int(offset_sec)
            frames.append(
                {
                    "sampleIndex": sample_index,
                    "offsetSec": offset_sec,
                    "second": second,
                    "hasCat": 1 <= second <= 12,
                    "nearBowl": 3 <= second <= 10,
                    "eatingVerified": 3 <= second <= 10,
                    "cuteEvidence": (
                        {
                            "closeup": True,
                            "closeupScore": 0.8 if offset_sec == 10.5 else 0.95,
                        }
                        if offset_sec in {10.5, 13.0}
                        else None
                    ),
                }
            )

        begin_ms = parse_begin_ms("2026-07-06 08:30:00")
        summary = build_markers(begin_ms, frames)
        closeups = [item for item in summary["markers"] if item["markerType"] == "cute_closeup"]
        feeding = [item for item in summary["markers"] if item["markerType"].startswith("feeding_")]

        self.assertEqual([item["offsetSec"] for item in closeups], [13])
        self.assertEqual(closeups[0]["markerTsMs"], begin_ms + 13000)
        self.assertEqual([item["offsetSec"] for item in feeding], [3, 13])
        self.assertTrue(all(isinstance(item["offsetSec"], int) for item in feeding))

    def test_cute_markers_do_not_change_existing_feeding_boundaries(self):
        frames = [
            {
                "second": second,
                "hasCat": 1 <= second <= 12,
                "nearBowl": 3 <= second <= 10,
                "eatingVerified": 3 <= second <= 10,
                "cuteEvidence": (
                    {"closeup": True, "closeupScore": 0.9, "front": False, "frontScore": 0.2}
                    if second == 6
                    else None
                ),
            }
            for second in range(20)
        ]

        begin_ms = parse_begin_ms("2026-07-06 08:30:00")
        summary = build_markers(begin_ms, frames)
        baseline = build_markers(
            begin_ms,
            [{key: value for key, value in frame.items() if key != "cuteEvidence"} for frame in frames],
        )

        existing = [
            (item["markerType"], item["offsetSec"])
            for item in summary["markers"]
            if item["markerType"] in {"cat_enter", "cat_leave", "feeding_start", "feeding_end"}
        ]
        baseline_existing = [
            (item["markerType"], item["offsetSec"])
            for item in baseline["markers"]
            if item["markerType"] in {"cat_enter", "cat_leave", "feeding_start", "feeding_end"}
        ]
        self.assertEqual(existing, baseline_existing)

    def test_build_markers_can_emit_face_enter_leave_without_feeding_window(self):
        frames = [
            {"second": 0, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 1, "hasCat": True, "nearBowl": False, "confidence": 0.8},
            {"second": 2, "hasCat": True, "nearBowl": False, "confidence": 0.8},
            {"second": 3, "hasCat": True, "nearBowl": False, "confidence": 0.8},
            {"second": 4, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 5, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 6, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 7, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 8, "hasCat": False, "nearBowl": False, "confidence": 0.1},
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames, target="face")

        self.assertEqual(summary["target"], "face")
        self.assertTrue(summary["hasCat"])
        self.assertFalse(summary["hasFeeding"])
        self.assertEqual(
            [marker["markerType"] for marker in summary["markers"]],
            ["face_enter", "face_leave"],
        )
        self.assertEqual([marker["target"] for marker in summary["markers"]], ["face", "face"])
        self.assertEqual([marker["offsetSec"] for marker in summary["markers"]], [1, 4])
        self.assertEqual([marker["offsetMs"] for marker in summary["markers"]], [1000, 4000])

    def test_build_markers_tracks_cat_enter_leave_and_verified_feeding_window(self):
        frames = [
            {"second": 0, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 1, "hasCat": True, "nearBowl": False, "confidence": 0.8},
            {"second": 2, "hasCat": True, "nearBowl": False, "confidence": 0.8},
            {"second": 3, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 4, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 5, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 6, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 7, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 8, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 9, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 10, "hasCat": True, "nearBowl": True, "eatingVerified": True, "confidence": 0.9},
            {"second": 11, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 12, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 13, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 14, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 15, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 16, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 17, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 18, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 19, "hasCat": False, "nearBowl": False, "confidence": 0.1},
            {"second": 20, "hasCat": False, "nearBowl": False, "confidence": 0.1},
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        self.assertTrue(summary["hasCat"])
        self.assertTrue(summary["hasFeeding"])
        self.assertEqual(
            [marker["markerType"] for marker in summary["markers"]],
            ["cat_enter", "feeding_start", "cat_leave", "feeding_end"],
        )
        self.assertEqual(summary["markers"][0]["beginTime"], "2026-07-06 08:30:01")
        self.assertEqual(summary["markers"][1]["beginTime"], "2026-07-06 08:30:03")
        self.assertEqual(summary["markers"][2]["beginTime"], "2026-07-06 08:30:11")
        self.assertEqual(summary["markers"][3]["beginTime"], "2026-07-06 08:30:11")
        self.assertEqual([marker["offsetSec"] for marker in summary["markers"]], [1, 3, 11, 11])
        self.assertEqual([marker["offsetMs"] for marker in summary["markers"]], [1000, 3000, 11000, 11000])

    def test_parse_begin_ms_accepts_dash_and_slash_timestamps(self):
        self.assertEqual(
            parse_begin_ms("2026-07-06 08:30:00"),
            parse_begin_ms("2026/07/06 08:30:00"),
        )

    def test_build_markers_tolerates_short_verified_feeding_gaps(self):
        verified_seconds = {3, 4, 5, 7, 8, 9, 11}
        frames = [
            {
                "second": second,
                "hasCat": second in verified_seconds,
                "nearBowl": second in verified_seconds,
                "eatingVerified": second in verified_seconds,
                "confidence": 0.9 if second in verified_seconds else 0.1,
            }
            for second in range(15)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        self.assertTrue(summary["hasFeeding"])
        self.assertIn("feeding_start", [item["markerType"] for item in summary["markers"]])

    def test_build_markers_rejects_near_bowl_without_behavior_evidence(self):
        near_bowl_seconds = set(range(1, 20))
        frames = [
            {
                "second": second,
                "hasCat": second in near_bowl_seconds,
                "nearBowl": second in near_bowl_seconds,
                "confidence": 0.9 if second in near_bowl_seconds else 0.1,
            }
            for second in range(120)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        self.assertFalse(summary["hasFeeding"])
        self.assertEqual(
            [item for item in summary["markers"] if item["markerType"].startswith("feeding_")],
            [],
        )

    def test_build_markers_keeps_one_feeding_event_across_supported_chewing_gap(self):
        verified_seconds = {5, 6, 7, 33, 34, 35}
        supported_seconds = set(range(5, 36))
        frames = [
            {
                "second": second,
                "hasCat": second in supported_seconds,
                "nearBowl": second in supported_seconds,
                "eatingVerified": second in verified_seconds,
                "confidence": 0.9 if second in supported_seconds else 0.1,
            }
            for second in range(40)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        self.assertTrue(summary["hasFeeding"])
        feeding = [item for item in summary["markers"] if item["markerType"].startswith("feeding_")]
        self.assertEqual([item["offsetSec"] for item in feeding], [5, 36])

    def test_build_markers_discards_isolated_hits_before_a_verified_seed(self):
        verified_seconds = {1, 2, *range(20, 29)}
        supported_seconds = set(range(1, 30))
        frames = [
            {
                "second": second,
                "hasCat": second in supported_seconds,
                "nearBowl": second in supported_seconds,
                "eatingVerified": second in verified_seconds,
            }
            for second in range(35)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        feeding = [item for item in summary["markers"] if item["markerType"].startswith("feeding_")]
        self.assertEqual([item["offsetSec"] for item in feeding], [20, 30])

    def test_build_markers_does_not_bridge_chewing_gap_without_cat_support(self):
        verified_seconds = {5, 6, 33, 34}
        frames = [
            {
                "second": second,
                "hasCat": second in verified_seconds,
                "nearBowl": second in verified_seconds,
                "eatingVerified": second in verified_seconds,
            }
            for second in range(40)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        self.assertFalse(summary["hasFeeding"])

    def test_build_markers_extends_feeding_tail_while_cat_stays_near_bowl(self):
        verified_seconds = set(range(5, 13))
        supported_seconds = set(range(5, 21))
        frames = [
            {
                "second": second,
                "hasCat": second in supported_seconds,
                "nearBowl": second in supported_seconds,
                "eatingVerified": second in verified_seconds,
            }
            for second in range(30)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        feeding = [item for item in summary["markers"] if item["markerType"].startswith("feeding_")]
        self.assertEqual([item["offsetSec"] for item in feeding], [5, 21])

    def test_build_markers_uses_observed_face_only_to_bridge_existing_feeding_anchors(self):
        verified_seconds = {5, 6, 7, 25, 26, 27}
        frames = [
            {
                "second": second,
                "hasCat": second in verified_seconds,
                "nearBowl": second in verified_seconds,
                "eatingVerified": second in verified_seconds,
                "behaviorEvidence": {"faceObserved": 5 <= second <= 27},
            }
            for second in range(35)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        self.assertTrue(summary["hasFeeding"])

    def test_build_markers_does_not_start_feeding_from_observed_face_alone(self):
        frames = [
            {
                "second": second,
                "hasCat": True,
                "nearBowl": True,
                "eatingVerified": False,
                "behaviorEvidence": {"faceObserved": True},
            }
            for second in range(35)
        ]

        summary = build_markers(parse_begin_ms("2026-07-06 08:30:00"), frames)

        self.assertFalse(summary["hasFeeding"])


if __name__ == "__main__":
    unittest.main()
