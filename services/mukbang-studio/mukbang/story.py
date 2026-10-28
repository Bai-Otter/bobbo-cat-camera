"""Validate the independent interaction-story decision without editing it.

This validates *the model's evidence declarations*, not visual truth: source
frames are not viewed a second time. Human/pet visibility and continuity remain
explicit, auditable model attestations. No eating-frame membership is required.
"""
from __future__ import annotations

import math
import re
from typing import Any

from .selection import SelectionError


STORY_TARGET_DURATION = 30
STORY_MAX_DURATION = 60
_IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,80}")


class StoryError(SelectionError):
    """A story was omitted or failed the independent evidence contract."""


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise StoryError(f"人宠故事的{label}必须是有限数值")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise StoryError(f"人宠故事的{label}必须是有限数值") from None
    if not math.isfinite(result):
        raise StoryError(f"人宠故事的{label}必须是有限数值")
    return result


def _text(value: Any, label: str, *, limit: int = 2000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise StoryError(f"人宠故事的{label}必须是非空短文本")
    return value.strip()


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise StoryError(f"人宠故事的{label}无效")
    return value


def _warnings(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 100 or any(
        not isinstance(row, str) or len(row) > 4000 for row in value
    ):
        raise StoryError("人宠故事的warnings必须为短文字数组")
    return value[:]


def story_parameters(options: dict) -> dict:
    """Bound both prompt and validator settings; the 60s ceiling is immutable.

    Target is aspirational, independent of the eating video's duration target.
    A lower explicit maximum can be used, but never padding, crop, or speedup.
    """
    if not isinstance(options, dict):
        raise StoryError("人宠故事参数必须是对象")
    target = _number(options.get("story_target_duration", STORY_TARGET_DURATION), "目标时长")
    maximum = _number(options.get("story_max_duration", STORY_MAX_DURATION), "时长上限")
    if not 1 <= target <= STORY_MAX_DURATION:
        raise StoryError("人宠故事目标时长必须为1–60秒")
    if not 1 <= maximum <= STORY_MAX_DURATION:
        raise StoryError("人宠故事时长上限必须为1–60秒，不能放宽60秒硬上限")
    mode = options.get("story_mode", "interaction")
    if mode not in ("interaction", "inner_monologue"):
        raise StoryError("小剧场模式无效")
    result = {"story_target_duration_seconds": target,
              "story_max_duration_seconds": maximum,
              "story_target_is_aspirational": True}
    if mode == "inner_monologue":
        result.update(story_mode=mode, story_min_duration_seconds=max(3., target - 5),
                      story_preferred_max_duration_seconds=min(maximum, target + 5),
                      story_target_is_aspirational=False,
                      story_duration_policy="target_band_or_explicit_evidence_shortfall")
    return result


def _source_frames(frames: list[dict], duration: float) -> dict[str, dict]:
    if not isinstance(frames, list):
        raise StoryError("人宠故事的源帧清单必须是数组")
    mapping = {}
    for frame in frames:
        if not isinstance(frame, dict):
            raise StoryError("人宠故事的源帧条目无效")
        ident = _identifier(frame.get("id"), "源帧ID")
        moment = _number(frame.get("time"), "源帧实际PTS")
        if ident in mapping or not 0 <= moment < duration:
            raise StoryError("人宠故事源帧ID重复或实际PTS超出源视频")
        mapping[ident] = {"id": ident, "time": moment}
    return mapping


def _references(value: Any, mapping: dict[str, dict], start: float, end: float,
                label: str) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > len(mapping):
        raise StoryError(f"人宠故事的{label}必须引用本次源帧")
    if any(not isinstance(ident, str) or ident not in mapping for ident in value):
        raise StoryError(f"人宠故事的{label}引用了不存在的源帧")
    if len(set(value)) != len(value):
        raise StoryError(f"人宠故事的{label}包含重复引用")
    for ident in value:
        moment = mapping[ident]["time"]
        if not start <= moment < end:
            raise StoryError(f"人宠故事的{label}引用{ident}实际PTS={moment:.12g}秒，"
                             f"不在半开区间[{start:.12g},{end:.12g})内；不会取整或移动剪点")
    return value[:]


def _interval(row: dict, label: str, duration: float) -> tuple[float, float]:
    start = _number(row.get("start"), f"{label}开始时间")
    end = _number(row.get("end"), f"{label}结束时间")
    if not 0 <= start < end <= duration:
        raise StoryError(f"人宠故事的{label}时间必须在源视频内且start<end")
    return start, end


def validate_story(parsed_story: Any, frames: list[dict], duration: float, options: dict) -> dict:
    """Return a canonical ready/not_found decision, or raise ``StoryError``.

    Missing/invalid is deliberately not converted into a no-story judgment.
    Every clip is retained exactly as approved: no automatic crop, extension,
    reorder, evidence removal, overlap merging, fallback, or second AI call.
    """
    parameters = story_parameters(options)
    duration = _number(duration, "源视频时长")
    if duration <= 0:
        raise StoryError("人宠故事的源视频时长必须大于0")
    mapping = _source_frames(frames, duration)
    if not isinstance(parsed_story, dict):
        raise StoryError("AI缺少人宠故事对象；这不等于已确认没有故事")
    status = parsed_story.get("status")
    if not isinstance(status, str) or status not in {"ready", "not_found"}:
        raise StoryError("AI缺少有效的人宠故事状态，必须为ready或not_found")
    warnings = _warnings(parsed_story.get("warnings", []))
    if status == "not_found":
        if parsed_story.get("clips") != [] or parsed_story.get("events") != []:
            raise StoryError("人宠故事not_found时clips和events必须明确为空数组")
        return {"status": "not_found", "episode_id": "", "title": "", "summary": "",
                "clips": [], "events": [], "warnings": warnings, "duration": 0.0,
                "reason": _text(parsed_story.get("reason"), "无可用故事原因")}

    episode_id = _identifier(parsed_story.get("episode_id"), "episode_id")
    title = _text(parsed_story.get("title"), "标题", limit=200)
    summary = _text(parsed_story.get("summary"), "事实概要")
    clip_rows = parsed_story.get("clips")
    if not isinstance(clip_rows, list) or not 1 <= len(clip_rows) <= 40:
        raise StoryError("人宠故事ready时必须有1–40个片段")
    clips, clip_map = [], {}
    previous_end = -1.0
    for row in clip_rows:
        if not isinstance(row, dict):
            raise StoryError("人宠故事片段必须是对象")
        ident = _identifier(row.get("id"), "片段ID")
        if ident in clip_map:
            raise StoryError("人宠故事片段ID重复")
        if row.get("episode_id") != episode_id:
            raise StoryError("人宠故事不能拼接声明为不同episode的无关事件")
        start, end = _interval(row, "片段", duration)
        if start < previous_end:
            raise StoryError("人宠故事片段必须按源时间顺序且不重叠；不会倒序或重复播放")
        previous_end = end
        refs = _references(row.get("frame_ids"), mapping, start, end, "片段证据")
        co_visible = _references(row.get("co_visible_frame_ids"), mapping, start, end, "同镜覆盖")
        all_sampled = {ident for ident, frame in mapping.items() if start <= frame["time"] < end}
        if set(co_visible) != all_sampled:
            raise StoryError("人宠故事片段内的全部采样帧都必须明确声明人和宠物同镜；不能只批准峰值帧")
        clip = {"id": ident, "episode_id": episode_id, "start": start, "end": end,
                "title": _text(row.get("title"), "片段标题", limit=200),
                "reason": _text(row.get("reason"), "片段事实理由"),
                "frame_ids": refs, "co_visible_frame_ids": co_visible}
        clips.append(clip)
        clip_map[ident] = clip
    achieved = math.fsum(clip["end"] - clip["start"] for clip in clips)
    if achieved > parameters["story_max_duration_seconds"]:
        raise StoryError(f"人宠故事原剪点总长{achieved:.12g}秒超过"
                         f"{parameters['story_max_duration_seconds']:g}秒上限；不会裁掉反应或变速凑时长")

    event_rows = parsed_story.get("events")
    if not isinstance(event_rows, list) or not 2 <= len(event_rows) <= 120:
        raise StoryError("人宠故事至少需要有事实动作和随后反应两个事件")
    events, event_map = [], {}
    clips_with_evidence, actions, reactions = set(), {}, []
    previous_end, action_seen = -1.0, False
    for row in event_rows:
        if not isinstance(row, dict):
            raise StoryError("人宠故事事件必须是对象")
        ident = _identifier(row.get("id"), "事件ID")
        if ident in event_map:
            raise StoryError("人宠故事事件ID重复")
        clip_id = _identifier(row.get("clip_id"), "事件片段ID")
        if clip_id not in clip_map:
            raise StoryError("人宠故事事件引用了不存在的片段")
        clip = clip_map[clip_id]
        start, end = _interval(row, "事件", duration)
        if not clip["start"] <= start < end <= clip["end"]:
            raise StoryError("人宠故事事件必须完整位于其原片段区间内")
        if start < previous_end:
            raise StoryError("人宠故事事件必须按源时间顺序且不重叠；不能倒置动作和反应")
        previous_end = end
        refs = _references(row.get("frame_ids"), mapping, start, end, "事件证据")
        if not set(refs).issubset(clip["frame_ids"]):
            raise StoryError("人宠故事事件证据必须同时列入所属片段的frame_ids")
        if row.get("human_visible") is not True or row.get("pet_visible") is not True:
            raise StoryError("人宠故事每个事件必须明确确认同一画面中人和宠物都可见（可见人手/身体可计）")
        phase = row.get("phase")
        if not isinstance(phase, str) or phase not in {"setup", "action", "reaction"}:
            raise StoryError("人宠故事事件phase必须为setup/action/reaction")
        event = {"id": ident, "clip_id": clip_id, "start": start, "end": end, "phase": phase,
                 "human_action": _text(row.get("human_action"), "可见人的动作"),
                 "pet_action": _text(row.get("pet_action"), "可见宠物动作"),
                 "human_visible": True, "pet_visible": True, "frame_ids": refs,
                 "source_times": [{"frame_id": ref, "time": mapping[ref]["time"]} for ref in refs]}
        if phase == "setup":
            if action_seen:
                raise StoryError("人宠故事铺垫不能出现在动作/反应之后，避免拼接不同事件")
            if row.get("reacts_to_event_id") is not None and row.get("reacts_to_event_id") != "":
                raise StoryError("人宠故事铺垫不能声明为另一事件的反应")
        elif phase == "action":
            action_seen = True
            actions[ident] = event
            if row.get("reacts_to_event_id") is not None and row.get("reacts_to_event_id") != "":
                raise StoryError("人宠故事动作事件不应伪装为反应事件")
        else:
            reference = row.get("reacts_to_event_id")
            if not isinstance(reference, str) or reference not in actions:
                raise StoryError("人宠故事反应必须引用已经出现的真实动作事件ID")
            if actions[reference]["end"] > start:
                raise StoryError("人宠故事反应不能先于所引用的动作")
            event["reacts_to_event_id"] = reference
            reactions.append(event)
        events.append(event)
        event_map[ident] = event
        clips_with_evidence.add(clip_id)
    if not actions or not reactions:
        raise StoryError("人宠故事必须有同镜的交互动作和随后可见反应，不能只用共处或吃饭冒充")
    if clips_with_evidence != set(clip_map):
        raise StoryError("人宠故事每个片段都必须包含属于这条事件链的事实证据")
    if events[-1]["phase"] != "reaction":
        raise StoryError("人宠故事结尾缺少动作后的可见反应，不能剪断事件冒充完整故事")
    if achieved < parameters["story_target_duration_seconds"] and options.get("story_mode") != "inner_monologue":
        warnings.append(f"已确认的同镜互动仅{achieved:g}秒，短于约"
                        f"{parameters['story_target_duration_seconds']:g}秒目标；未用独猫、无关画面或重复镜头填充")
    result = {"status": "ready", "episode_id": episode_id, "title": title, "summary": summary,
              "clips": clips, "events": events, "warnings": warnings,
              "duration": achieved, "reason": ""}
    if options.get("story_mode") == "inner_monologue":
        from .story_subtitles import validate_monologues
        return validate_monologues(result, parsed_story, frames, duration, parameters)
    return result
