from __future__ import annotations

import math
import statistics
from typing import Any

from .detectors import create_target_detector, resolve_detection_target


AUTO_BOWL_CONFIRM_FRAMES = 3
AUTO_BOWL_MAX_WIDTH_RATIO = 0.20
AUTO_BOWL_MAX_HEIGHT_RATIO = 0.25
AUTO_BOWL_MAX_AREA_RATIO = 0.05
MIN_TARGET_CANDIDATE_CONFIDENCE = 0.35
MIN_TARGET_CLIP_CONFIDENCE = 0.5
DETECTION_BATCH_SIZE = 8
QUALITY_GATE_SAMPLE_COUNT = 8
MIN_LUMINANCE = 35.0
INFRARED_MAX_CHROMA = 4.0
INFRARED_MAX_LUMINANCE = 140.0
MAX_DARK_SAMPLE_RATIO = 0.75


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def rects_overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return not (
        a["x"] + a["width"] < b["x"]
        or b["x"] + b["width"] < a["x"]
        or a["y"] + a["height"] < b["y"]
        or b["y"] + b["height"] < a["y"]
    )


def centers_close(cat_box: dict[str, Any], bowl_box: dict[str, Any]) -> bool:
    cat_cx = cat_box["x"] + cat_box["width"] / 2
    cat_cy = cat_box["y"] + cat_box["height"] / 2
    bowl_cx = bowl_box["x"] + bowl_box["width"] / 2
    bowl_cy = bowl_box["y"] + bowl_box["height"] / 2
    distance = math.hypot(cat_cx - bowl_cx, cat_cy - bowl_cy)
    return distance <= max(bowl_box["width"], bowl_box["height"]) * 1.25


def is_plausible_bowl_roi(
    roi: dict[str, Any] | None,
    frame_width: int,
    frame_height: int,
) -> bool:
    if not roi or frame_width <= 0 or frame_height <= 0:
        return False
    try:
        x = int(roi["x"])
        y = int(roi["y"])
        width = int(roi["width"])
        height = int(roi["height"])
    except (KeyError, TypeError, ValueError):
        return False
    if x < 0 or y < 0 or width <= 0 or height <= 0:
        return False
    if x + width > frame_width or y + height > frame_height:
        return False
    if width > frame_width * AUTO_BOWL_MAX_WIDTH_RATIO:
        return False
    if height > frame_height * AUTO_BOWL_MAX_HEIGHT_RATIO:
        return False
    return width * height <= frame_width * frame_height * AUTO_BOWL_MAX_AREA_RATIO


def _roi_is_consistent(a: dict[str, Any], b: dict[str, Any]) -> bool:
    a_width = max(1, int(a["width"]))
    a_height = max(1, int(a["height"]))
    b_width = max(1, int(b["width"]))
    b_height = max(1, int(b["height"]))
    width_ratio = max(a_width, b_width) / min(a_width, b_width)
    height_ratio = max(a_height, b_height) / min(a_height, b_height)
    if width_ratio > 1.5 or height_ratio > 1.5:
        return False
    a_center = (int(a["x"]) + a_width / 2, int(a["y"]) + a_height / 2)
    b_center = (int(b["x"]) + b_width / 2, int(b["y"]) + b_height / 2)
    center_distance = math.hypot(a_center[0] - b_center[0], a_center[1] - b_center[1])
    return center_distance <= max(a_width, a_height, b_width, b_height) * 0.5


class BowlRoiConsensus:
    def __init__(self, required_observations: int = AUTO_BOWL_CONFIRM_FRAMES):
        self.required_observations = max(1, int(required_observations))
        self.candidates: list[dict[str, Any]] = []

    def add(self, roi: dict[str, Any] | None) -> dict[str, int] | None:
        if not roi:
            self.candidates = []
            return None
        candidate = {key: int(roi[key]) for key in ("x", "y", "width", "height")}
        if self.candidates and not _roi_is_consistent(self.candidates[-1], candidate):
            self.candidates = []
        self.candidates.append(candidate)
        if len(self.candidates) < self.required_observations:
            return None
        recent = self.candidates[-self.required_observations :]
        return {
            key: int(statistics.median(item[key] for item in recent))
            for key in ("x", "y", "width", "height")
        }


def detect_frame_batch(detector: Any, frames: list[Any]) -> list[list[dict[str, Any]]]:
    if not frames:
        return []
    detect_many = getattr(detector, "detect_many", None)
    boxes_by_frame = detect_many(frames) if callable(detect_many) else [detector.detect(frame) for frame in frames]
    if len(boxes_by_frame) != len(frames):
        raise RuntimeError("DETECTOR_BATCH_RESULT_MISMATCH")
    return boxes_by_frame


def assess_scene_quality(sample_frames: list[Any]) -> dict[str, Any]:
    samples = []
    for frame in sample_frames:
        if frame is None or getattr(frame, "ndim", 0) < 3 or frame.shape[2] < 3:
            continue
        pixels = frame[..., :3].astype("float32")
        luminance = float(
            (pixels[..., 0] * 0.114 + pixels[..., 1] * 0.587 + pixels[..., 2] * 0.299).mean()
        )
        chroma = float((pixels.max(axis=2) - pixels.min(axis=2)).mean())
        is_dark = luminance < MIN_LUMINANCE or (
            chroma < INFRARED_MAX_CHROMA and luminance < INFRARED_MAX_LUMINANCE
        )
        samples.append({"luminance": luminance, "chroma": chroma, "isDark": is_dark})

    sample_count = len(samples)
    dark_sample_count = sum(1 for sample in samples if sample["isDark"])
    return {
        "isDark": bool(sample_count and dark_sample_count / sample_count >= MAX_DARK_SAMPLE_RATIO),
        "sampleCount": sample_count,
        "darkSampleCount": dark_sample_count,
        "meanLuminance": round(
            sum(sample["luminance"] for sample in samples) / sample_count, 2
        )
        if sample_count
        else 0.0,
        "meanChroma": round(sum(sample["chroma"] for sample in samples) / sample_count, 2)
        if sample_count
        else 0.0,
    }


def apply_feeding_verification(
    source_url: str,
    frames: list[dict[str, Any]],
    bowl_roi: dict[str, Any] | None,
    target: str,
    verifier: Any | None = None,
    cute_analysis_all_scales: bool = False,
) -> list[dict[str, Any]]:
    def sample_key(frame: dict[str, Any]) -> int:
        return int(frame.get("sampleIndex", frame.get("second") or 0))

    enriched = [
        {
            **frame,
            "eatingVerified": False,
            "behaviorEvidence": {
                "eatingVerified": False,
                "confidence": 0.0,
                "reason": "NOT_A_FEEDING_CANDIDATE",
            },
        }
        for frame in frames
    ]
    if target != "cat" or not bowl_roi or not any(frame.get("nearBowl") for frame in enriched):
        return enriched
    if verifier is None:
        from .feeding_behavior import verify_candidate_behavior

        verifier = verify_candidate_behavior

    try:
        if cute_analysis_all_scales:
            evidence_by_sample = verifier(
                source_url,
                enriched,
                bowl_roi,
                cute_analysis_all_scales=True,
            ) or {}
        else:
            evidence_by_sample = verifier(source_url, enriched, bowl_roi) or {}
    except Exception as error:
        failure = {
            "eatingVerified": False,
            "confidence": 0.0,
            "reason": "BEHAVIOR_VERIFIER_FAILED",
            "error": str(error),
        }
        evidence_by_sample = {
            sample_key(frame): failure
            for frame in enriched
            if frame.get("nearBowl")
        }

    for frame in enriched:
        evidence = evidence_by_sample.get(sample_key(frame))
        if evidence is None:
            continue
        frame["behaviorEvidence"] = evidence
        frame["eatingVerified"] = bool(evidence.get("eatingVerified"))
        if isinstance(evidence.get("cuteEvidence"), dict):
            frame["cuteEvidence"] = dict(evidence["cuteEvidence"])
    return enriched


def expand_roi(roi: dict[str, Any], factor: float) -> dict[str, Any]:
    width = int(roi["width"])
    height = int(roi["height"])
    grow_w = int(width * factor)
    grow_h = int(height * factor)
    return {
        "x": int(roi["x"]) - grow_w,
        "y": int(roi["y"]) - grow_h,
        "width": width + grow_w * 2,
        "height": height + grow_h * 2,
    }


def detect_bowl(cv2: Any, frame: Any) -> tuple[dict[str, Any] | None, float]:
    height, width = frame.shape[:2]
    search_top = height // 2
    roi = frame[search_top:, :]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (9, 9), 2)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(20, width // 6),
        param1=100,
        param2=20,
        minRadius=max(12, min(width, height) // 40),
        maxRadius=max(40, min(width, height) // 8),
    )
    if circles is None:
        return None, 0.0
    for x, y, radius in sorted(circles[0], key=lambda item: item[2], reverse=True):
        roi_x = int(clamp(x - radius, 0, width))
        roi_y = int(clamp(search_top + y - radius, 0, height))
        bowl_roi = {
            "x": roi_x,
            "y": roi_y,
            "width": min(int(radius * 2), width - roi_x),
            "height": min(int(radius * 2), height - roi_y),
        }
        if not is_plausible_bowl_roi(bowl_roi, width, height):
            continue
        confidence = float(clamp(radius / max(width, height) * 8.0, 0.2, 0.95))
        return bowl_roi, confidence
    return None, 0.0


def read_video_frames(
    source_url: str,
    bowl_roi: dict[str, Any] | None = None,
    sample_seconds: float = 0.5,
    detector_backend: str | None = "auto",
    yolo_model: str | None = None,
    detection_target: str | None = "cat",
    auto_bowl_detection: bool = False,
    feeding_verifier: Any | None = None,
    cute_analysis_all_scales: bool = False,
) -> dict[str, Any]:
    try:
        import cv2
    except ImportError:
        return {"frames": [], "bowlRoi": bowl_roi, "error": "OPENCV_UNAVAILABLE"}

    capture = cv2.VideoCapture(source_url)
    if not capture.isOpened():
        return {"frames": [], "bowlRoi": bowl_roi, "error": "VIDEO_OPEN_FAILED"}

    target = resolve_detection_target(detection_target)
    target_detector = None
    fps = capture.get(cv2.CAP_PROP_FPS) or 25
    step = max(1, int(round(fps * sample_seconds)))
    frame_index = 0
    sample_index = 0
    frames = []
    pending_samples = []
    detected_bowl_confidence = 0.0
    bowl_consensus = BowlRoiConsensus()
    quality_checked = False
    scene_quality = None
    skipped_dark_recording = False

    def flush_pending_samples() -> bool:
        nonlocal quality_checked, scene_quality, skipped_dark_recording, target_detector
        if not pending_samples:
            return True
        if not quality_checked:
            scene_quality = assess_scene_quality(
                [sample["frame"] for sample in pending_samples[:QUALITY_GATE_SAMPLE_COUNT]]
            )
            quality_checked = True
            if scene_quality["isDark"]:
                skipped_dark_recording = True
                pending_samples.clear()
                return False
        if target_detector is None:
            target_detector = create_target_detector(
                cv2,
                target=target,
                backend=detector_backend,
                yolo_model=yolo_model,
            )
        boxes_by_frame = detect_frame_batch(
            target_detector,
            [sample["frame"] for sample in pending_samples],
        )
        for sample, detected_boxes in zip(pending_samples, boxes_by_frame):
            sample_bowl_roi = sample["bowlRoi"]
            target_boxes = [
                box
                for box in detected_boxes
                if float(box.get("confidence") or 0) >= MIN_TARGET_CANDIDATE_CONFIDENCE
            ]
            has_target = len(target_boxes) > 0
            near_bowl = False
            if target == "cat" and has_target and sample_bowl_roi:
                expanded_bowl = expand_roi(sample_bowl_roi, 0.25)
                near_bowl = any(
                    rects_overlap(box, expanded_bowl) or centers_close(box, sample_bowl_roi)
                    for box in target_boxes
                )

            target_confidence = max([float(box.get("confidence") or 0) for box in target_boxes] or [0])
            frames.append(
                {
                    "sampleIndex": sample["sampleIndex"],
                    "offsetSec": sample["offsetSec"],
                    "second": sample["second"],
                    "hasCat": has_target,
                    "hasTarget": has_target,
                    "nearBowl": near_bowl,
                    "confidence": target_confidence if has_target else sample["bowlConfidence"],
                    "catBoxes": target_boxes,
                    "targetBoxes": target_boxes,
                    "bowlRoi": sample_bowl_roi,
                    "detectorBackend": target_detector.backend,
                    "target": target,
                }
            )
        pending_samples.clear()
        return True

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % step != 0:
            frame_index += 1
            continue

        offset_sec = frame_index / fps
        second = int(offset_sec)
        if bowl_roi is None and auto_bowl_detection:
            detected_roi, confidence = detect_bowl(cv2, frame)
            if detected_roi:
                detected_bowl_confidence = max(detected_bowl_confidence, confidence)
            bowl_roi = bowl_consensus.add(detected_roi)

        pending_samples.append(
            {
                "sampleIndex": sample_index,
                "offsetSec": float(offset_sec),
                "second": second,
                "frame": frame,
                "bowlRoi": {**bowl_roi} if bowl_roi else None,
                "bowlConfidence": detected_bowl_confidence,
            }
        )
        sample_index += 1
        if len(pending_samples) >= DETECTION_BATCH_SIZE:
            if not flush_pending_samples():
                break
        frame_index += 1

    if not skipped_dark_recording:
        flush_pending_samples()
    capture.release()
    if skipped_dark_recording:
        return {
            "frames": [],
            "bowlRoi": bowl_roi,
            "detectorBackend": str(detector_backend or "auto"),
            "detectorError": "",
            "target": target,
            "sceneQuality": scene_quality,
            "skipped": True,
            "skipReason": "DARK_RECORDING",
            "error": "",
        }
    if target == "cat":
        has_reliable_cat_anchor = any(
            float(box.get("confidence") or 0) >= MIN_TARGET_CLIP_CONFIDENCE
            for frame in frames
            for box in frame.get("catBoxes") or []
        )
        if not has_reliable_cat_anchor:
            for frame in frames:
                frame.update(
                    {
                        "hasCat": False,
                        "hasTarget": False,
                        "nearBowl": False,
                        "confidence": 0.0,
                        "catBoxes": [],
                        "targetBoxes": [],
                    }
                )
    frames = apply_feeding_verification(
        source_url,
        frames,
        bowl_roi,
        target=target,
        verifier=feeding_verifier,
        cute_analysis_all_scales=cute_analysis_all_scales,
    )
    return {
        "frames": frames,
        "bowlRoi": bowl_roi,
        "detectorBackend": target_detector.backend
        if target_detector is not None
        else str(detector_backend or "auto"),
        "detectorError": getattr(target_detector, "fallback_error", ""),
        "target": target,
        "sceneQuality": scene_quality,
        "skipped": False,
        "skipReason": "",
        "error": "",
    }
