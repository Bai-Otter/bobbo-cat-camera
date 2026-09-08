import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from src.cat_face import _ensure_model, _input_square_size


class CatFaceModelTests(unittest.TestCase):
    def test_reads_the_square_input_size_from_each_model(self):
        class FakeInterpreter:
            def get_input_details(self):
                return [{"shape": np.array([1, 384, 384, 3])}]

        self.assertEqual(_input_square_size(FakeInterpreter()), 384)

    def test_cloud_rejects_missing_face_model_without_downloading(self):
        with tempfile.TemporaryDirectory() as model_dir, patch.dict(
            "os.environ",
            {
                "WECHAT_CLOUD_HOSTING": "true",
                "CAT_FACE_MODEL_DIR": model_dir,
            },
            clear=True,
        ), patch("urllib.request.urlretrieve") as download:
            with self.assertRaisesRegex(FileNotFoundError, "CAT_FACE_MODEL_NOT_FOUND"):
                _ensure_model("cat_face_localizer.tflite")

        download.assert_not_called()

    def test_cloud_accepts_existing_face_model(self):
        with tempfile.TemporaryDirectory() as model_dir:
            model_path = Path(model_dir, "cat_face_localizer.tflite")
            model_path.write_bytes(b"original-local-model")
            with patch.dict(
                "os.environ",
                {
                    "WECHAT_CLOUD_HOSTING": "true",
                    "CAT_FACE_MODEL_DIR": model_dir,
                },
                clear=True,
            ):
                self.assertEqual(_ensure_model(model_path.name), model_path)


if __name__ == "__main__":
    unittest.main()
