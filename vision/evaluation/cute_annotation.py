from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
from typing import Any, Iterable


ANNOTATION_DATASET_VERSION = 1
VERDICTS = {"cute", "exclude"}
RELATIONS = {
    "toward_camera",
    "profile_left",
    "profile_right",
    "looking_away",
    "head_down",
    "partial",
    "unknown",
}

FEATURE_KEYS = (
    "cuteScore",
    "modelConfidence",
    "sizeScore",
    "cameraScore",
    "pitchScore",
    "visibilityScore",
)

GEOMETRY_KEYS = (
    "relationConfidence",
    "faceWidthRatio",
    "faceHeightRatio",
    "faceAreaRatio",
    "muzzleVerticalRatio",
    "yawRatio",
)

RANK_FEATURE_KEYS = FEATURE_KEYS + GEOMETRY_KEYS
RANK_WEIGHTS = {
    "sizeScore": 0.55,
    "pitchScore": 0.25,
    "visibilityScore": 0.10,
    "relationConfidence": 0.05,
    "modelConfidence": 0.05,
}
ALIGNMENT_TOLERANCE_SEC = 1.5


class CuteAnnotationError(ValueError):
    pass


def _number(value: Any, code: str, default: float | None = None) -> float:
    if value is None and default is not None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise CuteAnnotationError(code) from error
    if not math.isfinite(number):
        raise CuteAnnotationError(code)
    return number


def _clamp(value: Any) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, number)) if math.isfinite(number) else 0.0


def _signed(value: Any) -> float:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return round(number, 6) if math.isfinite(number) else 0.0


def _frames(video: dict[str, Any]) -> list[dict[str, Any]]:
    frames = video.get("frames")
    if not isinstance(frames, list):
        raise CuteAnnotationError(f"VIDEO_FRAMES_REQUIRED:{video.get('id', '')}")
    normalized = []
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            raise CuteAnnotationError(f"FRAME_INVALID:{video.get('id', '')}:{index}")
        evidence = frame.get("cuteEvidence")
        if not isinstance(evidence, dict):
            evidence = frame
        offset = _number(frame.get("offsetSec", frame.get("second", 0)), "FRAME_OFFSET_INVALID")
        item = {"offsetSec": max(0.0, offset)}
        for key in FEATURE_KEYS:
            item[key] = _clamp(evidence.get(key, frame.get(key)))
        for key in GEOMETRY_KEYS:
            value = evidence.get(key, frame.get(key))
            item[key] = _signed(value) if key in {"muzzleVerticalRatio", "yawRatio"} else _clamp(value)
        item["faceRelation"] = str(evidence.get("faceRelation", frame.get("faceRelation", "unknown")) or "unknown")
        item["hasCat"] = bool(frame.get("hasCat", frame.get("hasTarget")))
        item["eatingVerified"] = bool(frame.get("eatingVerified"))
        item["cuteEligible"] = bool(evidence.get("cuteEligible", frame.get("cuteEligible")))
        item["strictEligible"] = bool(evidence.get("strictEligible", frame.get("strictEligible")))
        item["looseEligible"] = bool(evidence.get("looseEligible", frame.get("looseEligible")))
        normalized.append(item)
    return sorted(normalized, key=lambda item: item["offsetSec"])


def normalize_timeline(timeline: dict[str, Any] | list[dict[str, Any]]) -> list[dict[str, Any]]:
    if isinstance(timeline, list):
        return _frames({"id": "timeline", "frames": timeline})
    if not isinstance(timeline, dict):
        raise CuteAnnotationError("TIMELINE_INVALID")
    return _frames({"id": str(timeline.get("jobId") or "timeline"), "frames": timeline.get("frames") or timeline.get("timeline")})


def normalize_dataset(dataset: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(dataset, dict):
        raise CuteAnnotationError("DATASET_INVALID")
    if int(dataset.get("datasetVersion", ANNOTATION_DATASET_VERSION)) != ANNOTATION_DATASET_VERSION:
        raise CuteAnnotationError("DATASET_VERSION_UNSUPPORTED")
    videos = dataset.get("videos")
    labels = dataset.get("labels")
    if not isinstance(videos, list) or not videos:
        raise CuteAnnotationError("VIDEOS_REQUIRED")
    if not isinstance(labels, list):
        raise CuteAnnotationError("LABELS_REQUIRED")
    seen_ids: set[str] = set()
    normalized_videos = []
    durations: dict[str, float] = {}
    for index, video in enumerate(videos):
        if not isinstance(video, dict):
            raise CuteAnnotationError(f"VIDEO_INVALID:{index}")
        video_id = str(video.get("id") or "").strip()
        if not video_id or video_id in seen_ids:
            raise CuteAnnotationError(f"VIDEO_ID_INVALID:{index}")
        duration = _number(video.get("durationSec"), f"VIDEO_DURATION_INVALID:{video_id}")
        if duration <= 0:
            raise CuteAnnotationError(f"VIDEO_DURATION_INVALID:{video_id}")
        seen_ids.add(video_id)
        durations[video_id] = duration
        normalized_videos.append({
            **video,
            "id": video_id,
            "durationSec": duration,
            "frames": _frames(video),
        })
    normalized_labels = []
    occupied: dict[str, list[tuple[float, float]]] = {video_id: [] for video_id in seen_ids}
    for index, label in enumerate(labels):
        if not isinstance(label, dict):
            raise CuteAnnotationError(f"LABEL_INVALID:{index}")
        video_id = str(label.get("videoId") or "").strip()
        if video_id not in durations:
            raise CuteAnnotationError(f"LABEL_VIDEO_UNKNOWN:{index}")
        start = _number(label.get("startSec"), f"LABEL_START_INVALID:{index}")
        end = _number(label.get("endSec"), f"LABEL_END_INVALID:{index}")
        verdict = str(label.get("verdict") or "")
        if verdict not in VERDICTS or start < 0 or end <= start or end > durations[video_id]:
            raise CuteAnnotationError(f"LABEL_BOUNDS_INVALID:{index}")
        if any(start < old_end and end > old_start for old_start, old_end in occupied[video_id]):
            raise CuteAnnotationError(f"LABEL_OVERLAP:{video_id}:{index}")
        cute_value = _number(label.get("cuteValue", 0), f"LABEL_SCORE_INVALID:{index}")
        if verdict == "cute" and not 1 <= cute_value <= 5:
            raise CuteAnnotationError(f"LABEL_SCORE_INVALID:{index}")
        if verdict == "exclude" and cute_value not in (0, 1, 2, 3, 4, 5):
            raise CuteAnnotationError(f"LABEL_SCORE_INVALID:{index}")
        occupied[video_id].append((start, end))
        tags = label.get("tags") or []
        if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise CuteAnnotationError(f"LABEL_TAGS_INVALID:{index}")
        normalized_labels.append({
            **label,
            "videoId": video_id,
            "startSec": start,
            "endSec": end,
            "verdict": verdict,
            "cuteValue": int(cute_value),
            "tags": list(dict.fromkeys(tags)),
        })
    return {
        **dataset,
        "datasetVersion": ANNOTATION_DATASET_VERSION,
        "videos": normalized_videos,
        "labels": sorted(normalized_labels, key=lambda item: (item["videoId"], item["startSec"])),
    }


def load_dataset(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        return normalize_dataset(json.load(handle))


def timeline_alignment(video: dict[str, Any], tolerance: float = ALIGNMENT_TOLERANCE_SEC) -> dict[str, Any]:
    """Report whether a video's sampled frames cover its declared duration."""
    frames = _frames(video)
    duration = float(video["durationSec"])
    offsets = [float(frame["offsetSec"]) for frame in frames]
    last_offset = max(offsets, default=-1.0)
    complete = bool(offsets) and last_offset >= duration - max(0.1, float(tolerance))
    return {
        "videoId": str(video.get("id") or ""),
        "durationSec": round(duration, 4),
        "frameCount": len(frames),
        "firstFrameSec": round(min(offsets), 4) if offsets else None,
        "lastFrameSec": round(last_offset, 4) if offsets else None,
        "coverageSec": round(max(0.0, last_offset), 4) if offsets else 0.0,
        "missingTailSec": round(max(0.0, duration - last_offset), 4) if offsets else round(duration, 4),
        "complete": complete,
    }


def validate_timeline_alignment(dataset: dict[str, Any], require_complete: bool = False) -> list[dict[str, Any]]:
    normalized = normalize_dataset(dataset)
    reports = [timeline_alignment(video) for video in normalized["videos"]]
    if require_complete:
        incomplete = [item for item in reports if not item["complete"]]
        if incomplete:
            ids = ",".join(str(item["videoId"]) for item in incomplete)
            raise CuteAnnotationError(f"VIDEO_TIMELINE_INCOMPLETE:{ids}")
    return reports


def _label_for_time(labels: Iterable[dict[str, Any]], offset: float) -> dict[str, Any] | None:
    for label in labels:
        if float(label["startSec"]) <= offset < float(label["endSec"]):
            return label
    return None


def feature_row(frame: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or {}
    relation = str(frame.get("faceRelation") or "unknown")
    allowed = set(policy.get("allowedRelations") or [])
    predicted = (
        _clamp(frame.get("cuteScore")) >= float(
            policy.get("minProfileCuteScore", 0.55)
            if relation in {"profile_left", "profile_right"}
            else policy.get("minCuteScore", 0.65)
        )
        and _clamp(frame.get("modelConfidence")) >= float(policy.get("minModelConfidence", 0.65))
        and (not allowed or relation in allowed)
        and _clamp(frame.get("visibilityScore")) >= float(policy.get("minVisibilityScore", 0.0))
    )
    return {
        "offsetSec": frame["offsetSec"],
        "predictedCute": predicted,
        **{key: frame[key] for key in RANK_FEATURE_KEYS},
        "faceRelation": relation,
    }


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * max(0.0, min(1.0, fraction))
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return round(ordered[lower], 4)
    weight = position - lower
    return round(ordered[lower] * (1 - weight) + ordered[upper] * weight, 4)


def _feature_stats(values: list[float]) -> dict[str, Any]:
    return {
        "count": len(values),
        "mean": round(sum(values) / len(values), 4) if values else 0.0,
        "median": _percentile(values, 0.5),
        "p10": _percentile(values, 0.1),
        "p90": _percentile(values, 0.9),
        "min": round(min(values), 4) if values else 0.0,
        "max": round(max(values), 4) if values else 0.0,
    }


def positive_rank_score(frame: dict[str, Any]) -> float:
    """Soft ranking score for cute candidates; it is not a classifier."""
    return round(
        sum(_clamp(frame.get(key)) * weight for key, weight in RANK_WEIGHTS.items()),
        4,
    )


def _rank_feature_value(frame: dict[str, Any], key: str) -> float:
    value = frame.get(key)
    return _signed(value) if key in {"muzzleVerticalRatio", "yawRatio"} else _clamp(value)


def rank_positive(dataset: dict[str, Any], top_fraction: float = 0.2) -> dict[str, Any]:
    """Analyze manually marked cute intervals without treating unlabeled frames as negatives."""
    normalized = normalize_dataset(dataset)
    alignment = validate_timeline_alignment(normalized, require_complete=True)
    labels_by_video: dict[str, list[dict[str, Any]]] = {}
    for label in normalized["labels"]:
        if label["verdict"] == "cute":
            labels_by_video.setdefault(label["videoId"], []).append(label)
    if not labels_by_video:
        raise CuteAnnotationError("POSITIVE_LABELS_REQUIRED")

    video_reports = []
    for video in normalized["videos"]:
        labels = labels_by_video.get(video["id"], [])
        frames = _frames(video)
        positive = [frame for frame in frames if _label_for_time(labels, frame["offsetSec"])]
        ranked = sorted(
            ({**frame, "rankScore": positive_rank_score(frame)} for frame in frames),
            key=lambda item: (-item["rankScore"], item["offsetSec"]),
        )
        top_count = max(1, math.ceil(len(ranked) * max(0.01, min(1.0, top_fraction)))) if ranked else 0
        top_offsets = {item["offsetSec"] for item in ranked[:top_count]}
        feature_stats = {}
        coverage = {}
        for key in RANK_FEATURE_KEYS:
            positive_values = [_rank_feature_value(frame, key) for frame in positive]
            all_values = [_rank_feature_value(frame, key) for frame in frames]
            feature_stats[key] = {"positive": _feature_stats(positive_values), "all": _feature_stats(all_values)}
            coverage[key] = {
                str(threshold): round(
                    sum(value >= threshold for value in positive_values) / len(positive_values), 4
                ) if positive_values else 0.0
                for threshold in (0.4, 0.5, 0.6, 0.7, 0.8)
            }
        video_reports.append({
            "videoId": video["id"],
            "name": video.get("name", ""),
            "durationSec": video["durationSec"],
            "positiveFrames": len(positive),
            "unlabeledFrames": len(frames) - len(positive),
            "topFraction": top_fraction,
            "topFrameCount": top_count,
            "positiveCoverageInTopFrames": round(
                sum(frame["offsetSec"] in top_offsets for frame in positive) / len(positive), 4
            ) if positive else 0.0,
            "relations": {
                relation: sum(1 for frame in positive if frame["faceRelation"] == relation)
                for relation in sorted({frame["faceRelation"] for frame in positive})
            },
            "featureStats": feature_stats,
            "positiveCoverageAtThreshold": coverage,
            "topFrames": ranked[:top_count],
        })
    return {
        "datasetVersion": ANNOTATION_DATASET_VERSION,
        "mode": "positive-only-ranking",
        "classifierMetrics": None,
        "warning": "Unlabeled frames are not negative samples; this report does not establish precision or generalization.",
        "rankWeights": RANK_WEIGHTS,
        "alignment": alignment,
        "videos": video_reports,
    }


def rank_timeline(timeline: dict[str, Any] | list[dict[str, Any]], top_fraction: float = 0.2) -> dict[str, Any]:
    frames = normalize_timeline(timeline)
    ranked = sorted(
        ({**frame, "rankScore": positive_rank_score(frame)} for frame in frames),
        key=lambda item: (-item["rankScore"], item["offsetSec"]),
    )
    count = max(1, math.ceil(len(ranked) * max(0.01, min(1.0, top_fraction)))) if ranked else 0
    return {
        "mode": "unlabeled-timeline-ranking",
        "warning": "This is a candidate ranking only; no human labels are available for this timeline.",
        "rankWeights": RANK_WEIGHTS,
        "frameCount": len(frames),
        "topFraction": top_fraction,
        "topFrames": ranked[:count],
    }


def _binary_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    labeled = [row for row in rows if row.get("truth") in VERDICTS]
    tp = sum(1 for row in labeled if row["truth"] == "cute" and row["predictedCute"])
    fp = sum(1 for row in labeled if row["truth"] == "exclude" and row["predictedCute"])
    fn = sum(1 for row in labeled if row["truth"] == "cute" and not row["predictedCute"])
    tn = sum(1 for row in labeled if row["truth"] == "exclude" and not row["predictedCute"])
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"frames": len(labeled), "tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": precision, "recall": recall, "f1": f1}


def evaluate_dataset(dataset: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized = normalize_dataset(dataset)
    labels_by_video: dict[str, list[dict[str, Any]]] = {}
    for label in normalized["labels"]:
        labels_by_video.setdefault(label["videoId"], []).append(label)
    rows = []
    by_video = {}
    for video in normalized["videos"]:
        video_rows = []
        for frame in video["frames"]:
            row = feature_row(frame, policy)
            label = _label_for_time(labels_by_video.get(video["id"], []), frame["offsetSec"])
            row["truth"] = label["verdict"] if label else None
            row["cuteValue"] = label.get("cuteValue") if label else None
            video_rows.append(row)
        rows.extend(video_rows)
        by_video[video["id"]] = _binary_metrics(video_rows)
    result = _binary_metrics(rows)
    result.update({"policy": policy or {}, "byVideo": by_video, "labeledVideos": len(by_video)})
    return result


def _candidate_policies() -> Iterable[dict[str, Any]]:
    scores = (0.45, 0.55, 0.65, 0.72, 0.8, 0.88)
    confidences = (0.45, 0.55, 0.65, 0.75)
    relation_sets = (
        [],
        ["toward_camera"],
        ["toward_camera", "profile_left", "profile_right"],
        ["toward_camera", "profile_left", "profile_right", "unknown"],
    )
    profile_scores = (0.45, 0.55, 0.65, 0.72)
    for cute_score, profile_score, model_confidence, allowed in itertools.product(scores, profile_scores, confidences, relation_sets):
        yield {
            "minCuteScore": cute_score,
            "minProfileCuteScore": profile_score,
            "minModelConfidence": model_confidence,
            "allowedRelations": allowed,
            "minVisibilityScore": 0.0,
        }


def tune_policy(dataset: dict[str, Any], train_video_ids: set[str] | None = None) -> dict[str, Any]:
    normalized = normalize_dataset(dataset)
    ids = {video["id"] for video in normalized["videos"]}
    train_ids = train_video_ids or ids
    train = {
        **normalized,
        "videos": [video for video in normalized["videos"] if video["id"] in train_ids],
        "labels": [label for label in normalized["labels"] if label["videoId"] in train_ids],
    }
    if not train["videos"]:
        raise CuteAnnotationError("TRAIN_VIDEOS_REQUIRED")
    candidates = []
    for policy in _candidate_policies():
        metrics = evaluate_dataset(train, policy)
        objective = 0.6 * metrics["f1"] + 0.4 * metrics["precision"]
        candidates.append({"policy": policy, "objective": objective, "metrics": metrics})
    best = max(candidates, key=lambda item: (item["objective"], item["metrics"]["precision"], item["metrics"]["recall"]))
    validation_ids = ids - train_ids
    validation = None
    if validation_ids:
        validation = evaluate_dataset({
            **normalized,
            "videos": [video for video in normalized["videos"] if video["id"] in validation_ids],
            "labels": [label for label in normalized["labels"] if label["videoId"] in validation_ids],
        }, best["policy"])
    return {
        "datasetVersion": ANNOTATION_DATASET_VERSION,
        "policy": best["policy"],
        "trainVideoIds": sorted(train_ids),
        "validationVideoIds": sorted(validation_ids),
        "train": best["metrics"],
        "validation": validation,
        "candidateCount": len(candidates),
        "generalizationWarning": len(ids) < 3 or not validation_ids,
    }
