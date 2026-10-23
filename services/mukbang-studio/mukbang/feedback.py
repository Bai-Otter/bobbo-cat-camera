"""Per-video human feedback and observable frame-set changes, not training.

This module has no file, credential, media, network, or model-call operations.
Draft replacement/versioning and task identity belong to the server; the real
selection schema still validates AI output after this best-effort comparison.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt


FRAME_ID_PATTERN = r"^F[0-9]{4,6}$"
_FRAME_ID = re.compile(FRAME_ID_PATTERN)


class FrameAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    frame_id: str = Field(pattern=FRAME_ID_PATTERN)
    label: Literal["like", "dislike"]
    reason: str = Field(default="", max_length=500)


class FeedbackDraftUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: StrictInt = Field(ge=0)
    annotations: list[FrameAnnotation] = Field(default_factory=list, max_length=2400)
    note: str = Field(default="", max_length=4000)


def _valid_id(value) -> bool:
    return isinstance(value, str) and _FRAME_ID.fullmatch(value) is not None


def validate_annotations(annotations: list[dict], frames: list[dict]) -> None:
    """Require unique IDs in this video's sampling map; unmarked means neutral.

    Errors intentionally never interpolate submitted IDs, reasons, or notes.
    Pydantic handles field lengths/types at the HTTP boundary; shape checks here
    keep direct callers from raising unhelpful unhashable-value/attribute errors.
    """
    if not isinstance(annotations, list) or not isinstance(frames, list):
        raise ValueError("反馈或当前视频的采样帧清单格式不正确")
    known = {row["id"] for row in frames
             if isinstance(row, dict) and _valid_id(row.get("id"))}
    seen = set()
    for row in annotations:
        if not isinstance(row, dict):
            raise ValueError("反馈标注格式不正确")
        ident = row.get("frame_id")
        if not _valid_id(ident) or ident not in known:
            raise ValueError("反馈帧不属于当前视频的采样清单")
        if ident in seen:
            raise ValueError("同一采样帧不能重复标注，请每帧仅保留一个反馈")
        if row.get("label") not in ("like", "dislike"):
            raise ValueError("反馈标签只能是喜欢或不想要")
        seen.add(ident)


def _selected_ids(rows, *, allow_id: bool = False) -> set[str]:
    if not isinstance(rows, list):
        return set()
    result = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        ident = row.get("frame_id")
        if allow_id and not _valid_id(ident):
            ident = row.get("id")
        if _valid_id(ident):
            result.add(ident)
    return result


def build_comparison(parent_job_id: str, previous_selected_frames: list[dict],
                     parsed: dict, feedback: dict) -> dict:
    """Describe raw model changes and feedback coverage, never taste accuracy.

    Bad response structures are ignored here only so a failure can retain its
    diagnostic comparison. This is not model-output validation or a fallback
    selection: the pipeline must still reject invalid AI output independently.
    Feedback is the complete current snapshot; no ancestor labels are merged.
    """
    previous = _selected_ids(previous_selected_frames, allow_id=True)
    current = _selected_ids(parsed.get("selected_frames") if isinstance(parsed, dict) else None)
    annotations = feedback.get("annotations") if isinstance(feedback, dict) else None
    liked, disliked = set(), set()
    if isinstance(annotations, list):
        for row in annotations:
            if not isinstance(row, dict) or not _valid_id(row.get("frame_id")):
                continue
            ident, label = row["frame_id"], row.get("label")
            if label == "like":
                liked.add(ident)
            elif label == "dislike":
                disliked.add(ident)
    return {
        "parent_job_id": parent_job_id,
        "added_frame_ids": sorted(current - previous),
        "removed_frame_ids": sorted(previous - current),
        "kept_frame_ids": sorted(previous & current),
        "liked_selected_ids": sorted(liked & current),
        "liked_omitted_ids": sorted(liked - current),
        "disliked_selected_ids": sorted(disliked & current),
        # This includes disliked IDs that were never selected in the parent.
        "disliked_removed_ids": sorted(disliked - current),
    }
