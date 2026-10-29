import json
import shutil
from copy import deepcopy

import pytest

from mukbang import media, pipeline, vision
from mukbang.selection import SelectionError
from mukbang.timing import JobTimings


def timing_row(snapshot, stage_id):
    return next(row for row in snapshot["stages"] if row["id"] == stage_id)


@pytest.fixture
def instrumented_pipeline(tmp_path, monkeypatch):
    """Deterministic phase costs; every provider/media replacement is test-only."""
    class Clock:
        value = 0.0
        def __call__(self):
            return self.value
        def advance(self, seconds):
            self.value += seconds
    clock = Clock()
    monkeypatch.setattr(pipeline.time, "monotonic", clock)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"offline phase instrumentation fixture")
    frames = [{"id": f"F{i + 1:04d}", "time": float(i), "sheet_id": "S01", "row": i // 6 + 1,
               "col": i % 6 + 1, "source_frame_index": i * 10, "url": f"/fixture/{i}.jpg", "path": f"{i}.jpg"} for i in range(12)]
    sampling = {"interval": 1, "frame_count": 12, "sheet_count": 1, "frames_per_sheet": 60, "frames": frames,
                "sheets": [{"id": "S01", "path": "sheet.jpg", "width": 10, "height": 10, "sha256": "fixture", "frames": frames}]}
    info = {"duration": 12., "width": 128, "height": 192, "fps": 10., "audio_sample_rate": 8000,
            "audio_channels": 2, "time_base": "1/10", "origin_pts": 0, "end_pts": 120, "pts": list(range(120))}
    state = {"clock": clock, "source": source, "cancel_sampling": False, "ai_fails": False, "calls": 0}
    def probe(*args, **kwargs):
        clock.advance(3)
        return {"streams": [{"codec_type": "video", "duration": "12"}]}
    def pts(*args, **kwargs):
        clock.advance(2)
        return []
    def digest(*args):
        clock.advance(1)
        return "fixture-sha256"
    def samples(*args, timings=None, **kwargs):
        with timings.measure("extract_frames"):
            clock.advance(7)
            if state["cancel_sampling"]:
                raise media.Cancelled("fixture cancellation")
        with timings.measure("build_sheets"):
            clock.advance(2)
        return sampling
    monkeypatch.setattr(media, "probe", probe)
    monkeypatch.setattr(media, "frame_times", pts)
    monkeypatch.setattr(media, "video_info", lambda *args: info)
    monkeypatch.setattr(media, "sha256", digest)
    monkeypatch.setattr(media, "sample_video", samples)
    # This phase-only fixture intentionally has no cached JPEG artifacts.
    monkeypatch.setattr(media, "write_input_cache_integrity", lambda *args: None)
    original_prompts = vision.build_prompts
    def prompts(*args):
        clock.advance(1)
        return original_prompts(*args)
    monkeypatch.setattr(vision, "build_prompts", prompts)
    model_result = {"summary": "offline timing fixture", "selected_frames": [
        {"frame_id": "F0003", "score": 90, "reason": "fixture", "labels": ["test"]},
        {"frame_id": "F0009", "score": 85, "reason": "fixture", "labels": ["test"]}],
        "highlight_clips": [
            {"id": "c01", "start": 1., "end": 4., "context_start": 0., "context_end": 5., "title": "test1", "reason": "fixture", "score": 90, "frame_ids": ["F0003"]},
            {"id": "c02", "start": 7., "end": 10., "context_start": 6., "context_end": 12., "title": "test2", "reason": "fixture", "score": 85, "frame_ids": ["F0009"]}],
        "memes": [{"id": "m01", "start": 1.5, "end": 3., "title": "test-meme", "reason": "fixture", "score": 90, "frame_ids": ["F0003"]}], "warnings": []}
    def ai(*args):
        state["calls"] += 1
        clock.advance(11)
        if state["ai_fails"]:
            raise vision.VisionError("offline timing failure", "fixture raw response")
        return {"text": json.dumps(model_result), "envelope": {"fixture": True}, "elapsed_seconds": .25, "usage": {}}
    monkeypatch.setattr(vision, "call_vision", ai)
    original_selection = pipeline.selection.validate_and_adjust
    def choose(*args, **kwargs):
        clock.advance(3)
        return original_selection(*args, **kwargs)
    monkeypatch.setattr(pipeline.selection, "validate_and_adjust", choose)
    def annotate(job_dir, sampling, selected, memes):
        clock.advance(4)
        chosen = {row["frame_id"]: row for row in selected}
        for frame in sampling["frames"]:
            frame["selected"] = frame["id"] in chosen
            if frame["selected"]:
                frame.update(chosen[frame["id"]])
    monkeypatch.setattr(media, "annotate_sheets", annotate)
    original_quantize = media.quantize_clips
    def quantize(*args):
        clock.advance(.5)
        return original_quantize(*args)
    monkeypatch.setattr(media, "quantize_clips", quantize)
    def highlight(*args, on_step=None):
        clock.advance(5)
        if on_step:
            on_step("encode", "视频编码", 3., "completed")
            on_step("scan", "逐帧检查", 2., "completed")
        return {"actual_container_duration_seconds": 8}
    def meme(source, job_dir, clip, *args, on_step=None):
        clock.advance(2)
        if on_step:
            on_step("encode", "MP4与GIF联合编码", 1.5, "completed")
            on_step("scan", "逐帧检查", .5, "completed")
        return {**clip, "gif_url": "/fixture.gif", "video_url": "/fixture.mp4"}
    monkeypatch.setattr(media, "render_video", highlight)
    monkeypatch.setattr(media, "render_meme", meme)
    state["options"] = {"target_duration": 8, "min_duration": 7, "max_duration": 9, "sample_interval": 1, "prompt": "offline fixture"}
    state["config"] = {"model": "test-only", "api_style": "responses", "base_url": "https://example.com/v1", "api_key": ""}
    state.update(info=info, sampling=sampling, parsed=model_result)
    return state


def test_all_success_phases_are_separate_and_completion_has_final_timings(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    result = pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], updates.append, lambda: False)
    timings = result["timings"]
    expected = {"source_probe": 6, "extract_frames": 7, "build_sheets": 2, "prepare_request": 1,
                "ai_request": 11, "selection": 3.5, "annotate_sheets": 4,
                "render_highlight": 5, "export_memes": 2.5, "final_validation": 1}
    for stage, seconds in expected.items():
        assert timing_row(timings, stage)["status"] == "completed"
        assert timing_row(timings, stage)["seconds"] == seconds
    assert timings["status"] == "completed" and state["calls"] == 1
    assert result["result"]["validation"]["visual_api_call_count"] == 1
    assert result["result"]["validation"]["sheets_sent_in_one_request"] == 1
    assert "recovery" not in result
    assert result["ai"]["elapsed_seconds"] == 11  # call_vision outer scope, not the .25s network-only fixture
    assert timings["scope"] == "pipeline_execution"
    assert "不包含 HTTP" in timings["note"]
    assert sum(row["seconds"] or 0 for row in timings["stages"]) == timings["total_seconds"]
    assert updates[-1]["status"] == "completed" and updates[-1]["timings"]["status"] == "completed"
    assert json.loads((tmp_path / "timings.json").read_text(encoding="utf-8")) == timings
    assert timing_row(timings, "source_probe")["details"] == [
        {"id": "metadata", "label": "读取源片元信息", "seconds": 3, "status": "completed", "percent": 50.0},
        {"id": "frame_index", "label": "解码源片建立帧时间戳", "seconds": 2, "status": "completed", "percent": 33.33},
        {"id": "source_digest", "label": "源片完整性摘要", "seconds": 1, "status": "completed", "percent": 16.67}]
    assert [detail["seconds"] for detail in timing_row(timings, "render_highlight")["details"]] == [3, 2]
    assert [detail["id"] for detail in timing_row(timings, "export_memes")["details"]] == ["meme_1.encode", "meme_1.scan"]
    assert timing_row(timings, "export_memes")["details"][0]["label"] == "表情包1 · MP4与GIF联合编码"


def test_redundant_outside_references_are_audited_without_changing_raw_or_recalling_ai(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    state["parsed"]["highlight_clips"][0]["frame_ids"].append("F0009")
    state["parsed"]["memes"][0]["frame_ids"].append("F0009")
    original = deepcopy(state["parsed"])
    result = pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], updates.append, lambda: False)
    assert result["status"] == "completed"
    assert state["calls"] == result["ai"]["call_count"] == 1
    assert result["result"]["validation"]["visual_api_call_count"] == 1
    assert state["parsed"] == result["ai"]["parsed"] == original
    assert json.loads(result["ai"]["raw_response"]) == original
    assert json.loads((tmp_path / "ai-raw-response.txt").read_text(encoding="utf-8")) == original
    assert json.loads((tmp_path / "ai-selection-original.json").read_text(encoding="utf-8")) == original
    assert result["result"]["clips"][0]["frame_ids"] == ["F0003"]
    assert result["result"]["clips"][1]["frame_ids"] == ["F0009"]
    assert result["result"]["memes"][0]["frame_ids"] == ["F0003"]
    assert {row["id"] for row in result["result"]["selected_frames"]} == {"F0003", "F0009"}
    for ident, collection, interval in (("c01", "highlight_clips", [0.0, 5.0]),
                                       ("m01", "memes", [1.5, 3.0])):
        audit = next(row for row in result["result"]["adjustments"] if row.get("clip_id") == ident
                     and row.get("before") == ["F0003", "F0009"] and row.get("after") == ["F0003"])
        assert audit["type"] == "drop_out_of_interval_references"
        assert audit["collection"] == collection
        assert audit["interval"] == interval
        assert audit["removed"] == [{"frame_id": "F0009", "time": 8.0}]
        assert any(ident in warning and "F0009" in warning for warning in result["result"]["warnings"])
    saved = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert saved["adjustments"] == result["result"]["adjustments"]
    assert saved["warnings"] == result["result"]["warnings"]
    assert updates[-1]["status"] == "completed"


@pytest.mark.parametrize("invalid_ref", ["F0012", "F9999"])
def test_outside_reference_cannot_hide_unknown_or_not_selected_evidence(tmp_path, instrumented_pipeline, invalid_ref):
    state = instrumented_pipeline
    state["parsed"]["highlight_clips"][0]["frame_ids"].append(invalid_ref)
    original = deepcopy(state["parsed"])
    with pytest.raises(SelectionError, match="不存在或没有被AI选中"):
        pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], lambda row: None, lambda: False)
    assert state["calls"] == 1 and state["parsed"] == original
    assert json.loads((tmp_path / "ai-selection-original.json").read_text(encoding="utf-8")) == original
    assert not (tmp_path / "result.json").exists()


def test_shared_renderer_reports_zero_new_ai_calls_for_recovery(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    choices = pipeline.selection.validate_and_adjust(state["parsed"], state["sampling"]["frames"], 12., state["options"])
    timings = JobTimings(clock=state["clock"], scope="render_recovery")
    recovery = {"source_job_id": "abcdef123456", "source_ai_call_count": 1, "no_ai_calls": True}
    result = pipeline.render_choices(
        tmp_path, state["source"], state["options"], state["info"], state["sampling"], "fixture-sha256",
        choices, {}, {"system": "saved", "user": "saved"},
        {"call_count": 0, "reused_response_from_job": recovery["source_job_id"]},
        updates.append, lambda: False, timings, recovery=recovery)
    validation = result["result"]["validation"]
    assert state["calls"] == 0
    assert result["ai"]["call_count"] == validation["visual_api_call_count"] == 0
    assert validation["sheets_sent_in_one_request"] == 0
    assert validation["source_sheet_count"] == 1
    assert result["recovery"] == recovery
    assert "复用" in result["message"] and "未调用 AI" in result["message"]
    assert all(update.get("status") != "completed" for update in updates)
    assert timings.snapshot()["status"] == "running"
    assert timing_row(timings.snapshot(), "ai_request")["seconds"] is None


@pytest.mark.parametrize("ai,recovery", [
    ({"call_count": 0}, None),
    ({"call_count": True}, None),
    ({"call_count": 1}, {"no_ai_calls": True, "source_job_id": "abcdef123456"}),
    ({"call_count": 0, "reused_response_from_job": "bad"}, {"no_ai_calls": True, "source_job_id": "abcdef123456"}),
    ({"call_count": 0, "reused_response_from_job": "abcdef123456"}, {"no_ai_calls": False, "source_job_id": "abcdef123456"}),
])
def test_shared_renderer_rejects_inconsistent_call_provenance(tmp_path, instrumented_pipeline, ai, recovery):
    state = instrumented_pipeline
    with pytest.raises(ValueError, match="计数或复用来源不一致"):
        pipeline.render_choices(tmp_path, state["source"], {}, {}, {}, "", {}, {}, {}, ai,
                                lambda update: pytest.fail("invalid provenance must fail before publishing"),
                                lambda: False, JobTimings(), recovery=recovery)
    assert state["calls"] == 0


def test_ai_failure_elapsed_excludes_probe_and_sampling(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    state["ai_fails"] = True
    with pytest.raises(vision.VisionError):
        pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], updates.append, lambda: False)
    timings = updates[-1]["timings"]
    assert timings["status"] == "failed"
    assert timings["failed_stage"] == "ai_request"
    assert timing_row(timings, "ai_request")["seconds"] == 11
    assert next(u["ai"] for u in reversed(updates) if "ai" in u)["elapsed_seconds"] == 11
    assert timings["total_seconds"] > 11
    assert timing_row(timings, "render_highlight")["seconds"] is None
    assert state["calls"] == 1


def test_sampling_cancellation_keeps_partial_timing_and_never_calls_ai(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    state["cancel_sampling"] = True
    with pytest.raises(media.Cancelled):
        pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], updates.append, lambda: False)
    timings = updates[-1]["timings"]
    assert timings["status"] == "cancelled"
    assert timing_row(timings, "extract_frames")["status"] == "cancelled"
    assert timing_row(timings, "extract_frames")["seconds"] == 7
    assert timing_row(timings, "ai_request")["seconds"] is None
    assert state["calls"] == 0


def test_external_timings_are_not_finished_or_published_completed_early(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    timings = JobTimings(clock=state["clock"])
    result = pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], updates.append, lambda: False, timings)
    assert result["status"] == "completed" and "timings" not in result
    assert timings.snapshot()["status"] == "running"
    assert all(update.get("status") != "completed" for update in updates)
    assert not (tmp_path / "timings.json").exists()
    assert timing_row(timings.snapshot(), "final_validation")["status"] == "completed"


def test_early_cancellation_also_persists_timings(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    with pytest.raises(media.Cancelled):
        pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], updates.append, lambda: True)
    value = updates[-1]["timings"]
    assert value["status"] == "cancelled"
    assert timing_row(value, "source_probe")["status"] == "cancelled"
    assert timing_row(value, "source_probe")["seconds"] == 0
    assert timing_row(value, "extract_frames")["seconds"] is None
    assert state["calls"] == 0
    assert (tmp_path / "timings.json").is_file()


def test_quantized_evidence_cannot_disappear():
    with pytest.raises(SelectionError, match="没有保留"):
        pipeline._retain_quantized_evidence(
            [{"id": "c01", "frame_ids": ["F0001"], "source_first_frame_index": 11, "source_end_frame_index_exclusive": 20}],
            [{"id": "F0001", "source_frame_index": 10}], [])


def test_overlong_video_rejected_before_decoding_pts(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"fixture")
    monkeypatch.setattr(media, "probe", lambda *args: {"streams": [{"codec_type": "video", "duration": "36000"}]})
    monkeypatch.setattr(media, "frame_times", lambda *args: pytest.fail("overlong video must not be decoded"))
    with pytest.raises(ValueError, match="10分钟"):
        pipeline.run_pipeline(tmp_path, source, {}, {"model": "test", "base_url": "https://example.com/v1", "api_style": "responses"}, lambda u: None, lambda: False)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_failed_model_retains_inputs_and_counts_one_attempt(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=gray:size=128x192:rate=5:duration=2",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
    calls, updates = [], []
    def fail(*args):
        calls.append(1)
        raise vision.VisionError("fixture model failure", "test provider error")
    monkeypatch.setattr(vision, "call_vision", fail)
    options = {"target_duration": 40, "min_duration": 30, "max_duration": 50, "sample_interval": 1, "prompt": "请测试"}
    config = {"model": "test-only", "api_style": "chat_completions", "base_url": "https://example.com/v1", "api_key": "PRIVATE_FIXTURE_KEY"}
    with pytest.raises(vision.VisionError):
        pipeline.run_pipeline(tmp_path, source, options, config, lambda update: updates.append(json.loads(json.dumps(update))), lambda: False)
    assert len(calls) == 1
    assert any(u.get("ai", {}).get("call_count") == 1 for u in updates)
    assert any("sampling" in u and "prompt" in u for u in updates)
    assert (tmp_path / "ai-raw-response.txt").read_text() == "test provider error"
    assert "PRIVATE_FIXTURE_KEY" not in json.dumps(updates)
    assert "base64," not in (tmp_path / "request-manifest.json").read_text(encoding="utf-8")


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_malformed_json_is_not_faked_or_retried(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=gray:size=128x192:rate=5:duration=2",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
    calls = []
    def invalid(*args):
        calls.append(1)
        return {"text": "not valid JSON", "envelope": {"fixture": True}, "usage": {}, "elapsed_seconds": 0}
    monkeypatch.setattr(vision, "call_vision", invalid)
    with pytest.raises(vision.VisionError, match="严格JSON"):
        pipeline.run_pipeline(tmp_path, source,
            {"target_duration": 40, "min_duration": 30, "max_duration": 50, "sample_interval": 1, "prompt": "测试"},
            {"model": "test", "api_style": "responses", "base_url": "https://example.com/v1", "api_key": ""}, lambda u: None, lambda: False)
    assert len(calls) == 1
    assert (tmp_path / "ai-raw-response.txt").read_text() == "not valid JSON"
    assert not (tmp_path / "highlights.mp4").exists()


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_complete_synthetic_pipeline_no_live_provider(tmp_path, monkeypatch):
    """Fixture injection is confined to tests; this never opens a network socket."""
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=128x192:rate=10:duration=12",
               "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=12", "-ac", "2", "-c:a", "aac", "-b:a", "48k",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
    calls, updates = [], []
    model_result = {"summary": "合成测试，不是猫咪识别", "selected_frames": [
        {"frame_id": "F0003", "score": 90, "reason": "fixture only", "labels": ["test"]},
        {"frame_id": "F0009", "score": 85, "reason": "fixture only", "labels": ["test"]}],
        "highlight_clips": [
            {"id": "c01", "start": 1., "end": 4., "context_start": 0., "context_end": 5., "title": "test1", "reason": "fixture", "score": 90, "frame_ids": ["F0003"]},
            {"id": "c02", "start": 7., "end": 10., "context_start": 6., "context_end": 12., "title": "test2", "reason": "fixture", "score": 85, "frame_ids": ["F0009"]}],
        "memes": [{"id": "m01", "start": 1.5, "end": 3., "title": "test-meme", "reason": "fixture", "score": 90, "frame_ids": ["F0003"]}], "warnings": []}
    def fixture(prompts, sheets, job_dir, config):
        assert '"target_duration_seconds": 8' in prompts["user"]
        assert len(sheets) == 1
        calls.append(1)
        return {"text": json.dumps(model_result), "envelope": {"fixture": True}, "elapsed_seconds": .01, "usage": {}}
    monkeypatch.setattr(vision, "call_vision", fixture)
    result = pipeline.run_pipeline(tmp_path, source,
        {"target_duration": 8, "min_duration": 7, "max_duration": 9, "sample_interval": 1, "prompt": "合成测试"},
        {"model": "test-only", "api_style": "responses", "base_url": "https://example.com/v1", "api_key": ""},
        lambda u: updates.append(json.loads(json.dumps(u))), lambda: False)
    assert result["status"] == "completed"
    assert result["ai"]["call_count"] == len(calls) == 1
    assert result["result"]["video_duration"] == 8
    assert len(result["result"]["memes"]) == 1
    assert result["result"]["validation"]["duration_in_requested_range"]
    assert result["sampling"]["sheets"][0]["selected_count"] == 2
    assert (tmp_path / "highlights.mp4").is_file()
    assert all(a["progress"] <= b["progress"] for a, b in zip([u for u in updates if "progress" in u], [u for u in updates if "progress" in u][1:]))
