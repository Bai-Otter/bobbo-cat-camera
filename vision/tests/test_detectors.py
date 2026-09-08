import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.detectors import (
    HaarCatDetector,
    YoloCatDetector,
    boxes_from_yolo_result,
    load_yolo_model,
    resolve_detection_target,
    resolve_detector_backend,
    resolve_yolo_model_path,
)


class FakeScalar:
    def __init__(self, value):
        self.value = value

    def item(self):
        return self.value


class FakeVector:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return self.values


class FakeBox:
    def __init__(self, xyxy, confidence, class_id):
        self.xyxy = [FakeVector(xyxy)]
        self.conf = [FakeScalar(confidence)]
        self.cls = [FakeScalar(class_id)]


class FakeResult:
    names = {0: "person", 15: "cat", 16: "dog"}

    def __init__(self):
        self.boxes = [
            FakeBox([10, 20, 40, 70], 0.82, 15),
            FakeBox([1, 2, 3, 4], 0.91, 0),
            FakeBox([50, 60, 90, 120], 0.22, 15),
        ]


class DetectorTests(unittest.TestCase):
    def test_cloud_yolo_uses_configured_local_model_for_missing_default_name(self):
        with tempfile.TemporaryDirectory() as model_dir:
            model_path = Path(model_dir, "yolo11s.pt")
            model_path.touch()
            with patch.dict(
                "os.environ",
                {
                    "WECHAT_CLOUD_HOSTING": "true",
                    "CAT_VISION_YOLO_MODEL": str(model_path),
                },
                clear=True,
            ):
                resolved = resolve_yolo_model_path("yolo11s.pt")

        self.assertEqual(resolved, str(model_path))

    def test_cloud_yolo_rejects_missing_local_model_before_ultralytics_load(self):
        with patch.dict(
            "os.environ",
            {
                "WECHAT_CLOUD_HOSTING": "true",
                "CAT_VISION_YOLO_MODEL": "missing-yolo11s.pt",
            },
            clear=True,
        ), patch("src.detectors.load_yolo_model") as loader:
            with self.assertRaisesRegex(FileNotFoundError, "YOLO_MODEL_NOT_FOUND"):
                YoloCatDetector(model_path="yolo11s.pt")

        loader.assert_not_called()

    def test_haar_detector_uses_configured_cascades_without_cv2_data(self):
        classifier_paths = []
        fake_cv2 = SimpleNamespace(
            CascadeClassifier=lambda path: classifier_paths.append(path) or object(),
        )
        with tempfile.TemporaryDirectory() as cascade_dir:
            cascade_file = Path(cascade_dir, "haarcascade_frontalcatface_extended.xml")
            cascade_file.touch()

            with patch.dict("os.environ", {"OPENCV_HAAR_CASCADES": cascade_dir}):
                HaarCatDetector(fake_cv2)

            self.assertEqual(classifier_paths, [str(cascade_file)])

    def test_yolo_detector_defaults_to_yolo11s(self):
        with patch.dict("os.environ", {}, clear=True), patch(
            "src.detectors.load_yolo_model", return_value=object()
        ):
            detector = YoloCatDetector()

        self.assertEqual(detector.model_path, "yolo11s.pt")

    def test_resolve_detection_target_accepts_face_and_cat_only(self):
        self.assertEqual(resolve_detection_target("face"), "face")
        self.assertEqual(resolve_detection_target("cat"), "cat")
        self.assertEqual(resolve_detection_target(""), "face")
        with self.assertRaises(ValueError):
            resolve_detection_target("dog")

    def test_resolve_detector_backend_prefers_yolo_when_available(self):
        self.assertEqual(resolve_detector_backend("auto", yolo_available=True), "yolo")
        self.assertEqual(resolve_detector_backend("auto", yolo_available=False), "opencv")
        self.assertEqual(resolve_detector_backend("opencv", yolo_available=True), "opencv")

    def test_boxes_from_yolo_result_keeps_cat_boxes_above_threshold(self):
        boxes = boxes_from_yolo_result(FakeResult(), min_confidence=0.3, target="cat")

        self.assertEqual(
            boxes,
            [
                {
                    "x": 10,
                    "y": 20,
                    "width": 30,
                    "height": 50,
                    "confidence": 0.82,
                    "className": "cat",
                }
            ],
        )

    def test_yolo_detector_batches_frames_in_one_model_call(self):
        calls = []

        def fake_model(frames, **options):
            calls.append((frames, options))
            return [FakeResult() for _ in frames]

        detector = YoloCatDetector.__new__(YoloCatDetector)
        detector.model = fake_model
        detector.min_confidence = 0.3

        boxes_by_frame = detector.detect_many(["frame-1", "frame-2"])

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], ["frame-1", "frame-2"])
        self.assertEqual(calls[0][1], {"verbose": False, "conf": 0.3})
        self.assertEqual(len(boxes_by_frame), 2)
        self.assertEqual(boxes_by_frame[0][0]["className"], "cat")

    def test_yolo_model_is_loaded_once_per_weight_path(self):
        created = []

        def fake_yolo(path):
            model = {"path": path}
            created.append(model)
            return model

        load_yolo_model.cache_clear()
        try:
            with patch.dict("sys.modules", {"ultralytics": SimpleNamespace(YOLO=fake_yolo)}):
                first = YoloCatDetector(model_path="shared.pt")
                second = YoloCatDetector(model_path="shared.pt")

            self.assertEqual(len(created), 1)
            self.assertIs(first.model, second.model)
        finally:
            load_yolo_model.cache_clear()


if __name__ == "__main__":
    unittest.main()
