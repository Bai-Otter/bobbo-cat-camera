"""Same-video iteration fixtures; no images are viewed and no network opens."""
from copy import deepcopy
import json

import pytest

from mukbang import media, pipeline, vision
from mukbang.selection import SelectionError


@pytest.fixture
def cached_round(tmp_path, monkeypatch):
    parent = tmp_path / "parent"
    parent.mkdir()
    source = parent / "source.mp4"
    source.write_bytes(b"same-video offline source fixture")
    metadata = {"streams": [{"codec_type": "video", "time_base": "1/10", "width": 128,
                              "height": 192, "duration_ts": 120, "start_pts": 0, "duration": "12"}]}
    points = {"time_base": "1/10", "origin_pts": 0, "end_pts": 120, "pts": list(range(120))}
    media.write_json(parent / "source-metadata.json", metadata)
    media.write_json(parent / "source-pts.json", points)
    frames = []
    (parent / "samples").mkdir()
    (parent / "sheets").mkdir()
    for i in range(12):
        path = f"samples/frame-{i + 1:05d}.jpg"
        (parent / path).write_bytes(f"offline sample {i}".encode())
        frames.append({"id": f"F{i + 1:04d}", "time": float(i), "requested_time": float(i),
                       "source_frame_index": i * 10, "source_pts": i * 10, "path": path,
                       "url": media.artifact_url(parent, path), "sheet_id": "S01", "row": i // 6 + 1,
                       "col": i % 6 + 1, "box": [i % 6 * 10, i // 6 * 10, 10, 10],
                       "selected": True, "meme_selected": True, "score": 100, "reason": "OLD_CHOICE",
                       "labels": ["old"], "title": "old", "used_in_highlight": True})
    sheet_path = "sheets/S01-input.jpg"
    (parent / sheet_path).write_bytes(b"offline contact sheet not visually inspected")
    sampling = {"interval": 1., "frames_per_sheet": 60, "frame_count": 12, "sheet_count": 1,
                "frames": frames, "sheets": [{"id": "S01", "index": 1, "path": sheet_path,
                "url": media.artifact_url(parent, sheet_path), "count": 12, "width": 60, "height": 20,
                "sha256": media.sha256(parent / sheet_path), "frames": frames,
                "annotated_url": "/old/annotated.jpg", "annotated_path": "old.jpg", "selected_count": 12}]}
    media.write_json(parent / "sampling.json", sampling)
    digest = media.sha256(source)
    media.write_json(parent / "edit-timeline.json", {"source_sha256": digest})
    media.write_input_cache_integrity(parent, source, sampling, digest)
    feedback = {"version": 2, "annotations": [
        {"frame_id": "F0001", "label": "dislike", "reason": "低头看不到脸"},
        {"frame_id": "F0002", "label": "like", "reason": "喜欢这个表情"},
        {"frame_id": "F0003", "label": "like", "reason": "正面很可爱"}], "note": "多找看镜头的"}
    state = {"parent": parent, "source": source, "sampling": sampling, "digest": digest,
             "calls": 0, "requests": [], "feedback": feedback,
             "options": {"target_duration": 8, "min_duration": 7, "max_duration": 9,
                         "sample_interval": 1, "prompt": "本轮自定义提示"},
             "config": {"model": "offline-test", "base_url": "https://example.com/v1",
                        "api_style": "responses", "api_key": "PRIVATE_TEST_KEY"}}
    state["model_result"] = {"summary": "offline same-video test", "selected_frames": [
        {"frame_id": "F0003", "score": 90, "reason": "正脸", "labels": ["test"]},
        {"frame_id": "F0009", "score": 85, "reason": "抬头", "labels": ["test"]}],
        "highlight_clips": [
            {"id": "c01", "start": 1., "end": 4., "context_start": 0., "context_end": 5.,
             "title": "test1", "reason": "fixture", "score": 90, "frame_ids": ["F0003"]},
            {"id": "c02", "start": 7., "end": 10., "context_start": 6., "context_end": 12.,
             "title": "test2", "reason": "fixture", "score": 85, "frame_ids": ["F0009"]}],
        "memes": [], "warnings": []}
    def forbidden(*args, **kwargs):
        pytest.fail("same-video reuse must not probe, decode, sample or build sheets")
    for name in ("probe", "frame_times", "sample_video", "create_sheets", "run"):
        monkeypatch.setattr(media, name, forbidden)
    def provider(prompts, sheets, job_dir, config):
        state["calls"] += 1
        state["requests"].append({"prompts": deepcopy(prompts), "sheets": deepcopy(sheets)})
        assert all(not frame.get("selected") and "reason" not in frame and "score" not in frame
                   and "meme_selected" not in frame for frame in json.loads((job_dir / "sampling.json").read_text(encoding="utf-8"))["frames"])
        assert all("annotated_url" not in sheet and "annotated_path" not in sheet and "selected_count" not in sheet
                   for sheet in sheets)
        # Offline fake transport still exercises the exact real payload/manifest.
        payload = vision.make_payload(prompts, sheets, job_dir, config)
        assert len(payload["input"][0]["content"]) == len(sheets) + 1
        return {"text": json.dumps(state["model_result"], ensure_ascii=False), "envelope": {"fixture": True},
                "usage": {}, "elapsed_seconds": .01}
    monkeypatch.setattr(vision, "call_vision", provider)
    def annotate(job_dir, sample, selected, memes):
        chosen = {row["frame_id"]: row for row in selected}
        for frame in sample["frames"]:
            frame["selected"] = frame["id"] in chosen
            if frame["selected"]:
                frame.update({key: chosen[frame["id"]][key] for key in ("score", "reason", "labels")})
    monkeypatch.setattr(media, "annotate_sheets", annotate)
    monkeypatch.setattr(media, "render_video", lambda *args, **kwargs: {"actual_container_duration_seconds": 8})
    return state


def revision_for(state, parent=None, number=2):
    directory = parent or state["parent"]
    return {"reuse_from": directory, "parent_job_id": directory.name, "root_job_id": "parent", "round": number,
            "feedback": deepcopy(state["feedback"]), "previous_selected_frames": [
                {"frame_id": "F0001", "reason": "旧低头"}, {"id": "F0003", "reason": "旧正面"},
                {"frame_id": "F0007", "reason": "旧动作"}]}


def execute_revision(tmp_path, state, *, revision=None, name="round2"):
    target = tmp_path / name
    target.mkdir()
    updates = []
    result = pipeline.run_pipeline(target, target / "source.mp4", state["options"], state["config"],
                                   lambda row: updates.append(deepcopy(row)), lambda: False,
                                   revision=revision or revision_for(state))
    return target, result, updates


def test_reuse_preserves_source_ids_pts_and_rebases_all_urls(tmp_path, cached_round):
    state = cached_round
    target, result, _ = execute_revision(tmp_path, state)
    assert state["calls"] == result["ai"]["call_count"] == 1
    assert media.sha256(target / "source.mp4") == media.sha256(state["source"]) == state["digest"]
    assert (target / "source-pts.json").read_bytes() == (state["parent"] / "source-pts.json").read_bytes()
    assert [media._frame_input(frame) for frame in result["sampling"]["frames"]] == [
        media._frame_input(frame) for frame in state["sampling"]["frames"]]
    sampling = result["sampling"]
    assert all(f"/jobs/{target.name}/" in frame["url"] for frame in sampling["frames"])
    assert all(f"/jobs/{target.name}/" in sheet["url"] for sheet in sampling["sheets"])
    assert all(f"/jobs/{target.name}/" in frame["url"] for sheet in sampling["sheets"] for frame in sheet["frames"])
    assert result["source"]["video_url"].startswith(f"/api/jobs/{target.name}/")
    timings = {row["id"]: row for row in result["timings"]["stages"]}
    assert timings["reuse_inputs"]["status"] == "completed" and timings["reuse_inputs"]["seconds"] is not None
    for name in ("source_probe", "extract_frames", "build_sheets"):
        assert timings[name]["status"] == "skipped" and timings[name]["seconds"] is None
    # No unrelated parent config/job artifacts are copied.
    assert not (target / "job.json").exists()


def test_actual_prompt_and_comparison_include_current_feedback(tmp_path, cached_round):
    target, result, _ = execute_revision(tmp_path, cached_round)
    prompt = cached_round["requests"][0]["prompts"]
    assert '"round": 2' in prompt["user"] and '"source_time_seconds": 1.0' in prompt["user"]
    for text in ("低头看不到脸", "喜欢这个表情", "多找看镜头的", "旧低头", "旧正面", "本轮自定义提示"):
        assert text in prompt["user"]
    assert '"target_duration_seconds": 8' in prompt["user"]
    assert "dislike帧禁止" in prompt["system"] and "未标注的帧一律中性" in prompt["system"]
    comparison = json.loads((target / "comparison.json").read_text(encoding="utf-8"))
    assert comparison == result["comparison"]
    assert comparison["added_frame_ids"] == ["F0009"]
    assert comparison["removed_frame_ids"] == ["F0001", "F0007"]
    assert comparison["kept_frame_ids"] == ["F0003"]
    assert comparison["liked_selected_ids"] == ["F0003"]
    assert comparison["liked_omitted_ids"] == ["F0002"]
    assert comparison["disliked_selected_ids"] == []
    assert comparison["disliked_removed_ids"] == ["F0001"]
    assert any("F0002" in warning for warning in result["result"]["warnings"])
    assert result["feedback"] == cached_round["feedback"]
    manifest = json.loads((target / "request-manifest.json").read_text(encoding="utf-8"))
    assert manifest["user"] == prompt["user"]


def test_revision_audits_redundant_outside_reference_but_preserves_actual_ai_decision(tmp_path, cached_round):
    state = cached_round
    state["model_result"]["highlight_clips"][0]["frame_ids"].append("F0009")
    original = deepcopy(state["model_result"])
    target, result, _ = execute_revision(tmp_path, state)
    assert state["calls"] == result["ai"]["call_count"] == 1
    assert state["model_result"] == original == result["ai"]["parsed"]
    assert json.loads(result["ai"]["raw_response"]) == original
    assert json.loads((target / "ai-selection-original.json").read_text(encoding="utf-8")) == original
    assert json.loads((target / "ai-raw-response.txt").read_text(encoding="utf-8")) == original
    assert result["result"]["clips"][0]["frame_ids"] == ["F0003"]
    assert result["result"]["clips"][1]["frame_ids"] == ["F0009"]
    assert result["comparison"]["added_frame_ids"] == ["F0009"]
    audit = next(row for row in result["result"]["adjustments"] if row.get("clip_id") == "c01"
                 and row.get("before") == ["F0003", "F0009"] and row.get("after") == ["F0003"])
    assert audit["type"] == "drop_out_of_interval_references"
    assert audit["collection"] == "highlight_clips" and audit["interval"] == [0.0, 5.0]
    assert audit["removed"] == [{"frame_id": "F0009", "time": 8.0}]
    assert any("c01" in warning and "F0009" in warning for warning in result["result"]["warnings"])
    assert result["feedback"] == state["feedback"]


def test_disliked_selection_keeps_original_and_comparison_before_failing(tmp_path, cached_round):
    state = cached_round
    state["model_result"]["selected_frames"].append({"frame_id": "F0001", "score": 99, "reason": "wrong", "labels": []})
    target = tmp_path / "violating"
    target.mkdir()
    updates = []
    with pytest.raises(SelectionError, match="F0001"):
        pipeline.run_pipeline(target, target / "source.mp4", state["options"], state["config"],
                              updates.append, lambda: False, revision=revision_for(state))
    assert state["calls"] == 1 and not (target / "highlights.mp4").exists()
    assert json.loads((target / "comparison.json").read_text(encoding="utf-8"))["disliked_selected_ids"] == ["F0001"]
    original = json.loads((target / "ai-selection-original.json").read_text(encoding="utf-8"))
    assert original == state["model_result"]
    assert any("comparison" in update for update in updates)
    assert updates[-1]["timings"]["failed_stage"] == "selection"


def test_disliked_frame_cannot_be_cited_even_if_not_in_selected_list(tmp_path, cached_round):
    state = cached_round
    state["model_result"]["highlight_clips"][0]["frame_ids"].append("F0001")
    with pytest.raises(SelectionError, match="F0001"):
        execute_revision(tmp_path, state)
    assert state["calls"] == 1
    assert (tmp_path / "round2/comparison.json").exists()


@pytest.mark.parametrize("kind, selected", [("highlight_clips", True), ("highlight_clips", False),
                                            ("memes", True), ("memes", False)])
def test_outside_disliked_reference_fails_before_any_evidence_normalization(tmp_path, cached_round, monkeypatch, kind, selected):
    state = cached_round
    state["model_result"]["highlight_clips"][0]["context_start"] = 1.0
    if kind == "memes":
        state["model_result"]["memes"] = [{"id": "m01", "start": 1.5, "end": 3.0,
            "title": "fixture", "reason": "fixture", "score": 90, "frame_ids": ["F0003"]}]
    state["model_result"][kind][0]["frame_ids"].append("F0001")  # t=0, outside every allowed range.
    if selected:
        state["model_result"]["selected_frames"].append({"frame_id": "F0001", "score": 99,
                                                          "reason": "wrong", "labels": []})
    original = deepcopy(state["model_result"])
    def normalization_must_not_run(*args, **kwargs):
        pytest.fail("raw dislike violations must fail before evidence normalization")
    monkeypatch.setattr(pipeline.selection, "validate_and_adjust", normalization_must_not_run)
    with pytest.raises(SelectionError, match="F0001"):
        execute_revision(tmp_path, state)
    target = tmp_path / "round2"
    assert state["calls"] == 1 and not (target / "highlights.mp4").exists()
    assert state["model_result"] == original
    assert json.loads((target / "ai-selection-original.json").read_text(encoding="utf-8")) == original
    assert json.loads((target / "ai-raw-response.txt").read_text(encoding="utf-8")) == original
    comparison = json.loads((target / "comparison.json").read_text(encoding="utf-8"))
    assert comparison["disliked_selected_ids"] == (["F0001"] if selected else [])
    timings = json.loads((target / "timings.json").read_text(encoding="utf-8"))
    assert timings["status"] == "failed" and timings["failed_stage"] == "selection"


def test_two_revisions_use_snapshot_without_recursively_embedding_history(tmp_path, cached_round):
    state = cached_round
    parent, first, _ = execute_revision(tmp_path, state)
    second_revision = revision_for(state, parent, 3)
    second_revision["feedback"] = {"version": 3, "annotations": [], "note": "第二次当前意见"}
    second_revision["previous_selected_frames"] = first["result"]["selected_frames"]
    second_revision["prompt"] = "DO_NOT_EMBED_PRIOR_PROMPT"
    second_revision["previous_feedback_context"] = revision_for(state)
    _, second, _ = execute_revision(tmp_path, state, revision=second_revision, name="round3")
    assert state["calls"] == 2
    user = second["prompt"]["user"]
    assert '"round": 3' in user and user.count("同视频人工反馈（") == 1
    assert "第二次当前意见" in user
    assert "低头看不到脸" not in user and "多找看镜头的" not in user
    assert "DO_NOT_EMBED_PRIOR_PROMPT" not in user and '"reuse_from"' not in user
    assert second["feedback"]["annotations"] == []
    assert second["comparison"]["kept_frame_ids"] == ["F0003", "F0009"]


@pytest.mark.parametrize("corruption", ["source", "sheet", "sample", "pts", "mapping", "identity", "interval", "manifest"])
def test_corrupt_cache_fails_without_fallback_or_ai(tmp_path, cached_round, corruption):
    state = cached_round
    parent = state["parent"]
    if corruption == "source":
        state["source"].write_bytes(b"modified source")
    elif corruption == "sheet":
        (parent / "sheets/S01-input.jpg").write_bytes(b"modified board")
    elif corruption == "sample":
        (parent / "samples/frame-00001.jpg").write_bytes(b"modified sample")
    elif corruption == "pts":
        record = json.loads((parent / "source-pts.json").read_text(encoding="utf-8"))
        record["pts"][1] = 0
        media.write_json(parent / "source-pts.json", record)
    elif corruption in {"mapping", "identity"}:
        record = deepcopy(state["sampling"])
        if corruption == "mapping":
            record["frames"][0]["source_pts"] = 5
        else:
            record["sheets"][0]["id"] = "OTHER"
        media.write_json(parent / "sampling.json", record)
    elif corruption == "manifest":
        record = json.loads((parent / "input-cache-integrity.json").read_text(encoding="utf-8"))
        record.pop("source_sha256")
        media.write_json(parent / "input-cache-integrity.json", record)
    else:
        state["options"]["sample_interval"] = .5
    with pytest.raises(ValueError):
        execute_revision(tmp_path, state)
    assert state["calls"] == 0
    timings = json.loads((tmp_path / "round2/timings.json").read_text(encoding="utf-8"))
    assert timings["failed_stage"] == "reuse_inputs"
    assert next(row for row in timings["stages"] if row["id"] == "ai_request")["seconds"] is None


def test_legacy_failed_round_records_missing_historical_source_hash(tmp_path, cached_round):
    state = cached_round
    # This fixture emulates a parent failure before its timeline was written.
    (state["parent"] / "edit-timeline.json").unlink()
    (state["parent"] / "input-cache-integrity.json").unlink()
    target, _, _ = execute_revision(tmp_path, state)
    provenance = json.loads((target / "reuse-provenance.json").read_text(encoding="utf-8"))
    assert provenance["expected_source_sha256"] is None
    assert provenance["expected_source_sha256_from"] is None
    assert provenance["historic_source_hash_available"] is False
    assert provenance["historic_frame_hashes_available"] is False
    assert provenance["source_baseline_sha256"] == state["digest"]
    assert (target / "input-cache-integrity.json").exists()


def test_feedback_key_paste_is_redacted_in_actual_prompt_and_saved_artifacts(tmp_path, cached_round):
    state = cached_round
    state["feedback"]["note"] += " PRIVATE_TEST_KEY"
    state["feedback"]["annotations"][0]["reason"] += " PRIVATE_TEST_KEY"
    target, result, _ = execute_revision(tmp_path, state)
    assert "PRIVATE_TEST_KEY" not in json.dumps(result, ensure_ascii=False)
    for name in ("feedback.json", "prompt.json", "request-manifest.json", "result.json", "comparison.json"):
        assert "PRIVATE_TEST_KEY" not in (target / name).read_text(encoding="utf-8")
