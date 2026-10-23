"""Validate model evidence and adjust only model-approved source intervals."""
from __future__ import annotations

import math
import re
from copy import deepcopy


class SelectionError(ValueError):
    pass


def number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SelectionError(f"AI返回的{label}必须是有限数值")
    return float(value)


def text(value, label: str, *, limit: int = 4000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise SelectionError(f"AI返回的{label}必须是非空短文本")
    return value.strip()


def _score(row: dict) -> float:
    value = number(row.get("score"), "分数")
    if not 0 <= value <= 100:
        raise SelectionError("AI返回的分数超出0–100")
    return value


def _reference_details(refs: list[str], frames: dict, start: float, end: float) -> str:
    """Explain exact evidence boundaries without rounding/relaxing validation."""
    details = []
    for ident in refs:
        moment = frames[ident]["time"]
        if moment < start:
            position = f"早于起点{start - moment:.9g}秒"
        elif moment == end:
            position = "等于右端点，半开区间不包含该帧"
        elif moment > end:
            position = f"晚于右端点{moment - end:.9g}秒"
        else:
            position = "位于区间内"
        details.append(f"{ident}={moment:.12g}秒（{position}）")
    return "；".join(details)


def _validate_clips(rows, name: str, frames: dict, selected: set, duration: float, *,
                    meme=False, reference_adjustments=None) -> list:
    if not isinstance(rows, list) or len(rows) > (4 if meme else 100):
        raise SelectionError(f"AI返回的{name}列表无效或条数过多")
    result, ids = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise SelectionError(f"AI返回的{name}条目必须是对象")
        ident = row.get("id")
        if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", ident) or ident in ids:
            raise SelectionError(f"AI返回的{name}ID重复或格式无效")
        ids.add(ident)
        start, end = number(row.get("start"), "开始时间"), number(row.get("end"), "结束时间")
        if not 0 <= start < end <= duration + 0.000001:
            raise SelectionError(f"AI返回的{name} {ident} 时间超出源视频或顺序错误")
        if meme and not 0.7 - 0.000001 <= end - start <= 4 + 0.000001:
            raise SelectionError(f"表情包 {ident} 必须为0.7–4秒")
        refs = row.get("frame_ids")
        if not isinstance(refs, list) or not refs or any(not isinstance(x, str) or x not in selected for x in refs):
            raise SelectionError(f"{name} {ident} 引用了不存在或没有被AI选中的帧")
        refs = list(dict.fromkeys(refs))
        # Exact source sampling times are known. Do not accept unrelated evidence.
        if not any(start <= frames[x]["time"] < end for x in refs):
            raise SelectionError(f"{name} {ident} [{start:.12g},{end:.12g}) 秒内没有任何所引用的采样帧："
                                 + _reference_details(refs, frames, start, end))
        item = {"id": ident, "start": start, "end": min(duration, end),
                "title": text(row.get("title"), "片段标题", limit=300),
                "reason": text(row.get("reason"), "选片理由"), "score": _score(row), "frame_ids": refs}
        left, right = start, item["end"]
        if not meme:
            left = number(row.get("context_start"), "上下文开始时间")
            right = number(row.get("context_end"), "上下文结束时间")
            if not 0 <= left <= start < end <= right <= duration + 0.000001:
                raise SelectionError(f"精选 {ident} 的模型批准上下文无效")
            right = min(duration, right)
            item.update(context_start=left, context_end=right)
        outside = [x for x in refs if not left <= frames[x]["time"] < right]
        if outside:
            boundary = "片段" if meme else "批准上下文"
            details = _reference_details(outside, frames, left, right)
            if reference_adjustments is None:
                raise SelectionError(f"{name} {ident} 引用了不在{boundary} [{left:.12g},{right:.12g}) 秒里的帧："
                                     + details)
            # Only redundant references can be removed. Membership, all other
            # fields, and an ORIGINAL reference inside the clip passed above.
            # Do not infer evidence, change selected frames, or move boundaries.
            inside = [x for x in refs if left <= frames[x]["time"] < right]
            if not any(start <= frames[x]["time"] < item["end"] for x in inside):
                raise SelectionError(f"{name} {ident} 移除越界引用后没有片段内证据；不会扩大区间或补造引用")
            item["frame_ids"] = inside
            reference_adjustments.append({
                "type": "drop_out_of_interval_references",
                "collection": "memes" if meme else "highlight_clips", "clip_id": ident,
                "before": refs, "after": inside, "interval": [left, right],
                "removed": [{"frame_id": x, "time": frames[x]["time"]} for x in outside],
                "reason": f"{name} {ident} 已移除区间外的多余引用：{details}；"
                          "原剪点和批准上下文未改变，仅保留原AI已选中的区间内证据，未新增AI调用。"})
        result.append(item)
    return result


def validate_result(parsed: dict, frames: list[dict], duration: float) -> dict:
    """Strict validation: never remove invalid references or relax boundaries."""
    return _validate_result(parsed, frames, duration)


def _validate_result(parsed: dict, frames: list[dict], duration: float, *, reference_adjustments=None) -> dict:
    if not isinstance(parsed, dict):
        raise SelectionError("AI结果必须是JSON对象")
    mapping = {f["id"]: f for f in frames}
    rows = parsed.get("selected_frames")
    if not isinstance(rows, list) or len(rows) > len(frames):
        raise SelectionError("AI选中帧列表无效")
    selected, ids = [], set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("frame_id"), str) or row["frame_id"] not in mapping:
            raise SelectionError("AI选中了不存在的帧ID")
        ident = row["frame_id"]
        if ident in ids:
            raise SelectionError("AI返回了重复的选中帧ID")
        ids.add(ident)
        labels = row.get("labels", [])
        if not isinstance(labels, list) or any(not isinstance(x, str) or len(x) > 100 for x in labels):
            raise SelectionError("AI返回的帧标签无效")
        selected.append({"frame_id": ident, "score": _score(row),
                         "reason": text(row.get("reason"), "可爱证据"), "labels": labels})
    warnings = parsed.get("warnings", [])
    if not isinstance(warnings, list) or any(not isinstance(w, str) for w in warnings):
        raise SelectionError("AI warnings必须是文字数组")
    return {"summary": text(parsed.get("summary"), "总体判断"), "selected_frames": selected,
            "highlight_clips": _validate_clips(parsed.get("highlight_clips"), "精选", mapping, ids, duration,
                                                reference_adjustments=reference_adjustments),
            "memes": _validate_clips(parsed.get("memes"), "表情包", mapping, ids, duration, meme=True,
                                      reference_adjustments=reference_adjustments),
            "warnings": warnings[:]}


def total_duration(clips: list[dict]) -> float:
    return sum(c["end"] - c["start"] for c in clips)


def _merge_overlaps(clips: list[dict], adjustments: list) -> list:
    ordered = [{**deepcopy(c), "model_order": i} for i, c in enumerate(clips)]
    chronological = sorted(ordered, key=lambda c: (c["start"], c["end"]))
    merged = []
    for row in chronological:
        if merged and row["start"] < merged[-1]["end"] - 1e-7:
            previous = merged[-1]
            adjustments.append({"type": "merge_overlap", "clip_ids": [previous["id"], row["id"]],
                                "reason": "同源重叠画面合并，避免在精选里重复播放"})
            previous.update(end=max(previous["end"], row["end"]),
                            context_start=min(previous["context_start"], row["context_start"]),
                            context_end=max(previous["context_end"], row["context_end"]),
                            score=max(previous["score"], row["score"]),
                            model_order=min(previous["model_order"], row["model_order"]),
                            frame_ids=list(dict.fromkeys(previous["frame_ids"] + row["frame_ids"])),
                            reason=previous["reason"] + "；" + row["reason"])
        else:
            merged.append(row)
    return sorted(merged, key=lambda c: c["model_order"])


def adjust_duration(validated: dict, frames: list[dict], options: dict) -> dict:
    adjustments, warnings = [], validated["warnings"][:]
    clips = _merge_overlaps(validated["highlight_clips"], adjustments)
    memes = []
    # Alternate windows around the same action are not distinct meme events.
    for meme in sorted(deepcopy(validated["memes"]), key=lambda c: -c["score"]):
        duplicate = next((m for m in memes if max(m["start"], meme["start"]) < min(m["end"], meme["end"]) - 1e-7), None)
        if duplicate:
            adjustments.append({"type": "drop_duplicate_meme", "clip_id": meme["id"],
                                "kept_clip_id": duplicate["id"], "reason": "重叠的同一事件只导出较高分表情包"})
        else:
            memes.append(meme)
    target, lower, upper = (float(options[x]) for x in ("target_duration", "min_duration", "max_duration"))
    if not clips:
        warnings.append("AI没有找到足够可爱的精选动作，未生成虚构的精选视频")
        return {"clips": [], "memes": memes, "adjustments": adjustments, "warnings": warnings}
    times = {f["id"]: f["time"] for f in frames}
    # Remove edge excess while keeping the cited cute moment(s), never retime.
    for clip in sorted(clips, key=lambda c: c["score"]):
        excess = total_duration(clips) - target
        if excess <= 1e-7:
            break
        evidence = [times[x] for x in clip["frame_ids"] if clip["start"] <= times[x] < clip["end"]]
        keep_left = max(clip["start"], min(evidence) - 0.35)
        keep_right = min(clip["end"], max(evidence) + 0.65)
        old = [clip["start"], clip["end"]]
        take_left = min(excess / 2, keep_left - clip["start"])
        clip["start"] += take_left
        excess -= take_left
        take_right = min(excess, clip["end"] - keep_right)
        clip["end"] -= take_right
        excess -= take_right
        clip["start"] += min(excess, keep_left - clip["start"])
        if old != [clip["start"], clip["end"]]:
            adjustments.append({"type": "trim_to_target", "clip_id": clip["id"], "before": old,
                                "after": [clip["start"], clip["end"]], "reason": "只裁动作边缘，保留引用的可爱帧"})
    # If evidence itself exceeds the maximum, drop low-scored events, not their timing.
    for clip in sorted(clips, key=lambda c: c["score"]):
        if total_duration(clips) <= upper + 1e-7:
            break
        if len(clips) > 1:
            clips.remove(clip)
            adjustments.append({"type": "drop_for_maximum", "clip_id": clip["id"],
                                "reason": "总长超上限，舍弃较低分事件；不压缩语速或重播"})
    # Expand only into approved handles, with other retained clips as hard limits.
    for clip in sorted(clips, key=lambda c: -c["score"]):
        deficit = target - total_duration(clips)
        if deficit <= 1e-7:
            break
        chronological = sorted(clips, key=lambda c: c["start"])
        index = chronological.index(clip)
        left_limit = max(clip["context_start"], chronological[index - 1]["end"] if index else 0)
        right_limit = min(clip["context_end"], chronological[index + 1]["start"] if index + 1 < len(clips) else math.inf)
        old = [clip["start"], clip["end"]]
        amount = min(deficit / 2, max(0, clip["start"] - left_limit))
        clip["start"] -= amount
        deficit -= amount
        amount = min(deficit, max(0, right_limit - clip["end"]))
        clip["end"] += amount
        deficit -= amount
        clip["start"] -= min(deficit, max(0, clip["start"] - left_limit))
        if old != [clip["start"], clip["end"]]:
            adjustments.append({"type": "expand_approved_context", "clip_id": clip["id"], "before": old,
                                "after": [clip["start"], clip["end"]], "approved": [clip["context_start"], clip["context_end"]],
                                "reason": "仅补入AI明确批准的连续动作上下文"})
    achieved = total_duration(clips)
    if achieved < lower - 0.001:
        warnings.append(f"已确认的可爱动作及批准上下文仅{achieved:.2f}秒，低于要求下限{lower:g}秒；没有用无关画面、重复或变速凑足")
    if achieved > upper + 0.001:
        raise SelectionError("在保留全部证据后仍无法遵守时长上限；请调整目标或Prompt重新创建任务")
    if not memes:
        warnings.append("本次AI未选出独立表情包，不强行生成")
    return {"clips": clips, "memes": memes,
            "adjustments": adjustments, "warnings": warnings}


def validate_and_adjust(parsed: dict, frames: list[dict], duration: float, options: dict) -> dict:
    """Converge redundant references with an audit, then apply normal edit rules.

    Raw decisions remain untouched. This is not an AI retry or a tolerance:
    surviving evidence must pass the same exact half-open interval checks.
    """
    references = []
    validated = _validate_result(parsed, frames, duration, reference_adjustments=references)
    # Fail closed if a future normalization change ever weakens the invariant.
    validated = validate_result(validated, frames, duration)
    validated["warnings"].extend(row["reason"] for row in references)
    adjusted = adjust_duration(validated, frames, options)
    return {**adjusted, "adjustments": references + adjusted["adjustments"], "validated": validated}
