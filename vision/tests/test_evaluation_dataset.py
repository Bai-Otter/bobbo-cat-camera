import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vision.evaluation.cat_chew_adapter import windows_to_intervals
from vision.evaluation.dataset import DatasetValidationError, load_manifest, validate_manifest
from vision.evaluation.metrics import evaluate_dataset, evaluate_sample


class EvaluationDatasetTests(unittest.TestCase):
    def manifest(self, directory: Path):
        video = directory / "meal.mp4"
        video.write_bytes(b"video")
        manifest_path = directory / "manifest.json"
        manifest_path.write_text("{}", encoding="utf-8")
        return {
            "_manifestPath": str(manifest_path),
            "samples": [{
                "id": "meal-1",
                "catId": "cat-1",
                "split": "test",
                "durationSec": 10,
                "labelStatus": "complete",
                "media": [{"id": "raw", "path": str(video)}],
                "labels": [
                    {"state": "not_eating", "startSec": 0, "endSec": 2},
                    {"state": "chewing", "startSec": 2, "endSec": 8},
                    {"state": "uncertain", "startSec": 8, "endSec": 10},
                ],
            }],
        }

    def test_validates_paths_labels_and_cat_level_splits(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = self.manifest(Path(temp_dir))
            result = validate_manifest(manifest)
            self.assertTrue(result["accuracyReady"])
            manifest["samples"].append({**manifest["samples"][0], "id": "meal-2", "split": "train"})
            with self.assertRaisesRegex(DatasetValidationError, "CAT_SPLIT_LEAKAGE"):
                validate_manifest(manifest)

    def test_rejects_overlap_and_pending_accuracy(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = self.manifest(Path(temp_dir))
            manifest["samples"][0]["labels"][1]["startSec"] = 1
            with self.assertRaisesRegex(DatasetValidationError, "LABEL_OVERLAP"):
                validate_manifest(manifest)
            manifest = self.manifest(Path(temp_dir))
            manifest["samples"][0]["labelStatus"] = "pending"
            with self.assertRaisesRegex(DatasetValidationError, "GROUND_TRUTH_INCOMPLETE"):
                evaluate_dataset(manifest["samples"])

    def test_resolves_environment_media_paths_without_tracking_private_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            manifest = self.manifest(directory)
            manifest["samples"][0]["media"] = [{"id": "compressed", "pathEnv": "BOBBO_TEST_VIDEO"}]
            with patch.dict(os.environ, {"BOBBO_TEST_VIDEO": str(directory / "meal.mp4")}):
                self.assertTrue(validate_manifest(manifest)["ok"])

    def test_manifest_loader_keeps_source_location_for_relative_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "manifest.json"
            path.write_text(json.dumps({"samples": []}), encoding="utf-8")
            loaded = load_manifest(path)
            self.assertEqual(loaded["_manifestPath"], str(path.resolve()))


class EvaluationMetricTests(unittest.TestCase):
    def test_reports_state_and_combined_eating_metrics_by_duration(self):
        truth = [
            {"state": "not_eating", "startSec": 0, "endSec": 4},
            {"state": "chewing", "startSec": 4, "endSec": 8},
            {"state": "licking", "startSec": 8, "endSec": 10},
            {"state": "uncertain", "startSec": 10, "endSec": 12},
        ]
        predicted = [
            {"state": "not_eating", "startSec": 0, "endSec": 3},
            {"state": "chewing", "startSec": 3, "endSec": 9},
            {"state": "licking", "startSec": 9, "endSec": 10},
            {"state": "not_eating", "startSec": 10, "endSec": 12},
        ]
        result = evaluate_sample(truth, predicted)
        self.assertAlmostEqual(result["combinedEatingRecall"], 1.0)
        self.assertAlmostEqual(result["nonEatingFalsePositiveRate"], 0.25)
        self.assertAlmostEqual(result["actualEatingDurationErrorSeconds"], 1.0)
        self.assertAlmostEqual(result["perState"]["licking"]["recall"], 0.5)

    def test_chewmeter_windows_are_merged_into_binary_state_intervals(self):
        intervals = windows_to_intervals([
            {"t": 3.25, "eating": False},
            {"t": 3.50, "eating": False},
            {"t": 3.75, "eating": True},
        ], 0.25)
        self.assertEqual(intervals, [
            {"state": "not_eating", "startSec": 3.0, "endSec": 3.5},
            {"state": "chewing", "startSec": 3.5, "endSec": 3.75},
        ])


if __name__ == "__main__":
    unittest.main()
