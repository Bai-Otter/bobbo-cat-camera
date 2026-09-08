from __future__ import annotations

import math
from typing import Any, Iterable

from evaluation.cute_annotation import positive_rank_score


DEFAULT_CONFIG = {
    "anchorRankMin": 0.65,
    "anchorCuteMin": 0.55,
    "continuityMin": 0.45,
    "minSegmentSec": 4.0,
    "targetSegmentSec": 6.0,
    "maxSegmentSec": 8.0,
    "maxGapSec": 1.0,
    "maxTransitionSec": 1.0,
    "nmsRadiusSec": 1.5,
    "modelConfidenceMin": 0.55,
    "anchorModelConfidenceMin": 0.65,
}

BAD_RELATIONS = {"looking_away", "head_down"}
INVALID_RELATIONS = BAD_RELATIONS | {"partial"}


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _clamp(value: Any) -> float:
    return max(0.0, min(1.0, _number(value)))


def _evidence(frame: dict[str, Any]) -> dict[str, Any]:
    evidence = frame.get("cuteEvidence")
    return evidence if isinstance(evidence, dict) else {}


def _merged(frame: dict[str, Any]) -> dict[str, Any]:
    merged = dict(frame)
    merged.update(_evidence(frame))
    return merged


def _relation(frame: dict[str, Any]) -> str:
    merged = _merged(frame)
    return str(merged.get("faceRelation") or frame.get("faceRelation") or "unknown")


def normalize_cute_samples(frames: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize analyzer frames into the small set needed for temporal ranking."""
    samples = []
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            continue
        merged = _merged(frame)
        offset = _number(frame.get("offsetSec", frame.get("second", index * 0.5)), -1.0)
        if offset < 0:
            continue
        has_cat = bool(frame.get("hasCat", frame.get("hasTarget")))
        model_confidence = _clamp(
            merged.get("modelConfidence", frame.get("confidence", frame.get("presenceConfidence", 0)))
        )
        cute_score = _clamp(merged.get("cuteScore"))
        rank_score = _clamp(frame.get("rankScore"))
        if not rank_score:
            rank_score = positive_rank_score(merged)
        samples.append(
            {
                "offsetSec": round(offset, 4),
                "hasCat": has_cat,
                "modelConfidence": round(model_confidence, 4),
                "cuteScore": round(cute_score, 4),
                "rankScore": round(rank_score, 4),
                "faceRelation": _relation(frame),
                "partialFace": bool(merged.get("partialFace")),
                "hasEvidence": bool(rank_score > 0 or cute_score > 0),
            }
        )
    return sorted(samples, key=lambda item: item["offsetSec"])


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def smooth_cute_samples(samples: list[dict[str, Any]], window_samples: int = 3) -> list[dict[str, Any]]:
    """Add a short robust temporal score without overwriting the raw peak score."""
    if not samples:
        return []
    radius = max(0, int(window_samples) // 2)
    output = []
    for index, sample in enumerate(samples):
        start = max(0, index - radius)
        end = min(len(samples), index + radius + 1)
        neighborhood = [item["rankScore"] for item in samples[start:end]]
        median_score = _median(neighborhood)
        continuity = 0.6 * median_score + 0.4 * sample["rankScore"]
        if sample["rankScore"] > 0:
            continuity = max(continuity, sample["rankScore"] * 0.8)
        if sample["hasCat"] and not sample.get("partialFace") and sample["rankScore"] <= 0:
            previous = next(
                (
                    item
                    for item in reversed(samples[:index])
                    if item["hasCat"] and item["rankScore"] > 0
                ),
                None,
            )
            following = next(
                (
                    item
                    for item in samples[index + 1 :]
                    if item["hasCat"] and item["rankScore"] > 0
                ),
                None,
            )
            previous_distance = sample["offsetSec"] - previous["offsetSec"] if previous else math.inf
            following_distance = following["offsetSec"] - sample["offsetSec"] if following else math.inf
            if previous_distance <= 1.0 and following_distance <= 1.0:
                weight = previous_distance / max(0.001, previous_distance + following_distance)
                continuity = previous["rankScore"] * (1 - weight) + following["rankScore"] * weight
            elif previous_distance <= 1.0:
                continuity = previous["rankScore"] * 0.85
            elif following_distance <= 1.0:
                continuity = following["rankScore"] * 0.85
        output.append({
            **sample,
            "medianScore": round(median_score, 4),
            "continuityScore": round(_clamp(continuity), 4),
        })
    return output


def _is_anchor(sample: dict[str, Any], config: dict[str, float]) -> bool:
    if not sample["hasCat"] or sample["partialFace"]:
        return False
    if sample["modelConfidence"] < config["anchorModelConfidenceMin"]:
        return False
    if sample["faceRelation"] in INVALID_RELATIONS:
        return False
    return (
        sample["rankScore"] >= config["anchorRankMin"]
        and (
            sample["cuteScore"] >= config["anchorCuteMin"]
            or sample["rankScore"] >= config["anchorRankMin"] + 0.10
        )
    )


def _is_valid_context(sample: dict[str, Any], config: dict[str, float]) -> bool:
    if not sample["hasCat"] or sample["partialFace"] or not sample["hasEvidence"]:
        return False
    if sample["modelConfidence"] < config["modelConfidenceMin"]:
        return False
    if sample["faceRelation"] in INVALID_RELATIONS:
        return False
    return sample["continuityScore"] >= config["continuityMin"]


def _is_padding_context(sample: dict[str, Any], config: dict[str, float]) -> bool:
    """Allow low-scoring cat frames only while satisfying the four-second floor."""
    if not sample["hasCat"] or sample["partialFace"] or not sample["hasEvidence"]:
        return False
    if sample["modelConfidence"] < config["modelConfidenceMin"]:
        return False
    if sample["faceRelation"] in {"partial"}:
        return False
    # A high-confidence detector box alone is not enough: samples with no
    # usable face evidence have a zero rank and must not become filler.
    return sample["rankScore"] >= 0.35 or sample["cuteScore"] >= 0.35


def _is_bad_transition(sample: dict[str, Any]) -> bool:
    return sample["faceRelation"] in BAD_RELATIONS


def _sample_step(samples: list[dict[str, Any]]) -> float:
    offsets = [samples[index + 1]["offsetSec"] - samples[index]["offsetSec"] for index in range(len(samples) - 1)]
    positive = [value for value in offsets if value > 0]
    return min(positive) if positive else 0.5


def _nearest_index(samples: list[dict[str, Any]], offset: float) -> int:
    return min(range(len(samples)), key=lambda index: abs(samples[index]["offsetSec"] - offset))


def _non_maximum_peaks(samples: list[dict[str, Any]], config: dict[str, float]) -> list[int]:
    eligible = [index for index, sample in enumerate(samples) if _is_anchor(sample, config)]
    ranked = sorted(
        eligible,
        key=lambda index: (-samples[index]["rankScore"], -samples[index]["cuteScore"], samples[index]["offsetSec"]),
    )
    selected: list[int] = []
    for index in ranked:
        if all(abs(samples[index]["offsetSec"] - samples[item]["offsetSec"]) >= config["nmsRadiusSec"] for item in selected):
            selected.append(index)
    return sorted(selected, key=lambda index: samples[index]["offsetSec"])


def _can_extend(
    sample: dict[str, Any],
    transition_sec: float,
    missing_sec: float,
    config: dict[str, float],
    *,
    padding: bool = False,
) -> bool:
    if not sample["hasCat"]:
        return missing_sec <= config["maxGapSec"]
    if sample["partialFace"] or sample["modelConfidence"] < config["modelConfidenceMin"]:
        return False
    if _is_bad_transition(sample):
        return transition_sec < config["maxTransitionSec"]
    return _is_padding_context(sample, config) if padding else _is_valid_context(sample, config)


def _expand_peak(
    samples: list[dict[str, Any]],
    peak_index: int,
    duration_sec: float,
    config: dict[str, float],
) -> dict[str, Any]:
    step = _sample_step(samples)
    peak = samples[peak_index]
    min_sec = config["minSegmentSec"]
    target_sec = config["targetSegmentSec"]
    max_sec = config["maxSegmentSec"]
    start_sec = max(0.0, peak["offsetSec"] - min_sec / 2)
    end_sec = min(duration_sec, peak["offsetSec"] + min_sec / 2)
    start_index = _nearest_index(samples, start_sec)
    end_index = _nearest_index(samples, end_sec)
    if end_index < start_index:
        start_index, end_index = end_index, start_index

    transition_sec = 0.0
    missing_sec = 0.0
    left = start_index
    right = end_index
    # The floor is allowed to include valid cat context even when its score is low.
    while right - left + 1 < max(1, int(math.ceil(min_sec / step))):
        options = []
        for direction, index in ((-1, left - 1), (1, right + 1)):
            if index < 0 or index >= len(samples):
                continue
            candidate = samples[index]
            bad = step if _is_bad_transition(candidate) else 0.0
            missing = step if not candidate["hasCat"] else 0.0
            if _can_extend(candidate, transition_sec + bad, missing_sec + missing, config, padding=True):
                options.append((candidate["rankScore"], direction, index, bad, missing))
        if not options:
            break
        _, direction, index, bad, missing = max(options, key=lambda item: item[0])
        transition_sec += bad
        missing_sec += missing
        if direction < 0:
            left = index
        else:
            right = index

    # After the floor is satisfied, grow toward six seconds using only smooth context.
    while samples[right]["offsetSec"] - samples[left]["offsetSec"] + step < target_sec:
        options = []
        for direction, index in ((-1, left - 1), (1, right + 1)):
            if index < 0 or index >= len(samples):
                continue
            candidate = samples[index]
            bad = step if _is_bad_transition(candidate) else 0.0
            missing = step if not candidate["hasCat"] else 0.0
            if _can_extend(candidate, transition_sec + bad, missing_sec + missing, config):
                options.append((candidate["continuityScore"], direction, index, bad, missing))
        if not options:
            break
        _, direction, index, bad, missing = max(options, key=lambda item: item[0])
        transition_sec += bad
        missing_sec += missing
        if direction < 0:
            left = index
        else:
            right = index

    start = max(0.0, samples[left]["offsetSec"] - step / 2)
    end = min(duration_sec, samples[right]["offsetSec"] + step / 2)
    end = min(end, start + max_sec)
    selected = [sample for sample in samples if start <= sample["offsetSec"] < end]
    while selected and selected[0]["continuityScore"] <= 0:
        left += 1
        if left > right:
            return {}
        start = max(0.0, samples[left]["offsetSec"] - step / 2)
        selected = [sample for sample in samples if start <= sample["offsetSec"] < end]
    while selected and selected[-1]["continuityScore"] <= 0:
        right -= 1
        if left > right:
            return {}
        end = min(duration_sec, samples[right]["offsetSec"] + step / 2)
        selected = [sample for sample in samples if start <= sample["offsetSec"] < end]
    # Do not let the fixed four-second floor include a long bad-relation or
    # no-cat run. Trim invalid edges; if the remaining window is too short,
    # reject this candidate instead of lowering its quality silently.
    while selected and (
        sum(step for sample in selected if _is_bad_transition(sample)) > config["maxTransitionSec"]
        or sum(step for sample in selected if not sample["hasCat"]) > config["maxGapSec"]
    ):
        if _is_bad_transition(samples[left]) or not samples[left]["hasCat"]:
            left += 1
        elif _is_bad_transition(samples[right]) or not samples[right]["hasCat"]:
            right -= 1
        else:
            return {}
        if left > right:
            selected = []
            break
        start = max(0.0, samples[left]["offsetSec"] - step / 2)
        end = min(duration_sec, samples[right]["offsetSec"] + step / 2)
        selected = [sample for sample in samples if start <= sample["offsetSec"] < end]
        while selected and selected[0]["continuityScore"] <= 0:
            left += 1
            if left > right:
                return {}
            start = max(0.0, samples[left]["offsetSec"] - step / 2)
            selected = [sample for sample in samples if start <= sample["offsetSec"] < end]
        while selected and selected[-1]["continuityScore"] <= 0:
            right -= 1
            if left > right:
                return {}
            end = min(duration_sec, samples[right]["offsetSec"] + step / 2)
            selected = [sample for sample in samples if start <= sample["offsetSec"] < end]
    if end - start < min_sec:
        return {}
    if not selected:
        selected = [peak]
    scores = [sample["continuityScore"] for sample in selected]
    bad_seconds = sum(step for sample in selected if _is_bad_transition(sample))
    missing_seconds = sum(step for sample in selected if not sample["hasCat"])
    return {
        "startSec": round(start, 3),
        "endSec": round(end, 3),
        "durationSec": round(max(0.0, end - start), 3),
        "anchorOffsetSec": peak["offsetSec"],
        "peakScore": peak["rankScore"],
        "peakCuteScore": peak["cuteScore"],
        "meanContinuityScore": round(sum(scores) / len(scores), 4),
        "minContinuityScore": round(min(scores), 4),
        "continuityCoverage": round(sum(score >= config["continuityMin"] for score in scores) / len(scores), 4),
        "badTransitionSec": round(bad_seconds, 3),
        "missingCatSec": round(missing_seconds, 3),
        "sampleCount": len(selected),
    }


def _segment_metrics(segment: dict[str, Any], samples: list[dict[str, Any]], config: dict[str, float]) -> dict[str, Any]:
    step = _sample_step(samples)
    selected = [sample for sample in samples if segment["startSec"] <= sample["offsetSec"] < segment["endSec"]]
    if not selected:
        return dict(segment)
    anchor_samples = [sample for sample in selected if _is_anchor(sample, config)]
    peak = max(
        anchor_samples or selected,
        key=lambda sample: (sample["rankScore"], sample["cuteScore"], -sample["offsetSec"]),
    )
    scores = [sample["continuityScore"] for sample in selected]
    return {
        **segment,
        "anchorOffsetSec": peak["offsetSec"],
        "peakScore": peak["rankScore"],
        "peakCuteScore": peak["cuteScore"],
        "meanContinuityScore": round(sum(scores) / len(scores), 4),
        "minContinuityScore": round(min(scores), 4),
        "continuityCoverage": round(sum(score >= config["continuityMin"] for score in scores) / len(scores), 4),
        "badTransitionSec": round(sum(step for sample in selected if _is_bad_transition(sample)), 3),
        "missingCatSec": round(sum(step for sample in selected if not sample["hasCat"]), 3),
        "sampleCount": len(selected),
    }


def _merge_segments(
    segments: list[dict[str, Any]],
    samples: list[dict[str, Any]],
    config: dict[str, float],
) -> list[dict[str, Any]]:
    if not segments:
        return []
    ordered = sorted(segments, key=lambda item: item["startSec"])
    merged: list[dict[str, Any]] = []
    for segment in ordered:
        previous = merged[-1] if merged else None
        if previous is None or segment["startSec"] > previous["endSec"] + config["maxGapSec"]:
            merged.append(_segment_metrics(segment, samples, config))
            continue
        combined = {
            **previous,
            "endSec": max(previous["endSec"], segment["endSec"]),
        }
        combined["durationSec"] = round(combined["endSec"] - combined["startSec"], 3)
        refreshed = _segment_metrics(combined, samples, config)
        if (
            refreshed["badTransitionSec"] <= config["maxTransitionSec"]
            and refreshed["missingCatSec"] <= config["maxGapSec"]
        ):
            previous.clear()
            previous.update(refreshed)
        elif segment["startSec"] < previous["endSec"]:
            # Overlapping windows that cannot be merged are competing clips.
            # Keep the stronger anchor so the final report never contains
            # duplicate playback time.
            if segment["peakScore"] > previous["peakScore"]:
                merged[-1] = _segment_metrics(segment, samples, config)
        else:
            merged.append(_segment_metrics(segment, samples, config))
    return merged


def _split_long_segment(segment: dict[str, Any], samples: list[dict[str, Any]], config: dict[str, float]) -> list[dict[str, Any]]:
    if segment["durationSec"] <= config["maxSegmentSec"]:
        return [segment]
    start = segment["startSec"]
    end = segment["endSec"]
    parts = []
    while end - start > config["maxSegmentSec"]:
        lower = start + config["minSegmentSec"]
        upper = end - config["minSegmentSec"]
        desired = min(start + config["targetSegmentSec"], upper)
        valleys = [
            sample for sample in samples
            if lower <= sample["offsetSec"] <= upper
        ]
        split_at = min(
            (sample["offsetSec"] for sample in valleys),
            key=lambda offset: (abs(offset - desired), next(sample["continuityScore"] for sample in valleys if sample["offsetSec"] == offset)),
            default=desired,
        )
        if split_at <= start + config["minSegmentSec"] or split_at >= end - config["minSegmentSec"]:
            split_at = desired
        part = {**segment, "startSec": round(start, 3), "endSec": round(split_at, 3)}
        part["durationSec"] = round(part["endSec"] - part["startSec"], 3)
        parts.append(_segment_metrics(part, samples, config))
        start = split_at
    tail = {**segment, "startSec": round(start, 3), "endSec": round(end, 3)}
    tail["durationSec"] = round(tail["endSec"] - tail["startSec"], 3)
    parts.append(_segment_metrics(tail, samples, config))
    return [part for part in parts if part["durationSec"] >= config["minSegmentSec"]]


def build_cute_segments(
    frames: Iterable[dict[str, Any]],
    *,
    duration_sec: float | None = None,
    config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build continuous experimental clips from frame-level cute evidence."""
    policy = {**DEFAULT_CONFIG, **(config or {})}
    samples = smooth_cute_samples(normalize_cute_samples(frames))
    if not samples:
        return []
    duration = _number(duration_sec, samples[-1]["offsetSec"] + _sample_step(samples))
    peaks = _non_maximum_peaks(samples, policy)
    candidates = [
        candidate
        for index in peaks
        if (candidate := _expand_peak(samples, index, duration, policy))
    ]
    merged = _merge_segments(candidates, samples, policy)
    split = [part for segment in merged for part in _split_long_segment(segment, samples, policy)]
    return sorted(split, key=lambda item: item["startSec"])


def segment_for_offset(segments: list[dict[str, Any]], offset_sec: float) -> tuple[int, dict[str, Any]] | None:
    for index, segment in enumerate(segments, start=1):
        if segment["startSec"] <= offset_sec < segment["endSec"]:
            return index, segment
    return None


__all__ = [
    "DEFAULT_CONFIG",
    "build_cute_segments",
    "normalize_cute_samples",
    "segment_for_offset",
    "smooth_cute_samples",
]
