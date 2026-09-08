from __future__ import annotations

import datetime as dt
from typing import Any


CAT_ENTER_SECONDS = 1
CAT_LEAVE_SECONDS = 4
FEEDING_START_SECONDS = 7
FEEDING_END_SECONDS = 9
FEEDING_MAX_GAP_SECONDS = 2
FEEDING_CHEWING_MAX_GAP_SECONDS = 30
FEEDING_CHEWING_MIN_SUPPORT_RATIO = 0.25
FEEDING_SEED_MIN_VERIFIED_SECONDS = 3
CUTE_MARKER_MIN_SEPARATION_SECONDS = 3


def parse_begin_ms(value: str | None) -> int:
    if not value:
        return 0
    normalized = str(value).strip().replace("-", "/")
    parsed = dt.datetime.strptime(normalized, "%Y/%m/%d %H:%M:%S")
    return int(parsed.timestamp() * 1000)


def ms_to_text(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")


def normalize_target(value: str | None = "cat") -> str:
    target = str(value or "cat").strip().lower()
    return "face" if target == "face" else "cat"


def normalize_cute_reasons(value: Any) -> list[str]:
    if isinstance(value, str):
        candidates = [value]
    elif isinstance(value, (list, tuple)):
        candidates = value
    else:
        return []

    reasons = []
    for candidate in candidates:
        if isinstance(candidate, str) and candidate not in reasons:
            reasons.append(candidate)
    return reasons


def marker(
    marker_type: str,
    marker_ts_ms: int,
    offset_sec: int | float,
    target: str | None = "cat",
    confidence: float | None = None,
    model_confidence: float | None = None,
    cute_score: float | None = None,
    cute_reasons: Any = None,
) -> dict[str, Any]:
    timestamp = ms_to_text(marker_ts_ms)
    numeric_offset = float(offset_sec)
    normalized_offset = int(numeric_offset) if numeric_offset.is_integer() else numeric_offset
    item = {
        "markerType": marker_type,
        "markerTsMs": int(marker_ts_ms),
        "offsetSec": normalized_offset,
        "offsetMs": int(round(numeric_offset * 1000)),
        "beginTime": timestamp,
        "endTime": timestamp,
        "target": normalize_target(target),
    }
    if confidence is not None:
        item["confidence"] = round(max(0.0, min(1.0, float(confidence))), 4)
    if model_confidence is not None:
        item["modelConfidence"] = round(max(0.0, min(1.0, float(model_confidence))), 4)
    if cute_score is not None:
        item["cuteScore"] = round(max(0.0, min(1.0, float(cute_score))), 4)
    if cute_reasons is not None:
        item["cuteReasons"] = normalize_cute_reasons(cute_reasons)
    return item


def marker_ts(begin_ms: int, offset_sec: int | float) -> int:
    return int(begin_ms) + int(round(float(offset_sec) * 1000))


def positive_runs(seconds: list[int], max_gap_seconds: int = 0) -> list[dict[str, int]]:
    if not seconds:
        return []

    runs = []
    start = previous = seconds[0]
    count = 1
    for second in seconds[1:]:
        missing_seconds = second - previous - 1
        if missing_seconds <= max_gap_seconds:
            previous = second
            count += 1
            continue

        runs.append({"start": start, "end": previous, "count": count})
        start = previous = second
        count = 1

    runs.append({"start": start, "end": previous, "count": count})
    return runs


def _frame_supports_feeding(frame: dict[str, Any] | None) -> bool:
    return bool(
        frame
        and (
            frame.get("nearBowl")
            or frame.get("hasTarget")
            or frame.get("hasCat")
            or (frame.get("behaviorEvidence") or {}).get("faceObserved")
        )
    )


def _frames_by_second(frames: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    aggregated = {}
    for frame in frames:
        second = int(frame.get("second") or 0)
        current = aggregated.setdefault(second, {"second": second})
        for key in ("nearBowl", "hasTarget", "hasCat", "eatingVerified"):
            current[key] = bool(current.get(key) or frame.get(key))
        if (frame.get("behaviorEvidence") or {}).get("faceObserved"):
            current["behaviorEvidence"] = {"faceObserved": True}
    return aggregated


def feeding_runs(frames: list[dict[str, Any]], verified_seconds: list[int]) -> list[dict[str, int]]:
    if not verified_seconds:
        return []
    frames_by_second = _frames_by_second(frames)
    runs = []
    start = previous = verified_seconds[0]
    count = 1
    for second in verified_seconds[1:]:
        missing_seconds = second - previous - 1
        can_bridge = missing_seconds <= FEEDING_MAX_GAP_SECONDS
        if not can_bridge and missing_seconds <= FEEDING_CHEWING_MAX_GAP_SECONDS:
            gap = range(previous + 1, second)
            support_count = sum(
                1
                for gap_second in gap
                if _frame_supports_feeding(frames_by_second.get(gap_second))
            )
            can_bridge = support_count / max(1, missing_seconds) >= FEEDING_CHEWING_MIN_SUPPORT_RATIO
        if can_bridge:
            previous = second
            count += 1
            continue
        runs.append({"start": start, "end": previous, "count": count})
        start = previous = second
        count = 1
    runs.append({"start": start, "end": previous, "count": count})
    return runs


def build_feeding_markers(
    begin_ms: int,
    frames: list[dict[str, Any]],
    target: str | None = "cat",
) -> list[dict[str, Any]]:
    if normalize_target(target) != "cat":
        return []

    verified_seconds = sorted(
        {int(frame.get("second") or 0) for frame in frames if frame.get("eatingVerified")}
    )
    if not verified_seconds:
        return []

    seed = next(
        (
            run
            for run in positive_runs(verified_seconds, max_gap_seconds=FEEDING_MAX_GAP_SECONDS)
            if run["count"] >= FEEDING_SEED_MIN_VERIFIED_SECONDS
        ),
        None,
    )
    if seed is None:
        return []
    verified_seconds = [second for second in verified_seconds if second >= seed["start"]]

    last_second = max((int(frame.get("second") or 0) for frame in frames), default=verified_seconds[-1])
    frames_by_second = _frames_by_second(frames)
    for run in feeding_runs(frames, verified_seconds):
        if run["end"] - run["start"] >= FEEDING_START_SECONDS:
            supported_end = run["end"]
            tail_limit = min(last_second, run["end"] + FEEDING_END_SECONDS)
            for second in range(run["end"] + 1, tail_limit + 1):
                if _frame_supports_feeding(frames_by_second.get(second)):
                    supported_end = second
            event_end = min(supported_end + 1, last_second)
            return [
                marker("feeding_start", marker_ts(begin_ms, run["start"]), run["start"], target="cat"),
                marker(
                    "feeding_end",
                    marker_ts(begin_ms, event_end),
                    event_end,
                    target="cat",
                ),
            ]

    return []


def build_cute_markers(
    begin_ms: int,
    frames: list[dict[str, Any]],
    target: str | None = "cat",
) -> list[dict[str, Any]]:
    if normalize_target(target) != "cat":
        return []

    cute_markers = []
    for marker_type, flag_key, score_key, profile_side in (
        ("cute_closeup", "closeup", "closeupScore", ""),
        ("cute_front", "front", "frontScore", ""),
        ("cute_extreme_closeup", "extremeCloseup", "extremeCloseupScore", ""),
        ("cute_head_up", "headUp", "headUpScore", ""),
        ("cute_profile_left", "profile", "profileScore", "left"),
        ("cute_profile_right", "profile", "profileScore", "right"),
    ):
        hits = []
        for frame in frames:
            evidence = frame.get("cuteEvidence")
            if not isinstance(evidence, dict) or not evidence.get(flag_key):
                continue
            if "cuteEligible" in evidence and not evidence.get("cuteEligible"):
                continue
            if profile_side and evidence.get("profileSide") != profile_side:
                continue
            hits.append(
                {
                    "second": int(frame.get("second") or 0),
                    "offsetSec": float(frame.get("offsetSec", frame.get("second") or 0)),
                    "score": max(0.0, min(1.0, float(evidence.get(score_key) or 0))),
                    "modelConfidence": evidence.get("modelConfidence"),
                    "cuteScore": evidence.get("cuteScore"),
                    "cuteReasons": normalize_cute_reasons(evidence.get("cuteReasons")),
                }
            )
        if not hits:
            continue

        selected = []
        for hit in sorted(hits, key=lambda item: (-item["score"], item["offsetSec"])):
            if any(
                abs(hit["offsetSec"] - kept["offsetSec"]) < CUTE_MARKER_MIN_SEPARATION_SECONDS
                for kept in selected
            ):
                continue
            selected.append(hit)

        for best in sorted(selected, key=lambda item: item["offsetSec"]):
            cute_markers.append(
                marker(
                    marker_type,
                    marker_ts(begin_ms, best["offsetSec"]),
                    best["offsetSec"],
                    target="cat",
                    confidence=best["score"],
                    model_confidence=best.get("modelConfidence"),
                    cute_score=best.get("cuteScore"),
                    cute_reasons=best.get("cuteReasons"),
                )
            )
    return cute_markers


def build_markers(
    begin_ms: int,
    frames: list[dict[str, Any]],
    target: str | None = "cat",
) -> dict[str, Any]:
    normalized_target = normalize_target(target)
    markers = []
    has_cat = False
    cat_positive_start = None
    cat_negative_start = None
    cat_entered = False
    enter_type = f"{normalized_target}_enter"
    leave_type = f"{normalized_target}_leave"

    for frame in frames:
        second = int(frame.get("second") or 0)
        frame_has_cat = bool(frame.get("hasTarget", frame.get("hasCat")))

        if frame_has_cat:
            has_cat = True
            cat_negative_start = None
            if cat_positive_start is None:
                cat_positive_start = second
            if not cat_entered and second - cat_positive_start >= CAT_ENTER_SECONDS:
                cat_entered = True
                markers.append(
                    marker(enter_type, marker_ts(begin_ms, cat_positive_start), cat_positive_start, target=normalized_target)
                )
        else:
            cat_positive_start = None
            if cat_entered:
                if cat_negative_start is None:
                    cat_negative_start = second
                if second - cat_negative_start >= CAT_LEAVE_SECONDS:
                    markers.append(
                        marker(leave_type, marker_ts(begin_ms, cat_negative_start), cat_negative_start, target=normalized_target)
                    )
                    cat_entered = False

    feeding_markers = build_feeding_markers(begin_ms, frames, target=normalized_target)
    markers.extend(feeding_markers)
    markers.extend(build_cute_markers(begin_ms, frames, target=normalized_target))

    return {
        "target": normalized_target,
        "hasCat": has_cat,
        "hasFeeding": len(feeding_markers) > 0,
        "markers": sorted(markers, key=lambda item: item["markerTsMs"]),
    }
