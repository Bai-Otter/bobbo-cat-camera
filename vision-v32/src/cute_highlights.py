from __future__ import annotations

import math
from typing import Any, Sequence


CLOSEUP_MIN_WIDTH_RATIO = 0.25
CLOSEUP_MIN_HEIGHT_RATIO = 0.30
CLOSEUP_MIN_AREA_RATIO = 0.08
FRONT_MIN_SCORE = 0.72
PROFILE_MIN_SCORE = 0.72
PROFILE_MIN_YAW_RATIO = 0.35
PROFILE_MAX_YAW_RATIO = 1.50
PROFILE_MIN_VERTICAL_RATIO = 0.35
PROFILE_MAX_VERTICAL_RATIO = 1.80
HEAD_UP_MIN_SCORE = 0.72
HEAD_UP_MAX_VERTICAL_RATIO = 0.53
HEAD_UP_VERTICAL_RANGE = 0.35
EXTREME_CLOSEUP_SCORE_MIN = 0.80
MODEL_CONFIDENCE_MIN = 0.65
MOUTH_NOT_DOWN_MAX_VERTICAL_RATIO = 1.05
MOUTH_NOT_DOWN_VERTICAL_RANGE = 0.45


def _empty_evidence() -> dict[str, Any]:
    return {
        "closeup": False,
        "closeupScore": 0.0,
        "front": False,
        "frontScore": 0.0,
        "profile": False,
        "profileSide": "",
        "profileScore": 0.0,
        "headUp": False,
        "headUpScore": 0.0,
        "extremeCloseup": False,
        "extremeCloseupScore": 0.0,
        "cuteScore": 0.0,
        "cuteReasons": [],
        "modelConfidence": 0.0,
        "cuteEligible": False,
        "muzzleVerticalRatio": 0.0,
        "faceWidthRatio": 0.0,
        "faceHeightRatio": 0.0,
        "faceAreaRatio": 0.0,
    }


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _point(landmarks: Sequence[Sequence[float]], index: int) -> tuple[float, float]:
    point = landmarks[index]
    if len(point) < 2:
        raise ValueError("landmark must contain x and y")
    x = float(point[0])
    y = float(point[1])
    if not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("landmark must be finite")
    return x, y


def evaluate_cute_face(
    face_box: dict[str, Any] | None,
    landmarks: Sequence[Sequence[float]],
    frame_shape: Sequence[int],
    *,
    model_confidence: float = 0.0,
    landmark_fallback_confidence: bool = False,
) -> dict[str, Any]:
    result = _empty_evidence()
    if not face_box or len(frame_shape) < 2:
        return result

    frame_height = max(0.0, float(frame_shape[0]))
    frame_width = max(0.0, float(frame_shape[1]))
    face_width = max(0.0, float(face_box.get("width") or 0))
    face_height = max(0.0, float(face_box.get("height") or 0))
    if frame_width <= 0 or frame_height <= 0 or face_width <= 0 or face_height <= 0:
        return result

    width_ratio = face_width / frame_width
    height_ratio = face_height / frame_height
    area_ratio = face_width * face_height / (frame_width * frame_height)
    closeup = (
        width_ratio >= CLOSEUP_MIN_WIDTH_RATIO
        and height_ratio >= CLOSEUP_MIN_HEIGHT_RATIO
        and area_ratio >= CLOSEUP_MIN_AREA_RATIO
    )
    # Passing the threshold starts near 0.5 while larger faces retain ranking headroom.
    closeup_score = sum(
        (
            _clamp(width_ratio / (2 * CLOSEUP_MIN_WIDTH_RATIO)),
            _clamp(height_ratio / (2 * CLOSEUP_MIN_HEIGHT_RATIO)),
            _clamp(area_ratio / (2 * CLOSEUP_MIN_AREA_RATIO)),
        )
    ) / 3
    result.update(
        {
            "closeup": closeup,
            "closeupScore": round(closeup_score, 4),
            "faceWidthRatio": round(width_ratio, 4),
            "faceHeightRatio": round(height_ratio, 4),
            "faceAreaRatio": round(area_ratio, 4),
        }
    )

    if len(landmarks) < 48:
        return result
    try:
        left_eye = _point(landmarks, 4)
        right_eye = _point(landmarks, 8)
        mouth_points = [_point(landmarks, index) for index in (16, 17, 46, 47)]
    except (IndexError, TypeError, ValueError):
        return result

    eye_distance = math.dist(left_eye, right_eye)
    if eye_distance < max(4.0, face_width * 0.08):
        return result
    eye_midpoint = (
        (left_eye[0] + right_eye[0]) / 2,
        (left_eye[1] + right_eye[1]) / 2,
    )
    muzzle_midpoint = (
        sum(point[0] for point in mouth_points) / len(mouth_points),
        sum(point[1] for point in mouth_points) / len(mouth_points),
    )
    eye_level_score = 1.0 - _clamp(abs(left_eye[1] - right_eye[1]) / (eye_distance * 0.25))
    muzzle_center_score = 1.0 - _clamp(
        abs(muzzle_midpoint[0] - eye_midpoint[0]) / (eye_distance * 0.35)
    )
    eye_separation_score = _clamp((eye_distance / face_width) / 0.30)
    front_score = (
        eye_level_score * 0.35
        + muzzle_center_score * 0.50
        + eye_separation_score * 0.15
    )
    result["frontScore"] = round(front_score, 4)
    result["front"] = bool(closeup and front_score >= FRONT_MIN_SCORE)
    yaw_ratio = (muzzle_midpoint[0] - eye_midpoint[0]) / eye_distance
    vertical_ratio = (muzzle_midpoint[1] - eye_midpoint[1]) / eye_distance
    head_up_score = _clamp(
        (HEAD_UP_MAX_VERTICAL_RATIO - vertical_ratio) / HEAD_UP_VERTICAL_RANGE
    )
    result["headUpScore"] = round(head_up_score, 4)
    result["headUp"] = bool(closeup and head_up_score >= HEAD_UP_MIN_SCORE)
    result["muzzleVerticalRatio"] = round(vertical_ratio, 4)
    yaw_score = _clamp((abs(yaw_ratio) - 0.25) / 0.75)
    vertical_score = 1.0 - _clamp(abs(vertical_ratio - 0.9) / 0.9)
    profile_score = yaw_score * 0.75 + vertical_score * 0.25
    plausible_profile = (
        PROFILE_MIN_YAW_RATIO <= abs(yaw_ratio) <= PROFILE_MAX_YAW_RATIO
        and PROFILE_MIN_VERTICAL_RATIO <= vertical_ratio <= PROFILE_MAX_VERTICAL_RATIO
    )
    is_profile = bool(
        closeup
        and not result["front"]
        and plausible_profile
        and profile_score >= PROFILE_MIN_SCORE
    )
    result["profileScore"] = round(profile_score, 4) if plausible_profile else 0.0
    result["profile"] = is_profile
    result["profileSide"] = (
        "right" if is_profile and yaw_ratio > 0 else "left" if is_profile else ""
    )

    face_left = float(face_box.get("x") or 0)
    face_top = float(face_box.get("y") or 0)
    face_right = face_left + face_width
    face_bottom = face_top + face_height
    mouth_margin_x = face_width * 0.2
    mouth_margin_y = face_height * 0.2
    mouth_inside_expanded_face = all(
        face_left - mouth_margin_x <= point[0] <= face_right + mouth_margin_x
        and face_top - mouth_margin_y <= point[1] <= face_bottom + mouth_margin_y
        for point in mouth_points
    )
    reliable_model_confidence = _clamp(float(model_confidence or 0))
    if (
        reliable_model_confidence < MODEL_CONFIDENCE_MIN
        and landmark_fallback_confidence
        and mouth_inside_expanded_face
    ):
        reliable_model_confidence = MODEL_CONFIDENCE_MIN
    result["modelConfidence"] = round(reliable_model_confidence, 4)

    size_score = min(
        _clamp(width_ratio / 0.55),
        _clamp(height_ratio / 0.60),
        _clamp(area_ratio / 0.30),
    )
    not_looking_down_score = _clamp(
        (MOUTH_NOT_DOWN_MAX_VERTICAL_RATIO - vertical_ratio)
        / MOUTH_NOT_DOWN_VERTICAL_RANGE
    )
    extreme_closeup_score = size_score * not_looking_down_score
    result["extremeCloseupScore"] = round(extreme_closeup_score, 4)
    result["extremeCloseup"] = bool(
        closeup and extreme_closeup_score >= EXTREME_CLOSEUP_SCORE_MIN
    )
    scene_scores = {
        "extreme_closeup": extreme_closeup_score,
        "head_up": head_up_score,
        "profile_left": profile_score if result["profileSide"] == "left" else 0.0,
        "profile_right": profile_score if result["profileSide"] == "right" else 0.0,
    }
    cute_score = max(scene_scores.values())
    cute_reasons = [
        name
        for name in ("extreme_closeup", "head_up", "profile_left", "profile_right")
        if scene_scores[name] >= EXTREME_CLOSEUP_SCORE_MIN
    ]
    result["cuteScore"] = round(cute_score, 4)
    result["cuteReasons"] = cute_reasons
    result["cuteEligible"] = bool(
        reliable_model_confidence >= MODEL_CONFIDENCE_MIN
        and cute_score >= EXTREME_CLOSEUP_SCORE_MIN
    )
    return result
