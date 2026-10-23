"""Text-only prompt proposals: strict evidence, no network, no cat imagery."""
from copy import deepcopy
import json
from pathlib import Path

import httpx
import pytest

from mukbang import prompt_tuning, vision


BASE = "优先选择正脸。\n不要为凑时长重复或变速。\n输出严格JSON，遵守实际目标时长和上下限。"
RULE = "优先选择正脸，能看清眼睛、鼻子和嘴。"


@pytest.fixture
def sources():
    return [{"job_id": "a123456789ab", "feedback_version": 3, "note": "不要把只顾吃饭的镜头都当可爱",
             "annotations": [{"frame_id": "F0001", "label": "like", "reason": "脸完整露出来才可爱",
                              "model_reason": "舔嘴很可爱", "model_labels": ["舔嘴"]},
                             {"frame_id": "F0002", "label": "dislike", "reason": "嘴被挡住了"}]},
            {"job_id": "b123456789ab", "feedback_version": 1, "note": "",
             "annotations": [{"frame_id": "F0008", "label": "like", "reason": ""}]}]


def valid_result(sources):
    return {"candidate_prompt": BASE.replace("优先选择正脸。", RULE), "summary": "明确完整正脸的判断依据",
            "changes": [{"before": "优先选择正脸。", "after": RULE, "reason": "用户明确说脸完整才可爱",
                         "evidence": [{"job_id": sources[0]["job_id"], "frame_id": "F0001"}]}],
            "warnings": []}


def parse(value, sources, base=BASE):
    return prompt_tuning.parse_tuning_result(json.dumps(value, ensure_ascii=False), base, sources)


def test_build_prompt_separates_user_preference_from_prior_model_context(sources):
    before = deepcopy(sources)
    prompts = prompt_tuning.build_tuning_prompts(BASE, sources, "保持自然，不要强行卖萌")
    assert set(prompts) == {"system", "user"}
    assert json.dumps(BASE, ensure_ascii=False)[1:-1] in prompts["user"]
    for text in ("保持自然，不要强行卖萌", "脸完整露出来才可爱", "嘴被挡住了", "F0008"):
        assert text in prompts["user"]
    for text in ("没有图片", "用户明确", "无理由", "旧AI", "局部", "技术约束", "不自动发布"):
        assert text in prompts["system"]
    assert "candidate_prompt" in prompts["system"] and "evidence" in prompts["system"]
    assert sources == before


def test_build_input_whitelist_never_sends_files_images_or_old_prompts(sources):
    sources[0].update(path="E:/private/file.mp4", image_url="data:image/jpeg;base64,not-a-real-image",
                      previous_prompt="SHOULD_NOT_LEAVE_THIS_OBJECT")
    prompts = prompt_tuning.build_tuning_prompts(BASE, sources)
    assert "E:/private" not in prompts["user"] and "data:image" not in prompts["user"]
    assert "SHOULD_NOT_LEAVE_THIS_OBJECT" not in prompts["user"]


def test_valid_result_keeps_exact_candidate_and_auditable_changes(sources):
    value = valid_result(sources)
    assert parse(value, sources) == value


@pytest.mark.parametrize("mutation", [
    lambda r: r.update(extra="not allowed"),
    lambda r: r.pop("warnings"),
    lambda r: r.update(candidate_prompt=123),
    lambda r: r.update(summary=" "),
    lambda r: r.update(changes={}),
    lambda r: r.update(warnings="fine"),
    lambda r: r["changes"][0].update(extra=1),
    lambda r: r["changes"][0].update(before=1),
    lambda r: r["changes"][0].update(reason=""),
    lambda r: r["changes"][0].update(evidence=[]),
    lambda r: r["changes"][0]["evidence"][0].update(extra="no"),
])
def test_strict_schema_rejects_unsupported_or_ambiguous_fields(sources, mutation):
    value = valid_result(sources)
    mutation(value)
    with pytest.raises(prompt_tuning.PromptTuningError):
        parse(value, sources)


@pytest.mark.parametrize("bad", ["选F0001和F0002。", "选f12345。", "参考a123456789ab。", "选cat_2026.mp4这一段。", "视频00:12之后都选。", "打开E:/private/cat.mov。"])
def test_candidate_cannot_carry_local_ids_files_or_timeline(sources, bad):
    value = valid_result(sources)
    value["candidate_prompt"] += "\n" + bad
    with pytest.raises(prompt_tuning.PromptTuningError):
        parse(value, sources)


def test_candidate_cannot_evade_source_job_id_filter_by_changing_case(sources):
    value = valid_result(sources)
    value["candidate_prompt"] += "\n参考来源" + sources[0]["job_id"].upper() + "的实例。"
    with pytest.raises(prompt_tuning.PromptTuningError, match="任务ID"):
        parse(value, sources)


@pytest.mark.parametrize("which", ["before", "after"])
def test_reported_change_must_really_exist_in_its_text(sources, which):
    value = valid_result(sources)
    value["changes"][0][which] = "THIS TEXT DOES NOT EXIST"
    with pytest.raises(prompt_tuning.PromptTuningError):
        parse(value, sources)


@pytest.mark.parametrize("evidence", [
    [{"job_id": "unknown-source", "frame_id": "F0001"}],
    [{"job_id": "a123456789ab", "frame_id": "F9999"}],
    [{"job_id": "b123456789ab", "frame_id": "F0001"}],
    [{"job_id": "b123456789ab"}],  # No source-level user note to support this citation.
])
def test_evidence_is_scoped_to_supplied_job_and_annotated_frame(sources, evidence):
    value = valid_result(sources)
    value["changes"][0]["evidence"] = evidence
    with pytest.raises(prompt_tuning.PromptTuningError):
        parse(value, sources)


def test_explicit_source_level_note_can_support_general_change(sources):
    value = valid_result(sources)
    value["changes"][0]["evidence"] = [{"job_id": sources[0]["job_id"]}]
    assert parse(value, sources)["changes"][0]["evidence"] == [{"job_id": sources[0]["job_id"]}]


def test_explicit_current_note_supports_job_level_citation_without_rewriting_source(sources):
    blank = [sources[1]]
    before = deepcopy(blank)
    value = valid_result(sources)
    value["changes"][0]["evidence"] = [{"job_id": blank[0]["job_id"]}]
    result = prompt_tuning.parse_tuning_result(json.dumps(value, ensure_ascii=False), BASE, blank,
                                             note="只有脸完整露出来才算可爱")
    assert result["candidate_prompt"] == value["candidate_prompt"]
    assert blank == before


def test_generic_process_numbers_are_not_mistaken_for_instance_timeline(sources):
    value = valid_result(sources)
    value["candidate_prompt"] += "\n每张60帧，表情包0.7–4秒；目标30–50秒，依实际设置。"
    assert parse(value, sources)["candidate_prompt"] == value["candidate_prompt"]


def test_annotation_budget_is_global_not_per_source(sources):
    source = sources[0]
    source["annotations"] = [{"frame_id": f"F{i:04d}", "label": "like", "reason": ""}
                             for i in range(1, 481)]
    with pytest.raises(prompt_tuning.PromptTuningError, match="480|少选"):
        prompt_tuning.build_tuning_prompts(BASE, sources)


def test_exactly_480_annotations_are_accepted_within_text_budget(sources):
    source = sources[0]
    source["annotations"] = [{"frame_id": f"F{i:04d}", "label": "like", "reason": ""}
                             for i in range(1, 481)]
    assert '"F0480"' in prompt_tuning.build_tuning_prompts(BASE, [source])["user"]


def test_character_budget_rejects_dense_old_ai_context_before_call(sources):
    source = sources[0]
    source["annotations"] = [{"frame_id": f"F{i:04d}", "label": "like", "reason": "明确用户理由",
                              "model_reason": "旧" * 4000} for i in range(1, 22)]
    with pytest.raises(prompt_tuning.PromptTuningError, match="80000|少选"):
        prompt_tuning.build_tuning_prompts(BASE, [source])


def test_reasonless_labels_cannot_be_only_basis_for_new_visual_preference(sources):
    value = valid_result(sources)
    value["changes"][0]["evidence"] = [{"job_id": sources[1]["job_id"], "frame_id": "F0008"}]
    with pytest.raises(prompt_tuning.PromptTuningError, match="明确|理由|依据"):
        parse(value, sources)


def test_unchanged_candidate_is_valid_when_information_is_insufficient(sources):
    blank = [sources[1]]
    value = {"candidate_prompt": BASE, "summary": "没有足够明确的用户理由，保持基线", "changes": [], "warnings": []}
    result = parse(value, blank)
    assert result["candidate_prompt"] == BASE and result["changes"] == []
    assert result["warnings"] and "理由" in "".join(result["warnings"])


def test_technical_constraints_cannot_be_removed_by_candidate(sources):
    value = valid_result(sources)
    value["candidate_prompt"] = RULE
    with pytest.raises(prompt_tuning.PromptTuningError, match="技术约束"):
        parse(value, sources)


def test_changed_candidate_needs_at_least_one_explicit_change(sources):
    value = valid_result(sources)
    value["changes"] = []
    with pytest.raises(prompt_tuning.PromptTuningError):
        parse(value, sources)


@pytest.mark.parametrize("raw", ['{"candidate_prompt":NaN}', '[]', 'not JSON'])
def test_invalid_json_has_visible_tuning_error(sources, raw):
    with pytest.raises(prompt_tuning.PromptTuningError):
        prompt_tuning.parse_tuning_result(raw, BASE, sources)


def test_call_tuning_delegates_once_with_zero_sheets_and_unchanged_configuration(monkeypatch):
    received = []
    returned = {"text": "{}", "envelope": {}, "usage": {}, "elapsed_seconds": .1}
    def fake(prompts, sheets, folder, config):
        received.append((prompts, sheets, folder, config))
        return returned
    monkeypatch.setattr(vision, "call_vision", fake)
    prompts, config = {"system": "system", "user": "user"}, {"model": "gpt-6.1-sol", "stream": True}
    assert prompt_tuning.call_tuning(prompts, config) is returned
    assert received == [(prompts, [], Path("."), config)]


def test_real_transport_is_one_text_post_with_existing_key_redaction(monkeypatch, sources):
    calls = []
    real_client = httpx.AsyncClient
    async def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"output_text": "OFFLINE_KEY_TEXT response", "usage": {"input_tokens": 5}})
    def client(**kwargs):
        assert kwargs["trust_env"] is False
        return real_client(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr(vision.httpx, "AsyncClient", client)
    monkeypatch.setattr(vision.httpx, "Client", lambda **kwargs: pytest.fail("text tuning must use the mocked async transport"))
    config = {"base_url": "https://example.com/v1", "api_style": "responses", "model": "gpt-6.1-sol", "api_key": "OFFLINE_KEY_TEXT"}
    result = prompt_tuning.call_tuning(prompt_tuning.build_tuning_prompts(BASE, sources), config)
    assert len(calls) == 1
    assert calls[0].method == "POST" and str(calls[0].url) == "https://example.com/v1/responses"
    assert calls[0].headers["authorization"] == "Bearer OFFLINE_KEY_TEXT"
    payload = json.loads(calls[0].content)
    assert payload["model"] == "gpt-6.1-sol"
    assert [item["type"] for item in payload["input"][0]["content"]] == ["input_text"]
    assert "OFFLINE_KEY_TEXT" not in result["text"] + json.dumps(result["envelope"])
    assert result["usage"] == {"input_tokens": 5}


def test_provider_failure_does_not_retry(monkeypatch):
    calls = []
    def fail(*args):
        calls.append(1)
        raise vision.VisionError("offline failure", "raw preserved by library")
    monkeypatch.setattr(vision, "call_vision", fail)
    with pytest.raises(vision.VisionError):
        prompt_tuning.call_tuning({"system": "s", "user": "u"}, {})
    assert calls == [1]
