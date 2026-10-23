"""Offline version/CAS/proposal tests; no media, provider, or credentials."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from threading import Event, Thread

import pytest
from pydantic import ValidationError

from mukbang.prompt_library import (LibraryError, PromptActivation, PromptLibrary,
                                    PromptVersionCreate, ProposalRequest)


BASE = "优先选择正脸。\n不要为凑时长重复或变速。\n输出严格JSON，遵守实际目标时长和上下限。"
EDIT = BASE.replace("优先选择正脸。", "优先选择正脸，能看清眼睛、鼻子和嘴。")
JOB = "a123456789ab"


class ManualExecutor:
    def __init__(self): self.pending = []
    def submit(self, fn, *args): self.pending.append((fn, args))
    def run(self):
        fn, args = self.pending.pop(0)
        fn(*args)


def publish(text=EDIT, revision=0, request="publish_request_0001", **extra):
    return {"expected_revision": revision, "request_id": request, "text": text, **extra}


def proposal(revision=0, request="proposal_request_0001", **extra):
    return {"expected_revision": revision, "request_id": request,
            "sources": [{"job_id": JOB, "feedback_version": 2}], **extra}


def sources():
    return [{"job_id": JOB, "feedback_version": 2, "note": "脸完整露出来才可爱",
             "annotations": [{"frame_id": "F0001", "label": "like", "reason": "脸要完整"}]}]


def model_result(text=EDIT):
    return {"candidate_prompt": text, "summary": "明确完整正脸的判断依据",
            "changes": [{"before": "优先选择正脸。", "after": "优先选择正脸，能看清眼睛、鼻子和嘴。",
                         "reason": "用户明确要求脸完整", "evidence": [{"job_id": JOB, "frame_id": "F0001"}]}],
            "warnings": []}


def caller(prompts, config):
    return {"text": json.dumps(model_result(), ensure_ascii=False), "envelope": {"id": "offline"},
            "usage": {"input_tokens": 15}, "elapsed_seconds": .01}


@pytest.fixture
def lib(tmp_path):
    return PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=caller)


def test_initial_baseline_is_immutable_and_loaded_text_is_not_overwritten(tmp_path):
    library = PromptLibrary(tmp_path, BASE, ManualExecutor())
    assert library.public()["revision"] == 0
    assert library.active()["id"] == "P0001"
    copy = library.active()
    copy["text"] = "do not mutate"
    assert library.active()["text"] == BASE
    loaded = PromptLibrary(tmp_path, "different baseline", ManualExecutor())
    assert loaded.active()["text"] == BASE


def test_publish_creates_version_true_diff_and_revision(lib):
    old = lib.active()
    result = lib.create_version(publish())
    assert result["revision"] == 1 and result["active_version_id"] == "P0002"
    assert result["versions"][0] == old
    version = lib.active()
    assert version["text"] == EDIT and version["parent_version_id"] == "P0001"
    assert "-优先选择正脸。" in version["diff"]
    assert "+优先选择正脸，能看清眼睛、鼻子和嘴。" in version["diff"]


def test_real_diff_keeps_newline_only_changes_visible(lib):
    lib.create_version(publish(BASE + "\n"))
    assert lib.active()["diff"]
    assert "No newline at end of file" in lib.active()["diff"]


def test_publish_idempotency_precedes_stale_revision_and_survives_restart(lib, tmp_path):
    lib.create_version(publish())
    lib.create_version(publish("另外的通用规则", 1, "publish_request_0002"))
    loaded = PromptLibrary(tmp_path, "ignored", ManualExecutor())
    result = loaded.create_version(publish())
    assert result["revision"] == 2 and len(result["versions"]) == 3
    with pytest.raises(LibraryError) as caught:
        loaded.create_version(publish("different"))
    assert caught.value.status_code == 409


def test_stale_and_aba_revision_cannot_publish(lib):
    lib.create_version(publish())
    lib.activate({"expected_revision": 1, "request_id": "activate_request_001", "version_id": "P0001"})
    assert lib.public()["revision"] == 2 and lib.active()["text"] == BASE
    with pytest.raises(LibraryError) as caught:
        lib.create_version(publish("stale", request="publish_request_stale"))
    assert caught.value.status_code == 409


def test_rollback_changes_pointer_not_old_version_and_is_idempotent(lib):
    lib.create_version(publish())
    before = lib.public()["versions"]
    values = {"expected_revision": 1, "request_id": "activate_request_001", "version_id": "P0001"}
    lib.activate(values)
    assert lib.public()["versions"] == before
    assert lib.activate(values)["revision"] == 2


@pytest.mark.parametrize("text", ["", " ", "选择F0001", "选择f123456", "打开E:/private/cat.mp4", "file:///tmp/cat.mp4",
                                 "用cat_2026.mp4这个文件", "参考a123456789ab的结果", "从00:12开始选"])
def test_generic_versions_reject_empty_or_video_local_instructions(lib, text):
    with pytest.raises(LibraryError): lib.create_version(publish(text))
    assert lib.public()["revision"] == 0


@pytest.mark.parametrize("model,values", [
    (PromptVersionCreate, publish(revision=True)),
    (PromptVersionCreate, publish(revision="0")),
    (PromptVersionCreate, publish(revision=-1)),
    (PromptVersionCreate, publish(request="short")),
    (PromptVersionCreate, publish(path="E:/private")),
    (PromptActivation, {"expected_revision": 0, "request_id": "activation_request1", "version_id": "../P0001"}),
    (ProposalRequest, proposal(sources=[])),
    (ProposalRequest, proposal(sources=[{"job_id": JOB, "feedback_version": True}])),
    (ProposalRequest, proposal(sources=[{"job_id": JOB, "feedback_version": 0}] * 2)),
])
def test_requests_are_strict_and_forbid_extra_fields(model, values):
    with pytest.raises(ValidationError): model.model_validate(values)


def test_proposal_is_frozen_zero_images_one_text_call_and_never_auto_active(lib):
    frozen = sources()
    record = lib.create_proposal(proposal(), frozen, {"api_key": "OFFLINE_PRIVATE_KEY", "model": "offline"})
    frozen[0]["note"] = "changed after submit"
    assert record["status"] == "queued" and record["ai"]["call_count"] == 0
    assert record["base_prompt"] == BASE and record["base_revision"] == 0
    assert record["sources"][0]["note"] != frozen[0]["note"]
    lib.executor.run()
    done = lib.get_proposal(record["id"])
    assert done["status"] == "completed" and done["candidate_prompt"] == EDIT
    assert done["ai"]["call_count"] == done["ai"]["text_call_count"] == 1
    assert done["ai"]["visual_call_count"] == done["ai"]["image_count"] == 0
    assert done["ai"]["usage"] == {"input_tokens": 15}
    assert done["ai"]["raw_response"] and done["prompt"]["system"]
    assert done["timings"]["status"] == "completed" and done["timings"]["scope"] == "prompt_tuning"
    assert lib.active()["id"] == "P0001" and lib.public()["revision"] == 0
    assert "+优先选择正脸，能看清眼睛、鼻子和嘴。" in done["diff"]


def test_proposal_retry_precedes_new_source_state_and_revision(lib):
    first = lib.create_proposal(proposal(), sources(), {})
    lib.create_version(publish())
    assert lib.existing_proposal(proposal())["id"] == first["id"]
    assert lib.create_proposal(proposal(), [], {})["id"] == first["id"]
    assert len(lib.executor.pending) == 1
    with pytest.raises(LibraryError) as caught:
        lib.existing_proposal(proposal(note="different"))
    assert caught.value.status_code == 409


def test_candidate_requires_completed_current_base_but_allows_user_edit(lib):
    record = lib.create_proposal(proposal(), sources(), {})
    with pytest.raises(LibraryError):
        lib.create_version(publish(proposal_id=record["id"]))
    lib.executor.run()
    edited = EDIT + "\n动作保持自然。"
    result = lib.create_version(publish(edited, proposal_id=record["id"]))
    assert result["revision"] == 1 and lib.active()["text"] == edited
    assert lib.active()["source_proposal_id"] == record["id"]


def test_candidate_from_old_base_cannot_publish_after_other_publication(lib):
    record = lib.create_proposal(proposal(), sources(), {})
    lib.executor.run()
    lib.create_version(publish())
    with pytest.raises(LibraryError) as caught:
        lib.create_version(publish(EDIT, revision=1, request="another_publish_001", proposal_id=record["id"]))
    assert caught.value.status_code == 409


def test_failure_preserves_attempt_accounting_and_redacts_every_saved_surface(tmp_path):
    key = "OFFLINE_SECRET_VALUE"
    class OfflineFailure(Exception):
        raw_text = key + " raw body"
    def fail(*args): raise OfflineFailure(key + " failure")
    library = PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=fail)
    values = proposal(note="用户误贴 " + key)
    frozen = sources()
    frozen[0]["note"] += key
    record = library.create_proposal(values, frozen, {"api_key": key})
    library.executor.run()
    done = library.get_proposal(record["id"])
    assert done["status"] == "failed" and done["ai"]["text_call_count"] == 1
    assert done["ai"].get("successful_text_call_count", 0) == 0
    assert done["ai"]["raw_response"]
    assert key not in json.dumps(done, ensure_ascii=False)
    assert all(key not in path.read_text(encoding="utf-8") for path in tmp_path.rglob("*.json"))
    assert library.active()["id"] == "P0001"


def test_restart_interrupts_without_resubmitting_or_inventing_elapsed_time(lib, tmp_path):
    original = lib.create_proposal(proposal(), sources(), {})
    saved = json.loads((tmp_path / "prompt-proposals" / (original["id"] + ".json")).read_text(encoding="utf-8"))
    loaded_executor = ManualExecutor()
    loaded = PromptLibrary(tmp_path, "ignored", loaded_executor, caller=caller)
    interrupted = loaded.get_proposal(original["id"])
    assert interrupted["status"] == "interrupted" and loaded_executor.pending == []
    assert interrupted["ai"]["call_count"] == 0
    assert interrupted["timings"]["status"] == "interrupted"
    assert interrupted["timings"]["total_seconds"] == saved["timings"]["total_seconds"]
    assert loaded.existing_proposal(proposal())["id"] == original["id"]


def test_manual_publish_redacts_current_key_before_persisting(lib, tmp_path):
    lib.create_version(publish("通用说明 OFFLINE_KEY"), secret="OFFLINE_KEY")
    assert "OFFLINE_KEY" not in lib.active()["text"]
    assert all("OFFLINE_KEY" not in p.read_text(encoding="utf-8") for p in tmp_path.rglob("*.json"))


def test_proposal_unknown_id_is_safe_and_copies_are_isolated(lib):
    with pytest.raises(LibraryError) as caught: lib.get_proposal("../../private")
    assert caught.value.status_code == 404
    first = lib.create_proposal(proposal(), sources(), {})
    first["sources"][0]["note"] = "changed"
    assert lib.get_proposal(first["id"])["sources"][0]["note"] != "changed"


def test_pasted_key_in_request_id_never_persists_but_idempotency_still_works(lib, tmp_path):
    secret = "accidentally_pasted_key_12345"
    values = publish(request=secret)
    lib.create_version(values, secret=secret)
    assert lib.create_version(values, secret=secret)["revision"] == 1
    assert all(secret not in p.read_text(encoding="utf-8") for p in tmp_path.rglob("*.json"))


def test_pasted_key_proposal_request_id_is_redacted_without_losing_identity(tmp_path):
    secret = "proposal_pasted_key_12345"
    library = PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=caller)
    values = proposal(request=secret)
    first = library.create_proposal(values, sources(), {"api_key": secret})
    assert library.existing_proposal(values)["id"] == first["id"]
    assert all(secret not in p.read_text(encoding="utf-8") for p in tmp_path.rglob("*.json"))


def test_failed_atomic_publication_keeps_memory_and_disk_baseline(lib, monkeypatch, tmp_path):
    before = (tmp_path / "prompt-library.json").read_text(encoding="utf-8")
    def fail(): raise OSError("offline disk failure")
    monkeypatch.setattr(lib, "_save_library", fail)
    with pytest.raises(LibraryError): lib.create_version(publish())
    assert lib.public()["revision"] == 0 and lib.active()["id"] == "P0001"
    assert (tmp_path / "prompt-library.json").read_text(encoding="utf-8") == before


def test_corrupted_library_is_not_silently_overwritten(tmp_path):
    path = tmp_path / "prompt-library.json"
    path.write_text("broken evidence", encoding="utf-8")
    with pytest.raises(LibraryError): PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=caller)
    assert path.read_text(encoding="utf-8") == "broken evidence"


def test_only_one_of_two_concurrent_cas_publications_wins(lib):
    def submit(index):
        try:
            lib.create_version(publish(EDIT + str(index), request=f"concurrent_publish_{index:02d}"))
            return "ok"
        except LibraryError as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, range(2)))
    assert sorted(results, key=str) == [409, "ok"]
    assert lib.public()["revision"] == 1 and len(lib.public()["versions"]) == 2


def test_actual_diff_is_computed_not_trusted_model_changes(lib):
    first = lib.create_proposal(proposal(), sources(), {})
    lib.executor.run()
    done = lib.get_proposal(first["id"])
    assert "---" in done["diff"] and "+++" in done["diff"]
    assert done["changes"][0]["reason"] not in done["diff"]


def test_invalid_model_json_preserves_raw_response_and_does_not_publish(tmp_path):
    library = PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=lambda *args: {"text": "not JSON", "usage": {"x": 1}})
    first = library.create_proposal(proposal(), sources(), {})
    library.executor.run()
    done = library.get_proposal(first["id"])
    assert done["status"] == "failed" and done["ai"]["raw_response"] == "not JSON"
    assert done["ai"]["text_call_count"] == 1 and done["ai"]["successful_text_call_count"] == 1
    assert library.public()["revision"] == 0


def test_no_request_attempt_when_executor_rejects_submission(tmp_path):
    class ClosedExecutor:
        def submit(self, *args): raise RuntimeError("offline closed executor")
    library = PromptLibrary(tmp_path, BASE, ClosedExecutor(), caller=caller)
    done = library.create_proposal(proposal(), sources(), {})
    assert done["status"] == "failed" and done["ai"]["call_count"] == 0
    assert done["timings"]["status"] == "failed"


def test_explicit_overall_note_is_passed_without_rewriting_source_notes(tmp_path):
    frozen = sources()
    frozen[0]["note"] = ""
    frozen[0]["annotations"][0]["reason"] = ""
    value = model_result()
    value["changes"][0]["evidence"] = [{"job_id": JOB}]
    library = PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=lambda *args: {"text": json.dumps(value, ensure_ascii=False)})
    first = library.create_proposal(proposal(note="请明确正脸要看清眼睛、鼻子和嘴"), frozen, {})
    library.executor.run()
    done = library.get_proposal(first["id"])
    assert done["status"] == "completed", done.get("error")
    assert done["sources"][0]["note"] == ""
    assert "请明确正脸" in done["prompt"]["user"]


def test_nonfinite_model_envelope_fails_cleanly_instead_of_poisoning_saved_record(tmp_path):
    response = caller({}, {})
    response["usage"]["input_tokens"] = float("nan")
    library = PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=lambda *args: response)
    first = library.create_proposal(proposal(), sources(), {})
    library.executor.run()
    done = library.get_proposal(first["id"])
    assert done["status"] == "failed" and done["timings"]["status"] == "failed"
    assert "NaN" not in json.dumps(done, ensure_ascii=False)


def test_get_cannot_observe_running_record_with_terminal_timings(lib, monkeypatch):
    first = lib.create_proposal(proposal(), sources(), {})
    timer = lib.timings[first["id"]]
    original_finish = timer.finish
    reached, release, reader_done = Event(), Event(), Event()
    observed = []
    def paused_finish(status):
        snapshot = original_finish(status)
        reached.set()
        assert release.wait(3)
        return snapshot
    monkeypatch.setattr(timer, "finish", paused_finish)
    worker = Thread(target=lib.executor.run)
    worker.start()
    assert reached.wait(3)
    def read():
        observed.append(lib.get_proposal(first["id"]))
        reader_done.set()
    reader = Thread(target=read)
    reader.start()
    try:
        assert not reader_done.wait(.05)
    finally:
        release.set()
        worker.join(3)
        reader.join(3)
    assert reader_done.is_set()
    assert observed[0]["status"] == observed[0]["timings"]["status"] == "completed"


def test_completed_proposal_is_frozen_and_idempotent_after_restart(lib, tmp_path):
    first = lib.create_proposal(proposal(), sources(), {})
    lib.executor.run()
    before = lib.get_proposal(first["id"])
    executor = ManualExecutor()
    loaded = PromptLibrary(tmp_path, "ignored", executor, caller=caller)
    assert loaded.get_proposal(first["id"]) == before
    assert loaded.create_proposal(proposal(), [], {}) == before
    assert executor.pending == []


def test_one_request_id_cannot_be_reused_for_other_operation(lib):
    values = publish()
    lib.create_version(values)
    with pytest.raises(LibraryError) as caught:
        lib.activate({"expected_revision": 1, "request_id": values["request_id"], "version_id": "P0001"})
    assert caught.value.status_code == 409
    with pytest.raises(LibraryError): lib.existing_proposal(proposal(request=values["request_id"]))


def test_private_configuration_is_cleared_only_on_worker_copy(tmp_path):
    captured = []
    def inspect(prompts, private):
        captured.append(private)
        return caller(prompts, private)
    private = {"api_key": "OFFLINE_KEY_CLEAR", "model": "offline"}
    library = PromptLibrary(tmp_path, BASE, ManualExecutor(), caller=inspect)
    library.create_proposal(proposal(), sources(), private)
    library.executor.run()
    assert captured == [{}]
    assert private == {"api_key": "OFFLINE_KEY_CLEAR", "model": "offline"}
    assert all("OFFLINE_KEY_CLEAR" not in p.read_text(encoding="utf-8") for p in tmp_path.rglob("*.json"))
