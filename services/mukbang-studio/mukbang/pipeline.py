"""Upload job -> sample sheets -> ONE vision request -> deterministic render."""
from __future__ import annotations

from copy import deepcopy
import json
import math
from pathlib import Path
import time

from . import media, selection, vision


def _public_source(info: dict, job_dir: Path, source: Path) -> dict:
    return {key: info[key] for key in ("duration", "width", "height", "fps", "audio_sample_rate", "audio_channels")} | {
        "video_url": media.artifact_url(job_dir, source.relative_to(job_dir)), "speed": 1.0}


def _retain_quantized_evidence(clips: list[dict], frames: list[dict], adjustments: list) -> None:
    frame_map = {f["id"]: f for f in frames}
    for clip in clips:
        original = clip["frame_ids"][:]
        inside = [f for f in original if clip["source_first_frame_index"] <= frame_map[f]["source_frame_index"] < clip["source_end_frame_index_exclusive"]]
        if not inside:
            raise selection.SelectionError(f"片段{clip['id']}量化后没有保留引用的可爱帧；已停止而不是输出无证据片段")
        if inside != original:
            clip.update(model_frame_ids=original, frame_ids=inside)
            adjustments.append({"type": "retain_actual_frame_evidence", "clip_id": clip["id"],
                                "before": original, "after": inside, "reason": "最终片段只引用真实包含的证据帧，原始AI证据另存"})


def validate_decisions(parsed: dict, frames: list[dict], duration: float, options: dict) -> dict:
    """One shared decision gate for fresh runs and zero-provider offline recovery."""
    try:
        choices = selection.validate_and_adjust(parsed, frames, duration, options)
    except selection.SelectionError as exc:
        if options.get("story_enabled") is not True:
            raise
        choices = {"clips": [], "memes": [], "adjustments": [], "warnings": [str(exc)],
                   "validated": {"summary": "吃播返回未通过校验", "selected_frames": []},
                   "highlight_error": str(exc)}
    if options.get("story_enabled") is True:
        from .story import StoryError, validate_story
        try:
            story_choice = validate_story(parsed.get("interaction_story"), frames, duration, options)
        except StoryError as exc:
            story_choice = {"status": "invalid", "reason": str(exc), "title": "", "summary": "",
                            "clips": [], "events": [], "warnings": [str(exc)]}
        choices["story"] = story_choice
    return choices


def run_pipeline(job_dir: Path, source_path: Path, options: dict, model_config: dict, emit, cancelled, timings=None, revision=None) -> dict:
    """Keep six-argument callers compatible; let a manager own final timing.

    Standalone calls persist timing snapshots and publish completion only after
    their timer has finished. A supplied timer belongs to the JobManager: this
    function neither finishes it nor emits a premature completed job record.
    """
    owned_timings = timings is None
    if owned_timings:
        from .timing import JobTimings
        def timing_update(snapshot):
            media.write_json(Path(job_dir) / "timings.json", snapshot)
            emit({"timings": snapshot})
        timings = JobTimings(
            on_update=timing_update, scope="pipeline_execution",
            note="从流水线开始处理到结束；直接调用不包含 HTTP 接收与排队。AI 调用包含编码、传输、等待与接收响应。")
    status = "failed"
    try:
        fields = _run_pipeline(job_dir, source_path, options, model_config, emit, cancelled, timings, revision)
        status = "completed"
    except BaseException as exc:
        if isinstance(exc, media.Cancelled) or cancelled():
            status = "cancelled"
        raise
    finally:
        if owned_timings:
            timings.finish(status)
    if owned_timings:
        fields["timings"] = timings.snapshot()
        emit(fields)
    return fields


def _run_pipeline(job_dir: Path, source_path: Path, options: dict, model_config: dict, emit, cancelled, timings, revision=None) -> dict:
    """No model retry. Every input/decision remains inspectable after failures."""
    job_dir, source_path = Path(job_dir).resolve(), Path(source_path).resolve()
    options, config = deepcopy(options), dict(model_config)
    ai = {"model": config["model"], "provider": config["base_url"], "api_style": config["api_style"], "call_count": 0}
    key = config.get("api_key", "")
    emit({"status": "preparing", "stage": "复用同视频输入" if revision else "读取视频", "progress": 3,
          "message": "核验原拼图、帧ID与源时间戳，不重新抽帧" if revision else "校验视频与真实源时间戳，不进行额外AI看图", "ai": ai})
    feedback_snapshot = None
    comparison = None
    if revision is not None:
        with timings.measure("reuse_inputs"):
            media.check_cancelled(cancelled)
            info, sampling, original_hash = media.reuse_inputs(job_dir, source_path, revision,
                                                               float(options["sample_interval"]), cancelled)
            current_feedback = revision["feedback"]
            snapshot = {"version": current_feedback["version"],
                        "annotations": [{"frame_id": row["frame_id"], "label": row["label"], "reason": row.get("reason", "")}
                                        for row in current_feedback["annotations"]],
                        "note": current_feedback.get("note", "")}
            feedback_snapshot = json.loads(vision.redact(json.dumps(snapshot, ensure_ascii=False), key))
            media.write_json(job_dir / "feedback.json", feedback_snapshot)
        source = _public_source(info, job_dir, source_path)
        emit({"source": source, "feedback": feedback_snapshot, "progress": 22,
              "stage": "已复用原始采样", "message": "使用同一源视频、同一帧ID与原始拼图；旧圈选已清除，不做视觉复看"})
    else:
        with timings.measure("source_probe"):
            if not source_path.is_file() or not source_path.is_relative_to(job_dir):
                raise ValueError("任务视频必须位于当前任务文件夹内")
            media.check_cancelled(cancelled)
            with timings.measure_detail("source_probe", "metadata", "读取源片元信息"):
                metadata = media.probe(source_path, cancelled)
            # Reject an advertised overlong source before decoding its entire
            # PTS index; check the frame-derived duration again below.
            video_stream = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "video"), None)
            if not video_stream:
                raise ValueError("上传文件没有视频轨道")
            advertised_duration = video_stream.get("duration", metadata.get("format", {}).get("duration"))
            if advertised_duration is not None:
                try:
                    advertised_duration = float(advertised_duration)
                except (ValueError, TypeError):
                    advertised_duration = None
                if advertised_duration is not None and (not math.isfinite(advertised_duration) or advertised_duration > 600.001):
                    raise ValueError("视频超过10分钟限制或时长无效，请先截取需要分析的一段")
            with timings.measure_detail("source_probe", "frame_index", "解码源片建立帧时间戳"):
                frames = media.frame_times(source_path, cancelled)
                info = media.video_info(metadata, frames)
            if info["duration"] > 600.001:
                raise ValueError("视频超过10分钟限制，请先截取需要分析的一段")
            source = _public_source(info, job_dir, source_path)
            with timings.measure_detail("source_probe", "source_digest", "源片完整性摘要"):
                original_hash = media.sha256(source_path)
            media.write_json(job_dir / "source-metadata.json", metadata)
            media.write_json(job_dir / "source-pts.json", {"time_base": info["time_base"], "origin_pts": info["origin_pts"],
                                                        "end_pts": info["end_pts"], "pts": info["pts"]})
        emit({"source": source, "progress": 8, "stage": "生成采样拼图", "message": "按设置间隔抽样，每张拼图最多60帧"})
        sampling = media.sample_video(source_path, job_dir, info, float(options["sample_interval"]), cancelled, timings=timings)
    with timings.measure("prepare_request"):
        if revision is None:
            media.write_input_cache_integrity(job_dir, source_path, sampling, original_hash)
            prompts = vision.build_prompts(options, source, sampling)
        else:
            prompts = vision.build_prompts(options, source, sampling, feedback_context={
                "round": revision["round"], "feedback": feedback_snapshot,
                "previous_selected_frames": revision.get("previous_selected_frames", [])})
        # Exact text is inspectable, but accidental key pastes are never persisted.
        prompts = {k: vision.redact(v, key) for k, v in prompts.items()}
        manifest = vision.request_manifest(prompts, sampling["sheets"], config)
        ai["request_manifest"] = manifest
        media.write_json(job_dir / "sampling.json", sampling)
        media.write_json(job_dir / "prompt.json", prompts)
        media.write_json(job_dir / "request-manifest.json", manifest)
    emit({"sampling": sampling, "prompt": prompts, "ai": deepcopy(ai), "progress": 25,
          "stage": "准备单次AI判断", "message": f"{sampling['frame_count']}张采样帧，{sampling['sheet_count']}张拼图，将在同一个请求内全部发送"})
    media.check_cancelled(cancelled)
    ai["call_count"] = 1
    emit({"status": "analyzing", "ai": deepcopy(ai), "progress": 30, "stage": "AI选择可爱画面",
          "message": "仅一次视觉请求，包含全部拼图、目标时长与完整Prompt；失败不会自动重试"})
    try:
        with timings.measure("ai_request"):
            ai_started = time.monotonic()
            try:
                response = vision.call_vision(prompts, sampling["sheets"], job_dir, config)
            finally:
                ai_elapsed = round(time.monotonic() - ai_started, 3)
    except vision.VisionError as exc:
        raw = vision.redact(exc.raw_text, key)
        if raw:
            (job_dir / "ai-raw-response.txt").write_text(raw, encoding="utf-8")
            ai["raw_response"] = raw
        ai["elapsed_seconds"] = ai_elapsed
        emit({"ai": deepcopy(ai)})
        raise
    with timings.measure("selection"):
        # Save raw output BEFORE parsing so malformed JSON remains debuggable.
        ai.update(raw_response=response["text"], usage=response.get("usage", {}), elapsed_seconds=ai_elapsed)
        (job_dir / "ai-raw-response.txt").write_text(response["text"], encoding="utf-8")
        media.write_json(job_dir / "ai-response-envelope.json", response["envelope"])
        emit({"ai": deepcopy(ai), "progress": 48, "stage": "验证选帧与时间轴", "message": "核对帧ID、源区间、去重和模型批准的上下文；不再看图"})
        media.check_cancelled(cancelled)
        parsed = vision.parse_model_json(response["text"])
        ai["parsed"] = parsed
        media.write_json(job_dir / "ai-selection-original.json", parsed)
        emit({"ai": deepcopy(ai)})
        if revision is not None:
            from .feedback import build_comparison
            comparison = build_comparison(revision["parent_job_id"], revision.get("previous_selected_frames", []), parsed, feedback_snapshot)
            media.write_json(job_dir / "comparison.json", comparison)
            emit({"comparison": comparison})
            disliked = {row["frame_id"] for row in feedback_snapshot["annotations"] if row["label"] == "dislike"}
            bad_refs = {ident for kind in ("highlight_clips", "memes")
                        for clip in (parsed.get(kind) if isinstance(parsed.get(kind), list) else []) if isinstance(clip, dict)
                        for ident in (clip.get("frame_ids") if isinstance(clip.get("frame_ids"), list) else [])
                        if isinstance(ident, str) and ident in disliked}
            violations = set(comparison["disliked_selected_ids"]) | bad_refs
            if violations:
                raise selection.SelectionError("AI仍选中或引用了人工标为不想要的帧：" + "、".join(sorted(violations)) +
                                               "；已保留原返回与对比，不会偷偷删改决定或自动重试")
        choices = validate_decisions(parsed, sampling["frames"], info["duration"], options)
        if options.get("story_enabled") is True:
            media.write_json(job_dir / "story-decision.json", choices["story"])
        if comparison is not None:
            for ident in comparison["liked_omitted_ids"]:
                if not any(ident in warning for warning in choices["warnings"]):
                    choices["warnings"].append(f"人工喜欢帧{ident}本轮未选，模型未提供该帧的具体漏选原因；未擅自塞入成片")
    return render_choices(job_dir, source_path, options, info, sampling, original_hash, choices,
                          source, prompts, ai, emit, cancelled, timings, revision=revision,
                          feedback_snapshot=feedback_snapshot, comparison=comparison)


def render_choices(job_dir: Path, source_path: Path, options: dict, info: dict, sampling: dict,
                   original_hash: str, choices: dict, source: dict, prompts: dict, ai: dict,
                   emit, cancelled, timings, *, revision=None, feedback_snapshot=None,
                   comparison=None, recovery=None) -> dict:
    """Render validated decisions without provider access or input resampling.

    The caller owns timing finalization and terminal publication. Recovery must
    explicitly separate inherited request evidence from this run's zero calls.
    """
    expected_calls = 0 if recovery is not None else 1
    if (type(ai.get("call_count")) is not int or ai["call_count"] != expected_calls or
            recovery is not None and (recovery.get("no_ai_calls") is not True or
                                      ai.get("reused_response_from_job") != recovery.get("source_job_id"))):
        raise ValueError("渲染任务的 AI 调用计数或复用来源不一致")
    if options.get("story_enabled") is True:
        from .daily_outputs import render_dual_outputs
        return render_dual_outputs(
            job_dir, source_path, options, info, sampling, original_hash, choices, source, prompts, ai,
            emit, cancelled, timings, eating_renderer=render_choices, revision=revision,
            feedback_snapshot=feedback_snapshot, comparison=comparison, recovery=recovery)
    with timings.measure("annotate_sheets"):
        media.annotate_sheets(job_dir, sampling, choices["validated"]["selected_frames"], choices["memes"])
        media.write_json(job_dir / "sampling.json", sampling)
    emit({"sampling": sampling, "progress": 55, "stage": "已圈出AI选帧", "message": "红圈是AI选中的采样帧，黄色MEME标记是表情包引用；原始拼图不改动"})
    with timings.measure("selection"):
        media.check_cancelled(cancelled)
        if not choices["clips"]:
            raise selection.SelectionError("AI没有选出可用于精选的视频片段；选帧、原图、Prompt和原始返回已保留")
        clips = media.quantize_clips(choices["clips"], info)
        _retain_quantized_evidence(clips, sampling["frames"], choices["adjustments"])
        for clip in clips:
            if abs(clip["requested_start"] - clip["start"]) > 1e-7 or abs(clip["requested_end"] - clip["end"]) > 1e-7:
                choices["adjustments"].append({"type": "source_frame_quantization", "clip_id": clip["id"],
                                                "before": [clip["requested_start"], clip["requested_end"]],
                                                "after": [clip["start"], clip["end"]], "reason": "剪点落到真实源帧PTS，保持原速"})
        duration = sum(c["duration"] for c in clips)
        if duration > float(options["max_duration"]) + 0.0001:
            raise selection.SelectionError("真实帧边界量化后超出时长上限，已停止；请稍微放宽上限后重新生成")
        if duration < float(options["min_duration"]) - 0.001 and not any("低于要求" in w for w in choices["warnings"]):
            choices["warnings"].append(f"按真实帧边界剪辑后只有{duration:.2f}秒，低于要求下限；未用无关片段凑长")
        timeline = {"source_sha256": original_hash, "speed": 1, "target": options["target_duration"],
                    "minimum": options["min_duration"], "maximum": options["max_duration"], "duration": duration,
                    "clips": clips, "memes": choices["memes"], "adjustments": choices["adjustments"], "warnings": choices["warnings"]}
        media.write_json(job_dir / "edit-timeline.json", timeline)
    emit({"status": "rendering", "progress": 60, "stage": "自动剪辑精选", "message": f"渲染{len(clips)}段，共{duration:.2f}秒；保留原速、原画幅和原声，不加BGM"})
    output_rel = Path("highlights.mp4")
    with timings.measure("render_highlight"):
        validation = media.render_video(
            source_path, job_dir / output_rel, clips, info, cancelled,
            on_step=lambda ident, label, seconds, status: timings.record_detail(
                "render_highlight", ident, label, seconds, status))
    memes = []
    if choices["memes"]:
        with timings.measure("export_memes"):
            for index, meme in enumerate(choices["memes"]):
                emit({"progress": 75 + round(15 * index / max(1, len(choices["memes"]))), "stage": "生成独立表情包",
                      "message": f"正在导出表情包{index + 1}/{len(choices['memes'])}，GIF仅独立循环，不重播到精选里"})
                media.check_cancelled(cancelled)
                quantized_meme = media.quantize_clips([meme], info)
                _retain_quantized_evidence(quantized_meme, sampling["frames"], choices["adjustments"])
                actual_refs = quantized_meme[0]["frame_ids"]
                memes.append(media.render_meme(
                    source_path, job_dir, {**meme, "frame_ids": actual_refs}, info, cancelled,
                    on_step=lambda ident, label, seconds, status, number=index + 1: timings.record_detail(
                        "export_memes", f"meme_{number}.{ident}", f"表情包{number} · {label}", seconds, status)))
    with timings.measure("final_validation"):
        unchanged = media.sha256(source_path) == original_hash
        if not unchanged:
            raise RuntimeError("源视频完整性校验未通过")
        validation.update(source_unchanged=True, visual_api_call_count=expected_calls, total_sampled_frames=sampling["frame_count"],
                          sheets_sent_in_one_request=sampling["sheet_count"] if expected_calls else 0, requested_target=options["target_duration"],
                          requested_minimum=options["min_duration"], requested_maximum=options["max_duration"],
                          achieved_source_timeline_duration=duration,
                          duration_in_requested_range=float(options["min_duration"]) - .001 <= duration <= float(options["max_duration"]) + .001)
        if recovery is not None:
            validation.update(reused_ai_result=True, source_job_id=recovery["source_job_id"],
                              source_ai_call_count=recovery["source_ai_call_count"],
                              source_sheet_count=sampling["sheet_count"])
        used = {f for c in clips for f in c["frame_ids"]}
        meme_used = {f for m in memes for f in m["frame_ids"]}
        selected_frames = [{**f, "title": " / ".join(f.get("labels", [])), "used_in_highlight": f["id"] in used,
                            "used_in_meme": f["id"] in meme_used} for f in sampling["frames"] if f.get("selected")]
        result = {"video_url": media.artifact_url(job_dir, output_rel), "video_duration": duration,
                  "container_duration": validation["actual_container_duration_seconds"], "summary": choices["validated"]["summary"],
                  "clips": clips, "memes": memes, "selected_frames": selected_frames,
                  "adjustments": choices["adjustments"], "warnings": choices["warnings"], "validation": validation}
        if revision is not None:
            result.update(feedback=feedback_snapshot, comparison=comparison)
        if recovery is not None:
            result["recovery"] = deepcopy(recovery)
        media.write_json(job_dir / "technical-validation.json", validation)
        media.write_json(job_dir / "result.json", result)
        request_note = "复用已有 AI 结果，本次未调用 AI" if recovery is not None else "本次视觉请求1次"
        fields = {"status": "completed", "progress": 100, "stage": "完成", "message": f"精选{duration:.2f}秒，{len(memes)}个独立表情包；{request_note}",
                  "source": source, "sampling": sampling, "prompt": prompts, "ai": ai, "result": result}
        if revision is not None:
            fields.update(feedback=feedback_snapshot, comparison=comparison)
        if recovery is not None:
            fields["recovery"] = deepcopy(recovery)
    return fields
