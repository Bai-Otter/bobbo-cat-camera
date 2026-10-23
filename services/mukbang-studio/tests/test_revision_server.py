import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from mukbang import config
from mukbang.server import create_app


@pytest.fixture
def setup(tmp_path, monkeypatch):
    for name in ("MUKBANG_VISION_BASE_URL", "MUKBANG_VISION_MODEL", "MUKBANG_VISION_API_STYLE",
                 "MUKBANG_VISION_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY",
                 "MUKBANG_VISION_USE_CODEX_PROVIDER", "MUKBANG_CODEX_HOME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(config, "ROOT", tmp_path)
    provider = config.ProviderConfig()
    provider.update({"base_url": "https://vision.example/v1", "model": "gpt-6.1-sol",
                     "api_style": "responses", "api_key": "TEST_PRIVATE_KEY_ONLY"})
    calls = []
    def fixture_pipeline(job_dir, source, options, model_config, emit, cancelled):
        calls.append(str(job_dir.name))
        inherited = manager.get(parent["id"])
        return {"ai": {"call_count": 1}, "source": inherited["source"],
                "sampling": inherited["sampling"],
                "result": {"selected_frames": [{"id": "F0002"}]}}
    app = create_app(tmp_path / "data", provider, pipeline=fixture_pipeline)
    manager = app.state.manager
    options = {"target_duration": 40, "min_duration": 30, "max_duration": 50, "sample_interval": 1, "prompt": "原来的偏好"}
    parent = manager.create("cat.mp4", options)
    (manager.jobs_dir / parent["id"] / "source.mp4").write_bytes(b"OFFLINE TEST FIXTURE, NOT A REAL CAT VIDEO")
    manager.finish(parent["id"], "completed", {
        "source": {"duration": 4, "width": 128, "height": 192},
        "sampling": {"interval": 1, "frame_count": 2, "sheet_count": 1, "frames": [
            {"id": "F0001", "time": 0, "path": "samples/frame-00001.jpg"},
            {"id": "F0002", "time": 1, "path": "samples/frame-00002.jpg"}],
            "sheets": [{"id": "S01", "path": "sheets/S01-input.jpg"}]},
        "result": {"selected_frames": [{"id": "F0001"}]}})
    with TestClient(app) as client:
        yield client, manager, parent["id"], calls, options
    manager.executor.shutdown(wait=True, cancel_futures=True)


def save_feedback(client, parent_id, version=0, annotations=None, note="更多正脸"):
    body = {"expected_version": version, "annotations": annotations if annotations is not None else [
        {"frame_id": "F0001", "label": "dislike", "reason": "看不清脸"},
        {"frame_id": "F0002", "label": "like", "reason": "正脸更可爱"}], "note": note}
    return client.put(f"/api/jobs/{parent_id}/feedback", json=body)


def test_feedback_is_explicit_versioned_local_storage_without_ai(setup):
    client, manager, parent_id, calls, _ = setup
    url = f"/api/jobs/{parent_id}/feedback"
    assert client.get(url).json() == {"version": 0, "annotations": [], "note": ""}
    response = save_feedback(client, parent_id)
    assert response.status_code == 200
    assert response.json()["version"] == 1
    assert len(response.json()["annotations"]) == 2
    assert save_feedback(client, parent_id).status_code == 409
    assert calls == []
    assert (manager.jobs_dir / parent_id / "feedback-draft.json").is_file()
    # Full replacement means clearing a label never resurrects ancestor data.
    clear = save_feedback(client, parent_id, 1, [], "")
    assert clear.status_code == 200 and clear.json()["annotations"] == []
    assert client.get(url).json()["annotations"] == []


def test_feedback_rejects_wrong_video_ids_duplicates_and_invalid_labels(setup):
    client, _, parent_id, calls, _ = setup
    wrong = [{"frame_id": "F9999", "label": "like", "reason": ""}]
    assert save_feedback(client, parent_id, annotations=wrong).status_code == 400
    repeated = [{"frame_id": "F0001", "label": "like"}, {"frame_id": "F0001", "label": "dislike"}]
    assert save_feedback(client, parent_id, annotations=repeated).status_code == 400
    assert save_feedback(client, parent_id, annotations=[{"frame_id": "F0001", "label": "other"}]).status_code == 422
    assert client.get(f"/api/jobs/{parent_id}/feedback").json()["version"] == 0
    assert calls == []


def test_feedback_notes_never_persist_current_credential(setup):
    client, manager, parent_id, _, _ = setup
    response = save_feedback(client, parent_id, annotations=[
        {"frame_id": "F0002", "label": "like", "reason": "TEST_PRIVATE_KEY_ONLY"}],
        note="误贴TEST_PRIVATE_KEY_ONLY")
    assert response.status_code == 200
    text = (manager.jobs_dir / parent_id / "feedback-draft.json").read_text(encoding="utf-8")
    assert "TEST_PRIVATE_KEY_ONLY" not in response.text + text


def test_revise_is_new_job_with_frozen_feedback_and_idempotent_manual_retry(setup):
    client, manager, parent_id, calls, options = setup
    save_feedback(client, parent_id)
    original = (manager.jobs_dir / parent_id / "job.json").read_bytes()
    body = {"expected_version": 1, "request_id": "offline-idempotent-request-0001", "options": options}
    response = client.post(f"/api/jobs/{parent_id}/revise", json=body)
    assert response.status_code == 202
    child_id = response.json()["id"]
    manager.executor.shutdown(wait=True)
    child = client.get(f"/api/jobs/{child_id}").json()
    assert child["status"] == "completed"
    assert child["iteration"]["root_job_id"] == parent_id
    assert child["iteration"]["parent_job_id"] == parent_id
    assert child["iteration"]["round"] == 2
    assert child["iteration"]["reused_sampling"]
    assert child["feedback"]["version"] == 1 and len(child["feedback"]["annotations"]) == 2
    assert next(s for s in child["timings"]["stages"] if s["id"] == "upload")["status"] == "skipped"
    assert (manager.jobs_dir / parent_id / "job.json").read_bytes() == original
    # A later draft does not mutate the submitted round or create a new charge
    # when the browser explicitly retries the same uncertain request.
    save_feedback(client, parent_id, 1, [], "新草稿")
    assert child["feedback"]["note"] == "更多正脸"
    again = client.post(f"/api/jobs/{parent_id}/revise", json=body)
    assert again.status_code == 202 and again.json()["id"] == child_id
    assert calls == [child_id]
    changed = {**body, "options": {**options, "target_duration": 35}}
    assert client.post(f"/api/jobs/{parent_id}/revise", json=changed).status_code == 409
    history = client.get(f"/api/jobs/{child_id}/iterations").json()
    assert history["root_job_id"] == parent_id
    assert [r["round"] for r in history["jobs"]] == [1, 2]
    inherited = client.get(f"/api/jobs/{child_id}/feedback").json()
    assert inherited["version"] == 0 and len(inherited["annotations"]) == 2


def test_revise_blocks_unreviewed_empty_or_changed_sampling_and_stale_draft(setup):
    client, manager, parent_id, calls, options = setup
    url = f"/api/jobs/{parent_id}/revise"
    body = {"expected_version": 0, "request_id": "offline-invalid-request-00001", "options": options}
    assert client.post(url, json=body).status_code == 400
    save_feedback(client, parent_id)
    assert client.post(url, json=body).status_code == 409
    changed = {**body, "expected_version": 1, "options": {**options, "sample_interval": .5}}
    assert client.post(url, json=changed).status_code == 400
    assert len(manager.jobs) == 1 and calls == []


def test_revision_family_uses_unique_rounds_and_independent_drafts(setup):
    client, manager, parent_id, _, options = setup
    save_feedback(client, parent_id)
    first = client.post(f"/api/jobs/{parent_id}/revise", json={"expected_version": 1,
        "request_id": "offline-first-branch-request-1", "options": options}).json()
    second = client.post(f"/api/jobs/{parent_id}/revise", json={"expected_version": 1,
        "request_id": "offline-other-branch-request-2", "options": options}).json()
    manager.executor.shutdown(wait=True)
    assert first["iteration"]["round"] == 2 and second["iteration"]["round"] == 3
    history = client.get(f"/api/jobs/{parent_id}/iterations").json()
    assert [r["round"] for r in history["jobs"]] == [1, 2, 3]
    assert client.get(f"/api/jobs/{parent_id}/feedback").json()["version"] == 1


def test_revise_without_source_or_from_running_task_never_enqueues(setup):
    client, manager, parent_id, calls, options = setup
    save_feedback(client, parent_id)
    body = {"expected_version": 1, "request_id": "offline-no-source-request-001", "options": options}
    manager.jobs[parent_id]["status"] = "rendering"
    assert client.post(f"/api/jobs/{parent_id}/revise", json=body).status_code == 409
    manager.jobs[parent_id]["status"] = "completed"
    (manager.jobs_dir / parent_id / "source.mp4").unlink()
    assert client.post(f"/api/jobs/{parent_id}/revise", json=body).status_code == 400
    assert len(manager.jobs) == 1 and calls == []


def test_existing_revision_can_be_confirmed_after_provider_configuration_is_lost(setup):
    client, manager, parent_id, calls, options = setup
    save_feedback(client, parent_id)
    body = {"expected_version": 1, "request_id": "offline-recover-without-key-001", "options": options}
    first = client.post(f"/api/jobs/{parent_id}/revise", json=body)
    assert first.status_code == 202
    child_id = first.json()["id"]
    manager.executor.shutdown(wait=True)
    manager.provider.update({"base_url": "https://new-unconfigured.example/v1"})
    assert not manager.provider.public()["configured"]
    again = client.post(f"/api/jobs/{parent_id}/revise", json=body)
    assert again.status_code == 202 and again.json()["id"] == child_id
    assert calls == [child_id]
    changed = {**body, "options": {**options, "target_duration": 35}}
    assert client.post(f"/api/jobs/{parent_id}/revise", json=changed).status_code == 409
    fresh = {**body, "request_id": "offline-new-without-key-000002"}
    assert client.post(f"/api/jobs/{parent_id}/revise", json=fresh).status_code == 400
    assert len(manager.jobs) == 2 and calls == [child_id]
    # Persisted request identity also survives a service restart; confirming
    # an existing task must never dispatch the pipeline again.
    def never_run(*_args):
        raise AssertionError("An existing revision must not be dispatched again")
    restarted = create_app(manager.data_dir, manager.provider, pipeline=never_run)
    try:
        with TestClient(restarted) as recovered:
            result = recovered.post(f"/api/jobs/{parent_id}/revise", json=body)
            assert result.status_code == 202 and result.json()["id"] == child_id
            assert len(restarted.state.manager.jobs) == 2
    finally:
        restarted.state.manager.executor.shutdown(wait=True, cancel_futures=True)
