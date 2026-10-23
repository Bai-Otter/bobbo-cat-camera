from copy import deepcopy

import pytest

from mukbang.selection import SelectionError, validate_and_adjust, validate_result


FRAMES = [{"id": f"F{i + 1:04d}", "time": float(i)} for i in range(100)]


def fixture_result():
    return {"summary": "抬头舔鼻子", "selected_frames": [
        {"frame_id": "F0011", "score": 92, "reason": "眼睛和舌头都清楚", "labels": ["舔嘴"]},
        {"frame_id": "F0051", "score": 86, "reason": "可爱的抬头反应", "labels": ["抬头"]}],
        "highlight_clips": [
            {"id": "c01", "start": 8., "end": 14., "context_start": 3., "context_end": 29.,
             "title": "舔鼻子", "reason": "伸舌头", "score": 92, "frame_ids": ["F0011"]},
            {"id": "c02", "start": 48., "end": 55., "context_start": 40., "context_end": 69.,
             "title": "抬头", "reason": "看向镜头", "score": 86, "frame_ids": ["F0051"]}],
        "memes": [{"id": "m01", "start": 9.5, "end": 11., "title": "舔", "reason": "舌头卷鼻子",
                   "score": 92, "frame_ids": ["F0011"]}], "warnings": []}


def test_expand_only_approved_context():
    result = validate_and_adjust(fixture_result(), FRAMES, 100, {"target_duration": 40, "min_duration": 30, "max_duration": 50})
    assert sum(c["end"] - c["start"] for c in result["clips"]) == 40
    assert all(c["context_start"] <= c["start"] < c["end"] <= c["context_end"] for c in result["clips"])
    assert any(a["type"] == "expand_approved_context" for a in result["adjustments"])


def test_insufficient_material_is_warning_not_replay():
    source = fixture_result()
    for clip in source["highlight_clips"]:
        clip["context_start"], clip["context_end"] = clip["start"], clip["end"]
    result = validate_and_adjust(source, FRAMES, 100, {"target_duration": 40, "min_duration": 30, "max_duration": 50})
    assert len(result["clips"]) == 2
    assert sum(c["end"] - c["start"] for c in result["clips"]) == 13
    assert any("低于要求" in w for w in result["warnings"])


@pytest.mark.parametrize("mutation", [
    lambda r: r["selected_frames"][0].update(frame_id="F9999"),
    lambda r: r["highlight_clips"][0].update(start=-1),
    lambda r: r["highlight_clips"][0].update(end=101),
    lambda r: r["highlight_clips"][0].update(context_end=9),
    lambda r: r["highlight_clips"][0].update(frame_ids=["F0051"]),
    lambda r: r["selected_frames"][0].update(score=float("nan")),
    lambda r: r["memes"][0].update(end=16),
])
def test_reject_invalid_model_evidence(mutation):
    result = fixture_result()
    mutation(result)
    with pytest.raises(SelectionError):
        validate_result(result, FRAMES, 100)


def test_overlapping_same_event_is_merged_not_repeated():
    result = fixture_result()
    duplicate = deepcopy(result["highlight_clips"][0])
    duplicate.update(id="c03", start=9, end=15)
    result["highlight_clips"].append(duplicate)
    output = validate_and_adjust(result, FRAMES, 100, {"target_duration": 20, "min_duration": 15, "max_duration": 25})
    assert len(output["clips"]) == 2
    assert any(a["type"] == "merge_overlap" for a in output["adjustments"])


def test_frame_exactly_at_half_open_end_is_not_support():
    result = fixture_result()
    result["highlight_clips"][0].update(start=8., end=10.)
    with pytest.raises(SelectionError, match="没有任何"):
        validate_result(result, FRAMES, 100)


def test_duplicate_meme_is_exported_once():
    result = fixture_result()
    duplicate = deepcopy(result["memes"][0])
    duplicate.update(id="m02", score=80, start=9.7, end=11.5)
    result["memes"].append(duplicate)
    output = validate_and_adjust(result, FRAMES, 100, {"target_duration": 40, "min_duration": 30, "max_duration": 50})
    assert len(output["memes"]) == 1
    assert output["memes"][0]["id"] == "m01"
    assert any(a["type"] == "drop_duplicate_meme" for a in output["adjustments"])
