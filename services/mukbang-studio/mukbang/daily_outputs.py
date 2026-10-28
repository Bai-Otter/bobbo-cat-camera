"""Independent, original-sound products from a single already-returned decision.

This module never calls a provider or resamples the video. Legacy eating edits
still use the existing renderer; a story is a separate, inward-quantized cut.
"""
from __future__ import annotations

from copy import deepcopy
from bisect import bisect_left, bisect_right
from fractions import Fraction
from pathlib import Path

from . import media


def poster_url(sampling: dict, clips: list[dict]) -> str | None:
    """Use an actual cached, referenced frame inside the final edit, not stock art."""
    candidates = [f for f in sampling["frames"] if f.get("url") and any(
        f["id"] in c["frame_ids"] and c["start"] <= f["time"] < c["end"] for c in clips)]
    return max(candidates, key=lambda f: f.get("score", 0))["url"] if candidates else None


def map_story_events(events: list[dict], clips: list[dict], frames: list[dict], info: dict | None = None) -> list[dict]:
    """Map factual events to the concatenation without inventing temporal anchors."""
    mapping = {c["id"]: c for c in clips}
    frame_map = {f["id"]: f for f in frames}
    output = []
    for event in events:
        clip = mapping.get(event["clip_id"])
        if clip is None:
            raise ValueError("小剧场事件没有对应的实际剪辑片段")
        refs = event["frame_ids"]
        if not refs or any(f not in frame_map or not (
                clip["source_first_frame_index"] <= frame_map[f]["source_frame_index"] <
                clip["source_end_frame_index_exclusive"]) for f in refs):
            raise ValueError("真实帧边界量化后丢失了小剧场事件证据，已停止而不是编造动作")
        start, end = max(event["start"], clip["start"]), min(event["end"], clip["end"])
        if start >= end:
            raise ValueError("量化后小剧场事件不再位于成片区间内")
        source_times = []
        for ident in refs:
            frame = frame_map[ident]
            actual = ((info["pts"][frame["source_frame_index"]] - info["origin_pts"]) * float(Fraction(info["time_base"]))
                      if info is not None else frame["time"])
            if not start <= actual < end:
                raise ValueError("小剧场事件的引用证据不在实际事件区间内")
            source_times.append({"frame_id": ident, "time": actual, "sample_manifest_time": frame["time"],
                                 "output_time": clip["output_start"] + actual - clip["start"]})
        output.append({**deepcopy(event), "requested_source_start": event["start"],
                       "requested_source_end": event["end"], "source_start": start, "source_end": end,
                       "output_start": clip["output_start"] + start - clip["start"],
                       "output_end": clip["output_start"] + end - clip["start"], "source_times": source_times})
    return output


def quantize_story(decision: dict, info: dict, frames: list[dict]) -> tuple[list, list, list]:
    """Never expand beyond model-approved jointly-visible intervals, even by one frame."""
    tb = float(Fraction(info["time_base"]))
    points = [(p - info["origin_pts"]) * tb for p in info["pts"] + [info["end_pts"]]]
    approved = []
    for original in decision["clips"]:
        left, right = bisect_left(points, original["start"]), bisect_right(points, original["end"]) - 1
        if left >= right:
            raise ValueError("批准的小剧场区间内没有完整源视频帧")
        approved.append({**deepcopy(original), "start": points[left], "end": points[right],
                         "context_start": points[left], "context_end": points[right]})
    clips = media.quantize_clips(approved, info)
    frame_map = {f["id"]: f for f in frames}
    audit = []
    for clip, original_clip in zip(clips, decision["clips"]):
        clip["requested_start"], clip["requested_end"] = original_clip["start"], original_clip["end"]
        if clip["start"] < original_clip["start"] or clip["end"] > original_clip["end"]:
            raise ValueError("小剧场量化越出人宠同框批准区间")
        original = clip["frame_ids"][:]
        retained = [f for f in original if clip["source_first_frame_index"] <= frame_map[f]["source_frame_index"] <
                    clip["source_end_frame_index_exclusive"]]
        if not retained:
            raise ValueError("量化后小剧场片段没有任何原始证据")
        clip["frame_ids"] = retained
        if retained != original:
            clip["model_frame_ids"] = original
            audit.append({"type": "story_retain_actual_evidence", "clip_id": clip["id"],
                          "before": original, "after": retained})
        original_coverage = clip["co_visible_frame_ids"][:]
        coverage = [f for f in original_coverage if clip["source_first_frame_index"] <= frame_map[f]["source_frame_index"] <
                    clip["source_end_frame_index_exclusive"]]
        clip["co_visible_frame_ids"] = coverage
        if coverage != original_coverage:
            clip["model_co_visible_frame_ids"] = original_coverage
            audit.append({"type": "story_retain_actual_co_visibility", "clip_id": clip["id"],
                          "before": original_coverage, "after": coverage})
        if clip["start"] != clip["requested_start"] or clip["end"] != clip["requested_end"]:
            audit.append({"type": "story_inward_frame_quantization", "clip_id": clip["id"],
                          "before": [clip["requested_start"], clip["requested_end"]],
                          "after": [clip["start"], clip["end"]],
                          "reason": "剪点只向批准区间内部落到源帧PTS，不扩入人宠不再同框的画面"})
    events = map_story_events(decision["events"], clips, frames, info)
    return clips, events, audit


def _empty_eating(choices: dict, reason: str = "") -> dict:
    return {"video_url": None, "video_duration": 0., "container_duration": None,
            "summary": choices.get("validated", {}).get("summary", ""), "clips": [], "memes": [],
            "selected_frames": [], "adjustments": choices.get("adjustments", []),
            "warnings": choices.get("warnings", [])[:], "validation": {},
            "highlight_status": "invalid" if choices.get("highlight_error") else "not_found",
            "highlight_reason": reason or choices.get("highlight_error") or "没有找到符合当前吃播标准的片段，未用其他画面凑数"}


def map_story_monologues(decision: dict, clips: list[dict], frames: list[dict], info: dict) -> list[dict]:
    if decision.get("story_mode") != "inner_monologue":
        return []
    from .story_subtitles import validate_cue_rhythm
    mapped = map_story_events(decision["inner_monologues"], clips, frames, info)
    validate_cue_rhythm(mapped, sum(c["duration"] for c in clips), start_key="output_start", end_key="output_end")
    return mapped


def render_dual_outputs(job_dir: Path, source_path: Path, options: dict, info: dict, sampling: dict,
                        original_hash: str, choices: dict, source: dict, prompts: dict, ai: dict,
                        emit, cancelled, timings, *, eating_renderer, revision=None,
                        feedback_snapshot=None, comparison=None, recovery=None) -> dict:
    """Keep product failures separate; cancellation and input corruption remain terminal."""
    decision = deepcopy(choices["story"])
    result = _empty_eating(choices)
    eating_fields = {}
    def eating_update(update):
        update = dict(update)
        if "progress" in update:
            update["progress"] = min(76, 55 + max(0, update["progress"] - 55) // 2)
        emit(update)
    if choices.get("clips"):
        try:
            eating_fields = eating_renderer(
                job_dir, source_path, {**options, "story_enabled": False, "photos_enabled": False}, info, sampling, original_hash,
                choices, source, prompts, ai, eating_update, cancelled, timings,
                revision=revision, feedback_snapshot=feedback_snapshot, comparison=comparison, recovery=recovery)
            result = {**eating_fields["result"], "highlight_status": "ready", "highlight_reason": ""}
        except media.Cancelled:
            raise
        except Exception as exc:
            media.check_cancelled(cancelled)
            result = {**_empty_eating(choices), "highlight_status": "failed", "highlight_reason": str(exc)}
            result["warnings"].append("吃播渲染未完成：" + str(exc))
    else:
        with timings.measure("annotate_sheets"):
            media.annotate_sheets(job_dir, sampling, choices.get("validated", {}).get("selected_frames", []), [])
            media.write_json(job_dir / "sampling.json", sampling)
        emit({"sampling": sampling, "progress": 60, "stage": "吃播选片已完成",
              "message": result["highlight_reason"]})
    result["poster_url"] = poster_url(sampling, result["clips"]) if result["highlight_status"] == "ready" else None
    media.check_cancelled(cancelled)
    story_output = {**decision, "video_url": None, "video_duration": 0., "poster_url": None}
    if decision["status"] == "ready":
        try:
            with timings.measure("selection"):
                clips, events, audit = quantize_story(decision, info, sampling["frames"])
                duration = sum(c["duration"] for c in clips)
                if duration > 60.000001:
                    raise ValueError("实际小剧场超出60秒上限")
                monologues = map_story_monologues(decision, clips, sampling["frames"], info)
                timeline = {"source_sha256": original_hash, "speed": 1, "duration": duration,
                            "target": options.get("story_target_duration", 30), "maximum": 60,
                            "clips": clips, "events": events, "adjustments": audit,
                            "co_visibility_policy": "all supplied sampled frames in each interval affirmed jointly visible; unsampled instants are not independently verified"}
                if monologues:
                    goal = deepcopy(decision["duration_goal"])
                    goal["met"] = goal["minimum"] <= duration <= goal["maximum"]
                    if not goal["met"] and not goal["shortfall_reason"]:
                        goal["shortfall_reason"] = "实际源帧边界向内对齐后略短于目标范围；未补帧或扩入未批准画面"
                        story_output["warnings"].append(goal["shortfall_reason"])
                    timeline.update(inner_monologues=monologues, duration_goal=goal,
                                    story_mode="inner_monologue", subtitle_kind="fictional_inner_monologue")
                media.write_json(job_dir / "story-timeline.json", timeline)
            emit({"status": "rendering", "progress": 80, "stage": "剪辑人宠互动小故事",
                  "message": f"{len(clips)}段可见互动，{duration:.2f}秒；原速、原画幅、原声" +
                             (f"＋{len(monologues)}句小布内心独白字幕，不加配音或BGM" if monologues else "，不加配音或BGM")})
            with timings.measure("render_story"):
                subtitle_options = {}
                if monologues:
                    from .story_subtitles import write_subtitles
                    with media._media_step(lambda ident, label, seconds, status: timings.record_detail(
                            "render_story", ident, label, seconds, status), "prepare_subtitles", "生成内心独白字幕与实际时间轴"):
                        subtitle_files = write_subtitles(job_dir, monologues, info)
                        media.write_json(job_dir / "story-inner-monologues.json", {
                            "kind": "fictional_inner_monologue", "narration_added": False,
                            "cues": monologues, "duration_goal": goal})
                    subtitle_options["subtitle_file"] = subtitle_files["ass"]
                validation = media.render_video(
                    source_path, job_dir / "interaction-story.mp4", clips, info, cancelled,
                    on_step=lambda ident, label, seconds, status: timings.record_detail(
                        "render_story", ident, label, seconds, status), **subtitle_options)
            validation.update(visual_api_call_count=ai["call_count"], additional_visual_api_calls=0,
                              achieved_source_timeline_duration=duration,
                              sampled_co_visibility_checked=True, unsampled_co_visibility_verified=False,
                              story_target_is_aspirational=not bool(monologues), narration_added=False, bgm_added=False)
            if monologues:
                validation.update(subtitles_burned_in=True, subtitle_count=len(monologues),
                                  subtitle_kind="fictional_inner_monologue", subtitle_sha256=media.sha256(subtitle_files["ass"]),
                                  duration_goal_met=goal["met"])
                story_output.update(inner_monologues=monologues, duration_goal=goal,
                                    subtitle_url=media.artifact_url(job_dir, subtitle_files["srt"].name),
                                    subtitle_timeline_url=media.artifact_url(job_dir, "story-inner-monologues.json"))
            if recovery is not None:
                validation.update(reused_ai_result=True, source_job_id=recovery["source_job_id"],
                                  source_ai_call_count=recovery["source_ai_call_count"],
                                  source_sheet_count=sampling["sheet_count"])
            story_output.update(status="ready", clips=clips, events=events, adjustments=audit,
                                duration=duration, video_duration=duration,
                                container_duration=validation["actual_container_duration_seconds"],
                                video_url=media.artifact_url(job_dir, "interaction-story.mp4"),
                                poster_url=poster_url(sampling, clips), validation=validation)
            media.write_json(job_dir / "story-technical-validation.json", validation)
        except media.Cancelled:
            raise
        except Exception as exc:
            media.check_cancelled(cancelled)
            story_output.update(status="failed", reason=str(exc), video_url=None, video_duration=0., poster_url=None)
    photo_outputs = None
    if options.get("photos_enabled") is True:
        from .photos import export_photos
        emit({"status": "rendering", "progress": 94, "stage": "提取合拍与丑萌照片",
              "message": "按AI选中的真实源帧导出原尺寸照片，不再请求AI，不重绘或裁切"})
        try:
            with timings.measure("export_photos"):
                photo_outputs = export_photos(job_dir, source_path, choices["photos"], info, sampling,
                                              original_hash, cancelled, on_step=lambda ident, label, seconds, status:
                                              timings.record_detail("export_photos", ident, label, seconds, status))
        except media.Cancelled:
            raise
        except Exception as exc:
            media.check_cancelled(cancelled)
            photo_outputs = {category: ({**pick, "status": "failed", "reason": str(exc)}
                                        if pick["status"] == "ready" else deepcopy(pick))
                             for category, pick in choices["photos"].items()}
            media.write_json(job_dir / "photo-result.json", photo_outputs)
    with timings.measure("final_validation"):
        if media.sha256(source_path) != original_hash:
            raise RuntimeError("源视频完整性校验未通过")
        result["story"] = story_output
        result["dual_video"] = True
        if photo_outputs is not None:
            result["photos"] = photo_outputs
        # Honest product states, not a claim that both videos necessarily exist.
        for label, state in (("吃播", result["highlight_status"]), ("小剧场", story_output["status"])):
            if state in {"failed", "invalid"}:
                result["warnings"].append(f"{label}未生成（{state}），详情见该产物状态；未追加AI请求")
        if photo_outputs is not None:
            from .photos import CATEGORIES
            for category, photo in photo_outputs.items():
                if photo["status"] in {"invalid", "failed"}:
                    result["warnings"].append(f"{CATEGORIES[category]}未生成（{photo['status']}）：{photo['reason']}；未追加AI请求")
        result["validation"].update(source_unchanged=True, visual_api_call_count=ai["call_count"],
                                    additional_story_visual_api_calls=0)
        media.write_json(job_dir / "story-result.json", story_output)
        media.write_json(job_dir / "result.json", result)
        successes = sum(state == "ready" for state in (result["highlight_status"], story_output["status"]))
        note = (f"吃播{result['video_duration']:.2f}秒；小剧场{story_output['video_duration']:.2f}秒" if successes == 2 else
                f"已生成{successes}类视频；其他类别的未生成原因已单独列出")
        photo_successes = sum(p["status"] == "ready" for p in (photo_outputs or {}).values())
        if photo_outputs is not None:
            note += f"；照片{photo_successes}/2张（各类结果单独列出）"
        request_note = "复用已保存视觉结果，本次未调用AI" if recovery is not None else "共用一次视觉判断，未重试看图"
        fields = {**eating_fields, "status": "completed", "progress": 100, "stage": "处理完成",
                  "message": note + "。" + request_note, "source": source, "sampling": sampling,
                  "prompt": prompts, "ai": ai, "result": result}
        if revision is not None:
            fields.update(feedback=feedback_snapshot, comparison=comparison)
        if recovery is not None:
            fields["recovery"] = deepcopy(recovery)
    if successes + photo_successes == 0 and (result["highlight_status"] in {"invalid", "failed"} or
            story_output["status"] in {"invalid", "failed"} or
            any(p["status"] in {"invalid", "failed"} for p in (photo_outputs or {}).values())):
        emit({"result": result, "sampling": sampling})
        raise RuntimeError("本次没有可交付的视频或照片，至少一个类别校验或导出失败；已保存各自原因，未重试AI")
    return fields
