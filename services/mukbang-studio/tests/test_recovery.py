"""Offline saved-decision recovery: no credentials, provider call or re-sampling."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from mukbang import media, recovery, vision


SOURCE_ID = "1a2b3c4d5e6f"
RECOVERY_ID = "abcdef000001"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def hashes(directory):
    return {p.relative_to(directory).as_posix(): media.sha256(p)
            for p in directory.rglob("*") if p.is_file()}


@pytest.fixture(scope="module")
def synthetic_failure(tmp_path_factory):
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg not installed")
    data = tmp_path_factory.mktemp("saved-render-failure")
    directory = data / "jobs" / SOURCE_ID
    directory.mkdir(parents=True)
    source = directory / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
               "testsrc2=size=128x96:rate=10:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
    metadata = media.probe(source)
    info = media.video_info(metadata, media.frame_times(source))
    media.write_json(directory / "source-metadata.json", metadata)
    media.write_json(directory / "source-pts.json", {name: info[name] for name in
                     ("time_base", "origin_pts", "end_pts", "pts")})
    sampling = media.sample_video(source, directory, info, 1)
    media.write_json(directory / "sampling.json", sampling)
    media.write_input_cache_integrity(directory, source, sampling, media.sha256(source))
    parsed = {"summary": "合成缓存恢复测试，不是真实猫咪识别", "selected_frames": [
        {"frame_id": "F0002", "score": 90, "reason": "test evidence", "labels": ["test"]},
        {"frame_id": "F0005", "score": 85, "reason": "test evidence", "labels": ["test"]}],
        "highlight_clips": [
            {"id": "c01", "start": 1, "end": 3, "context_start": 1, "context_end": 3,
             "title": "fixture one", "reason": "test", "score": 90, "frame_ids": ["F0002"]},
            {"id": "c02", "start": 4, "end": 5, "context_start": 4, "context_end": 5,
             "title": "fixture two", "reason": "test", "score": 85, "frame_ids": ["F0005"]}],
        "memes": [{"id": "m01", "start": 1, "end": 2, "title": "fixture meme", "reason": "test",
                   "score": 90, "frame_ids": ["F0002"]}], "warnings": []}
    options = {"target_duration": 3, "min_duration": 2, "max_duration": 4,
               "sample_interval": 1, "prompt": "保存的原始通用标准"}
    prompts = {"system": "saved fixture system", "user": "saved fixture user"}
    config = {"model": "gpt-6.1-sol", "api_style": "responses", "base_url": "https://saved.invalid/v1"}
    manifest = vision.request_manifest(prompts, sampling["sheets"], config)
    raw = json.dumps(parsed, ensure_ascii=False)
    usage = {"input_tokens": 123, "output_tokens": 45, "total_tokens": 168}
    envelope = {"status": "completed", "model": config["model"], "instructions": prompts["system"],
                "output_text": raw, "usage": usage, "error": None, "incomplete_details": None}
    ai = {"model": config["model"], "provider": config["base_url"], "api_style": config["api_style"],
          "call_count": 1, "raw_response": raw, "parsed": parsed, "usage": usage,
          "elapsed_seconds": 192.39, "request_manifest": manifest}
    standard = {"id": "P0001", "name": "历史标准", "text": options["prompt"]}
    record = {"id": SOURCE_ID, "filename": "fixture.mp4", "status": "failed", "stage": "生成未完成",
              "progress": 60, "error": "输出视频编码或像素格式不符", "options": options, "ai": ai,
              "created_at": "2026-10-22T23:58:09+08:00", "prompt": prompts, "sampling": sampling,
              "timings": {"failed_stage": "render_highlight"}, "prompt_standard": standard}
    for name, value in (("job.json", record), ("prompt.json", prompts), ("request-manifest.json", manifest),
                        ("ai-selection-original.json", parsed), ("ai-response-envelope.json", envelope)):
        media.write_json(directory / name, value)
    (directory / "ai-raw-response.txt").write_text(raw, encoding="utf-8")
    (data / "prompt-proposals").mkdir()
    return data


@pytest.fixture
def saved_failure(tmp_path, synthetic_failure, monkeypatch):
    data = tmp_path / "data"
    shutil.copytree(synthetic_failure, data)
    monkeypatch.setattr(recovery, "_service_running", lambda port: False)
    def forbidden(*args, **kwargs):
        pytest.fail("Recovery must not call a provider, build a request or re-sample inputs")
    monkeypatch.setattr(vision, "call_vision", forbidden)
    monkeypatch.setattr(vision, "make_payload", forbidden)
    monkeypatch.setattr(vision, "build_prompts", forbidden)
    monkeypatch.setattr(vision.httpx.Client, "send", forbidden)
    monkeypatch.setattr(media, "sample_video", forbidden)
    monkeypatch.setattr(media, "create_sheets", forbidden)
    return data


def test_complete_recovery_keeps_original_and_reports_zero_new_ai(saved_failure):
    original = saved_failure / "jobs" / SOURCE_ID
    before = hashes(original)
    updates = []
    record = recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID, emit=updates.append)
    directory = saved_failure / "jobs" / RECOVERY_ID
    assert record["status"] == "completed"
    assert record["id"] == RECOVERY_ID
    assert record["ai"]["call_count"] == 0
    assert record["ai"]["reused_response_from_job"] == SOURCE_ID
    assert "usage" not in record["ai"] and "elapsed_seconds" not in record["ai"]
    assert record["recovery"]["source_ai_call_count"] == 1
    assert record["recovery"]["source_ai_usage"]["total_tokens"] == 168
    assert record["recovery"]["source_response_sha256"] == media.sha256(original / "ai-raw-response.txt")
    assert record["recovery"]["no_ai_calls"] is True
    assert record["prompt_standard"] == load(original / "job.json")["prompt_standard"]
    assert record["prompt"] == load(original / "prompt.json")
    assert load(directory / "request-manifest.json") == load(original / "request-manifest.json")
    assert (directory / "ai-raw-response.txt").read_bytes() == (original / "ai-raw-response.txt").read_bytes()
    assert record["result"]["video_duration"] == 3
    assert record["result"]["validation"]["visual_api_call_count"] == 0
    assert record["result"]["validation"]["sheets_sent_in_one_request"] == 0
    assert len(record["result"]["memes"]) == 1
    assert (directory / "highlights.mp4").stat().st_size > 0
    assert hashes(original) == before
    timing = record["timings"]
    assert timing["scope"] == "render_recovery" and timing["status"] == "completed"
    assert next(row for row in timing["stages"] if row["id"] == "ai_request")["status"] == "skipped"
    assert next(row for row in timing["stages"] if row["id"] == "extract_frames")["status"] == "skipped"
    assert all(update["timings"]["status"] == "completed" for update in updates if update["status"] == "completed")
    assert load(directory / "job.json") == record


def test_cli_is_directly_runnable_from_project_root_without_starting_service():
    result = subprocess.run([sys.executable, "scripts/recover_render.py", "--help"],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True,
                            text=True, encoding="utf-8", errors="replace", timeout=30)
    assert result.returncode == 0, result.stderr
    assert "source_job_id" in result.stdout and "--data-dir" in result.stdout


@pytest.mark.parametrize("artifact,key,value", [
    ("job.json", "ai.parsed.summary", "altered decision"),
    ("job.json", "ai.raw_response", "{}"),
    ("job.json", "ai.call_count", 0),
    ("job.json", "timings.failed_stage", "ai_request"),
    ("job.json", "status", "completed"),
    ("job.json", "iteration", {"parent_job_id": "111111111111"}),
    ("job.json", "feedback", {"version": 1, "annotations": []}),
    ("job.json", "prompt.user", "changed prompt"),
    ("prompt.json", "system", "changed prompt"),
    ("ai-selection-original.json", "summary", "altered decision"),
    ("ai-response-envelope.json", "status", "incomplete"),
    ("ai-response-envelope.json", "output_text", "{}"),
    ("ai-response-envelope.json", "usage.total_tokens", 999),
    ("request-manifest.json", "image_count", 99),
])
def test_corrupt_saved_evidence_is_rejected_before_creating_job(saved_failure, artifact, key, value):
    path = saved_failure / "jobs" / SOURCE_ID / artifact
    data = load(path)
    holder = data
    parts = key.split(".")
    for part in parts[:-1]:
        holder = holder[part]
    holder[parts[-1]] = value
    media.write_json(path, data)
    before = hashes(path.parent)
    with pytest.raises(ValueError):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert not (saved_failure / "jobs" / RECOVERY_ID).exists()
    assert hashes(path.parent) == before


@pytest.mark.parametrize("name", ["ai-raw-response.txt", "ai-response-envelope.json", "prompt.json", "request-manifest.json"])
def test_missing_evidence_cannot_trigger_ai_fallback(saved_failure, name):
    (saved_failure / "jobs" / SOURCE_ID / name).unlink()
    with pytest.raises(ValueError):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert not (saved_failure / "jobs" / RECOVERY_ID).exists()


def test_running_service_blocks_all_writes(saved_failure, monkeypatch):
    monkeypatch.setattr(recovery, "_service_running", lambda port: True)
    before = hashes(saved_failure)
    with pytest.raises(ValueError, match="服务"):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert hashes(saved_failure) == before


@pytest.mark.parametrize("kind", ["job", "proposal"])
def test_nonterminal_work_blocks_recovery(saved_failure, kind):
    if kind == "job":
        path = saved_failure / "jobs" / "111111111111" / "job.json"
        path.parent.mkdir()
    else:
        path = saved_failure / "prompt-proposals" / "111111111111.json"
    media.write_json(path, {"id": "111111111111", "status": "running"})
    before = hashes(saved_failure)
    with pytest.raises(ValueError):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert hashes(saved_failure) == before


@pytest.mark.parametrize("source_id,destination_id", [("../escape", RECOVERY_ID), (SOURCE_ID, "../escape"),
                                                       (SOURCE_ID, SOURCE_ID), (SOURCE_ID, "not-a-job-id")])
def test_unsafe_or_reused_destination_is_rejected(saved_failure, source_id, destination_id):
    before = hashes(saved_failure)
    with pytest.raises(ValueError):
        recovery.recover_render(saved_failure, source_id, job_id=destination_id)
    assert hashes(saved_failure) == before


def test_cached_input_corruption_is_inspectable_and_never_resampled(saved_failure):
    original = saved_failure / "jobs" / SOURCE_ID
    sample = original / "samples" / "frame-00001.jpg"
    sample.write_bytes(sample.read_bytes() + b"corrupt fixture")
    before = hashes(original)
    with pytest.raises(ValueError, match="摘要"):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    record = load(saved_failure / "jobs" / RECOVERY_ID / "job.json")
    assert record["status"] == "failed" and record["ai"]["call_count"] == 0
    assert record["timings"]["failed_stage"] == "reuse_inputs"
    assert hashes(original) == before


def test_renderer_failure_is_saved_after_timings_finish(saved_failure, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("synthetic encoder failure")
    monkeypatch.setattr(media, "render_video", fail)
    original = saved_failure / "jobs" / SOURCE_ID
    before = hashes(original)
    with pytest.raises(RuntimeError, match="synthetic encoder"):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    record = load(saved_failure / "jobs" / RECOVERY_ID / "job.json")
    assert record["status"] == record["timings"]["status"] == "failed"
    assert record["timings"]["failed_stage"] == "render_highlight"
    assert record["ai"]["call_count"] == 0
    assert hashes(original) == before


def test_malformed_raw_cannot_trigger_ai_fallback(saved_failure):
    path = saved_failure / "jobs" / SOURCE_ID / "ai-raw-response.txt"
    path.write_text("not JSON", encoding="utf-8")
    with pytest.raises(ValueError, match="有效"):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert not (saved_failure / "jobs" / RECOVERY_ID).exists()


def test_local_service_guard_treats_only_connection_refusal_as_stopped(monkeypatch):
    def refused(*args, **kwargs):
        raise ConnectionRefusedError()
    monkeypatch.setattr(recovery.socket, "create_connection", refused)
    assert recovery._service_running(8876) is False
    def uncertain(*args, **kwargs):
        raise TimeoutError()
    monkeypatch.setattr(recovery.socket, "create_connection", uncertain)
    with pytest.raises(ValueError, match="确认"):
        recovery._service_running(8876)


def test_closed_local_port_can_be_confirmed_on_windows():
    # Windows can take roughly two seconds to deliver WSAECONNREFUSED even
    # for loopback. A half-second timeout misidentifies this as uncertainty.
    with recovery.socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        unused_port = listener.getsockname()[1]
    assert recovery._service_running(unused_port) is False
