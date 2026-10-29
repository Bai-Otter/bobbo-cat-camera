"""Single-response head anchors -> deterministic, stable caption layout.

No image reading, detector, network request or manually supplied coordinates.
Boxes describe sampled evidence, not a guarantee of per-frame tracking.
"""
from __future__ import annotations

import math
from statistics import median


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_placement(raw, cue: dict, clip: dict, frame_map: dict) -> dict:
    """Bad optional placement must not invalidate an otherwise valid story."""
    result = {"mode": "safe", "anchors": [], "reason": "没有可靠猫头定位，回退安全字幕", "warnings": []}
    if not isinstance(raw, dict) or raw.get("mode") != "head_top":
        return result
    rows = raw.get("anchors")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
        result["warnings"].append("猫头锚点数量或格式无效")
        return result
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            result["warnings"].append("忽略非对象猫头锚点")
            continue
        ident, box, confidence = row.get("frame_id"), row.get("head_box"), row.get("confidence")
        frame = frame_map.get(ident) if isinstance(ident, str) else None
        valid = (frame is not None and ident not in seen and
                 clip["start"] <= frame["time"] < clip["end"] and
                 cue["start"] <= frame["time"] < min(clip["end"], cue["end"] + 1.) and
                 isinstance(box, list) and len(box) == 4 and all(_number(v) and 0 <= v <= 1 for v in box) and
                 box[0] < box[2] and box[1] < box[3] and
                 _number(confidence) and .6 <= confidence <= 1)
        if not valid:
            result["warnings"].append("忽略越界、低置信度或不属于本句/片段的猫头锚点")
            continue
        seen.add(ident)
        result["anchors"].append({"frame_id": ident, "source_time": frame["time"],
                                  "head_box": [float(v) for v in box], "confidence": float(confidence)})
    result["anchors"].sort(key=lambda a: a["source_time"])
    if result["anchors"]:
        result.update(mode="head_top", reason="使用同一视觉响应中的猫头框，整句固定位置防抖")
    return result


def layout_caption(cue: dict, width: int, height: int) -> dict:
    from .story_subtitles import plain_caption
    text = plain_caption(cue["text"])
    if width <= 0 or height <= 0:
        raise ValueError("字幕画幅必须为正数")
    size = max(8, round(min(height * .085, width * .042)))
    margin = max(8, round(min(width, height) * .045))
    top_margin = max(8, round(height * .025))
    max_chars = max(1, min(14, int((width - 2 * margin) / (size * 1.10))))
    lines = [text[i:i + max_chars] for i in range(0, len(text), max_chars)]
    # Reserve generous glyph, outline, shadow and 106% entry-animation bounds.
    text_width = min(width - 2 * margin, math.ceil(max(map(len, lines)) * size * 1.10))
    text_height = math.ceil(len(lines) * size * 1.35)
    gap = max(12, round(size * .3))
    placement = cue.get("caption_placement", {})
    anchors = placement.get("anchors", []) if isinstance(placement, dict) else []
    # Include the first immediately following sample as an end-boundary guard:
    # a cat can approach the camera between the last in-cue sample and cue end.
    # This remains sampled evidence, not per-frame tracking or extrapolation.
    active_anchors = [a for a in anchors if isinstance(a, dict) and
                      ("source_start" not in cue or "source_end" not in cue or
                       (_number(a.get("source_time")) and cue["source_start"] <= a["source_time"] < cue["source_end"]))]
    if "source_end" in cue:
        following = [a for a in anchors if isinstance(a, dict) and _number(a.get("source_time")) and
                     cue["source_end"] <= a["source_time"] < cue["source_end"] + 1.]
        if following:
            active_anchors.append(min(following, key=lambda a: a["source_time"]))
    boxes = [a["head_box"] for a in active_anchors if isinstance(a, dict) and
             isinstance(a.get("head_box"), list) and len(a["head_box"]) == 4 and
             all(_number(v) and 0 <= v <= 1 for v in a["head_box"]) and
             a["head_box"][0] < a["head_box"][2] and a["head_box"][1] < a["head_box"][3]]
    mode, reason = "safe", "定位不足或无足够空间，使用安全字幕；未追加视觉请求"
    x, bottom = width / 2, height - margin
    union = None
    if boxes and placement.get("mode") == "head_top":
        union = [min(b[0] for b in boxes) * width, min(b[1] for b in boxes) * height,
                 max(b[2] for b in boxes) * width, max(b[3] for b in boxes) * height]
        center = median((b[0] + b[2]) * width / 2 for b in boxes)
        candidate_x = min(max(center, margin + text_width / 2), width - margin - text_width / 2)
        candidate_bottom = union[1] - gap
        # Prefer a slightly smaller head-top caption over jumping to the footer
        # when a close-up leaves just a little less vertical space.
        fit_size = math.floor((candidate_bottom - top_margin) / (len(lines) * 1.35))
        if size * .8 <= fit_size < size:
            size = fit_size
            text_width = min(width - 2 * margin, math.ceil(max(map(len, lines)) * size * 1.10))
            text_height = math.ceil(len(lines) * size * 1.35)
            candidate_x = min(max(center, margin + text_width / 2), width - margin - text_width / 2)
        if candidate_bottom - text_height >= top_margin:
            x, bottom, mode = candidate_x, candidate_bottom, "head_top"
            reason = "位于本句所有已知猫头框的上方，整句固定防抖"
        else:
            # Top edge lacks space; reserve the whole text box beside the head.
            spaces = [(union[0] - gap - margin, "left"), (width - margin - union[2] - gap, "right")]
            available, side = max(spaces)
            if available >= text_width:
                x = union[0] - gap - text_width / 2 if side == "left" else union[2] + gap + text_width / 2
                bottom = min(height - margin, max(margin + text_height, (union[1] + union[3]) / 2 + text_height / 2))
                mode, reason = "head_side", "头顶空间不足，放到猫头侧边，避开已知猫头框"
    x, bottom = round(x), round(bottom)
    return {"mode": mode, "reason": reason, "x": x, "bottom": bottom, "font_size": size,
            "lines": lines, "text_box": [round(x - text_width / 2), bottom - text_height,
                                         round(x + text_width / 2), bottom],
            "head_union_box": union, "anchor_count": len(boxes),
            "position_policy": "stable_per_cue", "unsampled_frames_verified": False}


def ass_header(width: int, height: int, size: int) -> str:
    outline, shadow = max(2, round(size * .07)), max(1, round(size * .025))
    return (f"[Script Info]\nTitle: 咪的头顶内心话（趣味演绎）\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\n"
            "ScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Head,Microsoft YaHei,{size},&H0099EEFF,&H0099EEFF,&H002D2420,&H70000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},2,0,0,0,1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")


def write_head_subtitles(directory, cues: list[dict], info: dict):
    import json
    from .story_subtitles import _clock
    width, height = int(info["width"]), int(info["height"])
    layouts = [layout_caption(cue, width, height) for cue in cues]
    ass_rows, srt_rows = [], []
    for index, (cue, layout) in enumerate(zip(cues, layouts), 1):
        start, end = cue["output_start"], cue["output_end"]
        if not all(_number(t) for t in (start, end)) or not 0 <= start < end:
            raise ValueError("头顶字幕时间无效")
        tags = (f"{{\\an2\\pos({layout['x']},{layout['bottom']})\\fs{layout['font_size']}"
                "\\fad(80,120)\\fscx94\\fscy94\\t(0,120,\\fscx106\\fscy106)"
                "\\t(120,230,\\fscx100\\fscy100)}")
        caption = "\\N".join(layout["lines"])
        ass_rows.append(f"Dialogue: 0,{_clock(start,ass=True)},{_clock(end,ass=True)},Head,,0,0,0,,{tags}{caption}\n")
        srt_rows.append(f"{index}\n{_clock(start)} --> {_clock(end)}\n" + "\n".join(layout["lines"]) + "\n\n")
        layout.update(cue_id=cue.get("id"), output_start=start, output_end=end)
    ass, srt = directory / "interaction-story.ass", directory / "interaction-story.srt"
    ass.write_text(ass_header(width, height, layouts[0]["font_size"]) + "".join(ass_rows), encoding="utf-8")
    srt.write_text("".join(srt_rows), encoding="utf-8")
    (directory / "story-caption-layout.json").write_text(json.dumps({
        "version": "head-top-v1", "origin": "single_vision_response", "additional_visual_api_calls": 0,
        "coordinates": "normalized_original_frame", "layouts": layouts}, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ass": ass, "srt": srt}
