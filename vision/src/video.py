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
MIN_TARGET_PRESENCE_CONFIDENCE = 0.10
PRESENCE_SEED_CONFIDENCE = MIN_TARGET_CLIP_CONFIDENCE
PRESENCE_MAX_BRIDGE_SECONDS = 2.0
PRESENCE_MAX_SEED_DISTANCE_SECONDS = 3.0
FACE_PRESENCE_MIN_MODEL_CONFIDENCE = 0.50
FACE_PRESENCE_MIN_WIDTH_RATIO = 0.25
FACE_PRESENCE_MIN_AREA_RATIO = 0.03
DETECTION_BATCH_SIZE = 8
QUALITY_GATE_SAMPLE_COUNT = 8
MIN_LUMINANCE = 35.0
INFRARED_MAX_CHROMA = 4.0
INFRARED_MAX_LUMINANCE = 140.0
MAX_DARK_SAMPLE_RATIO = 0.75
ADAPTIVE_DECODE_FPS = 8.0
ADAPTIVE_JPEG_QUALITY = 55
FIXED_BOTTOM_BOWL_WIDTH_RATIO = 0.50
FIXED_BOTTOM_BOWL_HEIGHT_RATIO = 1.0 / 3.0


class BufferedJpegCapture:
    """Small OpenCV-compatible reader backed by transient in-memory JPEGs."""

    def __init__(self, cv2: Any, encoded_frames: list[Any], fps: float, frame_shape: tuple[int, ...]):
        self.cv2 = cv2
        self.encoded_frames = encoded_frames
        self.fps = max(1.0, float(fps or ADAPTIVE_DECODE_FPS))
        self.frame_shape = frame_shape
        self.index = 0

    def isOpened(self) -> bool:
        return bool(self.encoded_frames)

    def get(self, prop: int) -> float:
        if prop == self.cv2.CAP_PROP_FPS:
            return self.fps
        if prop == self.cv2.CAP_PROP_FRAME_WIDTH:
            return float(self.frame_shape[1]) if len(self.frame_shape) >= 2 else 0.0
        if prop == self.cv2.CAP_PROP_FRAME_HEIGHT:
            return float(self.frame_shape[0]) if self.frame_shape else 0.0
        return 0.0

    def read(self) -> tuple[bool, Any | None]:
        if self.index >= len(self.encoded_frames):
            return False, None
        encoded = self.encoded_frames[self.index]
        self.index += 1
        frame = self.cv2.imdecode(encoded, self.cv2.IMREAD_COLOR)
        return (frame is not None), frame

    def release(self) -> None:
        self.index = len(self.encoded_frames)


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def fixed_bottom_bowl_roi(
    frame_width: int,
    frame_height: int,
    width_ratio: float = FIXED_BOTTOM_BOWL_WIDTH_RATIO,
    height_ratio: float = FIXED_BOTTOM_BOWL_HEIGHT_RATIO,
) -> dict[str, int] | None:
    """Return the fixed bottom-center feeding contact region.

    The camera is mounted against the bowl, so the useful contact area is a
    stable part of the composition rather than a circular object that needs to
    be rediscovered in every recording.
    """
    width = max(0, int(frame_width or 0))
    height = max(0, int(frame_height or 0))
    if width < 2 or height < 2:
        return None
    roi_width = max(1, min(width, int(round(width * clamp(width_ratio, 0.1, 1.0)))))
    roi_height = max(1, min(height, int(round(height * clamp(height_ratio, 0.1, 0.75)))))
    return {
        "x": max(0, (width - roi_width) // 2),
        "y": max(0, height - roi_height),
        "width": roi_width,
        "height": roi_height,
    }


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


def _box_confidence(box: dict[str, Any] | None) -> float:
    try:
        return float(box.get("confidence") or 0) if box else 0.0
    except (AttributeError, TypeError, ValueError):
        return 0.0


def _max_box_confidence(boxes: list[dict[str, Any]]) -> float:
    return max((_box_confidence(box) for box in boxes), default=0.0)


def _copy_box(box: dict[str, Any]) -> dict[str, Any]:
    return dict(box)


def _interpolate_box(left: dict[str, Any], right: dict[str, Any], ratio: float) -> dict[str, Any]:
    result = dict(left)
    for key in ("x", "y", "width", "height", "confidence"):
        try:
            result[key] = round(float(left.get(key) or 0) + (float(right.get(key) or 0) - float(left.get(key) or 0)) * ratio, 4)
        except (AttributeError, TypeError, ValueError):
            result[key] = left.get(key)
    result["confidence"] = min(_box_confidence(left), _box_confidence(right))
    return result


def _presence_near_bowl(frame: dict[str, Any]) -> bool:
    bowl_roi = frame.get("bowlRoi")
    if not bowl_roi:
        return False
    expanded_bowl = expand_roi(bowl_roi, 0.25)
    return any(
        rects_overlap(box, expanded_bowl) or centers_close(box, bowl_roi)
        for box in frame.get("catBoxes") or []
    )


def stabilize_cat_presence(
    frames: list[dict[str, Any]],
    sample_seconds: float = 0.5,
    min_confidence: float = MIN_TARGET_PRESENCE_CONFIDENCE,
    seed_confidence: float = PRESENCE_SEED_CONFIDENCE,
    max_bridge_seconds: float = PRESENCE_MAX_BRIDGE_SECONDS,
    max_seed_distance_seconds: float = PRESENCE_MAX_SEED_DISTANCE_SECONDS,
) -> list[dict[str, Any]]:
    """Turn intermittent cat detections into a bounded, explainable presence track.

    Weak YOLO boxes are useful evidence, but cannot start a track by themselves.
    A strong box seeds the track; weak boxes near that seed are retained, and only
    short internal gaps are bridged. Long all-negative stretches remain absent.
    """
    if not frames:
        return frames
    interval = max(0.05, float(sample_seconds or 0.5))
    raw_boxes = [
        [dict(box) for box in (frame.get("_presenceBoxes") or []) if _box_confidence(box) >= min_confidence]
        for frame in frames
    ]
    direct = [bool(boxes) for boxes in raw_boxes]
    seeds = [
        any(_box_confidence(box) >= seed_confidence for box in boxes)
        for boxes in raw_boxes
    ]
    seed_indexes = [index for index, value in enumerate(seeds) if value]
    if not seed_indexes:
        for frame in frames:
            frame.update({
                "hasCat": False,
                "hasTarget": False,
                "nearBowl": False,
                "confidence": 0.0,
                "catBoxes": [],
                "targetBoxes": [],
                "presenceSource": "none",
                "presenceConfidence": 0.0,
                "presenceStabilized": False,
            })
            frame.pop("_presenceBoxes", None)
        return frames

    max_bridge = max(0, int(round(max_bridge_seconds / interval)))
    # A confirmed anchor identifies this recording's target. Once it exists,
    # weaker cat boxes elsewhere in the same fixed-camera clip are valid
    # presence evidence; only all-negative stretches remain candidates for
    # temporal bridging.
    eligible = list(direct)
    retained = list(eligible)
    retained_indexes = [index for index, value in enumerate(eligible) if value]
    for left, right in zip(retained_indexes, retained_indexes[1:]):
        if right - left - 1 <= max_bridge:
            for index in range(left + 1, right):
                retained[index] = True

    for index, frame in enumerate(frames):
        boxes = raw_boxes[index] if eligible[index] else []
        source = "yolo" if boxes else "none"
        if retained[index] and not boxes:
            left_candidates = [value for value in retained_indexes if value < index]
            right_candidates = [value for value in retained_indexes if value > index]
            left = left_candidates[-1] if left_candidates else None
            right = right_candidates[0] if right_candidates else None
            if left is not None and right is not None and raw_boxes[left] and raw_boxes[right]:
                ratio = (index - left) / max(1, right - left)
                boxes = [_interpolate_box(raw_boxes[left][0], raw_boxes[right][0], ratio)]
            elif left is not None and raw_boxes[left]:
                boxes = [_copy_box(raw_boxes[left][0])]
            elif right is not None and raw_boxes[right]:
                boxes = [_copy_box(raw_boxes[right][0])]
            source = "temporal_bridge" if boxes else "none"
        has_cat = bool(retained[index] and boxes)
        frame["hasCat"] = has_cat
        frame["hasTarget"] = has_cat
        frame["catBoxes"] = boxes if has_cat else []
        frame["targetBoxes"] = boxes if has_cat else []
        frame["confidence"] = _max_box_confidence(boxes) if has_cat else 0.0
        frame["nearBowl"] = _presence_near_bowl(frame) if has_cat else False
        frame["presenceSource"] = source if has_cat else "none"
        frame["presenceConfidence"] = frame["confidence"] if has_cat else 0.0
        frame["presenceStabilized"] = has_cat
        frame.pop("_presenceBoxes", None)
    return frames


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
    cute_policy: dict[str, Any] | None = None,
    orientation: str = "none",
    capture_factory: Any | None = None,
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
    if target != "cat" or not bowl_roi or not any(
        frame.get("hasCat") or frame.get("nearBowl") for frame in enriched
    ):
        return enriched
    verifier_was_injected = verifier is not None
    if verifier is None:
        from .feeding_behavior import expand_candidate_timeline, verify_candidate_behavior

        verifier = verify_candidate_behavior
        enriched = expand_candidate_timeline(enriched)

    try:
        verifier_options = {} if verifier_was_injected else {
            "orientation": orientation,
            **({"capture_factory": capture_factory} if capture_factory else {}),
        }
        if cute_policy is not None:
            evidence_by_sample = verifier(
                source_url,
                enriched,
                bowl_roi,
                **({"cute_analysis_all_scales": True} if cute_analysis_all_scales else {}),
                cute_policy=cute_policy,
                **verifier_options,
            ) or {}
        elif cute_analysis_all_scales:
            evidence_by_sample = verifier(
                source_url,
                enriched,
                bowl_roi,
                cute_analysis_all_scales=True,
                **verifier_options,
            ) or {}
        else:
            evidence_by_sample = verifier(
                source_url,
                enriched,
                bowl_roi,
                **verifier_options,
            ) or {}
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
            if frame.get("hasCat") or frame.get("nearBowl") or frame.get("coarseInterpolated")
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


def promote_face_presence(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recover visible cats whose whole-cat YOLO box disappeared.

    CatFLW is already run for feeding candidates and can observe a reliable
    cat face even when YOLO returns no whole-cat box. This is presence evidence
    only; it does not make the frame a feeding candidate or mark it near bowl.
    """
    if not any(frame.get("hasCat") for frame in frames):
        return frames
    for frame in frames:
        if frame.get("hasCat"):
            continue
        behavior = frame.get("behaviorEvidence") or {}
        cute = frame.get("cuteEvidence") or behavior.get("cuteEvidence") or {}
        if not behavior.get("faceObserved"):
            continue
        try:
            model_confidence = float(cute.get("modelConfidence") or 0)
            width_ratio = float(cute.get("faceWidthRatio") or 0)
            area_ratio = float(cute.get("faceAreaRatio") or 0)
        except (TypeError, ValueError):
            continue
        if model_confidence < FACE_PRESENCE_MIN_MODEL_CONFIDENCE:
            # CatFLW may omit model confidence on a valid but partially
            # occluded face; require stronger geometry in that case.
            if width_ratio < 0.30 or area_ratio < 0.04:
                continue
        elif width_ratio < FACE_PRESENCE_MIN_WIDTH_RATIO and area_ratio < FACE_PRESENCE_MIN_AREA_RATIO:
            continue
        frame.update(
            {
                "hasCat": True,
                "hasTarget": True,
                "confidence": round(model_confidence, 4),
                "presenceSource": "face_landmark",
                "presenceConfidence": round(model_confidence, 4),
                "presenceStabilized": True,
            }
        )
    return frames


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
    sample_offset_seconds: float = 0.0,
    detector_backend: str | None = "auto",
    yolo_model: str | None = None,
    detection_target: str | None = "cat",
    auto_bowl_detection: bool = False,
    feeding_verifier: Any | None = None,
    cute_analysis_all_scales: bool = False,
    cute_policy: dict[str, Any] | None = None,
    max_duration_sec: float | None = None,
    screen_only: bool = False,
    orientation: str = "none",
    adaptive_feeding: bool = False,
    fixed_bottom_bowl_region: bool = False,
) -> dict[str, Any]:
    try:
        import cv2
    except ImportError:
        return {"frames": [], "bowlRoi": bowl_roi, "error": "OPENCV_UNAVAILABLE"}

    from .orientation import normalize_orientation, orient_frame
    from .ffmpeg_capture import open_video_capture

    normalized_orientation = normalize_orientation(orientation)
    cache_for_verification = bool(adaptive_feeding and not screen_only)
    decode_fps = ADAPTIVE_DECODE_FPS if cache_for_verification else min(
        4.0,
        max(0.25, 1.0 / max(0.05, float(sample_seconds or 0.5))),
    )
    capture = open_video_capture(
        cv2,
        source_url,
        output_fps=decode_fps,
        max_width=640,
    )
    if not capture.isOpened():
        return {"frames": [], "bowlRoi": bowl_roi, "error": "VIDEO_OPEN_FAILED"}

    target = resolve_detection_target(detection_target)
    target_detector = None
    fps = capture.get(cv2.CAP_PROP_FPS) or 25
    step = max(1, int(round(fps * sample_seconds)))
    sample_offset_frames = max(
        0,
        min(step - 1, int(round(fps * max(0.0, float(sample_offset_seconds or 0.0))))),
    )
    frame_index = 0
    decoded_frame_count = 0
    sample_index = 0
    frames = []
    pending_samples = []
    detected_bowl_confidence = 0.0
    bowl_consensus = BowlRoiConsensus()
    quality_checked = False
    scene_quality = None
    skipped_dark_recording = False
    buffered_frames = []
    buffered_frame_shape: tuple[int, ...] = ()

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
                min_confidence=MIN_TARGET_PRESENCE_CONFIDENCE,
            )
        boxes_by_frame = detect_frame_batch(
            target_detector,
            [sample["frame"] for sample in pending_samples],
        )
        for sample, detected_boxes in zip(pending_samples, boxes_by_frame):
            sample_bowl_roi = sample["bowlRoi"]
            presence_boxes = [
                box
                for box in detected_boxes
                if _box_confidence(box) >= MIN_TARGET_PRESENCE_CONFIDENCE
            ]
            target_boxes = [
                box for box in presence_boxes
                if _box_confidence(box) >= MIN_TARGET_CANDIDATE_CONFIDENCE
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
                    "_presenceBoxes": presence_boxes,
                    "bowlRoi": sample_bowl_roi,
                    "detectorBackend": target_detector.backend,
                    "target": target,
                }
            )
        pending_samples.clear()
        return True

    while True:
        if max_duration_sec is not None and max_duration_sec > 0 and frame_index / fps >= max_duration_sec:
            break
        ok, frame = capture.read()
        if not ok:
            break
        decoded_frame_count += 1
        frame = orient_frame(cv2, frame, normalized_orientation)
        if bowl_roi is None and fixed_bottom_bowl_region:
            bowl_roi = fixed_bottom_bowl_roi(frame.shape[1], frame.shape[0])
        if cache_for_verification:
            if not buffered_frame_shape:
                buffered_frame_shape = tuple(frame.shape)
            encoded_ok, encoded = cv2.imencode(
                ".jpg",
                frame,
                [int(cv2.IMWRITE_JPEG_QUALITY), ADAPTIVE_JPEG_QUALITY],
            )
            if encoded_ok:
                buffered_frames.append(encoded)
        if frame_index < sample_offset_frames or (frame_index - sample_offset_frames) % step != 0:
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
    if decoded_frame_count == 0:
        return {
            "frames": [],
            "bowlRoi": bowl_roi,
            "detectorBackend": str(detector_backend or "auto"),
            "detectorError": "",
            "target": target,
            "sceneQuality": scene_quality,
            "skipped": False,
            "skipReason": "",
            "error": "VIDEO_READ_FAILED",
        }
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
        frames = stabilize_cat_presence(frames, sample_seconds=sample_seconds)
    if not screen_only:
        capture_factory = None
        verification_orientation = normalized_orientation
        if cache_for_verification and buffered_frames:
            capture_factory = lambda _source_url: BufferedJpegCapture(
                cv2,
                buffered_frames,
                decode_fps,
                buffered_frame_shape,
            )
            verification_orientation = "none"
        frames = apply_feeding_verification(
            source_url,
            frames,
            bowl_roi,
            target=target,
            verifier=feeding_verifier,
            cute_analysis_all_scales=cute_analysis_all_scales,
            cute_policy=cute_policy,
            orientation=verification_orientation,
            capture_factory=capture_factory,
        )
    if target == "cat" and not screen_only:
        frames = promote_face_presence(frames)
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
