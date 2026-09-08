import unittest

from evaluation.cute_segments import build_cute_segments, segment_for_offset, smooth_cute_samples


def frames(values, *, relation="toward_camera", relations=None, has_cat=True):
    return [
        {
            "offsetSec": index * 0.5,
            "hasCat": has_cat,
            "rankScore": score,
            "cuteEvidence": {
                "cuteScore": score,
                "modelConfidence": 0.9,
                "faceRelation": relations[index] if relations else relation,
            },
        }
        for index, score in enumerate(values)
    ]


class CuteSegmentTests(unittest.TestCase):
    def test_smoothing_keeps_raw_peak_but_adds_continuity_score(self):
        result = smooth_cute_samples(frames([0.2, 0.2, 0.95, 0.2, 0.2]))
        self.assertEqual(result[2]["rankScore"], 0.95)
        self.assertGreater(result[2]["continuityScore"], 0.2)
        self.assertLess(result[2]["continuityScore"], 0.95)

    def test_short_cat_analysis_gap_gets_continuity_interpolation(self):
        data = frames([0.7, 0.0, 0.8])
        data[1]["cuteEvidence"]["modelConfidence"] = 0.0
        result = smooth_cute_samples(data)
        self.assertEqual(result[1]["rankScore"], 0.0)
        self.assertGreater(result[1]["continuityScore"], 0.6)

    def test_real_evidence_is_not_over_suppressed_by_a_zero_neighbor(self):
        result = smooth_cute_samples(frames([0.8, 0.0, 0.0]))
        self.assertGreaterEqual(result[0]["continuityScore"], 0.64)

    def test_single_peak_expands_to_at_least_four_seconds(self):
        result = build_cute_segments(frames([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.95, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), duration_sec=8)
        self.assertEqual(len(result), 1)
        self.assertGreaterEqual(result[0]["durationSec"], 4.0)
        self.assertLessEqual(result[0]["durationSec"], 6.0)
        self.assertEqual(result[0]["anchorOffsetSec"], 4.0)

    def test_looking_away_is_not_an_anchor_but_can_be_a_short_transition(self):
        data = frames(
            [0.6, 0.6, 0.9, 0.6, 0.9, 0.6, 0.6, 0.6, 0.6],
            relations=[
                "toward_camera", "toward_camera", "looking_away", "toward_camera",
                "toward_camera", "toward_camera", "toward_camera", "toward_camera", "toward_camera",
            ],
        )
        result = build_cute_segments(data, duration_sec=4.5)
        self.assertTrue(result)
        self.assertEqual(result[0]["anchorOffsetSec"], 2.0)
        self.assertLessEqual(result[0]["badTransitionSec"], 1.0)
        self.assertGreater(result[0]["minContinuityScore"], 0.0)

    def test_no_cat_gap_longer_than_one_second_ends_segment(self):
        data = frames([0.5] * 20)
        data[8]["rankScore"] = 0.9
        data[8]["cuteEvidence"]["cuteScore"] = 0.9
        for index in range(13, len(data)):
            data[index]["hasCat"] = False
            data[index]["cuteEvidence"]["modelConfidence"] = 0.0
        result = build_cute_segments(data, duration_sec=10)
        self.assertTrue(result)
        self.assertLessEqual(result[0]["missingCatSec"], 1.0)
        self.assertLessEqual(result[0]["endSec"], 7.0)

    def test_nearby_peaks_merge_and_long_result_is_split(self):
        values = [0.5] * 25
        for index in (8, 14, 20):
            values[index] = 0.95
        result = build_cute_segments(
            frames(values),
            duration_sec=12.5,
            config={"targetSegmentSec": 6.0, "maxSegmentSec": 8.0},
        )
        self.assertGreaterEqual(len(result), 2)
        self.assertTrue(all(item["durationSec"] >= 4.0 for item in result))
        self.assertTrue(all(item["durationSec"] <= 8.0 for item in result))
        self.assertEqual(result, sorted(result, key=lambda item: item["startSec"]))
        for first, second in zip(result, result[1:]):
            self.assertLessEqual(first["endSec"], second["startSec"])

    def test_segment_lookup_returns_segment_number(self):
        segments = [{"startSec": 1.0, "endSec": 5.0}]
        self.assertEqual(segment_for_offset(segments, 2.0), (1, segments[0]))
        self.assertIsNone(segment_for_offset(segments, 5.0))


if __name__ == "__main__":
    unittest.main()
