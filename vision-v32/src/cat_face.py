from __future__ import annotations

import os
import threading
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np


MODEL_BASE_URL = (
    "https://raw.githubusercontent.com/hugocornellier/cat_detection/main/assets/models"
)
FACE_LOCALIZER_FILE = "cat_face_localizer.tflite"
FACE_LANDMARK_FILE = "cat_face_landmarks_full.tflite"
_MODEL_LOCK = threading.Lock()


def _model_root() -> Path:
    configured = str(os.environ.get("CAT_FACE_MODEL_DIR") or "").strip()
    if configured:
        return Path(configured)
    local_root = Path(__file__).resolve().parents[1] / "data" / "models" / "hugocornellier-cat-detection"
    if local_root.exists():
        return local_root
    return Path.home() / ".cache" / "cat-vision" / "models" / "cat-face"


def _ensure_model(file_name: str) -> Path:
    path = _model_root() / file_name
    if path.exists() and path.stat().st_size > 0:
        return path
    if str(os.environ.get("WECHAT_CLOUD_HOSTING") or "").lower() in {"1", "true"}:
        raise FileNotFoundError(f"CAT_FACE_MODEL_NOT_FOUND: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".download")
    urllib.request.urlretrieve(f"{MODEL_BASE_URL}/{file_name}", temporary)
    temporary.replace(path)
    return path


def _interpreter(path: Path) -> Any:
    from ai_edge_litert.interpreter import Interpreter

    interpreter = Interpreter(model_path=str(path))
    interpreter.allocate_tensors()
    return interpreter


@lru_cache(maxsize=1)
def load_cat_face_models() -> tuple[Any, Any]:
    return (
        _interpreter(_ensure_model(FACE_LOCALIZER_FILE)),
        _interpreter(_ensure_model(FACE_LANDMARK_FILE)),
    )


def _run(interpreter: Any, values: np.ndarray) -> np.ndarray:
    input_detail = interpreter.get_input_details()[0]
    output_detail = interpreter.get_output_details()[0]
    interpreter.set_tensor(input_detail["index"], values.astype(input_detail["dtype"]))
    interpreter.invoke()
    return np.asarray(interpreter.get_tensor(output_detail["index"]))


def _input_square_size(interpreter: Any) -> int:
    input_detail = interpreter.get_input_details()[0]
    shape = np.asarray(input_detail.get("shape", [])).reshape(-1)
    if (
        len(shape) != 4
        or int(shape[1]) <= 0
        or int(shape[2]) <= 0
        or int(shape[1]) != int(shape[2])
    ):
        raise ValueError(f"CAT_FACE_MODEL_INPUT_INVALID: {shape.tolist()}")
    return int(shape[1])


def _letterbox(frame: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    import cv2

    height, width = frame.shape[:2]
    scale = min(size / max(1, width), size / max(1, height))
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    resized = cv2.resize(frame, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    pad_left = (size - resized_width) // 2
    pad_top = (size - resized_height) // 2
    padded = cv2.copyMakeBorder(
        resized,
        pad_top,
        size - resized_height - pad_top,
        pad_left,
        size - resized_width - pad_left,
        cv2.BORDER_CONSTANT,
        value=(0, 0, 0),
    )
    return padded, scale, pad_left, pad_top


def _expanded_crop(
    frame: np.ndarray,
    box: dict[str, Any] | None,
    margin: float,
) -> tuple[np.ndarray, int, int]:
    height, width = frame.shape[:2]
    if not box:
        return frame, 0, 0
    box_width = max(1.0, float(box.get("width") or 0))
    box_height = max(1.0, float(box.get("height") or 0))
    left = max(0, int(float(box.get("x") or 0) - box_width * margin))
    top = max(0, int(float(box.get("y") or 0) - box_height * margin))
    right = min(width, int(float(box.get("x") or 0) + box_width * (1 + margin)))
    bottom = min(height, int(float(box.get("y") or 0) + box_height * (1 + margin)))
    if right <= left or bottom <= top:
        return frame, 0, 0
    return frame[top:bottom, left:right], left, top


class CatFaceLandmarkEstimator:
    def __init__(self, models: tuple[Any, Any] | None = None, crop_margin: float = 0.2):
        self._models = models
        self.crop_margin = float(crop_margin)

    @property
    def models(self) -> tuple[Any, Any]:
        if self._models is None:
            self._models = load_cat_face_models()
        return self._models

    def estimate(self, frame: np.ndarray, cat_boxes: list[dict[str, Any]]) -> dict[str, Any] | None:
        import cv2

        reliable_boxes = [
            box
            for box in cat_boxes
            if float(box.get("confidence") or 0) >= 0.2
            and float(box.get("width") or 0) > 0
            and float(box.get("height") or 0) > 0
        ]
        cat_box = max(
            reliable_boxes,
            key=lambda box: float(box["width"]) * float(box["height"]),
            default=None,
        )
        body_crop, body_left, body_top = _expanded_crop(frame, cat_box, self.crop_margin)
        localizer_size = _input_square_size(self.models[0])
        padded, scale, pad_left, pad_top = _letterbox(body_crop, localizer_size)
        localizer_input = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB).astype(np.float32)[None] / 255.0
        with _MODEL_LOCK:
            raw_box = _run(self.models[0], localizer_input).reshape(-1)[:4] * localizer_size

        first_x, second_x = sorted((float(raw_box[0]), float(raw_box[2])))
        first_y, second_y = sorted((float(raw_box[1]), float(raw_box[3])))
        crop_height, crop_width = body_crop.shape[:2]
        face_left = max(0.0, min(crop_width, (first_x - pad_left) / scale)) + body_left
        face_top = max(0.0, min(crop_height, (first_y - pad_top) / scale)) + body_top
        face_right = max(0.0, min(crop_width, (second_x - pad_left) / scale)) + body_left
        face_bottom = max(0.0, min(crop_height, (second_y - pad_top) / scale)) + body_top
        face_width = face_right - face_left
        face_height = face_bottom - face_top
        if face_width < 8 or face_height < 8:
            return None

        face_box = {
            "x": round(face_left, 2),
            "y": round(face_top, 2),
            "width": round(face_width, 2),
            "height": round(face_height, 2),
        }
        face_crop, face_crop_left, face_crop_top = _expanded_crop(
            frame,
            face_box,
            self.crop_margin,
        )
        landmark_size = _input_square_size(self.models[1])
        landmark_input = cv2.cvtColor(
            cv2.resize(
                face_crop,
                (landmark_size, landmark_size),
                interpolation=cv2.INTER_LINEAR,
            ),
            cv2.COLOR_BGR2RGB,
        ).astype(np.float32)[None] / 255.0
        with _MODEL_LOCK:
            raw_landmarks = _run(self.models[1], landmark_input).reshape(-1, 2)[:48]
        face_crop_height, face_crop_width = face_crop.shape[:2]
        landmarks = [
            [
                round(float(np.clip(point[0], 0, 1) * face_crop_width + face_crop_left), 2),
                round(float(np.clip(point[1], 0, 1) * face_crop_height + face_crop_top), 2),
            ]
            for point in raw_landmarks
        ]
        return {"faceBox": face_box, "landmarks": landmarks}
