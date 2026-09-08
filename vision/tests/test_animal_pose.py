import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

import numpy as np

from src.animal_pose import RtmlibAnimalPoseEstimator, resolve_animal_pose_model


class FakePoseModel:
    def __init__(self):
        self.calls = []

    def __call__(self, frame, bboxes):
        self.calls.append((frame, bboxes))
        keypoints = np.zeros((len(bboxes), 17, 2), dtype=np.float32)
        scores = np.full((len(bboxes), 17), 0.8, dtype=np.float32)
        return keypoints, scores


class AnimalPoseEstimatorTests(unittest.TestCase):
    def test_cloud_uses_configured_local_pose_model(self):
        with tempfile.TemporaryDirectory() as model_dir:
            model_path = Path(model_dir, "vitpose-s-apt36k.onnx")
            model_path.touch()
            with patch.dict(
                "os.environ",
                {
                    "WECHAT_CLOUD_HOSTING": "true",
                    "CAT_VISION_POSE_MODEL": str(model_path),
                },
                clear=True,
            ):
                self.assertEqual(resolve_animal_pose_model(), str(model_path))

    def test_cloud_rejects_missing_pose_model_without_downloading(self):
        with patch.dict(
            "os.environ",
            {
                "WECHAT_CLOUD_HOSTING": "true",
                "CAT_VISION_POSE_MODEL": "missing-vitpose.onnx",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(FileNotFoundError, "ANIMAL_POSE_MODEL_NOT_FOUND"):
                resolve_animal_pose_model()

    def test_reuses_yolo_boxes_as_xyxy_pose_inputs(self):
        model = FakePoseModel()
        estimator = RtmlibAnimalPoseEstimator(model=model)
        frame = np.zeros((120, 200, 3), dtype=np.uint8)

        poses = estimator.estimate(
            frame,
            [{"x": 20, "y": 30, "width": 80, "height": 60, "confidence": 0.9}],
        )

        self.assertEqual(model.calls[0][1], [[20.0, 30.0, 100.0, 90.0]])
        self.assertEqual(len(poses), 1)
        self.assertEqual(poses[0]["scores"][0], 0.8)

    def test_skips_boxes_below_pose_confidence_threshold(self):
        model = FakePoseModel()
        estimator = RtmlibAnimalPoseEstimator(model=model, min_box_confidence=0.35)

        poses = estimator.estimate(
            np.zeros((80, 80, 3), dtype=np.uint8),
            [{"x": 1, "y": 2, "width": 10, "height": 20, "confidence": 0.2}],
        )

        self.assertEqual(poses, [])
        self.assertEqual(model.calls, [])


if __name__ == "__main__":
    unittest.main()
