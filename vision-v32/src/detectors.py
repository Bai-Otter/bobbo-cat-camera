from __future__ import annotations

import importlib.util
import os
import threading
from contextlib import nullcontext
from functools import lru_cache
from typing import Any

from .opencv_cascades import resolve_haar_cascade_path


CAT_CLASS_NAME = "cat"
FACE_CLASS_NAME = "face"
DEFAULT_YOLO_MODEL = "yolo11s.pt"
_YOLO_MODEL_LOCKS: dict[str, threading.Lock] = {}
_YOLO_MODEL_LOCKS_GUARD = threading.Lock()


def yolo_available() -> bool:
    return importlib.util.find_spec("ultralytics") is not None


@lru_cache(maxsize=4)
def load_yolo_model(model_path: str) -> Any:
    from ultralytics import YOLO

    return YOLO(model_path)


def yolo_model_lock(model_path: str) -> threading.Lock:
    with _YOLO_MODEL_LOCKS_GUARD:
        return _YOLO_MODEL_LOCKS.setdefault(model_path, threading.Lock())


def resolve_yolo_model_path(model_path: str | None = None) -> str:
    requested = str(model_path or "").strip()
    configured = str(
        os.getenv("CAT_VISION_YOLO_MODEL")
        or os.getenv("FEED_ANALYSIS_YOLO_MODEL")
        or ""
    ).strip()

    if requested and os.path.isfile(requested):
        return requested
    if (
        configured
        and os.path.isfile(configured)
        and (not requested or os.path.basename(requested) == DEFAULT_YOLO_MODEL)
    ):
        return configured

    is_cloud_hosting = str(os.getenv("WECHAT_CLOUD_HOSTING") or "").lower() in {
        "1",
        "true",
    }
    if is_cloud_hosting:
        attempted = requested or configured or DEFAULT_YOLO_MODEL
        raise FileNotFoundError(f"YOLO_MODEL_NOT_FOUND: {attempted}")

    return requested or configured or DEFAULT_YOLO_MODEL


def resolve_detection_target(requested: str | None = "face") -> str:
    target = str(requested or "face").strip().lower()
    if target in {"cat", "face"}:
        return target
    raise ValueError(f"Unsupported detection target: {requested}")


def resolve_detector_backend(requested: str | None = "auto", yolo_available: bool | None = None) -> str:
    backend = str(requested or "auto").strip().lower()
    if backend in {"opencv", "haar"}:
        return "opencv"
    if backend == "yolo":
        return "yolo"
    if backend == "auto":
        available = yolo_available if yolo_available is not None else globals()["yolo_available"]()
        return "yolo" if available else "opencv"
    raise ValueError(f"Unsupported detector backend: {requested}")


def scalar_value(value: Any) -> float:
    if hasattr(value, "item"):
        return float(value.item())
    return float(value)


def vector_values(value: Any) -> list[float]:
    if hasattr(value, "tolist"):
        return [float(item) for item in value.tolist()]
    return [float(item) for item in value]


def boxes_from_yolo_result(
    result: Any,
    min_confidence: float = 0.25,
    target: str | None = CAT_CLASS_NAME,
) -> list[dict[str, Any]]:
    target_class_name = resolve_detection_target(target)
    names = getattr(result, "names", {}) or {}
    boxes = []
    for box in getattr(result, "boxes", []) or []:
        class_id = int(scalar_value(box.cls[0]))
        class_name = str(names.get(class_id, class_id)).lower()
        confidence = round(scalar_value(box.conf[0]), 4)
        if class_name != target_class_name or confidence < min_confidence:
            continue

        x1, y1, x2, y2 = vector_values(box.xyxy[0])
        boxes.append(
            {
                "x": int(round(x1)),
                "y": int(round(y1)),
                "width": int(round(x2 - x1)),
                "height": int(round(y2 - y1)),
                "confidence": confidence,
                "className": target_class_name,
            }
        )
    return boxes


class HaarCatDetector:
    backend = "opencv"

    def __init__(self, cv2: Any):
        cascade_path = resolve_haar_cascade_path(
            cv2,
            "haarcascade_frontalcatface_extended.xml",
        )
        self.cv2 = cv2
        self.classifier = cv2.CascadeClassifier(cascade_path)
        self.fallback_error = ""

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        if self.classifier.empty():
            return []
        gray = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2GRAY)
        faces = self.classifier.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=3, minSize=(48, 48))
        return [
            {
                "x": int(x),
                "y": int(y),
                "width": int(width),
                "height": int(height),
                "confidence": 0.92,
                "className": CAT_CLASS_NAME,
            }
            for (x, y, width, height) in faces
        ]


class HaarFaceDetector:
    backend = "opencv-face"

    def __init__(self, cv2: Any):
        cascade_path = resolve_haar_cascade_path(
            cv2,
            "haarcascade_frontalface_default.xml",
        )
        self.cv2 = cv2
        self.classifier = cv2.CascadeClassifier(cascade_path)
        self.fallback_error = ""

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        if self.classifier.empty():
            return []
        gray = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2GRAY)
        faces = self.classifier.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(48, 48))
        return [
            {
                "x": int(x),
                "y": int(y),
                "width": int(width),
                "height": int(height),
                "confidence": 0.9,
                "className": FACE_CLASS_NAME,
            }
            for (x, y, width, height) in faces
        ]


class YoloCatDetector:
    backend = "yolo"

    def __init__(self, model_path: str | None = None, min_confidence: float = 0.25):
        self.model_path = resolve_yolo_model_path(model_path)
        self.min_confidence = min_confidence
        self.model = load_yolo_model(self.model_path)
        self.model_lock = yolo_model_lock(self.model_path)
        self.fallback_error = ""

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        return self.detect_many([frame])[0]

    def detect_many(self, frames: list[Any]) -> list[list[dict[str, Any]]]:
        if not frames:
            return []
        with getattr(self, "model_lock", nullcontext()):
            results = self.model(frames, verbose=False, conf=self.min_confidence)
        return [
            boxes_from_yolo_result(result, min_confidence=self.min_confidence, target=CAT_CLASS_NAME)
            for result in results
        ]


def create_target_detector(
    cv2: Any,
    target: str | None = "face",
    backend: str | None = "auto",
    yolo_model: str | None = None,
    min_confidence: float = 0.25,
) -> HaarCatDetector | HaarFaceDetector | YoloCatDetector:
    selected_target = resolve_detection_target(target)
    if selected_target == FACE_CLASS_NAME:
        detector = HaarFaceDetector(cv2)
        requested_backend = str(backend or "auto").strip().lower()
        if requested_backend == "yolo":
            detector.fallback_error = "FACE_YOLO_UNSUPPORTED"
        return detector

    return create_cat_detector(
        cv2,
        backend=backend,
        yolo_model=yolo_model,
        min_confidence=min_confidence,
    )


def create_cat_detector(
    cv2: Any,
    backend: str | None = "auto",
    yolo_model: str | None = None,
    min_confidence: float = 0.25,
) -> HaarCatDetector | YoloCatDetector:
    selected = resolve_detector_backend(backend)
    if selected == "yolo":
        try:
            return YoloCatDetector(model_path=yolo_model, min_confidence=min_confidence)
        except Exception as error:
            fallback = HaarCatDetector(cv2)
            fallback.fallback_error = f"YOLO_UNAVAILABLE: {error}"
            return fallback
    return HaarCatDetector(cv2)
