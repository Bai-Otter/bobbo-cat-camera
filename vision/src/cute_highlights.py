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
CUTE_SCORE_MIN = 0.65

DEFAULT_CUTE_POLICY = {
    "minCuteScore": CUTE_SCORE_MIN,
    "minProfileCuteScore": 0.55,
    "minModelConfidence": MODEL_CONFIDENCE_MIN,
    "allowedRelations": [],
    "minVisibilityScore": 0.0,
}

RELATION_TOWARD_CAMERA = "toward_camera"
RELATION_PROFILE_LEFT = "profile_left"
RELATION_PROFILE_RIGHT = "profile_right"
RELATION_LOOKING_AWAY = "looking_away"
RELATION_HEAD_DOWN = "head_down"
RELATION_PARTIAL = "partial"
RELATION_UNKNOWN = "unknown"


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
        "strictEligible": False,
        "looseEligible": False,
        "faceRelation": RELATION_UNKNOWN,
        "relationConfidence": 0.0,
        "sizeScore": 0.0,
        "cameraScore": 0.0,
        "pitchScore": 0.0,
        "visibilityScore": 0.0,
        "edgeContact": False,
        "partialFace": False,
        "muzzleVerticalRatio": 0.0,
        "yawRatio": 0.0,
        "faceWidthRatio": 0.0,
        "faceHeightRatio": 0.0,
        "faceAreaRatio": 0.0,
    }


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def normalize_cute_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    """Normalize a tuning report policy while keeping legacy defaults intact."""
    source = policy if isinstance(policy, dict) else {}
    normalized = dict(DEFAULT_CUTE_POLICY)
    for key in ("minCuteScore", "minProfileCuteScore", "minModelConfidence", "minVisibilityScore"):
        try:
            value = float(source.get(key, normalized[key]))
        except (TypeError, ValueError):
            value = normalized[key]
        normalized[key] = _clamp(value)
    relations = source.get("allowedRelations", normalized["allowedRelations"])
    normalized["allowedRelations"] = [str(item) for item in relations if str(item)] if isinstance(relations, list) else []
    return normalized


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
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    policy = normalize_cute_policy(policy)
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
    result["yawRatio"] = round(yaw_ratio, 4)

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
    edge_contact = (
        face_left <= 1
        or face_top <= 1
        or face_right >= frame_width - 1
        or face_bottom >= frame_height - 1
    )
    partial_face = bool(edge_contact and not mouth_inside_expanded_face)
    result["edgeContact"] = edge_contact
    result["partialFace"] = partial_face

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
    pitch_score = _clamp((1.25 - vertical_ratio) / 0.75)
    head_down = vertical_ratio >= MOUTH_NOT_DOWN_MAX_VERTICAL_RATIO
    visibility_score = 0.65 if edge_contact else 1.0
    if partial_face:
        visibility_score = 0.0
    not_looking_down_score = _clamp(
        (MOUTH_NOT_DOWN_MAX_VERTICAL_RATIO - vertical_ratio)
        / MOUTH_NOT_DOWN_VERTICAL_RANGE
    )
    extreme_closeup_score = size_score * not_looking_down_score
    result["extremeCloseupScore"] = round(extreme_closeup_score, 4)
    result["extremeCloseup"] = bool(
        closeup and extreme_closeup_score >= EXTREME_CLOSEUP_SCORE_MIN
    )

    if partial_face:
        relation = RELATION_PARTIAL
        relation_confidence = 0.9
    elif head_down:
        relation = RELATION_HEAD_DOWN
        relation_confidence = _clamp((vertical_ratio - 0.9) / 0.6)
    elif result["front"]:
        relation = RELATION_TOWARD_CAMERA
        relation_confidence = front_score
    elif result["profile"] and result["profileSide"] == "left":
        relation = RELATION_PROFILE_LEFT
        relation_confidence = profile_score
    elif result["profile"] and result["profileSide"] == "right":
        relation = RELATION_PROFILE_RIGHT
        relation_confidence = profile_score
    elif abs(yaw_ratio) >= 0.55 or front_score < 0.45:
        relation = RELATION_LOOKING_AWAY
        relation_confidence = _clamp(max(abs(yaw_ratio) / 1.5, 1.0 - front_score))
    else:
        relation = RELATION_UNKNOWN
        relation_confidence = _clamp(0.5 * front_score + 0.5 * pitch_score)

    result["faceRelation"] = relation
    result["relationConfidence"] = round(relation_confidence, 4)
    result["sizeScore"] = round(size_score, 4)
    result["pitchScore"] = round(pitch_score, 4)
    result["visibilityScore"] = round(visibility_score, 4)

    if relation == RELATION_TOWARD_CAMERA:
        camera_score = front_score
    elif relation in {RELATION_PROFILE_LEFT, RELATION_PROFILE_RIGHT}:
        camera_score = profile_score * 0.75
    elif relation == RELATION_UNKNOWN:
        camera_score = front_score * 0.65
    else:
        camera_score = 0.0
    cute_score = _clamp(
        0.40 * size_score
        + 0.30 * camera_score
        + 0.20 * pitch_score
        + 0.10 * visibility_score
    )
    if relation in {RELATION_LOOKING_AWAY, RELATION_HEAD_DOWN, RELATION_PARTIAL}:
        cute_score = 0.0
    result["cameraScore"] = round(camera_score, 4)

    scene_scores = {
        "extreme_closeup": extreme_closeup_score,
        "head_up": head_up_score,
        "front": front_score,
        "profile_left": profile_score if result["profileSide"] == "left" else 0.0,
        "profile_right": profile_score if result["profileSide"] == "right" else 0.0,
    }
    result["cuteReasons"] = [
        name
        for name, score in scene_scores.items()
        if score >= EXTREME_CLOSEUP_SCORE_MIN
    ]
    result["cuteScore"] = round(cute_score, 4)
    relation_eligible = {
        RELATION_TOWARD_CAMERA,
        RELATION_PROFILE_LEFT,
        RELATION_PROFILE_RIGHT,
    }
    relation_score_min = policy["minProfileCuteScore"] if relation in {
        RELATION_PROFILE_LEFT,
        RELATION_PROFILE_RIGHT,
    } else policy["minCuteScore"]
    relation_allowed = not policy["allowedRelations"] or relation in set(policy["allowedRelations"])
    result["strictEligible"] = bool(
        reliable_model_confidence >= policy["minModelConfidence"]
        and relation in relation_eligible
        and relation_allowed
        and visibility_score >= policy["minVisibilityScore"]
        and cute_score >= relation_score_min
    )
    result["looseEligible"] = bool(
        reliable_model_confidence >= policy["minModelConfidence"]
        and relation in relation_eligible | {RELATION_UNKNOWN}
        and relation_allowed
        and visibility_score >= policy["minVisibilityScore"]
        and cute_score >= relation_score_min
    )
    result["cuteEligible"] = result["strictEligible"] or result["looseEligible"]
    return result


def smooth_cute_frames(
    frames: list[dict[str, Any]],
    window: int = 3,
    policy: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Suppress one-sample relation spikes while preserving raw score evidence."""
    if not frames:
        return frames
    policy = normalize_cute_policy(policy)
    radius = max(1, int(window) // 2)
    ordered = sorted(
        range(len(frames)),
        key=lambda index: float(frames[index].get("offsetSec", frames[index].get("second") or 0)),
    )
    relations = [
        str((frames[index].get("cuteEvidence") or {}).get("faceRelation") or RELATION_UNKNOWN)
        for index in ordered
    ]
    for position, index in enumerate(ordered):
        evidence = frames[index].get("cuteEvidence")
        if not isinstance(evidence, dict):
            continue
        start = max(0, position - radius)
        end = min(len(ordered), position + radius + 1)
        votes = relations[start:end]
        candidates = [item for item in set(votes) if item != RELATION_UNKNOWN]
        if not candidates:
            continue
        smoothed = max(candidates, key=lambda item: (votes.count(item), item == relations[position]))
        if votes.count(smoothed) < 2 or smoothed == relations[position]:
            continue
        evidence["faceRelation"] = smoothed
        evidence["relationConfidence"] = round(
            max(float(evidence.get("relationConfidence") or 0), votes.count(smoothed) / len(votes)),
            4,
        )
        frame = frames[index]
        frame["faceRelation"] = smoothed
        relation_eligible = {
            RELATION_TOWARD_CAMERA,
            RELATION_PROFILE_LEFT,
            RELATION_PROFILE_RIGHT,
        }
        relation_score_min = policy["minProfileCuteScore"] if smoothed in {
            RELATION_PROFILE_LEFT,
            RELATION_PROFILE_RIGHT,
        } else policy["minCuteScore"]
        relation_allowed = not policy["allowedRelations"] or smoothed in set(policy["allowedRelations"])
        evidence["strictEligible"] = bool(
            evidence.get("modelConfidence", 0) >= policy["minModelConfidence"]
            and smoothed in relation_eligible
            and relation_allowed
            and evidence.get("visibilityScore", 0) >= policy["minVisibilityScore"]
            and evidence.get("cuteScore", 0) >= relation_score_min
        )
        evidence["looseEligible"] = bool(
            evidence.get("modelConfidence", 0) >= policy["minModelConfidence"]
            and smoothed in relation_eligible | {RELATION_UNKNOWN}
            and relation_allowed
            and evidence.get("visibilityScore", 0) >= policy["minVisibilityScore"]
            and evidence.get("cuteScore", 0) >= relation_score_min
        )
        evidence["cuteEligible"] = evidence["strictEligible"] or evidence["looseEligible"]
    return frames
