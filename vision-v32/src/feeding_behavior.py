from __future__ import annotations

import math
from bisect import bisect_right
from typing import Any, Sequence

import numpy as np

from .cute_highlights import evaluate_cute_face


LEFT_EYE = 0
RIGHT_EYE = 1
NOSE = 2
NECK = 3
MIN_HEAD_KEYPOINT_CONFIDENCE = 0.45
CLOSEUP_HEAD_KEYPOINT_CONFIDENCE = 0.25
CLOSEUP_MIN_BOX_RATIO = 0.80
NEAR_FIELD_MIN_WIDTH_RATIO = 0.42
NEAR_FIELD_MIN_HEIGHT_RATIO = 0.65
NEAR_FIELD_MIN_AREA_RATIO = 0.28
INTERMEDIATE_MIN_WIDTH_RATIO = 0.30
INTERMEDIATE_MIN_HEIGHT_RATIO = 0.55
INTERMEDIATE_MIN_AREA_RATIO = 0.18
MIN_FEEDING_FACE_WIDTH_RATIO = 0.25
MIN_FEEDING_FACE_HEIGHT_RATIO = 0.18
MIN_FEEDING_FACE_AREA_RATIO = 0.07
MIN_HEAD_DIRECTION_COSINE = 0.45
MIN_LOCAL_MOTION = 0.01
MIN_MOTION_ACTIVE_RATIO = 0.1
MIN_MOTION_SCORE = 0.001
MAX_GLOBAL_MOTION = 0.12
MIN_MASK_CONTACT_RATIO = 0.08
NEAR_FIELD_LEAD_SECONDS = 2
NEAR_FIELD_TAIL_SECONDS = 6
MAX_FACE_RECOVERY_GAP_SECONDS = 4.0


def _point(values: Sequence[Sequence[float]], index: int) -> tuple[float, float]:
    return float(values[index][0]), float(values[index][1])


def _score(values: Sequence[float], index: int) -> float:
    return float(values[index])


def _midpoint(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (a[0] + b[0]) / 2, (a[1] + b[1]) / 2


def _nearest_roi_point(point: tuple[float, float], roi: dict[str, Any]) -> tuple[float, float]:
    width = max(1.0, float(roi["width"]))
    height = max(1.0, float(roi["height"]))
    return (
        min(max(point[0], float(roi["x"])), float(roi["x"]) + width),
        min(max(point[1], float(roi["y"])), float(roi["y"]) + height),
    )


def _cosine(a: tuple[float, float], b: tuple[float, float]) -> float:
    a_length = math.hypot(*a)
    b_length = math.hypot(*b)
    if a_length <= 1e-6 or b_length <= 1e-6:
        return -1.0
    return (a[0] * b[0] + a[1] * b[1]) / (a_length * b_length)


def evaluate_pose_evidence(
    keypoints: Sequence[Sequence[float]],
    scores: Sequence[float],
    bowl_roi: dict[str, Any] | None,
    min_confidence: float = MIN_HEAD_KEYPOINT_CONFIDENCE,
) -> dict[str, Any]:
    result = {
        "verified": False,
        "confidence": 0.0,
        "muzzle": None,
        "muzzleSource": "",
        "directionCosine": -1.0,
        "reason": "HEAD_KEYPOINTS_UNRELIABLE",
    }
    if bowl_roi is None or len(keypoints) <= NECK or len(scores) <= NECK:
        result["reason"] = "BOWL_ROI_MISSING" if bowl_roi is None else result["reason"]
        return result

    eye_scores = (_score(scores, LEFT_EYE), _score(scores, RIGHT_EYE))
    neck_score = _score(scores, NECK)
    if min(eye_scores) < min_confidence:
        return result

    left_eye = _point(keypoints, LEFT_EYE)
    right_eye = _point(keypoints, RIGHT_EYE)
    eye_midpoint = _midpoint(left_eye, right_eye)
    nose_score = _score(scores, NOSE)
    if nose_score >= min_confidence:
        muzzle = _point(keypoints, NOSE)
        muzzle_source = "nose"
        confidence = min(*eye_scores, nose_score)
    else:
        if neck_score < min_confidence:
            return result
        neck = _point(keypoints, NECK)
        muzzle = (
            eye_midpoint[0] + (neck[0] - eye_midpoint[0]) * 0.55,
            eye_midpoint[1] + (neck[1] - eye_midpoint[1]) * 0.55,
        )
        muzzle_source = "head-axis"
        confidence = min(*eye_scores, neck_score) * 0.75

    result.update(
        {
            "confidence": round(float(confidence), 4),
            "muzzle": [round(muzzle[0], 2), round(muzzle[1], 2)],
            "muzzleSource": muzzle_source,
        }
    )
    nearest_bowl_point = _nearest_roi_point(muzzle, bowl_roi)
    muzzle_distance = math.hypot(
        muzzle[0] - nearest_bowl_point[0],
        muzzle[1] - nearest_bowl_point[1],
    )
    eye_distance = math.hypot(left_eye[0] - right_eye[0], left_eye[1] - right_eye[1])
    contact_threshold = max(8.0, eye_distance * 0.9)
    result["muzzleDistance"] = round(muzzle_distance, 2)
    result["contactThreshold"] = round(contact_threshold, 2)
    if muzzle_distance > contact_threshold:
        result["reason"] = "MUZZLE_AWAY_FROM_BOWL"
        return result

    head_direction = (muzzle[0] - eye_midpoint[0], muzzle[1] - eye_midpoint[1])
    bowl_direction = (
        nearest_bowl_point[0] - eye_midpoint[0],
        nearest_bowl_point[1] - eye_midpoint[1],
    )
    direction_cosine = _cosine(head_direction, bowl_direction)
    result["directionCosine"] = round(direction_cosine, 4)
    if direction_cosine < MIN_HEAD_DIRECTION_COSINE:
        result["reason"] = "HEAD_NOT_POINTING_TO_BOWL"
        return result

    result["verified"] = True
    result["reason"] = ""
    return result


def _is_extreme_closeup(
    cat_box: dict[str, Any] | None,
    frame_shape: Sequence[int],
) -> bool:
    if not cat_box or len(frame_shape) < 2:
        return False
    frame_height = max(1.0, float(frame_shape[0]))
    frame_width = max(1.0, float(frame_shape[1]))
    box_width = max(0.0, float(cat_box.get("width") or 0))
    box_height = max(0.0, float(cat_box.get("height") or 0))
    if box_width / frame_width < CLOSEUP_MIN_BOX_RATIO:
        return False
    if box_height / frame_height < CLOSEUP_MIN_BOX_RATIO:
        return False

    x = float(cat_box.get("x") or 0)
    y = float(cat_box.get("y") or 0)
    margin_x = frame_width * 0.05
    margin_y = frame_height * 0.05
    touched_edges = sum(
        (
            x <= margin_x,
            y <= margin_y,
            x + box_width >= frame_width - margin_x,
            y + box_height >= frame_height - margin_y,
        )
    )
    return touched_edges >= 2


def classify_cat_scale(
    cat_box: dict[str, Any] | None,
    frame_shape: Sequence[int],
) -> str:
    if not cat_box or len(frame_shape) < 2:
        return "distant"
    frame_height = max(1.0, float(frame_shape[0]))
    frame_width = max(1.0, float(frame_shape[1]))
    box_width = max(0.0, float(cat_box.get("width") or 0))
    box_height = max(0.0, float(cat_box.get("height") or 0))
    return classify_cat_scale_ratios(
        box_width / frame_width,
        box_height / frame_height,
        box_width * box_height / (frame_width * frame_height),
    )


def classify_cat_scale_ratios(
    width_ratio: float,
    height_ratio: float,
    area_ratio: float,
) -> str:
    if (
        width_ratio >= NEAR_FIELD_MIN_WIDTH_RATIO
        and height_ratio >= NEAR_FIELD_MIN_HEIGHT_RATIO
        and area_ratio >= NEAR_FIELD_MIN_AREA_RATIO
    ):
        return "near"
    if (
        width_ratio >= INTERMEDIATE_MIN_WIDTH_RATIO
        and height_ratio >= INTERMEDIATE_MIN_HEIGHT_RATIO
        and area_ratio >= INTERMEDIATE_MIN_AREA_RATIO
    ):
        return "intermediate"
    return "distant"


def classify_average_cat_scale(
    cat_boxes: Sequence[dict[str, Any]],
    frame_shape: Sequence[int],
) -> str:
    if not cat_boxes or len(frame_shape) < 2:
        return "distant"
    frame_height = max(1.0, float(frame_shape[0]))
    frame_width = max(1.0, float(frame_shape[1]))
    ratios = [
        (
            max(0.0, float(box.get("width") or 0)) / frame_width,
            max(0.0, float(box.get("height") or 0)) / frame_height,
            max(0.0, float(box.get("width") or 0))
            * max(0.0, float(box.get("height") or 0))
            / (frame_width * frame_height),
        )
        for box in cat_boxes
    ]
    count = len(ratios)
    return classify_cat_scale_ratios(
        sum(item[0] for item in ratios) / count,
        sum(item[1] for item in ratios) / count,
        sum(item[2] for item in ratios) / count,
    )


def is_near_field_cat(
    cat_box: dict[str, Any] | None,
    frame_shape: Sequence[int],
) -> bool:
    return classify_cat_scale(cat_box, frame_shape) == "near"


def is_large_feeding_face(
    face_box: dict[str, Any] | None,
    frame_shape: Sequence[int],
) -> bool:
    if not face_box or len(frame_shape) < 2:
        return False
    frame_height = max(1.0, float(frame_shape[0]))
    frame_width = max(1.0, float(frame_shape[1]))
    face_width = max(0.0, float(face_box.get("width") or 0))
    face_height = max(0.0, float(face_box.get("height") or 0))
    return (
        face_width / frame_width >= MIN_FEEDING_FACE_WIDTH_RATIO
        and face_height / frame_height >= MIN_FEEDING_FACE_HEIGHT_RATIO
        and face_width * face_height / (frame_width * frame_height)
        >= MIN_FEEDING_FACE_AREA_RATIO
    )


def evaluate_pose_evidence_for_frame(
    keypoints: Sequence[Sequence[float]],
    scores: Sequence[float],
    bowl_roi: dict[str, Any] | None,
    cat_box: dict[str, Any] | None,
    frame_shape: Sequence[int],
) -> dict[str, Any]:
    evidence = evaluate_pose_evidence(keypoints, scores, bowl_roi)
    evidence["evidenceMode"] = "standard"
    if evidence.get("reason") != "HEAD_KEYPOINTS_UNRELIABLE":
        return evidence
    if not _is_extreme_closeup(cat_box, frame_shape):
        return evidence

    closeup_evidence = evaluate_pose_evidence(
        keypoints,
        scores,
        bowl_roi,
        min_confidence=CLOSEUP_HEAD_KEYPOINT_CONFIDENCE,
    )
    closeup_evidence["evidenceMode"] = "closeup"
    return closeup_evidence


def evaluate_face_contact(
    face_box: dict[str, Any] | None,
    bowl_roi: dict[str, Any] | None,
) -> dict[str, Any]:
    result = {
        "verified": False,
        "confidence": 0.0,
        "evidenceMode": "face-contact",
        "faceObserved": False,
        "reason": "FACE_NOT_FOUND",
    }
    if not face_box or not bowl_roi:
        result["reason"] = "BOWL_ROI_MISSING" if not bowl_roi else result["reason"]
        return result

    face_left = float(face_box.get("x") or 0)
    face_top = float(face_box.get("y") or 0)
    face_width = max(0.0, float(face_box.get("width") or 0))
    face_height = max(0.0, float(face_box.get("height") or 0))
    if face_width <= 0 or face_height <= 0:
        return result
    result["faceObserved"] = True
    face_right = face_left + face_width
    face_bottom = face_top + face_height
    bowl_left = float(bowl_roi.get("x") or 0)
    bowl_top = float(bowl_roi.get("y") or 0)
    bowl_right = bowl_left + max(0.0, float(bowl_roi.get("width") or 0))
    bowl_bottom = bowl_top + max(0.0, float(bowl_roi.get("height") or 0))

    horizontal_gap = max(face_left - bowl_right, bowl_left - face_right, 0.0)
    vertical_gap = max(face_top - bowl_bottom, bowl_top - face_bottom, 0.0)
    distance = math.hypot(horizontal_gap, vertical_gap)
    contact_threshold = max(6.0, min(face_width, face_height) * 0.04)
    result.update(
        {
            "faceDistance": round(distance, 2),
            "contactThreshold": round(contact_threshold, 2),
        }
    )
    if distance > contact_threshold:
        result["reason"] = "FACE_AWAY_FROM_BOWL"
        return result

    result["verified"] = True
    result["confidence"] = round(0.6 + 0.25 * (1.0 - distance / contact_threshold), 4)
    result["reason"] = ""
    return result


def evaluate_face_landmark_contact(
    face_box: dict[str, Any] | None,
    landmarks: Sequence[Sequence[float]],
    bowl_roi: dict[str, Any] | None,
) -> dict[str, Any]:
    result = {
        "verified": False,
        "confidence": 0.0,
        "evidenceMode": "face-landmark-contact",
        "faceObserved": False,
        "muzzle": None,
        "muzzleSource": "",
        "reason": "FACE_LANDMARKS_UNRELIABLE",
    }
    if not face_box or not bowl_roi:
        result["reason"] = "BOWL_ROI_MISSING" if not bowl_roi else "FACE_NOT_FOUND"
        return result
    if len(landmarks) < 48:
        return result

    try:
        mouth_points = [_point(landmarks, index) for index in (16, 17, 46, 47)]
        left_eye = _point(landmarks, 4)
        right_eye = _point(landmarks, 8)
    except (IndexError, TypeError, ValueError):
        return result

    muzzle = (
        sum(point[0] for point in mouth_points) / len(mouth_points),
        sum(point[1] for point in mouth_points) / len(mouth_points),
    )
    eye_distance = math.dist(left_eye, right_eye)
    face_width = max(0.0, float(face_box.get("width") or 0))
    face_height = max(0.0, float(face_box.get("height") or 0))
    if eye_distance < max(4.0, min(face_width, face_height) * 0.08):
        return result
    result["faceObserved"] = True

    nearest_bowl_point = _nearest_roi_point(muzzle, bowl_roi)
    mouth_distance = math.dist(muzzle, nearest_bowl_point)
    bowl_short_side = min(
        max(1.0, float(bowl_roi.get("width") or 0)),
        max(1.0, float(bowl_roi.get("height") or 0)),
    )
    contact_threshold = max(8.0, min(eye_distance * 0.9, bowl_short_side * 0.35))
    result.update(
        {
            "muzzle": [round(muzzle[0], 2), round(muzzle[1], 2)],
            "muzzleSource": "catflw-mouth",
            "mouthDistance": round(mouth_distance, 2),
            "contactThreshold": round(contact_threshold, 2),
        }
    )
    if mouth_distance > contact_threshold:
        result["reason"] = "FACE_MOUTH_AWAY_FROM_BOWL"
        return result

    result["verified"] = True
    result["confidence"] = round(
        min(0.92, 0.64 + 0.24 * (1.0 - mouth_distance / contact_threshold)),
        4,
    )
    result["reason"] = ""
    return result


def evaluate_mask_contact(
    cat_mask: np.ndarray | None,
    bowl_roi: dict[str, Any] | None,
    detector_confidence: float = 0.0,
) -> dict[str, Any]:
    result = {
        "verified": False,
        "confidence": 0.0,
        "evidenceMode": "mask-contact",
        "maskContactRatio": 0.0,
        "detectorConfidence": round(float(detector_confidence), 4),
        "reason": "CAT_MASK_NOT_FOUND",
    }
    if cat_mask is None or not bowl_roi:
        result["reason"] = "BOWL_ROI_MISSING" if not bowl_roi else result["reason"]
        return result

    mask = np.asarray(cat_mask)
    if mask.ndim != 2 or mask.size == 0:
        return result
    height, width = mask.shape
    left = max(0, min(width, int(round(float(bowl_roi.get("x") or 0)))))
    top = max(0, min(height, int(round(float(bowl_roi.get("y") or 0)))))
    right = max(
        left,
        min(width, int(round(float(bowl_roi.get("x") or 0) + float(bowl_roi.get("width") or 0)))),
    )
    bottom = max(
        top,
        min(height, int(round(float(bowl_roi.get("y") or 0) + float(bowl_roi.get("height") or 0)))),
    )
    if right <= left or bottom <= top:
        result["reason"] = "BOWL_ROI_INVALID"
        return result

    contact_ratio = float(np.mean(mask[top:bottom, left:right] > 0.5))
    result["maskContactRatio"] = round(contact_ratio, 4)
    if contact_ratio < MIN_MASK_CONTACT_RATIO:
        result["reason"] = "CAT_MASK_AWAY_FROM_BOWL"
        return result

    result["verified"] = True
    result["confidence"] = round(
        min(0.95, 0.55 + min(contact_ratio, 0.5) * 0.5 + float(detector_confidence) * 0.15),
        4,
    )
    result["reason"] = ""
    return result


def _gray_crop(crop: np.ndarray, size: int = 64) -> np.ndarray:
    import cv2

    values = np.asarray(crop)
    if values.ndim == 3:
        values = cv2.cvtColor(values, cv2.COLOR_BGR2GRAY)
    return cv2.resize(values, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)


def _motion_masks(size: int) -> tuple[np.ndarray, np.ndarray]:
    y, x = np.ogrid[:size, :size]
    center = (size - 1) / 2
    radius = np.sqrt((x - center) ** 2 + (y - center) ** 2)
    return radius <= size * 0.20, (radius >= size * 0.30) & (radius <= size * 0.43)


def evaluate_muzzle_motion(crops: Sequence[np.ndarray], fps: float = 8) -> dict[str, Any]:
    import cv2

    required_pairs = max(4, int(round(max(1.0, fps) * 0.75)))
    result = {
        "verified": False,
        "score": 0.0,
        "activeRatio": 0.0,
        "globalMotionRatio": 0.0,
        "sampleCount": len(crops),
        "reason": "INSUFFICIENT_MUZZLE_SAMPLES",
    }
    if len(crops) - 1 < required_pairs:
        return result

    frames = [_gray_crop(crop) for crop in crops]
    inner_mask, outer_mask = _motion_masks(frames[0].shape[0])
    window = cv2.createHanningWindow((frames[0].shape[1], frames[0].shape[0]), cv2.CV_32F)
    residuals: list[float] = []
    global_motion_count = 0

    for previous, current in zip(frames, frames[1:]):
        shift, response = cv2.phaseCorrelate(previous.copy(), current.copy(), window)
        if response < 0.5:
            shift = (0.0, 0.0)
        shift_distance = math.hypot(float(shift[0]), float(shift[1]))
        transform = np.float32([[1, 0, -shift[0]], [0, 1, -shift[1]]])
        aligned = cv2.warpAffine(
            current,
            transform,
            (current.shape[1], current.shape[0]),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT,
        )
        difference = cv2.absdiff(previous, aligned) / 255.0
        inner_motion = float(np.mean(difference[inner_mask]))
        outer_motion = float(np.mean(difference[outer_mask]))
        if shift_distance > 6 or outer_motion > MAX_GLOBAL_MOTION:
            global_motion_count += 1
        residuals.append(max(0.0, inner_motion - outer_motion * 1.35))

    active_count = sum(value >= MIN_LOCAL_MOTION for value in residuals)
    active_ratio = active_count / len(residuals)
    global_ratio = global_motion_count / len(residuals)
    result.update(
        {
            "score": round(float(np.mean(residuals)), 4),
            "activeRatio": round(active_ratio, 4),
            "globalMotionRatio": round(global_ratio, 4),
        }
    )
    if global_ratio > 0.5:
        result["reason"] = "WHOLE_HEAD_MOTION"
        return result
    if active_ratio < MIN_MOTION_ACTIVE_RATIO or float(np.mean(residuals)) < MIN_MOTION_SCORE:
        result["reason"] = "MUZZLE_STATIC"
        return result

    result["verified"] = True
    result["reason"] = ""
    return result


def summarize_behavior_second(
    pose_evidence: Sequence[dict[str, Any]],
    motion_evidence: dict[str, Any],
) -> dict[str, Any]:
    verified_poses = [item for item in pose_evidence if item.get("verified")]
    pose_ratio = len(verified_poses) / len(pose_evidence) if pose_evidence else 0.0
    pose_confidence = (
        sum(float(item.get("confidence") or 0) for item in verified_poses) / len(verified_poses)
        if verified_poses
        else 0.0
    )
    motion_verified = bool(motion_evidence.get("verified"))
    face_observations = [
        item
        for item in pose_evidence
        if item.get("evidenceMode") in {"face-contact", "face-landmark-contact"}
    ]
    verified_face_contacts = [item for item in face_observations if item.get("verified")]
    face_contact_count = len(verified_face_contacts)
    mask_contact_count = sum(1 for item in verified_poses if item.get("evidenceMode") == "mask-contact")
    face_contact_ratio = face_contact_count / len(face_observations) if face_observations else 0.0
    mask_contact_ratio = mask_contact_count / len(pose_evidence) if pose_evidence else 0.0
    mask_contact_verified = mask_contact_count > 0
    face_contact_verified = face_contact_ratio >= 0.5
    contact_verified = mask_contact_verified or face_contact_verified
    eating_verified = motion_verified and (contact_verified or pose_ratio >= 0.5)
    if mask_contact_verified:
        confidence = sum(
            float(item.get("confidence") or 0)
            for item in verified_poses
            if item.get("evidenceMode") == "mask-contact"
        ) / mask_contact_count
        verification_mode = "mask-contact"
    elif face_contact_verified:
        confidence = sum(
            float(item.get("confidence") or 0)
            for item in verified_face_contacts
        ) / face_contact_count
        verification_mode = (
            "face-landmark-contact"
            if any(item.get("evidenceMode") == "face-landmark-contact" for item in verified_face_contacts)
            else "face-contact"
        )
    else:
        confidence = pose_confidence * 0.55 + float(motion_evidence.get("activeRatio") or 0) * 0.45
        verification_mode = "pose-motion"

    reason = ""
    if not eating_verified and pose_ratio < 0.5 and not contact_verified:
        reason = next(
            (str(item.get("reason")) for item in pose_evidence if item.get("reason")),
            "POSE_NOT_FOUND",
        )
    elif not eating_verified and not motion_verified:
        reason = str(motion_evidence.get("reason") or "MUZZLE_MOTION_NOT_VERIFIED")
    elif not contact_verified:
        reason = next(
            (str(item.get("reason")) for item in pose_evidence if item.get("reason")),
            "FOOD_CONTACT_NOT_VERIFIED",
        )

    return {
        "eatingVerified": eating_verified,
        "faceAtBowl": face_contact_verified,
        "confidence": round(confidence, 4) if eating_verified else 0.0,
        "poseVerifiedRatio": round(pose_ratio, 4),
        "faceContactRatio": round(face_contact_ratio, 4),
        "maskContactRatio": round(mask_contact_ratio, 4),
        "poseConfidence": round(pose_confidence, 4),
        "motionScore": round(float(motion_evidence.get("score") or 0), 4),
        "motionActiveRatio": round(float(motion_evidence.get("activeRatio") or 0), 4),
        "sampleCount": int(motion_evidence.get("sampleCount") or 0),
        "faceObserved": any(item.get("faceObserved") for item in face_observations),
        "verificationMode": verification_mode if eating_verified else "",
        "reason": reason,
    }


def _extract_muzzle_crop(
    frame: np.ndarray,
    muzzle: Sequence[float],
    cat_box: dict[str, Any],
) -> np.ndarray | None:
    height, width = frame.shape[:2]
    radius = int(
        max(
            16,
            min(128, min(float(cat_box.get("width") or 0), float(cat_box.get("height") or 0)) * 0.22),
        )
    )
    center_x = int(round(float(muzzle[0])))
    center_y = int(round(float(muzzle[1])))
    left = max(0, center_x - radius)
    top = max(0, center_y - radius)
    right = min(width, center_x + radius)
    bottom = min(height, center_y + radius)
    if right - left < 12 or bottom - top < 12:
        return None
    return frame[top:bottom, left:right].copy()


def verify_candidate_behavior(
    source_url: str,
    sampled_frames: list[dict[str, Any]],
    bowl_roi: dict[str, Any],
    sample_fps: float = 8,
    pose_sample_fps: float = 2,
    pose_estimator: Any | None = None,
    face_estimator: Any | None = None,
    mask_estimator: Any | None = None,
    capture_factory: Any | None = None,
    cute_analysis_all_scales: bool = False,
) -> dict[int, dict[str, Any]]:
    import cv2

    from .animal_pose import RtmlibAnimalPoseEstimator

    def sample_key(frame: dict[str, Any]) -> int:
        return int(frame.get("sampleIndex", frame.get("second") or 0))

    def sample_offset(frame: dict[str, Any]) -> float:
        return float(frame.get("offsetSec", frame.get("second") or 0))

    candidates = {
        sample_key(frame): frame
        for frame in sampled_frames
        if frame.get("nearBowl")
    }
    if not candidates:
        return {}

    ordered_frames = sorted(sampled_frames, key=sample_offset)
    anchor_positions = [
        index for index, frame in enumerate(ordered_frames) if frame.get("nearBowl")
    ]
    for left_position, right_position in zip(anchor_positions, anchor_positions[1:]):
        left = ordered_frames[left_position]
        right = ordered_frames[right_position]
        left_offset = sample_offset(left)
        right_offset = sample_offset(right)
        if right_offset - left_offset > MAX_FACE_RECOVERY_GAP_SECONDS:
            continue
        for frame in ordered_frames[left_position + 1 : right_position]:
            candidates[sample_key(frame)] = frame

    estimator = pose_estimator or RtmlibAnimalPoseEstimator()
    face_estimator_was_injected = face_estimator is not None
    capture = (capture_factory or cv2.VideoCapture)(source_url)
    if not capture.isOpened():
        return {
            key: {
                "eatingVerified": False,
                "confidence": 0.0,
                "reason": "VIDEO_OPEN_FAILED",
            }
            for key in candidates
        }

    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 25)
    frame_width = float(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    frame_height = float(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    closeup_clip = False
    near_field_clip = False
    intermediate_clip = False
    candidate_boxes = []
    if frame_width >= 32 and frame_height >= 32:
        frame_shape = (int(frame_height), int(frame_width))
        for candidate in candidates.values():
            boxes = list(candidate.get("targetBoxes") or candidate.get("catBoxes") or [])
            if boxes:
                candidate_boxes.append(
                    max(
                        boxes,
                        key=lambda box: float(box.get("width") or 0)
                        * float(box.get("height") or 0),
                    )
                )
        average_scale = classify_average_cat_scale(candidate_boxes, frame_shape)
        closeup_clip = any(
            _is_extreme_closeup(
                box,
                frame_shape,
            )
            for candidate in candidates.values()
            for box in list(candidate.get("targetBoxes") or candidate.get("catBoxes") or [])
        )
        near_field_clip = average_scale == "near"
        intermediate_clip = average_scale == "intermediate"
        if candidate_boxes and average_scale == "distant" and not cute_analysis_all_scales:
            capture.release()
            return {
                key: {
                    "eatingVerified": False,
                    "confidence": 0.0,
                    "reason": "CAT_TOO_FAR_FOR_FEEDING",
                }
                for key in candidates
            }
    if (
        near_field_clip
        or intermediate_clip
        or cute_analysis_all_scales
        or not candidate_boxes
    ) and face_estimator is None:
        from .cat_face import CatFaceLandmarkEstimator

        face_estimator = CatFaceLandmarkEstimator()
    if closeup_clip or near_field_clip:
        candidate_seconds = [int(frame.get("second") or 0) for frame in candidates.values()]
        first_second = max(0, min(candidate_seconds) - NEAR_FIELD_LEAD_SECONDS)
        last_second = max(candidate_seconds) + NEAR_FIELD_TAIL_SECONDS
        candidates = {
            sample_key(frame): frame
            for frame in sampled_frames
            if first_second <= int(frame.get("second") or 0) <= last_second
        }
    sample_step = max(1, int(round(source_fps / max(1.0, float(sample_fps)))))
    effective_fps = source_fps / sample_step
    pose_interval = max(1, int(round(effective_fps / max(0.5, float(pose_sample_fps)))))
    sample_groups = {
        key: {
            "frameCount": 0,
            "cuteEvidence": None,
        }
        for key in candidates
    }
    feeding_groups = {
        int(candidate.get("second") or 0): {
            "crops": [],
            "poses": [],
            "frameCount": 0,
            "muzzle": None,
            "catBox": None,
        }
        for candidate in candidates.values()
    }
    ordered_samples = sorted(
        ((sample_offset(frame), sample_key(frame)) for frame in sampled_frames),
        key=lambda item: item[0],
    )
    sample_offsets = [offset for offset, _key in ordered_samples]
    sample_interval = min(
        (
            right - left
            for left, right in zip(sample_offsets, sample_offsets[1:])
            if right > left
        ),
        default=1.0,
    )
    frame_index = 0
    contact_frames: list[tuple[int, np.ndarray]] = []
    closeup_mode_active = closeup_clip

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % sample_step != 0:
                frame_index += 1
                continue

            offset_sec = frame_index / source_fps
            sample_position = bisect_right(sample_offsets, offset_sec + 1e-9) - 1
            if sample_position < 0 or offset_sec >= sample_offsets[sample_position] + sample_interval:
                frame_index += 1
                continue
            key = ordered_samples[sample_position][1]
            candidate = candidates.get(key)
            if candidate is None:
                frame_index += 1
                continue

            second = int(candidate.get("second") or 0)
            sample_group = sample_groups[key]
            feeding_group = feeding_groups[second]
            cat_boxes = list(candidate.get("targetBoxes") or candidate.get("catBoxes") or [])
            frame_scales = [classify_cat_scale(box, frame.shape) for box in cat_boxes]
            if "near" in frame_scales:
                frame_scale = "near"
            elif "intermediate" in frame_scales:
                frame_scale = "intermediate"
            elif frame_scales:
                frame_scale = "distant"
            elif closeup_clip or near_field_clip:
                frame_scale = "near"
            elif intermediate_clip:
                frame_scale = "intermediate"
            else:
                frame_scale = "distant"
            frame_is_closeup = any(
                _is_extreme_closeup(box, frame.shape) for box in cat_boxes
            ) or (not cat_boxes and closeup_clip)
            frame_is_near_field = frame_scale == "near" or frame_is_closeup
            closeup_mode_active = closeup_mode_active or frame_is_closeup
            if frame_is_closeup and feeding_group["frameCount"] == 0:
                contact_frames.append((second, frame.copy()))
            if (
                feeding_group["frameCount"] % pose_interval == 0
                or feeding_group["muzzle"] is None
                or sample_group["frameCount"] == 0
            ):
                evaluated = []
                if frame_scale == "distant":
                    evaluated.append(
                        (
                            {
                                "verified": False,
                                "confidence": 0.0,
                                "reason": "CAT_TOO_FAR_FOR_FEEDING",
                            },
                            {},
                        )
                    )
                if frame_is_near_field:
                    poses = estimator.estimate(frame, cat_boxes)
                    for pose in poses:
                        evidence = evaluate_pose_evidence_for_frame(
                            pose.get("keypoints") or [],
                            pose.get("scores") or [],
                            bowl_roi,
                            pose.get("catBox"),
                            frame.shape,
                        )
                        evaluated.append((evidence, pose))
                face_muzzle = None
                face_box = None
                if (
                    (
                        frame_scale in {"near", "intermediate"}
                        or cute_analysis_all_scales
                        or not cat_boxes
                    )
                    and face_estimator is not None
                    and sample_group["frameCount"] == 0
                ):
                    face = face_estimator.estimate(frame, cat_boxes)
                    if face and face.get("faceBox"):
                        model_confidence = max(
                            [float(box.get("confidence") or 0) for box in cat_boxes] or [0.0]
                        )
                        cute_evidence = evaluate_cute_face(
                            face["faceBox"],
                            face.get("landmarks") or [],
                            frame.shape,
                            model_confidence=model_confidence,
                            landmark_fallback_confidence=not cat_boxes,
                        )
                        current_cute = sample_group.get("cuteEvidence")
                        if current_cute is None or (
                            float(cute_evidence.get("cuteScore") or 0),
                            float(cute_evidence.get("modelConfidence") or 0),
                        ) > (
                            float(current_cute.get("cuteScore") or 0),
                            float(current_cute.get("modelConfidence") or 0),
                        ):
                            sample_group["cuteEvidence"] = cute_evidence
                        if not is_large_feeding_face(face["faceBox"], frame.shape):
                            face_evidence = {
                                "verified": False,
                                "confidence": 0.0,
                                "evidenceMode": "face-contact",
                                "faceObserved": True,
                                "reason": "CAT_FACE_TOO_SMALL_FOR_FEEDING",
                            }
                        else:
                            landmarks = face.get("landmarks") or []
                            if len(landmarks) >= 48:
                                face_evidence = evaluate_face_landmark_contact(
                                    face["faceBox"], landmarks, bowl_roi
                                )
                            else:
                                face_evidence = {
                                    "verified": False,
                                    "confidence": 0.0,
                                    "evidenceMode": "face-contact",
                                    "faceObserved": True,
                                    "reason": "FACE_LANDMARKS_UNRELIABLE",
                                }
                        if feeding_group["frameCount"] == 0:
                            face_muzzle = face_evidence.get("muzzle")
                            face_box = face["faceBox"]
                            evaluated.append(
                                (
                                    face_evidence,
                                    {
                                        "catBox": face["faceBox"],
                                        "faceLandmarks": face.get("landmarks") or [],
                                    },
                                )
                            )
                    elif frame_scale == "intermediate" and feeding_group["frameCount"] == 0:
                        evaluated.append(
                            (
                                {
                                    "verified": False,
                                    "confidence": 0.0,
                                    "evidenceMode": "face-contact",
                                    "faceObserved": False,
                                    "reason": "FACE_NOT_FOUND",
                                },
                                {},
                            )
                        )
                if evaluated:
                    evidence, pose = max(
                        evaluated,
                        key=lambda item: (
                            bool(item[0].get("verified")),
                            bool(item[0].get("faceObserved")),
                            float(item[0].get("confidence") or 0),
                        ),
                    )
                    feeding_group["poses"].append(evidence)
                    if face_muzzle and face_box:
                        feeding_group["muzzle"] = face_muzzle
                        feeding_group["catBox"] = face_box
                    elif evidence.get("muzzle"):
                        feeding_group["muzzle"] = evidence["muzzle"]
                        feeding_group["catBox"] = pose.get("catBox")
                else:
                    feeding_group["poses"].append(
                        {
                            "verified": False,
                            "confidence": 0.0,
                            "reason": "POSE_NOT_FOUND",
                        }
                    )

            if feeding_group["muzzle"] is not None and feeding_group["catBox"] is not None:
                crop = _extract_muzzle_crop(
                    frame,
                    feeding_group["muzzle"],
                    feeding_group["catBox"],
                )
                if crop is not None:
                    feeding_group["crops"].append(crop)
            sample_group["frameCount"] += 1
            feeding_group["frameCount"] += 1
            frame_index += 1
    finally:
        capture.release()

    if closeup_mode_active and contact_frames and not (
        face_estimator_was_injected and mask_estimator is None
    ):
        if mask_estimator is None:
            from .cat_segmentation import CatMaskContactEstimator

            mask_estimator = CatMaskContactEstimator()
        try:
            mask_evidence = mask_estimator.estimate_many(
                [frame for _key, frame in contact_frames],
                bowl_roi,
            )
        except Exception as error:
            mask_evidence = [
                {
                    "verified": False,
                    "confidence": 0.0,
                    "evidenceMode": "mask-contact",
                    "reason": "MASK_CONTACT_VERIFIER_FAILED",
                    "error": str(error),
                }
                for _key, _frame in contact_frames
            ]
        for (second, _frame), evidence in zip(contact_frames, mask_evidence):
            feeding_groups[second]["poses"].append(evidence)

    evidence_by_second = {}
    for second, group in feeding_groups.items():
        motion = evaluate_muzzle_motion(group["crops"], fps=effective_fps)
        evidence_by_second[second] = summarize_behavior_second(group["poses"], motion)

    evidence_by_sample = {}
    for key, candidate in candidates.items():
        evidence = dict(evidence_by_second[int(candidate.get("second") or 0)])
        cute_evidence = sample_groups[key].get("cuteEvidence")
        if isinstance(cute_evidence, dict):
            evidence["cuteEvidence"] = cute_evidence
        evidence_by_sample[key] = evidence
    return evidence_by_sample
