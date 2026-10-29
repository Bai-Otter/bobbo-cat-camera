"""Ground sparse fictional inner thoughts in factual events; never invoke AI/TTS."""
from __future__ import annotations

from copy import deepcopy
import math
from pathlib import Path
import unicodedata

from .story import StoryError, _identifier, _interval, _references, _source_frames, _text


def plain_caption(value) -> str:
    text = _text(value, "内心独白", limit=36)
    if any(c in "{}\\<>\r\n" or unicodedata.category(c).startswith("C") for c in text):
        raise StoryError("内心独白只允许可见纯文字，不能含字幕指令、标签或控制字符")
    return text


def performance_direction(value) -> str:
    if value == '' or value is None:
        return ''
    text = _text(value, '逐句演绎', limit=160)
    if any(c in '{}\\<>\r\n' or unicodedata.category(c).startswith('C') for c in text):
        raise StoryError('逐句演绎只允许短纯文字，不接受指令代码或标签')
    return text


def validate_cue_rhythm(cues: list[dict], duration: float, *, start_key="start", end_key="end") -> None:
    if not 1 <= len(cues) <= max(1, math.ceil(duration / 5)):
        raise StoryError("内心独白数量过多或缺失；持续动作需要留白")
    previous_end, occupied = -10., 0.
    for cue in cues:
        text = plain_caption(cue["text"])
        start, end = cue[start_key], cue[end_key]
        length = end - start
        if length < max(1.4, len(text) / 5.) - .02 or length > 5.5 + .001:
            raise StoryError("内心独白显示时间不足以阅读或单句过长，应重写短句而非加速/裁尾")
        if start < previous_end + 1.5 - .001:
            raise StoryError("内心独白重叠或过密，成片两句之间至少留白1.5秒")
        previous_end = end
        occupied += length
    if occupied > duration * .55 + .001:
        raise StoryError("内心独白占用超过55%画面，应保留无字幕的自然留白")


def validate_monologues(decision: dict, parsed: dict, frames: list[dict], duration: float, parameters: dict) -> dict:
    """The old factual/co-visibility contract stays intact; only story scope expands."""
    arc = _text(parsed.get("narrative_arc"), "故事前后关联说明")
    if parsed.get("reviewed_full_video") is not True:
        raise StoryError("内心独白小剧场必须确认已检索整段视频，而不是找到一个短动作就结束")
    achieved = decision["duration"]
    minimum, maximum = parameters["story_min_duration_seconds"], parameters["story_preferred_max_duration_seconds"]
    shortfall = parsed.get("shortfall_reason", "")
    if not isinstance(shortfall, str) or len(shortfall) > 2000:
        raise StoryError("小剧场时长不足原因必须是短文字")
    shortfall = shortfall.strip()
    if achieved > maximum + .000001:
        raise StoryError(f"小剧场时长{achieved:g}秒超过本次目标范围上限{maximum:g}秒；不会自动截断反应")
    if achieved < minimum and not shortfall:
        raise StoryError(f"小剧场时长仅{achieved:g}秒，未达到{minimum:g}秒；必须继续检索相关互动或明确素材不足原因")
    if achieved >= minimum and shortfall:
        raise StoryError("已达到时长范围，不能同时声明时长不足")
    rows = parsed.get("inner_monologues")
    if not isinstance(rows, list) or not rows:
        raise StoryError("小剧场缺少小布的内心独白字幕")
    frame_map = _source_frames(frames, duration)
    clips = {c["id"]: c for c in decision["clips"]}
    events = {e["id"]: e for e in decision["events"]}
    cues, ids, output_cues = [], set(), []
    offsets, offset = {}, 0.
    for clip in decision["clips"]:
        offsets[clip["id"]] = offset
        offset += clip["end"] - clip["start"]
    for row in rows:
        if not isinstance(row, dict):
            raise StoryError("内心独白条目必须是对象")
        ident = _identifier(row.get("id"), "独白ID")
        if ident in ids:
            raise StoryError("内心独白ID重复")
        ids.add(ident)
        clip_id = _identifier(row.get("clip_id"), "独白片段ID")
        event_id = _identifier(row.get("event_id"), "独白动作ID")
        clip, event = clips.get(clip_id), events.get(event_id)
        if clip is None or event is None or event["clip_id"] != clip_id:
            raise StoryError("内心独白没有对应同一片段里的真实动作")
        start, end = _interval(row, "内心独白", duration)
        if not clip["start"] <= start < end <= clip["end"] or not event["start"] <= start < event["end"]:
            raise StoryError("内心独白必须从对应动作内开始、在本片段内结束，不能跨切镜硬塞台词")
        refs = _references(row.get("frame_ids"), frame_map, start, end, "独白动作依据")
        if not set(refs).issubset(event["frame_ids"]):
            raise StoryError("内心独白必须引用对应动作的已有事实证据")
        cue = {"id": ident, "clip_id": clip_id, "event_id": event_id, "start": start, "end": end,
               "frame_ids": refs, "text": plain_caption(row.get("text"))}
        if row.get('performance_direction'):
            cue['performance_direction'] = performance_direction(row['performance_direction'])
        if "caption_placement" in row:
            from .head_captions import validate_placement
            cue["caption_placement"] = validate_placement(row["caption_placement"], cue, clip, frame_map)
        cues.append(cue)
        output_cues.append({**cue, "start": offsets[clip_id] + start - clip["start"],
                            "end": offsets[clip_id] + end - clip["start"]})
    validate_cue_rhythm(output_cues, achieved)
    result = deepcopy(decision)
    result.update(story_mode="inner_monologue", narrative_arc=arc, reviewed_full_video=True,
                  inner_monologues=cues, subtitle_kind="fictional_inner_monologue",
                  duration_goal={"target": parameters["story_target_duration_seconds"], "minimum": minimum,
                                 "maximum": maximum, "met": achieved >= minimum, "shortfall_reason": shortfall})
    if shortfall:
        result["warnings"].append(f"素材不足：目标{parameters['story_target_duration_seconds']:g}秒，实际{achieved:g}秒。{shortfall}")
    return result


def _clock(seconds: float, *, ass=False) -> str:
    scale = 100 if ass else 1000
    units = round(seconds * scale)
    whole, fraction = divmod(units, scale)
    hours, remainder = divmod(whole, 3600)
    minutes, secs = divmod(remainder, 60)
    return (f"{hours}:{minutes:02}:{secs:02}.{fraction:02}" if ass else
            f"{hours:02}:{minutes:02}:{secs:02},{fraction:03}")


def write_subtitles(directory: Path, cues: list[dict], info: dict) -> dict[str, Path]:
    """Write trusted ASS styling and plain SRT; no untrusted styling can be injected."""
    if cues and any("caption_placement" in cue for cue in cues):
        from .head_captions import write_head_subtitles
        return write_head_subtitles(directory, cues, info)
    ass, srt = directory / "interaction-story.ass", directory / "interaction-story.srt"
    width, height = int(info["width"]), int(info["height"])
    # Readable when the native landscape frame is scaled into a phone card.
    # Width cap leaves room for 18 CJK characters and both side margins.
    size = max(8, round(min(height * .10, width * .048)))
    margin_x, margin_v = max(6, round(width * .04)), max(6, round(height * .075))
    outline, shadow = max(1, round(size * .035)), max(1, round(size * .015))
    header = (f"[Script Info]\nTitle: 小布的内心独白（趣味演绎）\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\n"
              "ScaledBorderAndShadow: yes\nWrapStyle: 0\n\n[V4+ Styles]\n"
              "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
              f"Style: Inner,Microsoft YaHei,{size},&H00FFFFFF,&H00FFFFFF,&H0024201C,&H80000000,0,0,0,0,100,100,0,0,1,{outline},{shadow},2,{margin_x},{margin_x},{margin_v},1\n\n"
              "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
    ass_rows, srt_rows = [], []
    for index, cue in enumerate(cues, 1):
        text = plain_caption(cue["text"])
        # Explicit maximum of two short lines, independent of external ASS tags.
        lines = [text] if len(text) <= 18 else [text[:18], text[18:]]
        ass_text = "\\N".join(lines)
        start, end = cue["output_start"], cue["output_end"]
        ass_rows.append(f"Dialogue: 0,{_clock(start, ass=True)},{_clock(end, ass=True)},Inner,,0,0,0,,{ass_text}\n")
        srt_rows.append(f"{index}\n{_clock(start)} --> {_clock(end)}\n" + "\n".join(lines) + "\n\n")
    ass.write_text(header + "".join(ass_rows), encoding="utf-8")
    srt.write_text("".join(srt_rows), encoding="utf-8")
    return {"ass": ass, "srt": srt}
