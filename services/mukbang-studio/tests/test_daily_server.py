"""Offline API contract for the opt-in mobile dual-video flow."""
from copy import deepcopy
import json

from fastapi.testclient import TestClient
import pytest

from mukbang import server
from mukbang.server import JobOptions, create_app, requested_options


class OfflineProvider:
    def public(self):
        return {"configured": True, "provider": {"base_url": "https://offline.invalid/v1",
                "model": "gpt-6.1-sol", "api_style": "responses", "key_configured": True}}

    def private(self):
        return {"base_url": "https://offline.invalid/v1", "model": "gpt-6.1-sol",
                "api_style": "responses", "api_key": "DAILY_TEST_SECRET_ONLY"}


@pytest.fixture
def daily_app(tmp_path):
    calls = []

    def pipeline(job_dir, source, options, private, emit, cancelled):
        calls.append({"options": deepcopy(options), "source": source.name})
        assert source.read_bytes() == b"OFFLINE UPLOAD FIXTURE"
        assert private["model"] == "gpt-6.1-sol"
        return {"ai": {"call_count": 1}, "result": {"video_duration": 40,
                "video_url": f"/api/jobs/{job_dir.name}/files/highlight.mp4"}}

    app = create_app(tmp_path / "data", OfflineProvider(), pipeline=pipeline)
    try:
        with TestClient(app) as client:
            yield app, client, calls
    finally:
        app.state.manager.executor.shutdown(wait=True, cancel_futures=True)


def upload(client, options):
    return client.post("/api/jobs", data={"options": json.dumps(options)},
                       files={"file": ("cat.mp4", b"OFFLINE UPLOAD FIXTURE", "video/mp4")})


def drain(app):
    app.state.manager.executor.submit(lambda: None).result(timeout=10)


def test_dual_video_is_opt_in_and_legacy_request_fingerprint_is_unchanged():
    model = JobOptions()
    assert model.story_enabled is False
    assert model.story_target_duration == 30
    assert requested_options(model) == {"target_duration": 40, "min_duration": 30,
        "max_duration": 50, "sample_interval": 1, "prompt": ""}
    assert requested_options(JobOptions(story_enabled=False, story_target_duration=20)) == requested_options(model)
    assert requested_options(JobOptions(story_enabled=True, story_target_duration=25)) == {
        **requested_options(model), "story_enabled": True, "story_target_duration": 25}


def test_config_announces_additive_features_without_changing_eating_defaults(daily_app):
    _, client, calls = daily_app
    result = client.get("/api/config")
    assert result.status_code == 200
    body = result.json()
    assert body["features"] == {"dual_video": True, "story_max_duration": 60, "story_inner_monologue": True, "photos": False}
    assert body["defaults"] == {"target_duration": 40, "min_duration": 30,
        "max_duration": 50, "sample_interval": 1, "frames_per_sheet": 60}
    assert body["prompt_template"] == body["prompt_library"]["active"]["text"]
    assert "DAILY_TEST_SECRET_ONLY" not in result.text
    assert calls == []


def test_new_story_mode_reaches_one_job_and_legacy_fingerprints_stay_unchanged(daily_app):
    app, client, calls = daily_app
    result = upload(client, {"story_enabled": True, "story_mode": "inner_monologue", "story_target_duration": 35})
    assert result.status_code == 202
    drain(app)
    assert len(calls) == 1 and calls[0]["options"]["story_mode"] == "inner_monologue"
    assert calls[0]["options"]["story_target_duration"] == 35
    assert requested_options(JobOptions(story_mode="inner_monologue")) == requested_options(JobOptions())
    assert upload(client, {"story_enabled": True, "story_mode": "third_video"}).status_code == 400


@pytest.mark.parametrize("path", ["/daily", "/daily/"])
def test_daily_routes_serve_mobile_page(daily_app, tmp_path, monkeypatch, path):
    _, client, calls = daily_app
    # The mount is created before this fixture file; ROOT is independently
    # redirected so the test never replaces the real app's frontend.
    web = tmp_path / "mobile-root" / "web"
    web.mkdir(parents=True)
    (web / "daily.html").write_text('<!doctype html><title>今日小剧场</title>', encoding="utf-8")
    monkeypatch.setattr(server, "ROOT", web.parent)
    response = client.get(path)
    assert response.status_code == 200
    assert "今日小剧场" in response.text
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert calls == []


def test_mobile_styles_and_script_use_the_existing_static_mount(tmp_path, monkeypatch):
    web = tmp_path / "static-root" / "web"
    web.mkdir(parents=True)
    (web / "daily.html").write_text('<link rel="stylesheet" href="/static/daily.css">'
                                  '<script src="/static/daily.js" defer></script>', encoding="utf-8")
    (web / "daily.css").write_text(".daily { color: #151515; }", encoding="utf-8")
    (web / "daily.js").write_text("/* local mobile frontend */", encoding="utf-8")
    monkeypatch.setattr(server, "ROOT", web.parent)
    app = create_app(tmp_path / "static-data", OfflineProvider())
    try:
        with TestClient(app) as client:
            assert client.get("/daily").status_code == 200
            css = client.get("/static/daily.css")
            assert css.status_code == 200 and css.headers["content-type"].startswith("text/css")
            assert css.text == ".daily { color: #151515; }"
            script = client.get("/static/daily.js")
            assert script.status_code == 200 and "javascript" in script.headers["content-type"]
            assert script.text == "/* local mobile frontend */"
    finally:
        app.state.manager.executor.shutdown(wait=True, cancel_futures=True)


def test_daily_missing_page_returns_honest_preparation_state(daily_app, tmp_path, monkeypatch):
    _, client, _ = daily_app
    monkeypatch.setattr(server, "ROOT", tmp_path / "missing")
    response = client.get("/daily")
    assert response.status_code == 503
    assert response.json()["detail"]


def test_daily_route_does_not_replace_the_original_debug_home(daily_app, tmp_path, monkeypatch):
    _, client, calls = daily_app
    web = tmp_path / "frontend-root" / "web"
    web.mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>Original debug</title>", encoding="utf-8")
    (web / "daily.html").write_text("<!doctype html><title>Daily mobile</title>", encoding="utf-8")
    monkeypatch.setattr(server, "ROOT", web.parent)
    assert "Original debug" in client.get("/").text
    assert "Daily mobile" in client.get("/daily").text
    assert calls == []


def test_upload_executes_one_pipeline_with_story_options_and_frozen_active_prompt(daily_app):
    app, client, calls = daily_app
    active = client.get("/api/config").json()["prompt_library"]["active"]
    response = upload(client, {"story_enabled": True, "story_target_duration": 27.5,
                               "use_active_prompt": True, "prompt": "页面过时的文字，不应该替换通用版"})
    assert response.status_code == 202, response.text
    drain(app)
    job = client.get(f"/api/jobs/{response.json()['id']}").json()
    assert job["status"] == "completed"
    assert job["ai"]["call_count"] == 1
    assert job["prompt_standard"]["version_id"] == active["id"]
    assert job["options"]["prompt"] == active["text"]
    assert job["options"]["story_enabled"] is True
    assert job["options"]["story_target_duration"] == 27.5
    assert len(calls) == 1
    assert calls[0]["options"] == job["options"]
    assert calls[0]["source"] == "source.mp4"


def test_legacy_upload_does_not_implicitly_enable_story_or_change_output_shape(daily_app):
    app, client, calls = daily_app
    response = upload(client, {})
    assert response.status_code == 202
    drain(app)
    job = client.get(f"/api/jobs/{response.json()['id']}").json()
    assert job["status"] == "completed"
    assert len(calls) == 1
    assert "story_enabled" not in calls[0]["options"]
    assert "story_target_duration" not in calls[0]["options"]
    assert job["result"]["video_duration"] == 40
    assert "story" not in job["result"]
    assert client.get("/api/jobs").json()["jobs"][0]["id"] == job["id"]


def test_dual_upload_does_not_reset_existing_p0004_library(daily_app):
    app, client, calls = daily_app
    # Exercise an existing, user-published P0004 rather than mistaking the
    # shipped first-install seed for the current online library version.
    for revision in range(3):
        response = client.post("/api/prompt-library/versions", json={
            "expected_revision": revision, "request_id": f"daily-existing-prompt-{revision:04d}",
            "text": f"用户确认的吃播审美第{revision + 2}版：近镜头进食为主体，站起只少量。", "name": "已确认标准"})
        assert response.status_code == 201, response.text
    before = client.get("/api/prompt-library").json()
    assert before["active_version_id"] == "P0004" and before["revision"] == 3
    submitted = upload(client, {"story_enabled": True, "use_active_prompt": True,
                                "prompt": "过期表单不能覆盖已确认版"})
    assert submitted.status_code == 202
    drain(app)
    job = client.get(f"/api/jobs/{submitted.json()['id']}").json()
    assert job["prompt_standard"]["version_id"] == "P0004"
    assert job["prompt_standard"]["revision"] == 3
    approved = next(row["text"] for row in before["versions"] if row["id"] == "P0004")
    assert calls[0]["options"]["prompt"] == approved
    assert client.get("/api/prompt-library").json() == before


@pytest.mark.parametrize("invalid", [
    {"story_enabled": "true"}, {"story_enabled": "false"},
    {"story_enabled": 1}, {"story_enabled": 0}, {"story_enabled": None},
    {"story_enabled": True, "story_target_duration": 2.99},
    {"story_enabled": True, "story_target_duration": 60.01},
    {"story_enabled": True, "story_target_duration": float("nan")},
    {"story_enabled": True, "story_target_duration": float("inf")},
    {"story_enabled": True, "story_target_duration": None},
    {"story_enabled": True, "story_target_duration": True},
])
def test_invalid_story_options_never_create_or_run_a_job(daily_app, invalid):
    app, client, calls = daily_app
    response = upload(client, invalid)
    assert response.status_code == 400
    assert client.get("/api/jobs").json() == {"jobs": []}
    assert calls == []
    assert list(app.state.manager.jobs_dir.iterdir()) == []


@pytest.mark.parametrize("seconds", [3, 30, 60])
def test_story_duration_boundary_values_are_accepted(daily_app, seconds):
    app, client, calls = daily_app
    response = upload(client, {"story_enabled": True, "story_target_duration": seconds})
    assert response.status_code == 202
    drain(app)
    assert len(calls) == 1
    assert calls[0]["options"]["story_target_duration"] == seconds


def test_mobile_story_and_eating_files_use_existing_safe_media_route(daily_app):
    app, client, _ = daily_app
    response = upload(client, {"story_enabled": True})
    drain(app)
    job_id = response.json()["id"]
    root = app.state.manager.jobs_dir / job_id
    (root / "story").mkdir()
    (root / "story" / "video.mp4").write_bytes(b"OFFLINE STORY VIDEO")
    (root / "story" / "poster.jpg").write_bytes(b"OFFLINE STORY POSTER")
    assert client.get(f"/api/jobs/{job_id}/files/story/video.mp4").content == b"OFFLINE STORY VIDEO"
    poster = client.get(f"/api/jobs/{job_id}/files/story/poster.jpg")
    assert poster.status_code == 200
    assert poster.headers["content-type"].startswith("image/jpeg")
    assert client.get(f"/api/jobs/{job_id}/files/../job.json").status_code == 404
