from __future__ import annotations

import math
import time
from typing import Any, Callable

from .markers import build_markers, normalize_cute_reasons, normalize_target, parse_begin_ms
from .cute_highlights import smooth_cute_frames

VideoReader = Callable[..., dict[str, Any]]


def _clamp_score(value: Any) -> float:
    try:
        score = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(score):
        return 0.0
    return round(max(0.0, min(1.0, score)), 4)


def _offset_seconds(frame: dict[str, Any]) -> float:
    try:
        offset = float(frame.get("offsetSec", frame.get("second") or 0))
    except (TypeError, ValueError):
        return 0.0
    return offset if math.isfinite(offset) else 0.0


def build_cute_timeline(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline = []
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        evidence = frame.get("cuteEvidence")
        if not isinstance(evidence, dict):
            evidence = {}

        item = {
            "offsetSec": _offset_seconds(frame),
            "cuteScore": _clamp_score(evidence.get("cuteScore")),
            "modelConfidence": _clamp_score(evidence.get("modelConfidence")),
            "cuteReasons": normalize_cute_reasons(evidence.get("cuteReasons")),
            "hasCat": bool(frame.get("hasCat")),
        }
        if "faceRelation" in evidence or "faceRelation" in frame:
            item.update(
                {
                    "faceRelation": str(
                        evidence.get("faceRelation") or frame.get("faceRelation") or "unknown"
                    ),
                    "relationConfidence": _clamp_score(evidence.get("relationConfidence")),
                    "strictEligible": bool(evidence.get("strictEligible")),
                    "looseEligible": bool(evidence.get("looseEligible")),
                    "sizeScore": _clamp_score(evidence.get("sizeScore")),
                    "cameraScore": _clamp_score(evidence.get("cameraScore")),
                    "pitchScore": _clamp_score(evidence.get("pitchScore")),
                    "visibilityScore": _clamp_score(evidence.get("visibilityScore")),
                }
            )
        timeline.append(item)
    return timeline


def _sanitize_roi(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    try:
        return {
            "x": int(value.get("x") or 0),
            "y": int(value.get("y") or 0),
            "width": max(0, int(value.get("width") or 0)),
            "height": max(0, int(value.get("height") or 0)),
        }
    except (TypeError, ValueError):
        return None


def _finite_number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _sanitize_behavior_evidence(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result = {
        "eatingVerified": bool(value.get("eatingVerified")),
        "confidence": _clamp_score(value.get("confidence")),
        "faceObserved": bool(value.get("faceObserved")),
        "faceAtBowl": bool(value.get("faceAtBowl")),
        "reason": str(value.get("reason") or ""),
    }
    for field in (
        "poseVerifiedRatio",
        "faceContactRatio",
        "maskContactRatio",
        "poseConfidence",
        "motionScore",
        "motionActiveRatio",
    ):
        if field in value:
            result[field] = _clamp_score(value.get(field))
    if "sampleCount" in value:
        result["sampleCount"] = max(0, int(_finite_number(value.get("sampleCount"))))
    if value.get("verificationMode"):
        result["verificationMode"] = str(value.get("verificationMode"))
    return result


def build_frame_timeline(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline = []
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            continue
        timeline.append(
            {
                "sampleIndex": max(0, int(_finite_number(frame.get("sampleIndex"), index))),
                "offsetSec": _offset_seconds(frame),
                "second": max(0, int(_finite_number(frame.get("second")))),
                "hasCat": bool(frame.get("hasCat")),
                "hasTarget": bool(frame.get("hasTarget")),
                "nearBowl": bool(frame.get("nearBowl")),
                "eatingVerified": bool(frame.get("eatingVerified")),
                "confidence": _clamp_score(frame.get("confidence")),
                "behaviorEvidence": _sanitize_behavior_evidence(frame.get("behaviorEvidence")),
                "bowlRoi": _sanitize_roi(frame.get("bowlRoi")),
            }
        )
    return timeline


def _empty_result(payload: dict[str, Any], started_at: float, error: str) -> dict[str, Any]:
    target = normalize_target(payload.get("detectionTarget") or "cat")
    return {
        "recordingKey": str(payload.get("recordingKey") or ""),
        "target": target,
        "hasCat": False,
        "hasFeeding": False,
        "analysisConfidence": 0,
        "feedingEvidence": {
            "candidateSeconds": 0,
            "verifiedSeconds": 0,
            "maxConfidence": 0.0,
            "rejectionReasons": {},
        },
        "bowlRoi": payload.get("bowlRoi"),
        "detectorBackend": str(payload.get("detectorBackend") or "auto"),
        "detectorError": "",
        "markers": [],
        "cuteTimeline": [],
        "frames": [],
        "framesSampled": 0,
        "durationMs": _duration_ms(started_at),
        "error": error,
    }


def _duration_ms(started_at: float) -> int:
    return max(0, int(round((time.perf_counter() - started_at) * 1000)))


def _average_positive_confidence(frames: list[dict[str, Any]]) -> float:
    values = [
        float(frame.get("confidence") or 0)
        for frame in frames
        if frame.get("hasCat") or frame.get("nearBowl")
    ]
    if not values:
        return 0
    return round(sum(values) / len(values), 3)


def _feeding_evidence_summary(frames: list[dict[str, Any]]) -> dict[str, Any]:
    per_second: dict[int, dict[str, Any]] = {}
    for frame in frames:
        evidence = frame.get("behaviorEvidence") or {}
        if (
            not frame.get("eatingVerified")
            and str(evidence.get("reason") or "") in {"", "NOT_A_FEEDING_CANDIDATE"}
        ):
            continue
        second = int(frame.get("second") or 0)
        summary = per_second.setdefault(
            second,
            {"verified": False, "confidence": 0.0, "reason": ""},
        )
        if frame.get("eatingVerified"):
            summary["verified"] = True
            summary["confidence"] = max(
                summary["confidence"],
                float(evidence.get("confidence") or 0),
            )
        elif not summary["verified"] and not summary["reason"]:
            summary["reason"] = str(
                evidence.get("reason")
                or "EATING_NOT_VERIFIED"
            )

    candidates = list(per_second.values())
    verified = [summary for summary in candidates if summary["verified"]]
    confidences = [
        summary["confidence"]
        for summary in verified
    ]
    rejection_reasons: dict[str, int] = {}
    for summary in candidates:
        if summary["verified"]:
            continue
        reason = summary["reason"] or "EATING_NOT_VERIFIED"
        rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1
    return {
        "candidateSeconds": len(candidates),
        "verifiedSeconds": len(verified),
        "maxConfidence": round(max(confidences or [0.0]), 4),
        "rejectionReasons": rejection_reasons,
    }


def _default_video_reader(
    source_url: str,
    bowl_roi: dict[str, Any] | None = None,
    detector_backend: str | None = "auto",
    yolo_model: str | None = None,
    detection_target: str | None = "cat",
    auto_bowl_detection: bool = False,
    cute_analysis_all_scales: bool = False,
    cute_policy: dict[str, Any] | None = None,
    max_duration_sec: float | None = None,
    sample_seconds: float = 0.5,
    sample_offset_seconds: float = 0.0,
    screen_only: bool = False,
    orientation: str = "none",
    adaptive_feeding: bool = False,
    fixed_bottom_bowl_region: bool = False,
) -> dict[str, Any]:
    from .video import read_video_frames

    options = {
        "bowl_roi": bowl_roi,
        "sample_seconds": max(0.5, float(sample_seconds or 0.5)),
        "detector_backend": detector_backend,
        "yolo_model": yolo_model,
        "detection_target": detection_target,
        "auto_bowl_detection": auto_bowl_detection,
        "screen_only": bool(screen_only),
        "orientation": orientation,
        "adaptive_feeding": bool(adaptive_feeding),
        "fixed_bottom_bowl_region": bool(fixed_bottom_bowl_region),
    }
    if sample_offset_seconds > 0:
        options["sample_offset_seconds"] = max(0.0, float(sample_offset_seconds))
    if max_duration_sec is not None and max_duration_sec > 0:
        options["max_duration_sec"] = max_duration_sec
    if cute_analysis_all_scales:
        options["cute_analysis_all_scales"] = True
    if cute_policy is not None:
        options["cute_policy"] = cute_policy
    return read_video_frames(source_url, **options)


def analyze_recording(
    payload: dict[str, Any],
    video_reader: VideoReader | None = None,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    source_url = str(payload.get("sourceUrl") or "").strip()
    detection_target = normalize_target(payload.get("detectionTarget") or "cat")
    if not source_url:
        return _empty_result(payload, started_at, "SOURCE_MISSING")

    try:
        begin_ms = parse_begin_ms(payload.get("beginTime"))
    except (TypeError, ValueError):
        return _empty_result(payload, started_at, "BEGIN_TIME_INVALID")

    reader_options = {
        "detector_backend": payload.get("detectorBackend") or "auto",
        "yolo_model": payload.get("yoloModel") or None,
        "detection_target": detection_target,
        "auto_bowl_detection": bool(payload.get("autoBowlDetection")),
        "screen_only": bool(payload.get("screenOnly")),
        "orientation": payload.get("orientation") or "none",
        "adaptive_feeding": bool(payload.get("adaptiveFeeding")),
        "fixed_bottom_bowl_region": bool(payload.get("fixedBottomBowlRegion")),
    }
    try:
        sample_seconds = float(payload.get("sampleSeconds") or 0.5)
    except (TypeError, ValueError):
        sample_seconds = 0.5
    reader_options["sample_seconds"] = max(0.5, min(10.0, sample_seconds))
    try:
        sample_offset_seconds = float(payload.get("sampleOffsetSeconds") or 0.0)
    except (TypeError, ValueError):
        sample_offset_seconds = 0.0
    if sample_offset_seconds > 0:
        reader_options["sample_offset_seconds"] = min(
            reader_options["sample_seconds"] - 0.001,
            sample_offset_seconds,
        )
    try:
        duration_sec = float(payload.get("durationSec") or 0)
    except (TypeError, ValueError):
        duration_sec = 0
    if duration_sec > 0:
        reader_options["max_duration_sec"] = duration_sec
    if payload.get("cuteAnalysisAllScales"):
        reader_options["cute_analysis_all_scales"] = True
    if payload.get("cutePolicy") is not None:
        reader_options["cute_policy"] = payload.get("cutePolicy")

    if video_reader:
        read_result = video_reader(
            source_url,
            payload.get("bowlRoi"),
            **reader_options,
        )
    else:
        read_result = _default_video_reader(
            source_url,
            payload.get("bowlRoi"),
            **reader_options,
        )
    frames = list(read_result.get("frames") or [])
    screen_only = bool(payload.get("screenOnly"))
    if not screen_only:
        smooth_cute_frames(frames, policy=payload.get("cutePolicy"))
        for frame in frames:
            evidence = frame.get("cuteEvidence")
            if isinstance(evidence, dict) and "faceRelation" in evidence:
                frame["faceRelation"] = str(evidence.get("faceRelation") or "unknown")
    error = str(read_result.get("error") or "")
    if error:
        result = _empty_result(payload, started_at, error)
        result["bowlRoi"] = read_result.get("bowlRoi") or payload.get("bowlRoi")
        result["detectorBackend"] = read_result.get("detectorBackend") or result["detectorBackend"]
        result["detectorError"] = read_result.get("detectorError") or ""
        return result

    summary = build_markers(begin_ms, frames, target=detection_target)
    cute_timeline = []
    if (
        not screen_only
        and not read_result.get("skipped")
        and not (read_result.get("sceneQuality") or {}).get("isDark")
    ):
        cute_timeline = build_cute_timeline(frames)
    return {
        "recordingKey": str(payload.get("recordingKey") or ""),
        "target": detection_target,
        "hasCat": bool(summary["hasCat"]),
        "hasFeeding": bool(summary["hasFeeding"]),
        "analysisConfidence": _average_positive_confidence(frames),
        "feedingEvidence": _feeding_evidence_summary(frames),
        "bowlRoi": read_result.get("bowlRoi") or payload.get("bowlRoi"),
        "detectorBackend": read_result.get("detectorBackend") or str(payload.get("detectorBackend") or "auto"),
        "detectorError": read_result.get("detectorError") or "",
        "markers": summary["markers"],
        "frames": build_frame_timeline(frames),
        "cuteTimeline": cute_timeline,
        "framesSampled": len(frames),
        "durationMs": _duration_ms(started_at),
        "error": "",
    }
