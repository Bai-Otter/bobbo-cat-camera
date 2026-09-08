import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


WORKER_PATH = Path(__file__).with_name("vision_worker.py")


def load_worker_module():
    spec = importlib.util.spec_from_file_location("embedded_vision_worker", WORKER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class EmbeddedVisionWorkerTests(unittest.TestCase):
    def test_imports_without_cv2_data_when_debian_cascades_are_configured(self):
        fake_cv2 = types.ModuleType("cv2")
        with tempfile.TemporaryDirectory() as cascade_dir:
            for filename in (
                "haarcascade_frontalcatface_extended.xml",
                "haarcascade_frontalcatface.xml",
            ):
                Path(cascade_dir, filename).touch()

            with patch.dict(sys.modules, {"cv2": fake_cv2}), patch.dict(
                os.environ,
                {"OPENCV_HAAR_CASCADES": cascade_dir},
            ):
                worker = load_worker_module()

        self.assertEqual(
            worker.CAT_CASCADE_PATH,
            str(Path(cascade_dir, "haarcascade_frontalcatface_extended.xml")),
        )
        self.assertEqual(
            worker.CAT_CASCADE_RELAXED_PATH,
            str(Path(cascade_dir, "haarcascade_frontalcatface.xml")),
        )

    def test_recording_mode_delegates_to_vendored_v1_analyzer(self):
        worker = load_worker_module()
        captured = {}
        fake_package = types.ModuleType("src")
        fake_analyzer = types.ModuleType("src.analyzer")

        def analyze_recording(payload):
            captured.update(payload)
            return {
                "recordingKey": payload["recordingKey"],
                "target": payload["detectionTarget"],
                "hasCat": True,
                "hasFeeding": True,
                "markers": [{"markerType": "feeding_start", "offsetSec": 8}],
                "error": "",
            }

        fake_analyzer.analyze_recording = analyze_recording
        payload = {
            "sourceUrl": "D:/recording.mp4",
            "recording": {"BeginTime": "2026-07-16 15:50:24"},
            "recordingKey": "recording-v1",
            "beginTime": "2026-07-16 15:50:24",
            "bowlRoi": {"x": 10, "y": 20, "width": 30, "height": 40},
            "detectionTarget": "cat",
            "detectorBackend": "yolo",
            "yoloModel": "yolo11s.pt",
            "autoBowlDetection": True,
            "durationSec": 120,
        }

        with patch.dict(sys.modules, {"src": fake_package, "src.analyzer": fake_analyzer}):
            result = worker.analyze_v1_recording(payload)

        self.assertTrue(result["hasFeeding"])
        self.assertEqual(captured["sourceUrl"], "D:/recording.mp4")
        self.assertEqual(captured["recordingKey"], "recording-v1")
        self.assertEqual(captured["beginTime"], "2026-07-16 15:50:24")
        self.assertEqual(captured["bowlRoi"], payload["bowlRoi"])
        self.assertEqual(captured["detectionTarget"], "cat")
        self.assertEqual(captured["detectorBackend"], "yolo")
        self.assertEqual(captured["yoloModel"], "yolo11s.pt")
        self.assertTrue(captured["autoBowlDetection"])
        self.assertEqual(captured["durationSec"], 120)


if __name__ == "__main__":
    unittest.main()
