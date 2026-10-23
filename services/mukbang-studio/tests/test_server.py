import json
from pathlib import Path
from threading import Event

from fastapi.testclient import TestClient
import pytest

from mukbang import config
from mukbang.server import clean_public, create_app, safe_file


@pytest.fixture
def provider(tmp_path, monkeypatch):
    for name in ("MUKBANG_VISION_BASE_URL", "MUKBANG_VISION_MODEL", "MUKBANG_VISION_API_STYLE",
                 "MUKBANG_VISION_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY",
                 "MUKBANG_VISION_USE_CODEX_PROVIDER", "MUKBANG_CODEX_HOME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(config, "ROOT", tmp_path)
    return config.ProviderConfig()


def connect(provider):
    provider.update({"base_url": "https://vision.example/v1", "model": "fixture-vision",
                     "api_style": "chat_completions", "api_key": "TEST_PRIVATE_KEY_ONLY"})


@pytest.fixture
def app(tmp_path, provider):
    def unused(*_args):
        raise AssertionError("No network or live inference belongs in API tests")
    result = create_app(tmp_path / "data", provider, pipeline=unused)
    yield result
    result.state.manager.executor.shutdown(wait=True, cancel_futures=True)


def test_defaults_and_unconfigured_key_do_not_leak(app):
    with TestClient(app) as client:
        result = client.get("/api/config")
        assert result.status_code == 200
        value = result.json()
        assert not value["configured"]
        assert value["defaults"]["target_duration"] == 40
        assert value["defaults"]["min_duration"] == 30
        assert value["defaults"]["max_duration"] == 50
        assert value["defaults"]["frames_per_sheet"] == 60
        assert "api_key" not in value["provider"]
        response = client.post("/api/jobs", files={"file": ("cat.mp4", b"not-a-real-video")})
        assert response.status_code == 400 and "API Key" in response.json()["detail"]
        assert client.get("/api/jobs").json() == {"jobs": []}


def test_settings_write_only_and_invalid_key_not_echoed(app):
    with TestClient(app) as client:
        settings = {"base_url": "https://vision.example/v1", "model": "fixture-vision",
                    "api_style": "chat_completions", "api_key": "TEST_PRIVATE_KEY_ONLY"}
        response = client.put("/api/config", json=settings)
        assert response.status_code == 200 and response.json()["configured"]
        assert "TEST_PRIVATE_KEY_ONLY" not in response.text
        assert "TEST_PRIVATE_KEY_ONLY" not in client.get("/api/config").text
        settings["api_key"] = "TEST_PRIVATE_KEY_ONLY" * 200
        response = client.put("/api/config", json=settings)
        assert response.status_code == 422 and "TEST_PRIVATE_KEY_ONLY" not in response.text
        settings["api_key"] = "line\nbreak"
        response = client.put("/api/config", json=settings)
        assert response.status_code == 400 and "line" not in response.text


def test_key_stays_for_same_host_and_clears_for_changed_origin(provider):
    connect(provider)
    provider.update({"base_url": "https://vision.example/other"})
    assert provider.public()["configured"]
    provider.update({"base_url": "https://different.example/v1", "api_key": ""})
    assert not provider.public()["configured"]
    provider.update({"base_url": "http://127.0.0.1:12435/v1"})
    assert provider.public()["configured"] and not provider.public()["provider"]["key_configured"]


@pytest.mark.parametrize("url", ["http://remote.example/v1", "https://127.0.0.2/v1", "https://10.0.0.1/v1",
    "https://169.254.169.254/v1", "https://user:secret@vision.example/v1", "https://vision.example/v1?key=private",
    "https://vision.example/v1#private", "file:///secret", "https://vision.example/v1/responses"])
def test_unsafe_or_ambiguous_base_url_rejected(url):
    # 127.0.0.2 is an IP loopback too and is intentionally valid for configuration.
    if "127.0.0.2" in url:
        assert config.validate_base_url(url) == url
    else:
        with pytest.raises(ValueError):
            config.validate_base_url(url)


def test_dashscope_key_not_selected_for_lookalike_host(tmp_path, monkeypatch, provider):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "ALIYUN_PRIVATE_TEST_KEY")
    monkeypatch.setenv("MUKBANG_VISION_BASE_URL", "https://aliyuncs.com.attacker.example/v1")
    assert not config.ProviderConfig().public()["provider"]["key_configured"]


def test_cross_site_and_rebound_host_are_rejected(app):
    with TestClient(app) as client:
        assert client.post("/api/jobs", headers={"Origin": "https://other.example"}).status_code == 403
        assert client.post("/api/jobs", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
        assert client.get("/api/config", headers={"Host": "attacker.example"}).status_code == 400
        assert client.post("/api/jobs", headers={"Content-Length": str(600 * 1024 * 1024)}).status_code == 413
        assert client.get("/api/config").headers["X-Content-Type-Options"] == "nosniff"


@pytest.mark.parametrize("options", [
    {"target_duration": 20, "min_duration": 30, "max_duration": 50},
    {"target_duration": 40, "min_duration": 50, "max_duration": 30},
    {"target_duration": 121}, {"sample_interval": 0.1}, {"sample_interval": 4},
    {"target_duration": float("nan")}, {"unknown_parameter": "not allowed"},
])
def test_invalid_duration_options_never_start_jobs(app, provider, options):
    connect(provider)
    with TestClient(app) as client:
        response = client.post("/api/jobs", data={"options": json.dumps(options)}, files={"file": ("cat.mp4", b"x")})
        assert response.status_code == 400
        assert not client.get("/api/jobs").json()["jobs"]


def test_invalid_upload_type_and_empty_file(app, provider):
    connect(provider)
    with TestClient(app) as client:
        assert client.post("/api/jobs", files={"file": ("file.txt", b"text")}).status_code == 400
        assert client.post("/api/jobs", files={"file": ("cat.mp4", b"")}).status_code == 400
        assert client.get("/api/jobs").json()["jobs"][0]["status"] == "failed"
        failed_id = client.get("/api/jobs").json()["jobs"][0]["id"]
        timing = client.get(f"/api/jobs/{failed_id}").json()["timings"]
        assert timing["status"] == "failed"
        assert next(s for s in timing["stages"] if s["id"] == "upload")["status"] == "failed"
        assert next(s for s in timing["stages"] if s["id"] == "ai_request")["seconds"] is None


def test_upload_passes_actual_options_and_sanitizes_filename_and_prompt(app, provider):
    connect(provider)
    received = []
    def pipeline(job_dir, source, options, model_config, emit, cancelled):
        received.append((source.name, options, model_config["api_key"]))
        assert source.read_bytes() == b"test-only-upload"
        emit({"status": "analyzing", "ai": {"call_count": 1}, "message": "TEST_PRIVATE_KEY_ONLY"})
        return {"result": {"video_duration": 43}, "ai": {"call_count": 1}}
    app.state.manager.pipeline = pipeline
    with TestClient(app) as client:
        options = {"target_duration": 43, "min_duration": 32, "max_duration": 49, "sample_interval": 1,
                   "prompt": "自定义口味，误贴TEST_PRIVATE_KEY_ONLY"}
        response = client.post("/api/jobs", data={"options": json.dumps(options)},
            files={"file": ("../TEST_PRIVATE_KEY_ONLY.mp4", b"test-only-upload")})
        assert response.status_code == 202
        job_id = response.json()["id"]
        app.state.manager.executor.shutdown(wait=True)
        value = client.get(f"/api/jobs/{job_id}").json()
        assert value["status"] == "completed" and value["options"]["target_duration"] == 43
        assert value["options"]["min_duration"] == 32 and value["options"]["max_duration"] == 49
        assert len(received) == 1 and received[0][2] == "TEST_PRIVATE_KEY_ONLY"
        assert received[0][0] == "source.mp4"
        assert "TEST_PRIVATE_KEY_ONLY" not in json.dumps(value)
        saved = app.state.manager.jobs_dir / job_id / "job.json"
        assert "TEST_PRIVATE_KEY_ONLY" not in saved.read_text(encoding="utf-8")
        timings = value["timings"]
        assert timings["status"] == "completed" and timings["available"]
        assert timings["total_seconds"] >= 0
        assert timings["finished_at"]
        stages = {s["id"]: s for s in timings["stages"]}
        assert stages["upload"]["status"] == stages["queue"]["status"] == "completed"
        assert stages["processing"]["status"] == "completed"
        assert sum(s["seconds"] or 0 for s in timings["stages"]) == pytest.approx(timings["total_seconds"], abs=0.00001)
        saved_timing = client.get(f"/api/jobs/{job_id}/files/timings.json")
        assert saved_timing.status_code == 200 and saved_timing.json() == timings
        assert "TEST_PRIVATE_KEY_ONLY" not in saved_timing.text
        response = client.get(f"/api/jobs/{job_id}/files/source.mp4", headers={"Range": "bytes=0-3"})
        assert response.status_code == 206 and response.content == b"test"
        assert response.headers["content-range"].startswith("bytes 0-3/")


def test_failed_worker_retains_debug_inputs_and_redacts_exception(app, provider):
    connect(provider)
    def pipeline(job_dir, source, options, model_config, emit, cancelled):
        emit({"prompt": {"system": "test only", "user": "actual parameters"}, "ai": {"call_count": 1}})
        raise RuntimeError("failed with TEST_PRIVATE_KEY_ONLY")
    app.state.manager.pipeline = pipeline
    with TestClient(app) as client:
        response = client.post("/api/jobs", files={"file": ("cat.mp4", b"x")})
        app.state.manager.executor.shutdown(wait=True)
        value = client.get("/api/jobs/" + response.json()["id"]).json()
        assert value["status"] == "failed" and value["ai"]["call_count"] == 1
        assert value["prompt"]["user"] == "actual parameters"
        assert "TEST_PRIVATE_KEY_ONLY" not in value["error"]
        assert value["timings"]["status"] == "failed"
        assert next(s for s in value["timings"]["stages"] if s["id"] == "processing")["status"] == "failed"


def test_cooperative_cancel_and_no_resubmission(app, provider):
    connect(provider)
    entered, release = Event(), Event()
    calls = []
    def pipeline(job_dir, source, options, model_config, emit, cancelled):
        calls.append(1)
        entered.set()
        assert release.wait(3)
        assert cancelled()
        raise RuntimeError("cancelled by test")
    app.state.manager.pipeline = pipeline
    with TestClient(app) as client:
        response = client.post("/api/jobs", files={"file": ("cat.mp4", b"x")})
        assert entered.wait(3)
        job_id = response.json()["id"]
        try:
            assert client.post(f"/api/jobs/{job_id}/cancel").status_code == 200
        finally:
            release.set()
        app.state.manager.executor.shutdown(wait=True)
        value = client.get(f"/api/jobs/{job_id}").json()
        assert value["status"] == "cancelled"
        assert value["timings"]["status"] == "cancelled"
        assert next(s for s in value["timings"]["stages"] if s["id"] == "processing")["status"] == "cancelled"
        assert len(calls) == 1


def test_queue_cancel_does_not_execute_pipeline_but_keeps_queue_timing(app, provider):
    connect(provider)
    entered, release = Event(), Event()
    calls = []
    def pipeline(*_args):
        calls.append(1)
        entered.set()
        assert release.wait(3)
        return {"result": {}}
    app.state.manager.pipeline = pipeline
    with TestClient(app) as client:
        client.post("/api/jobs", files={"file": ("first.mp4", b"x")})
        assert entered.wait(3)
        second = client.post("/api/jobs", files={"file": ("second.mp4", b"x")}).json()
        job_id = second["id"]
        try:
            running = client.get(f"/api/jobs/{job_id}").json()
            assert next(s for s in running["timings"]["stages"] if s["id"] == "queue")["status"] == "running"
            assert client.post(f"/api/jobs/{job_id}/cancel").status_code == 200
        finally:
            release.set()
        app.state.manager.executor.shutdown(wait=True)
        value = client.get(f"/api/jobs/{job_id}").json()
        assert value["status"] == value["timings"]["status"] == "cancelled"
        assert next(s for s in value["timings"]["stages"] if s["id"] == "queue")["status"] == "cancelled"
        assert len(calls) == 1


def test_restarting_freezes_saved_timing_without_counting_downtime(tmp_path, provider):
    from mukbang.timing import JobTimings
    data_dir = tmp_path / "restart-data"
    job_dir = data_dir / "jobs" / "0123456789ab"
    job_dir.mkdir(parents=True)
    timer = JobTimings(clock=lambda: 10, started_monotonic=5, initial_stage="ai_request")
    snapshot = timer.snapshot()
    record = {"id": job_dir.name, "status": "analyzing", "created_at": "2026-10-22T20:00:00+08:00",
              "updated_at": "2026-10-22T20:00:05+08:00", "timings": snapshot}
    (job_dir / "job.json").write_text(json.dumps(record), encoding="utf-8")
    restarted = create_app(data_dir, provider)
    try:
        with TestClient(restarted) as client:
            value = client.get(f"/api/jobs/{job_dir.name}").json()
            assert value["status"] == "failed"
            assert value["timings"]["total_seconds"] == 5
            assert value["timings"]["is_partial"]
            assert value["timings"]["status"] == "interrupted"
            assert client.get(f"/api/jobs/{job_dir.name}/files/timings.json").json() == value["timings"]
            assert json.loads((job_dir / "job.json").read_text(encoding="utf-8"))["timings"] == value["timings"]
    finally:
        restarted.state.manager.executor.shutdown(wait=True, cancel_futures=True)


def test_completed_legacy_record_is_not_backfilled_with_fabricated_timings(tmp_path, provider):
    data_dir = tmp_path / "legacy-timing-data"
    job_dir = data_dir / "jobs" / "abcdef123456"
    job_dir.mkdir(parents=True)
    record = {"id": job_dir.name, "status": "completed", "created_at": "2026-10-22T20:00:00+08:00",
              "updated_at": "2026-10-22T20:02:00+08:00", "ai": {"elapsed_seconds": 80}}
    text = json.dumps(record)
    (job_dir / "job.json").write_text(text, encoding="utf-8")
    legacy_app = create_app(data_dir, provider)
    try:
        with TestClient(legacy_app) as client:
            value = client.get(f"/api/jobs/{job_dir.name}").json()
            assert "timings" not in value
            assert not (job_dir / "timings.json").exists()
            assert (job_dir / "job.json").read_text(encoding="utf-8") == text
    finally:
        legacy_app.state.manager.executor.shutdown(wait=True, cancel_futures=True)


def test_safe_file_blocks_traversal_extensions_and_symlink(tmp_path):
    allowed = tmp_path / "job"
    allowed.mkdir()
    (allowed / "input.jpg").write_bytes(b"fixture")
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    assert safe_file(allowed, "input.jpg") == (allowed / "input.jpg").resolve()
    for relative in ("../outside.json", str(outside), "..\\outside.json", "input.exe", "", "a\x00.jpg"):
        with pytest.raises(Exception) as error:
            safe_file(allowed, relative)
        assert error.value.status_code == 404


def test_nested_public_redaction():
    assert clean_public({"api_key": "s", "nested": [{"Authorization": "s", "message": "the s key"}]}, "s") == {
        "nested": [{"message": "the [密钥已隐藏] key"}]}
