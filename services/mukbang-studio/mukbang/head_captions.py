"""Single-response head anchors -> deterministic, stable caption layout.

No image reading, detector, network request or manually supplied coordinates.
Boxes describe sampled evidence, not a guarantee of per-frame tracking.
"""
from __future__ import annotations

import math

LAYOUT_VERSION = "forehead-v2"


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_placement(raw, cue: dict, clip: dict, frame_map: dict) -> dict:
    """Bad optional placement must not invalidate an otherwise valid story."""
    result = {"mode": "safe", "anchors": [], "reason": "没有可靠猫头定位，回退安全字幕", "warnings": []}
    if not isinstance(raw, dict) or raw.get("mode") not in {"head_top", "forehead"}:
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
        forehead = row.get("forehead")
        if (isinstance(forehead, list) and len(forehead) == 2 and all(_number(v) for v in forehead)
                and box[0] <= forehead[0] <= box[2] and box[1] <= forehead[1] <= box[3]):
            result["anchors"][-1]["forehead"] = [float(v) for v in forehead]
        elif forehead is not None:
            result["warnings"].append("额头点无效，保留头部框作几何估计；未追加请求")
    result["anchors"].sort(key=lambda a: a["source_time"])
    if result["anchors"]:
        result.update(mode="forehead", reason="使用同一视觉响应定位额头，按采样时间平滑跟随")
    return result


def layout_caption(cue: dict, width: int, height: int) -> dict:
    from .story_subtitles import plain_caption
    text = plain_caption(cue["text"])
    if width <= 0 or height <= 0:
        raise ValueError("字幕画幅必须为正数")
    size = max(8, round(min(height * .07, width * .038)))
    margin = max(8, round(min(width, height) * .045))
    top_margin = max(8, round(height * .025))
    max_chars = max(1, min(14, int((width - 2 * margin) / (size * 1.10))))
    lines = [text[i:i + max_chars] for i in range(0, len(text), max_chars)]
    # Glyph/outline bounds only. No scaling or entry/exit animation.
    text_width = min(width - 2 * margin, math.ceil(max(map(len, lines)) * size * 1.10))
    text_height = math.ceil(len(lines) * size * 1.20)
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
    active_anchors = [a for a in active_anchors if isinstance(a, dict) and
             isinstance(a.get("head_box"), list) and len(a["head_box"]) == 4 and
             all(_number(v) and 0 <= v <= 1 for v in a["head_box"]) and
             a["head_box"][0] < a["head_box"][2] and a["head_box"][1] < a["head_box"][3]]
    boxes = [a["head_box"] for a in active_anchors]
    mode, reason = "safe", "定位不足，使用安全字幕；未追加视觉请求"
    start = float(cue.get("output_start", 0.))
    source_start = float(cue.get("source_start", cue.get("start", active_anchors[0]["source_time"] if active_anchors else 0.)))
    end = float(cue.get("output_end", start + float(cue.get("source_end", source_start + 2.)) - source_start))
    source_end = source_start + end - start
    point_map, point_origins = {}, []
    union = None
    if boxes and placement.get("mode") in {"head_top", "forehead"}:
        union = [min(b[0] for b in boxes) * width, min(b[1] for b in boxes) * height,
                 max(b[2] for b in boxes) * width, max(b[3] for b in boxes) * height]
        for anchor in active_anchors:
            left, top, right, bottom = anchor["head_box"]
            point = anchor.get("forehead")
            explicit = (isinstance(point, list) and len(point) == 2 and all(_number(v) for v in point)
                        and left <= point[0] <= right and top <= point[1] <= bottom)
            # Old responses have no anatomical point. Estimate upper head area,
            # explicitly label the approximation, and never call vision again.
            fx, fy = point if explicit else ((left + right) / 2, top + (bottom - top) * .27)
            point_map[anchor["source_time"]] = (fx * width, fy * height)
            point_origins.append("api_forehead" if explicit else "head_box_upper_region_estimate")
        mode, reason = "forehead", "字幕中心贴近额头，按同轮API采样点插值；无进出特效"
    def sample_at(moment):
        ordered = sorted(point_map)
        if not ordered:
            return width / 2, height - margin - text_height / 2
        if moment <= ordered[0]:
            return point_map[ordered[0]]
        if moment >= ordered[-1]:
            return point_map[ordered[-1]]
        for t0, t1 in zip(ordered, ordered[1:]):
            if t0 <= moment <= t1:
                fraction = (moment - t0) / (t1 - t0)
                p0, p1 = point_map[t0], point_map[t1]
                return tuple(a + (b-a) * fraction for a,b in zip(p0,p1))
        raise AssertionError("Unreachable anchor interval")
    moments = sorted({start, end, *(start+t-source_start for t in point_map if source_start<t<source_end)})
    points = []
    for moment in moments:
        x, y = sample_at(source_start + moment - start)
        x = round(min(max(x, margin + text_width/2), width-margin-text_width/2))
        y = round(min(max(y, top_margin+text_height/2), height-margin-text_height/2))
        points.append({"time": moment, "x": x, "y": y,
                       "text_box": [round(x-text_width/2),round(y-text_height/2),round(x+text_width/2),round(y+text_height/2)]})
    first = points[0]
    return {"mode": mode, "reason": reason, "x": first["x"], "y": first["y"],
            "font_size": size, "lines": lines, "text_box": first["text_box"], "points": points,
            "head_union_box": union, "anchor_count": len(boxes),
            "point_origins": sorted(set(point_origins)), "entry_exit_effects": False,
            "position_policy": "sampled_forehead_linear_interpolation", "unsampled_frames_verified": False}


def ass_header(width: int, height: int, size: int) -> str:
    outline, shadow = max(2, round(size * .07)), max(1, round(size * .025))
    return (f"[Script Info]\nTitle: 咪的额头内心话（趣味演绎）\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\n"
            "ScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Head,Microsoft YaHei,{size},&H0099EEFF,&H0099EEFF,&H002D2420,&H70000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},5,0,0,0,1\n\n"
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
        caption = "\\N".join(layout["lines"])
        for p0, p1 in zip(layout["points"], layout["points"][1:]):
            if _clock(p0['time'],ass=True)==_clock(p1['time'],ass=True):
                continue
            position = (f"\\pos({p0['x']},{p0['y']})" if (p0['x'],p0['y'])==(p1['x'],p1['y']) else
                        f"\\move({p0['x']},{p0['y']},{p1['x']},{p1['y']})")
            tags = f"{{\\an5{position}\\fs{layout['font_size']}}}"
            ass_rows.append(f"Dialogue: 0,{_clock(p0['time'],ass=True)},{_clock(p1['time'],ass=True)},Head,,0,0,0,,{tags}{caption}\n")
        srt_rows.append(f"{index}\n{_clock(start)} --> {_clock(end)}\n" + "\n".join(layout["lines"]) + "\n\n")
        layout.update(cue_id=cue.get("id"), output_start=start, output_end=end)
    ass, srt = directory / "interaction-story.ass", directory / "interaction-story.srt"
    ass.write_text(ass_header(width, height, layouts[0]["font_size"]) + "".join(ass_rows), encoding="utf-8")
    srt.write_text("".join(srt_rows), encoding="utf-8")
    (directory / "story-caption-layout.json").write_text(json.dumps({
        "version": LAYOUT_VERSION, "origin": "single_vision_response", "additional_visual_api_calls": 0,
        "coordinates": "normalized_original_frame", "layouts": layouts}, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ass": ass, "srt": srt}
