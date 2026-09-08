from __future__ import annotations

import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any


APT36K_VITPOSE_SMALL = (
    "https://huggingface.co/JunkyByte/easy_ViTPose/resolve/main/onnx/apt36k/"
    "vitpose-s-apt36k.onnx"
)
POSE_MODEL_FILE = "vitpose-s-apt36k.onnx"
_POSE_MODEL_LOCK = threading.Lock()


def resolve_animal_pose_model() -> str:
    configured = str(os.environ.get("CAT_VISION_POSE_MODEL") or "").strip()
    is_cloud_hosting = str(os.environ.get("WECHAT_CLOUD_HOSTING") or "").lower() in {
        "1",
        "true",
    }
    if configured:
        if Path(configured).is_file():
            return configured
        if is_cloud_hosting:
            raise FileNotFoundError(f"ANIMAL_POSE_MODEL_NOT_FOUND: {configured}")

    bundled = Path(__file__).resolve().parents[1] / "models" / POSE_MODEL_FILE
    if bundled.is_file():
        return str(bundled)
    if is_cloud_hosting:
        raise FileNotFoundError(f"ANIMAL_POSE_MODEL_NOT_FOUND: {bundled}")
    return APT36K_VITPOSE_SMALL


@lru_cache(maxsize=1)
def load_animal_pose_model() -> Any:
    from rtmlib import ViTPose

    return ViTPose(
        resolve_animal_pose_model(),
        model_input_size=(192, 256),
        backend="onnxruntime",
        device="cpu",
    )


class RtmlibAnimalPoseEstimator:
    def __init__(self, model: Any | None = None, min_box_confidence: float = 0.35):
        self._model = model
        self.min_box_confidence = float(min_box_confidence)

    @property
    def model(self) -> Any:
        if self._model is None:
            self._model = load_animal_pose_model()
        return self._model

    def estimate(self, frame: Any, cat_boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        reliable_boxes = [
            box
            for box in cat_boxes
            if float(box.get("confidence") or 0) >= self.min_box_confidence
            and float(box.get("width") or 0) > 0
            and float(box.get("height") or 0) > 0
        ]
        if not reliable_boxes:
            return []

        bboxes = [
            [
                float(box["x"]),
                float(box["y"]),
                float(box["x"]) + float(box["width"]),
                float(box["y"]) + float(box["height"]),
            ]
            for box in reliable_boxes
        ]
        with _POSE_MODEL_LOCK:
            keypoints, scores = self.model(frame, bboxes=bboxes)
        return [
            {
                "keypoints": [[round(float(value), 4) for value in point] for point in pose_keypoints],
                "scores": [round(float(value), 4) for value in pose_scores],
                "catBox": reliable_boxes[index],
            }
            for index, (pose_keypoints, pose_scores) in enumerate(zip(keypoints, scores))
        ]
