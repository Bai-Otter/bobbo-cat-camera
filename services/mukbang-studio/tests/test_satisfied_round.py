"""Satisfied-round visual proposals: offline images, never real jobs or AI."""
from copy import deepcopy
import hashlib
import json

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from mukbang import config, media, vision


RULE = "近镜头时，优先嘴和鼻子完整且自然咀嚼的画面。"


class OfflineProvider:
    configured = True

    def private(self):
        if not self.configured:
            raise ValueError("offline provider unavailable")
        return {"base_url": "https://offline.invalid/v1", "model": "gpt-6.1-sol",
                "api_style": "responses", "api_key": "SATISFIED_OFFLINE_PRIVATE"}

    def public(self):
        return {"configured": self.configured, "provider": {"model": "gpt-6.1-sol"}}


@pytest.fixture
def satisfied_studio(tmp_path, monkeypatch):
    # server's module-level app must also live entirely in the temporary tree
    # if this test file is run in isolation.
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.setenv("MUKBANG_CODEX_HOME", str(tmp_path / "absent-codex"))
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "0")
    from mukbang.server import create_app
    provider, calls = OfflineProvider(), []

    def offline_visual(prompts, sheets, directory, private):
        # Exercise the genuine image payload/hash validation, but no HTTP.
        payload = vision.make_payload(prompts, sheets, directory, private)
        calls.append({"prompt": deepcopy(prompts), "sheets": deepcopy(sheets), "payload": payload})
        data = json.loads(prompts["user"].split("\n", 1)[1])
        source = data["sources"][0]
        result = {"candidate_prompt": data["tuning_base_prompt"] + "\n" + RULE,
                  "summary": "根据满意轮次的可见画面提炼口鼻近景偏好",
                  "changes": [{"before": "", "after": RULE, "reason": "结合画面与本轮取舍",
                               "evidence": [{"job_id": source["job_id"], "frame_id": "F0002"}]}],
                  "warnings": []}
        if state.get("mutate_result"):
            state["mutate_result"](result)
        return {"text": json.dumps(result, ensure_ascii=False), "envelope": {"offline": True},
                "usage": {"total_tokens": 10}, "elapsed_seconds": .01}

    monkeypatch.setattr(vision, "call_vision", offline_visual)
    app = create_app(tmp_path / "data", provider, pipeline=lambda *_: pytest.fail("no video generation"))
    manager = app.state.manager
    state = {"app": app, "manager": manager, "provider": provider, "calls": calls}

    def add_round(*, feedback=True, round_number=2, template=None):
        actual = template or (app.state.prompt_library.active()["text"] + "\n本轮保留清楚的口鼻近景。")
        options = {"target_duration": 3, "min_duration": 2, "max_duration": 4,
                   "sample_interval": 1, "prompt": actual}
        record = manager.create("offline-fixture.mp4", options)
        directory = manager.jobs_dir / record["id"]
        (directory / "source.mp4").write_bytes(b"offline source never decoded")
        (directory / "sheets").mkdir()
        sheet_path = directory / "sheets/S01-input.jpg"
        Image.new("RGB", (96, 64), "gray").save(sheet_path)
        frames = [{"id": f"F{i+1:04d}", "time": i, "sheet_id": "S01", "row": 1, "col": i+1}
                  for i in range(2)]
        sheets = [{"id": "S01", "path": "sheets/S01-input.jpg", "width": 96, "height": 64,
                   "sha256": media.sha256(sheet_path), "count": 2}]
        sampling = {"interval": 1, "frames_per_sheet": 60, "frame_count": 2,
                    "sheet_count": 1, "frames": frames, "sheets": sheets}
        frozen = {"version": 7, "annotations": [{"frame_id": "F0002", "label": "like", "reason": ""}],
                  "note": "本轮喜欢自然进食"} if feedback else None
        source = {"duration": 3, "width": 96, "height": 64}
        context = {"round": round_number, "feedback": frozen, "previous_selected_frames": []} if feedback else None
        prompts = vision.build_prompts(options, source, sampling, context)
        manifest = vision.request_manifest(prompts, sheets, provider.private())
        fields = {"source": source, "sampling": sampling, "prompt": prompts,
                  "prompt_standard": {"mode": "custom", "sha256": hashlib.sha256(actual.encode()).hexdigest()},
                  "ai": {"call_count": 1, "request_manifest": manifest},
                  "result": {"selected_frames": [{"id": "F0001", "reason": "old model description"}]}}
        if feedback:
            fields.update(feedback=frozen, iteration={"round": round_number, "root_job_id": record["id"],
                                                     "parent_job_id": "111111111111"})
            media.write_json(directory / "feedback.json", frozen)
        for name, value in (("prompt.json", prompts), ("request-manifest.json", manifest), ("sampling.json", sampling)):
            media.write_json(directory / name, value)
        manager.finish(record["id"], "completed", fields)
        return manager.get(record["id"])

    state["add_round"] = add_round
    try:
        with TestClient(app) as client:
            state["client"] = client
            yield state
    finally:
        manager.executor.shutdown(wait=True, cancel_futures=True)


def submit(state, job, request_id="satisfied-round-request-0001", revision=0):
    return state["client"].post("/api/prompt-proposals/satisfied-round", json={
        "expected_revision": revision, "request_id": request_id, "job_id": job["id"]})


def finish(state, response):
    assert response.status_code == 202, response.text
    state["manager"].executor.submit(lambda: None).result(timeout=10)
    return state["client"].get(f"/api/prompt-proposals/{response.json()['id']}").json()


def test_satisfied_round_uses_actual_template_frozen_feedback_and_one_visual_request(satisfied_studio):
    state = satisfied_studio
    job = state["add_round"]()
    original = (state["manager"].jobs_dir / job["id"] / "job.json").read_bytes()
    # A new editable draft is NOT feedback that produced the displayed result.
    draft = {"version": 99, "annotations": [], "note": "SHOULD_NOT_BE_USED_DRAFT"}
    media.write_json(state["manager"].jobs_dir / job["id"] / "feedback-draft.json", draft)
    proposal = finish(state, submit(state, job))
    assert proposal["status"] == "completed", proposal.get("error")
    assert proposal["source_mode"] == "satisfied_round"
    assert proposal["tuning_base_prompt"] == job["options"]["prompt"]
    assert proposal["base_prompt"] == state["app"].state.prompt_library.active()["text"]
    assert proposal["satisfied_round"]["feedback_version"] == 7
    assert proposal["satisfied_round"]["annotation_count"] == 1
    assert proposal["satisfied_round"]["round"] == 2
    assert "SHOULD_NOT_BE_USED_DRAFT" not in json.dumps(proposal, ensure_ascii=False)
    assert proposal["ai"]["type"] == "visual"
    assert proposal["ai"]["call_count"] == proposal["ai"]["visual_call_count"] == 1
    assert proposal["ai"]["image_count"] == 1 and proposal["ai"]["text_call_count"] == 0
    assert len(state["calls"]) == 1
    assert len(state["calls"][0]["payload"]["input"][0]["content"]) == 2
    assert "没有图片" not in proposal["prompt"]["system"]
    assert proposal["candidate_prompt"].endswith(RULE)
    assert proposal["timings"]["status"] == "completed"
    assert state["client"].get("/api/prompt-library").json()["revision"] == 0
    assert (state["manager"].jobs_dir / job["id"] / "job.json").read_bytes() == original


def test_no_feedback_still_uses_images_and_does_not_treat_unselected_frames_as_negative(satisfied_studio):
    state = satisfied_studio
    job = state["add_round"](feedback=False)
    proposal = finish(state, submit(state, job))
    assert proposal["status"] == "completed", proposal.get("error")
    assert proposal["satisfied_round"]["annotation_count"] == 0
    assert proposal["satisfied_round"]["has_applied_feedback"] is False
    data = json.loads(proposal["prompt"]["user"].split("\n", 1)[1])
    assert data["selected_frame_ids"] == ["F0001"]
    assert data["sources"][0]["annotations"] == []
    assert {frame["id"] for frame in data["frames"]} == {"F0001", "F0002"}
    assert "未选中的帧不是负例" in proposal["prompt"]["system"]
    assert proposal["ai"]["visual_call_count"] == 1 and len(state["calls"]) == 1
    assert proposal["request_manifest"]["image_count"] == 1
    assert proposal["request_manifest"]["images"] == proposal["ai"]["request_manifest"]["images"]


def test_even_no_feedback_visual_proposal_requires_config(satisfied_studio):
    state = satisfied_studio
    job = state["add_round"](feedback=False)
    state["provider"].configured = False
    assert submit(state, job).status_code == 400
    assert state["calls"] == []


@pytest.mark.parametrize("status", ["failed", "cancelled", "rendering", "analyzing", "queued"])
def test_only_successful_selected_round_can_be_generalized(satisfied_studio, status):
    state = satisfied_studio
    job = state["add_round"]()
    state["manager"].emit(job["id"], {"status": status})
    assert submit(state, job).status_code == 409
    assert state["calls"] == []


@pytest.mark.parametrize("name", ["prompt.json", "request-manifest.json", "sampling.json", "feedback.json", "sheets/S01-input.jpg"])
def test_missing_saved_evidence_fails_before_ai(satisfied_studio, name):
    state = satisfied_studio
    job = state["add_round"]()
    (state["manager"].jobs_dir / job["id"] / name).unlink()
    assert submit(state, job).status_code == 400
    assert state["calls"] == []
    assert state["app"].state.prompt_library.public()["proposals"] == []


@pytest.mark.parametrize("corruption", ["hash", "template", "request", "feedback", "sheet", "manifest", "provider", "mapping"])
def test_available_evidence_mismatch_is_not_silently_repaired(satisfied_studio, corruption):
    state = satisfied_studio
    job = state["add_round"]()
    directory = state["manager"].jobs_dir / job["id"]
    if corruption == "hash":
        state["manager"].emit(job["id"], {"prompt_standard": {"sha256": "0" * 64}})
    elif corruption == "template":
        state["manager"].emit(job["id"], {"options": {**job["options"], "prompt": "different actual template"}, "prompt_standard": {}})
    elif corruption == "request":
        prompts = deepcopy(job["prompt"])
        prompts["user"] += "changed saved request"
        media.write_json(directory / "prompt.json", prompts)
    elif corruption == "feedback":
        changed = {**job["feedback"], "note": "changed applied opinion"}
        state["manager"].emit(job["id"], {"feedback": changed})
        media.write_json(directory / "feedback.json", changed)
    elif corruption == "sheet":
        (directory / "sheets/S01-input.jpg").write_bytes(b"different image bytes")
    elif corruption == "manifest":
        changed = deepcopy(job["ai"]["request_manifest"])
        changed["images"][0]["sha256"] = "0" * 64
        media.write_json(directory / "request-manifest.json", changed)
        state["manager"].emit(job["id"], {"ai": {**job["ai"], "request_manifest": changed}})
    elif corruption == "provider":
        state["manager"].emit(job["id"], {"ai": {**job["ai"], "model": "mismatched-model"}})
    else:
        changed = deepcopy(job["sampling"])
        changed["frames"][0]["col"] = 2
        media.write_json(directory / "sampling.json", changed)
        state["manager"].emit(job["id"], {"sampling": changed})
    assert submit(state, job).status_code == 400
    assert state["calls"] == []


def test_old_displayed_round_not_newest_family_and_global_diff_are_frozen(satisfied_studio):
    state = satisfied_studio
    chosen = state["add_round"](round_number=2)
    state["add_round"](round_number=3)
    library = state["app"].state.prompt_library
    new_global = library.active()["text"] + "\n当前新增的普通审美偏好。"
    library.create_version({"expected_revision": 0, "request_id": "publish-new-global-before-01", "text": new_global})
    proposal = finish(state, submit(state, chosen, revision=1))
    assert proposal["status"] == "completed", proposal.get("error")
    assert proposal["satisfied_round"]["job_id"] == chosen["id"]
    assert proposal["satisfied_round"]["round"] == 2
    assert proposal["tuning_base_prompt"] == chosen["options"]["prompt"]
    assert proposal["base_prompt"] == new_global and proposal["base_version_id"] == "P0002"
    assert proposal["base_revision"] == 1
    assert "-当前新增的普通审美偏好。" in proposal["diff"]


def test_same_request_confirmation_precedes_source_config_and_revision_checks(satisfied_studio):
    state = satisfied_studio
    job = state["add_round"]()
    first = finish(state, submit(state, job))
    library = state["app"].state.prompt_library
    library.create_version({"expected_revision": 0, "request_id": "unrelated-publish-after-001", "text": library.active()["text"]})
    state["provider"].configured = False
    state["manager"].jobs.pop(job["id"])
    repeated = submit(state, job)
    assert repeated.status_code == 202 and repeated.json()["id"] == first["id"]
    assert len(state["calls"]) == 1
    assert submit(state, {"id": "123456789abc"}).status_code == 409


def test_request_ids_cannot_cross_new_and_old_proposal_kinds(satisfied_studio):
    state = satisfied_studio
    job = state["add_round"]()
    first = finish(state, submit(state, job))
    old_body = {"expected_revision": 0, "request_id": "satisfied-round-request-0001",
                "sources": [{"job_id": job["id"], "feedback_version": 0}]}
    assert state["client"].post("/api/prompt-proposals", json=old_body).status_code == 409
    assert state["app"].state.prompt_library.get_proposal(first["id"])["status"] == "completed"
    assert len(state["calls"]) == 1


@pytest.mark.parametrize("baseline", ["round", "global"])
def test_generated_candidate_preserves_both_technical_baselines(satisfied_studio, baseline):
    state = satisfied_studio
    library = state["app"].state.prompt_library
    technical = "本测试独有技术原句，必须保留原声。"
    job = state["add_round"](template=library.active()["text"] + ("\n" + technical if baseline == "round" else ""))
    revision = 0
    if baseline == "global":
        library.create_version({"expected_revision": 0, "request_id": "publish-global-tech-only-01",
                                "text": library.active()["text"] + "\n" + technical})
        revision = 1
    else:
        state["mutate_result"] = lambda result: result.update(candidate_prompt=result["candidate_prompt"].replace(technical, ""))
    proposal = finish(state, submit(state, job, revision=revision))
    assert proposal["status"] == "failed"
    assert proposal["ai"]["visual_call_count"] == 1 and proposal["ai"]["raw_response"]
    assert proposal["candidate_prompt"] == "" and len(state["calls"]) == 1


@pytest.mark.parametrize("bad", ["unknown-frame", "instance-candidate", "malformed"])
def test_visual_candidate_failures_keep_raw_and_do_not_retry(satisfied_studio, bad):
    state = satisfied_studio
    job = state["add_round"]()
    def mutate(result):
        if bad == "unknown-frame":
            result["changes"][0]["evidence"][0]["frame_id"] = "F9999"
        elif bad == "instance-candidate":
            result["candidate_prompt"] += "\n永远选择F0002。"
        else:
            result["extra"] = "unsupported"
    state["mutate_result"] = mutate
    proposal = finish(state, submit(state, job))
    assert proposal["status"] == "failed" and proposal["ai"]["raw_response"]
    assert len(state["calls"]) == 1
    assert submit(state, job).json()["id"] == proposal["id"]
    assert len(state["calls"]) == 1


def test_publish_is_explicit_cas_and_rechecks_edited_candidate_technical_rules(satisfied_studio):
    state = satisfied_studio
    proposal = finish(state, submit(state, state["add_round"]()))
    removed = "不要添加配音、字幕、背景音乐、贴纸、慢放、加速、重播或拟造进食声。"
    assert removed in proposal["candidate_prompt"]
    body = {"expected_revision": 0, "request_id": "confirm-satisfied-standard-001", "proposal_id": proposal["id"],
            "text": proposal["candidate_prompt"].replace(removed, "")}
    assert state["client"].post("/api/prompt-library/versions", json=body).status_code == 400
    assert state["client"].get("/api/prompt-library").json()["revision"] == 0
    body["text"] = proposal["candidate_prompt"]
    response = state["client"].post("/api/prompt-library/versions", json=body)
    assert response.status_code == 201 and response.json()["revision"] == 1
    assert len(state["calls"]) == 1
    stale = {**body, "expected_revision": 1, "request_id": "confirm-old-candidate-new-001"}
    assert state["client"].post("/api/prompt-library/versions", json=stale).status_code == 409
