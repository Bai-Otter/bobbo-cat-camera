import unittest

from evaluation.cute_annotation import (
    CuteAnnotationError,
    evaluate_dataset,
    normalize_dataset,
    rank_positive,
    rank_timeline,
    timeline_alignment,
    tune_policy,
    validate_timeline_alignment,
)


def dataset():
    return {
        "datasetVersion": 1,
        "videos": [
            {
                "id": "v1",
                "name": "one.mp4",
                "durationSec": 3,
                "frames": [
                    {"offsetSec": 0, "cuteEvidence": {"cuteScore": 0.9, "modelConfidence": 0.9, "faceRelation": "toward_camera", "sizeScore": 0.9}},
                    {"offsetSec": 1, "cuteEvidence": {"cuteScore": 0.2, "modelConfidence": 0.9, "faceRelation": "head_down", "sizeScore": 0.8}},
                    {"offsetSec": 2, "cuteEvidence": {"cuteScore": 0.8, "modelConfidence": 0.4, "faceRelation": "toward_camera", "sizeScore": 0.8}},
                ],
            },
            {
                "id": "v2",
                "name": "two.mp4",
                "durationSec": 2.5,
                "frames": [
                    {"offsetSec": 0, "cuteEvidence": {"cuteScore": 0.8, "modelConfidence": 0.9, "faceRelation": "toward_camera"}},
                    {"offsetSec": 1, "cuteEvidence": {"cuteScore": 0.1, "modelConfidence": 0.9, "faceRelation": "looking_away"}},
                ],
            },
        ],
        "labels": [
            {"videoId": "v1", "startSec": 0, "endSec": 1, "verdict": "cute", "cuteValue": 5, "tags": ["closeup"]},
            {"videoId": "v1", "startSec": 1, "endSec": 2, "verdict": "exclude", "cuteValue": 1, "tags": ["head_down"]},
            {"videoId": "v1", "startSec": 2, "endSec": 3, "verdict": "cute", "cuteValue": 3, "tags": []},
            {"videoId": "v2", "startSec": 0, "endSec": 1, "verdict": "cute", "cuteValue": 4, "tags": []},
            {"videoId": "v2", "startSec": 1, "endSec": 2, "verdict": "exclude", "cuteValue": 1, "tags": []},
        ],
    }


class CuteAnnotationTests(unittest.TestCase):
    def test_normalize_extracts_evidence_and_rejects_overlap(self):
        normalized = normalize_dataset(dataset())
        self.assertEqual(len(normalized["videos"][0]["frames"]), 3)
        invalid = dataset()
        invalid["labels"].append({"videoId": "v1", "startSec": 0.5, "endSec": 1.5, "verdict": "cute", "cuteValue": 5})
        with self.assertRaisesRegex(CuteAnnotationError, "LABEL_OVERLAP"):
            normalize_dataset(invalid)

    def test_evaluate_reports_frame_confusion_and_per_video_results(self):
        result = evaluate_dataset(dataset(), {"minCuteScore": 0.65, "minModelConfidence": 0.65})
        self.assertEqual(result["tp"], 2)
        self.assertEqual(result["fn"], 1)
        self.assertEqual(result["fp"], 0)
        self.assertIn("v1", result["byVideo"])

    def test_tune_returns_policy_and_holdout_report(self):
        result = tune_policy(dataset(), {"v1"})
        self.assertIn("minCuteScore", result["policy"])
        self.assertEqual(result["trainVideoIds"], ["v1"])
        self.assertEqual(result["validationVideoIds"], ["v2"])
        self.assertIsNotNone(result["validation"])
        self.assertTrue(result["generalizationWarning"])

    def test_timeline_alignment_rejects_missing_tail_when_required(self):
        video = dataset()["videos"][0]
        video["durationSec"] = 10
        report = timeline_alignment(video)
        self.assertFalse(report["complete"])
        with self.assertRaisesRegex(CuteAnnotationError, "VIDEO_TIMELINE_INCOMPLETE"):
            validate_timeline_alignment({"datasetVersion": 1, "videos": [video], "labels": []}, require_complete=True)

    def test_rank_positive_does_not_treat_unlabeled_frames_as_negatives(self):
        result = rank_positive(dataset(), top_fraction=0.5)
        self.assertEqual(result["mode"], "positive-only-ranking")
        self.assertIsNone(result["classifierMetrics"])
        report = next(item for item in result["videos"] if item["videoId"] == "v1")
        self.assertEqual(report["positiveFrames"], 2)
        self.assertEqual(report["unlabeledFrames"], 1)
        self.assertIn("faceAreaRatio", report["featureStats"])
        self.assertIn("rankScore", report["topFrames"][0])

    def test_rank_timeline_returns_candidates(self):
        result = rank_timeline({"frames": dataset()["videos"][0]["frames"]}, top_fraction=0.5)
        self.assertEqual(result["mode"], "unlabeled-timeline-ranking")
        self.assertEqual(result["frameCount"], 3)
        self.assertGreaterEqual(len(result["topFrames"]), 1)


if __name__ == "__main__":
    unittest.main()
