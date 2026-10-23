"""Cross-video prompt standards, with no online inference or cat imagery."""
from copy import deepcopy
import hashlib
import json

from fastapi.testclient import TestClient
import pytest

from mukbang.server import create_app


class OfflineProvider:
    configured = True

    def public(self):
        return {"configured": self.configured, "provider": {"base_url": "https://offline.invalid/v1",
                "model": "gpt-6.1-sol", "api_style": "responses", "key_configured": self.configured}}

    def private(self):
        if not self.configured:
            raise ValueError("离线测试：当前没有配置模型")
        return {"base_url": "https://offline.invalid/v1", "model": "gpt-6.1-sol",
                "api_style": "responses", "api_key": "PROMPT_TEST_PRIVATE_ONLY"}


@pytest.fixture
def studio(tmp_path):
    provider = OfflineProvider()
    video_calls, text_calls = [], []

    def offline_video(job_dir, source, options, private, emit, cancelled):
        video_calls.append({"id": job_dir.name, "options": deepcopy(options)})
        return {"source": {"duration": 5, "video_url": f"/api/jobs/{job_dir.name}/files/source.mp4"},
                "sampling": {"interval": options["sample_interval"], "frames": [
                    {"id": "F0001", "time": 0}, {"id": "F0002", "time": 1}],
                    "sheets": [{"id": "S01", "path": "sheets/S01-input.jpg"}]},
                "result": {"selected_frames": [{"id": "F0001", "reason": "模型原来的说明", "labels": ["fixture"]}]},
                "ai": {"call_count": 1}}

    def offline_text(prompts, private):
        assert private["model"] == "gpt-6.1-sol"
        text_calls.append(deepcopy(prompts))
        source_ids = [row["id"] for row in app.state.manager.jobs.values() if row.get("status") == "completed"]
        rule = "同等条件下，优先五官清楚且有自然表情变化的画面。"
        candidate = app.state.prompt_library.active()["text"] + "\n\n" + rule
        return {"text": json.dumps({"candidate_prompt": candidate, "summary": "根据明确反馈增加审美偏好",
                "changes": [{"before": "", "after": rule, "reason": "用户明确偏好完整正脸",
                             "evidence": [{"job_id": source_ids[0], "frame_id": "F0002"}]}], "warnings": []}),
                "envelope": {"test_only": True}, "usage": {"total_tokens": 12}}

    app = create_app(tmp_path / "data", provider, pipeline=offline_video, prompt_caller=offline_text)
    manager = app.state.manager
    try:
        with TestClient(app) as client:
            yield client, app, provider, video_calls, text_calls
    finally:
        manager.executor.shutdown(wait=True, cancel_futures=True)


def drain(app):
    app.state.manager.executor.submit(lambda: None).result(timeout=10)


def upload(client, app, options=None, name="synthetic.mp4"):
    response = client.post("/api/jobs", data={"options": json.dumps(options or {})},
                           files={"file": (name, b"OFFLINE API FIXTURE, NOT VIDEO OR CAT IMAGERY", "video/mp4")})
    assert response.status_code == 202, response.text
    drain(app)
    return client.get(f"/api/jobs/{response.json()['id']}").json()


def mark(client, job_id, version=0, reason="正脸清楚，表情自然", note="多找看得清五官的表情"):
    response = client.put(f"/api/jobs/{job_id}/feedback", json={"expected_version": version,
        "annotations": [{"frame_id": "F0002", "label": "like", "reason": reason}], "note": note})
    assert response.status_code == 200
    return response.json()


def publish(client, text, revision=0, request_id="offline-publish-standard-0001", **extra):
    return client.post("/api/prompt-library/versions", json={"expected_revision": revision,
        "request_id": request_id, "text": text, "name": "我的选片标准", **extra})


def test_library_initializes_without_inference_and_config_uses_active(studio):
    client, app, provider, video_calls, text_calls = studio
    provider.configured = False
    library = client.get("/api/prompt-library").json()
    assert library["revision"] == 0 and library["active_version_id"] == "P0001"
    assert len(library["versions"]) == 1 and library["versions"][0]["text"]
    config = client.get("/api/config").json()
    assert config["prompt_template"] == library["versions"][0]["text"]
    assert config["prompt_library"]["active"]["id"] == "P0001"
    assert video_calls == text_calls == []


def test_published_standard_applies_to_different_videos_and_freezes_actual_prompt(studio):
    client, app, _, video_calls, text_calls = studio
    baseline = client.get("/api/prompt-library").json()["versions"][0]["text"]
    approved = baseline + "\n\n我更喜欢自然停顿和清楚的五官。"
    response = publish(client, approved)
    assert response.status_code == 201, response.text
    assert response.json()["active_version_id"] == "P0002"
    first = upload(client, app, {"use_active_prompt": True, "prompt": "页面过时文本"}, "first.mp4")
    second = upload(client, app, {"use_active_prompt": True, "prompt": "另一个过时文本"}, "second.mp4")
    for job in (first, second):
        assert job["options"]["prompt"] == approved
        assert job["prompt_standard"]["mode"] == "global"
        assert job["prompt_standard"]["version_id"] == "P0002"
        assert job["prompt_standard"]["sha256"] == hashlib.sha256(approved.encode()).hexdigest()
    assert [row["options"]["prompt"] for row in video_calls] == [approved, approved]
    assert text_calls == []
    assert client.get("/api/config").json()["prompt_template"] == approved


def test_single_video_custom_prompt_is_not_published_and_empty_uses_active(studio):
    client, app, _, _, _ = studio
    active = client.get("/api/prompt-library").json()["versions"][0]["text"]
    custom = upload(client, app, {"prompt": "这条视频只看走近镜头的动作"})
    assert custom["options"]["prompt"] == "这条视频只看走近镜头的动作"
    assert custom["prompt_standard"]["mode"] == "custom"
    following = upload(client, app, {"prompt": ""}, "following.mp4")
    assert following["options"]["prompt"] == active
    assert following["prompt_standard"]["version_id"] == "P0001"
    assert client.get("/api/prompt-library").json()["revision"] == 0


def test_confirm_publish_and_rollback_are_versioned_idempotent_and_zero_ai(studio):
    client, app, _, video_calls, text_calls = studio
    baseline = client.get("/api/prompt-library").json()["versions"][0]["text"]
    before = upload(client, app)
    path = app.state.manager.jobs_dir / before["id"] / "job.json"
    unchanged = path.read_bytes()
    first = publish(client, baseline + "\n保留自然的小停顿。")
    assert first.status_code == 201
    again = publish(client, baseline + "\n保留自然的小停顿。")
    assert again.status_code in (200, 201) and again.json()["revision"] == 1
    assert publish(client, "不同内容但重复请求ID").status_code == 409
    assert publish(client, "陈旧草稿", request_id="offline-stale-publish-0002").status_code == 409
    body = {"expected_revision": 1, "request_id": "offline-rollback-to-first-001", "version_id": "P0001"}
    switched = client.post("/api/prompt-library/activate", json=body)
    assert switched.status_code == 200 and switched.json()["revision"] == 2
    assert switched.json()["active_version_id"] == "P0001"
    assert len(switched.json()["versions"]) == 2
    assert client.post("/api/prompt-library/activate", json=body).json()["revision"] == 2
    # Active ID has returned to P0001, but a stale revision 0 cannot publish.
    assert publish(client, "ABA旧草稿", request_id="offline-aba-rejected-00003").status_code == 409
    assert path.read_bytes() == unchanged
    assert len(video_calls) == 1 and text_calls == []


def test_saved_feedback_generates_candidate_only_and_confirmed_version_transfers(studio):
    client, app, provider, _, text_calls = studio
    job = upload(client, app)
    saved = mark(client, job["id"])
    library_before = client.get("/api/prompt-library").json()
    body = {"expected_revision": 0, "request_id": "offline-propose-standard-0001",
            "sources": [{"job_id": job["id"], "feedback_version": saved["version"]}], "note": "提炼为后续视频通用标准"}
    response = client.post("/api/prompt-proposals", json=body)
    assert response.status_code == 202, response.text
    proposal_id = response.json()["id"]
    drain(app)
    proposal = client.get(f"/api/prompt-proposals/{proposal_id}").json()
    assert proposal["status"] == "completed", proposal.get("error")
    assert proposal["ai"]["text_call_count"] == proposal["ai"]["call_count"] == 1
    assert proposal["ai"]["visual_call_count"] == 0
    assert len(text_calls) == 1
    assert "正脸清楚，表情自然" in proposal["prompt"]["user"]
    assert proposal["sources"][0]["annotations"][0]["frame_id"] == "F0002"
    assert "---" in proposal["diff"] and "+++" in proposal["diff"]
    assert proposal["timings"]["status"] == "completed"
    assert client.get("/api/prompt-library").json()["active_version_id"] == library_before["active_version_id"]
    # The same uncertain submit confirms the accepted proposal even if drafts
    # or provider settings have since changed, without refreezing/recharging.
    mark(client, job["id"], 1, reason="后来改了草稿")
    provider.configured = False
    assert client.post("/api/prompt-proposals", json=body).json()["id"] == proposal_id
    assert len(text_calls) == 1
    provider.configured = True
    approved = proposal["candidate_prompt"] + "\n这是我确认过的通用偏好。"
    confirmed = publish(client, approved, proposal_id=proposal_id)
    assert confirmed.status_code == 201, confirmed.text
    following = upload(client, app, {"use_active_prompt": True}, "new-unseen.mp4")
    assert following["options"]["prompt"] == approved
    assert following["prompt_standard"]["version_id"] == "P0002"
    assert len(text_calls) == 1


def test_proposal_sources_must_be_real_saved_feedback_at_the_requested_version(studio):
    client, app, _, _, text_calls = studio
    job = upload(client, app)
    base = {"expected_revision": 0, "request_id": "offline-invalid-source-00001", "sources": [
        {"job_id": job["id"], "feedback_version": 0}]}
    assert client.post("/api/prompt-proposals", json=base).status_code == 400
    mark(client, job["id"])
    assert client.post("/api/prompt-proposals", json=base).status_code == 409
    fake = {**base, "sources": [{"job_id": "0123456789ab", "feedback_version": 1}]}
    assert client.post("/api/prompt-proposals", json=fake).status_code == 404
    unknown = {**base, "sources": [{"job_id": job["id"], "feedback_version": 1}], "reuse_from": "E:/"}
    assert client.post("/api/prompt-proposals", json=unknown).status_code == 422
    assert text_calls == []


def test_feedback_from_multiple_videos_is_frozen_namespaced_and_does_not_leak_to_video_inputs(studio):
    client, app, _, _, text_calls = studio
    jobs = [upload(client, app, name=name) for name in ("one.mp4", "two.mp4")]
    for i, job in enumerate(jobs):
        mark(client, job["id"], reason=f"用户明确意见{i+1}：更喜欢看得清五官")
    body = {"expected_revision": 0, "request_id": "offline-multi-video-proposal-01", "sources": [
        {"job_id": job["id"], "feedback_version": 1} for job in jobs]}
    response = client.post("/api/prompt-proposals", json=body)
    assert response.status_code == 202
    drain(app)
    record = client.get(f"/api/prompt-proposals/{response.json()['id']}").json()
    assert record["status"] == "completed", record.get("error")
    assert {source["job_id"] for source in record["sources"]} == {job["id"] for job in jobs}
    assert all(source["annotations"][0]["frame_id"] == "F0002" for source in record["sources"])
    assert "模型原来的说明" not in record["sources"][0]["annotations"][0]["reason"]
    published = publish(client, record["candidate_prompt"], proposal_id=record["id"])
    assert published.status_code == 201
    third = upload(client, app, {"use_active_prompt": True}, "three.mp4")
    assert "F0002" not in third["options"]["prompt"]
    assert all(job["id"] not in third["options"]["prompt"] for job in jobs)
    assert len(text_calls) == 1


def test_custom_and_global_prompt_origins_are_frozen_per_revision_and_retries_ignore_new_active(studio):
    client, app, _, video_calls, _ = studio
    parent = upload(client, app, {"prompt": "原视频自定义偏好"})
    mark(client, parent["id"])
    baseline = client.get("/api/prompt-library").json()["versions"][0]["text"]
    approved = baseline + "\n新的通用表情偏好。"
    assert publish(client, approved).status_code == 201
    base_body = {"expected_version": 1, "request_id": "offline-custom-revision-00001"}
    custom_response = client.post(f"/api/jobs/{parent['id']}/revise", json=base_body)
    assert custom_response.status_code == 202
    drain(app)
    custom = client.get(f"/api/jobs/{custom_response.json()['id']}").json()
    assert custom["options"]["prompt"] == parent["options"]["prompt"]
    assert custom["prompt_standard"]["mode"] == "custom"
    global_body = {"expected_version": 1, "request_id": "offline-global-revision-00001",
                   "options": {"use_active_prompt": True, "prompt": "忽略这份过时表单"}}
    global_response = client.post(f"/api/jobs/{parent['id']}/revise", json=global_body)
    assert global_response.status_code == 202
    drain(app)
    child = client.get(f"/api/jobs/{global_response.json()['id']}").json()
    assert child["options"]["prompt"] == approved
    assert child["prompt_standard"]["version_id"] == "P0002"
    assert publish(client, baseline + "\n再调整一次标准。", 1, "offline-later-publish-00002").status_code == 201
    again = client.post(f"/api/jobs/{parent['id']}/revise", json=global_body)
    assert again.status_code == 202 and again.json()["id"] == child["id"]
    assert len(video_calls) == 3


def test_persistent_standards_and_secret_redaction_and_local_write_guards(studio):
    client, app, provider, _, _ = studio
    response = publish(client, "我的标准，误贴PROMPT_TEST_PRIVATE_ONLY")
    assert response.status_code == 201
    assert "PROMPT_TEST_PRIVATE_ONLY" not in response.text
    assert client.post("/api/prompt-library/activate", headers={"Origin": "https://outside.example"},
        json={"expected_revision": 1, "request_id": "offline-cross-site-activation1", "version_id": "P0001"}).status_code == 403
    assert publish(client, "旧视频实例F0002不能进入通用标准", 1, "offline-local-id-rejected-001").status_code == 400
    restarted = create_app(app.state.manager.data_dir, provider, pipeline=lambda *_: {"result": {}})
    try:
        with TestClient(restarted) as other:
            current = other.get("/api/prompt-library").json()
            assert current["active_version_id"] == "P0002" and current["revision"] == 1
            assert "PROMPT_TEST_PRIVATE_ONLY" not in json.dumps(current)
    finally:
        restarted.state.manager.executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.parametrize("credential_state", ["lost", "rotated"])
def test_revision_identity_does_not_depend_on_current_redaction_secret(studio, credential_state):
    client, app, provider, video_calls, _ = studio
    parent = upload(client, app)
    mark(client, parent["id"])
    body = {"expected_version": 1, "request_id": "offline-redacted-revision-identity1",
            "options": {"prompt": "本条自定义，误贴PROMPT_TEST_PRIVATE_ONLY"}}
    submitted = client.post(f"/api/jobs/{parent['id']}/revise", json=body)
    assert submitted.status_code == 202, submitted.text
    drain(app)
    child = client.get(f"/api/jobs/{submitted.json()['id']}").json()
    assert "PROMPT_TEST_PRIVATE_ONLY" not in json.dumps(child)
    assert "[密钥已隐藏]" in child["options"]["prompt"]
    assert len(child["iteration"]["request_identity_fingerprint"]) == 64
    if credential_state == "lost":
        provider.configured = False
    else:
        old_private = provider.private()
        provider.private = lambda: {**old_private, "api_key": "ROTATED_OFFLINE_ONLY_KEY"}
    confirmed = client.post(f"/api/jobs/{parent['id']}/revise", json=body)
    assert confirmed.status_code == 202 and confirmed.json()["id"] == child["id"]
    assert len(video_calls) == 2
    different = deepcopy(body)
    different["options"]["prompt"] += "真的改动"
    assert client.post(f"/api/jobs/{parent['id']}/revise", json=different).status_code == 409
