from __future__ import annotations

import os
import threading
from functools import lru_cache
from typing import Any, Sequence

import numpy as np


_SEGMENTATION_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def load_cat_segmentation_model() -> Any:
    from ultralytics import YOLO

    model_path = str(os.environ.get("CAT_VISION_SEG_MODEL") or "yolo11s-seg.pt")
    return YOLO(model_path)


class CatMaskContactEstimator:
    def __init__(self, model: Any | None = None, min_confidence: float = 0.1):
        self._model = model
        self.min_confidence = float(min_confidence)

    @property
    def model(self) -> Any:
        if self._model is None:
            self._model = load_cat_segmentation_model()
        return self._model

    def estimate_many(
        self,
        frames: Sequence[np.ndarray],
        bowl_roi: dict[str, Any],
    ) -> list[dict[str, Any]]:
        import cv2

        from .feeding_behavior import evaluate_mask_contact

        if not frames:
            return []
        with _SEGMENTATION_LOCK:
            outputs = self.model.predict(
                list(frames),
                classes=[15],
                conf=self.min_confidence,
                verbose=False,
            )

        evidence = []
        for frame, output in zip(frames, outputs):
            candidates = []
            masks = getattr(output, "masks", None)
            boxes = getattr(output, "boxes", None)
            if masks is not None and boxes is not None:
                raw_masks = masks.data.cpu().numpy()
                for box, raw_mask in zip(boxes, raw_masks):
                    resized_mask = cv2.resize(
                        raw_mask,
                        (frame.shape[1], frame.shape[0]),
                        interpolation=cv2.INTER_NEAREST,
                    )
                    candidates.append(
                        evaluate_mask_contact(
                            resized_mask,
                            bowl_roi,
                            detector_confidence=float(box.conf[0]),
                        )
                    )
            if candidates:
                evidence.append(
                    max(
                        candidates,
                        key=lambda item: (
                            bool(item.get("verified")),
                            float(item.get("maskContactRatio") or 0),
                            float(item.get("detectorConfidence") or 0),
                        ),
                    )
                )
            else:
                evidence.append(evaluate_mask_contact(None, bowl_roi))
        return evidence
