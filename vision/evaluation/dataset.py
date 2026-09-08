from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

ALLOWED_STATES = {"chewing", "licking", "not_eating", "uncertain"}
ALLOWED_LABEL_STATUS = {"pending", "in_progress", "complete"}


class DatasetValidationError(ValueError):
    pass


def load_manifest(path: str | Path) -> dict[str, Any]:
    manifest_path = Path(path).resolve()
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    manifest["_manifestPath"] = str(manifest_path)
    return manifest


def resolve_media_path(media: dict[str, Any], manifest: dict[str, Any]) -> Path:
    path_env = str(media.get("pathEnv") or "").strip()
    raw_path = os.environ.get(path_env, "").strip() if path_env else str(media.get("path") or "").strip()
    if not raw_path:
        raise DatasetValidationError(f"MEDIA_PATH_MISSING:{media.get('id', '')}")
    path = Path(raw_path)
    if path.is_absolute():
        return path
    manifest_path = Path(str(manifest.get("_manifestPath") or "")).resolve()
    repository_root = manifest_path.parents[3]
    return (repository_root / path).resolve()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _finite_number(value: Any, code: str) -> float:
    if isinstance(value, bool):
        raise DatasetValidationError(code)
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise DatasetValidationError(code) from error
    if number != number or number in (float("inf"), float("-inf")):
        raise DatasetValidationError(code)
    return number


def validate_manifest(manifest: dict[str, Any], verify_hashes: bool = False) -> dict[str, Any]:
    samples = manifest.get("samples")
    if not isinstance(samples, list) or not samples:
        raise DatasetValidationError("SAMPLES_REQUIRED")
    seen_sample_ids: set[str] = set()
    cat_splits: dict[str, str] = {}
    media_count = 0
    completed_samples = 0
    for sample in samples:
        if not isinstance(sample, dict):
            raise DatasetValidationError("SAMPLE_INVALID")
        sample_id = str(sample.get("id") or "").strip()
        cat_id = str(sample.get("catId") or "").strip()
        split = str(sample.get("split") or "").strip()
        if not sample_id or sample_id in seen_sample_ids:
            raise DatasetValidationError("SAMPLE_ID_INVALID")
        if not cat_id or not split:
            raise DatasetValidationError(f"CAT_SPLIT_REQUIRED:{sample_id}")
        seen_sample_ids.add(sample_id)
        if cat_id in cat_splits and cat_splits[cat_id] != split:
            raise DatasetValidationError(f"CAT_SPLIT_LEAKAGE:{cat_id}")
        cat_splits[cat_id] = split
        duration = _finite_number(sample.get("durationSec"), f"DURATION_INVALID:{sample_id}")
        if duration <= 0:
            raise DatasetValidationError(f"DURATION_INVALID:{sample_id}")
        label_status = str(sample.get("labelStatus") or "")
        if label_status not in ALLOWED_LABEL_STATUS:
            raise DatasetValidationError(f"LABEL_STATUS_INVALID:{sample_id}")
        if label_status == "complete":
            completed_samples += 1
        media_items = sample.get("media")
        if not isinstance(media_items, list) or not media_items:
            raise DatasetValidationError(f"MEDIA_REQUIRED:{sample_id}")
        for media in media_items:
            if not isinstance(media, dict):
                raise DatasetValidationError(f"MEDIA_INVALID:{sample_id}")
            path = resolve_media_path(media, manifest)
            if not path.is_file():
                raise DatasetValidationError(f"MEDIA_NOT_FOUND:{media.get('id', '')}:{path}")
            expected_hash = str(media.get("sha256") or "").upper()
            if verify_hashes and expected_hash and sha256_file(path) != expected_hash:
                raise DatasetValidationError(f"MEDIA_HASH_MISMATCH:{media.get('id', '')}")
            media_count += 1
        labels = sample.get("labels")
        if not isinstance(labels, list):
            raise DatasetValidationError(f"LABELS_INVALID:{sample_id}")
        cursor = 0.0
        for index, label in enumerate(sorted(labels, key=lambda item: float(item.get("startSec", -1)))):
            if not isinstance(label, dict):
                raise DatasetValidationError(f"LABEL_INVALID:{sample_id}:{index}")
            state = str(label.get("state") or "")
            if state not in ALLOWED_STATES:
                raise DatasetValidationError(f"LABEL_STATE_INVALID:{sample_id}:{index}")
            start = _finite_number(label.get("startSec"), f"LABEL_BOUNDS_INVALID:{sample_id}:{index}")
            end = _finite_number(label.get("endSec"), f"LABEL_BOUNDS_INVALID:{sample_id}:{index}")
            if start < 0 or end <= start or end > duration:
                raise DatasetValidationError(f"LABEL_BOUNDS_INVALID:{sample_id}:{index}")
            if start < cursor:
                raise DatasetValidationError(f"LABEL_OVERLAP:{sample_id}:{index}")
            cursor = end
        if label_status == "complete" and not labels:
            raise DatasetValidationError(f"COMPLETE_LABELS_REQUIRED:{sample_id}")
    return {
        "ok": True,
        "sampleCount": len(samples),
        "mediaCount": media_count,
        "completedSampleCount": completed_samples,
        "accuracyReady": completed_samples == len(samples),
        "splits": sorted(set(cat_splits.values())),
    }
