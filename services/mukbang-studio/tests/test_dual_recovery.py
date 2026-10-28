"""Saved dual-output recovery is offline and leaves original evidence intact."""
from copy import deepcopy
import json

import pytest

from mukbang import media, recovery
from test_dual_regressions import interaction_story
from test_recovery import (RECOVERY_ID, SOURCE_ID, hashes, saved_failure,
                           save_selection_failure, synthetic_failure)


def save_dual_failure(data, failed_stage="render_highlight", *, eating="valid", story="ready"):
    original = data / "jobs" / SOURCE_ID
    record = json.loads((original / "job.json").read_text(encoding="utf-8"))
    record["options"].update(story_enabled=True, story_target_duration=30)
    record["timings"]["failed_stage"] = failed_stage
    parsed = deepcopy(record["ai"]["parsed"])
    if eating == "absent":
        parsed.update(selected_frames=[], highlight_clips=[], memes=[])
    elif eating == "invalid":
        parsed["selected_frames"] = "invalid eating schema"
    parsed["interaction_story"] = interaction_story() if story == "ready" else {
        "status": "not_found", "reason": "合成测试没有互动证据", "clips": [], "events": [], "warnings": []}
    if story == "outward_only":
        # Valid source evidence but inward quantization loses the reaction's
        # anchor; recovery must not expand the approved same-frame interval.
        parsed["interaction_story"] = interaction_story()
        clip = parsed["interaction_story"]["clips"][0]
        clip.update(start=.99, end=2.01)
        clip["frame_ids"] = clip["co_visible_frame_ids"] = ["F0002", "F0003"]
        parsed["interaction_story"]["events"][0].update(start=.99, end=1.01)
        parsed["interaction_story"]["events"][1].update(start=1.99, end=2.01, frame_ids=["F0003"])
    raw = json.dumps(parsed, ensure_ascii=False)
    record["ai"].update(parsed=parsed, raw_response=raw)
    envelope = json.loads((original / "ai-response-envelope.json").read_text(encoding="utf-8"))
    envelope["output_text"] = raw
    for name, value in (("job.json", record), ("ai-selection-original.json", parsed),
                        ("ai-response-envelope.json", envelope)):
        media.write_json(original / name, value)
    (original / "ai-raw-response.txt").write_text(raw, encoding="utf-8")
    return original


@pytest.mark.parametrize("failed_stage", ["selection", "render_highlight", "render_story", "final_validation"])
def test_saved_dual_job_recovery_revalidates_story_without_new_calls_or_resampling(saved_failure, failed_stage):
    original = save_dual_failure(saved_failure, failed_stage)
    before = hashes(original)
    final = recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert final["status"] == "completed" and final["ai"]["call_count"] == 0
    assert final["result"]["highlight_status"] == final["result"]["story"]["status"] == "ready"
    assert final["result"]["story"]["validation"]["visual_api_call_count"] == 0
    assert final["result"]["story"]["validation"]["reused_ai_result"] is True
    assert final["result"]["story"]["validation"]["source_job_id"] == SOURCE_ID
    assert hashes(original) == before


@pytest.mark.parametrize("eating", ["absent", "invalid"])
def test_recovery_keeps_valid_story_even_when_eating_cannot_be_delivered(saved_failure, eating):
    original = save_dual_failure(saved_failure, "selection", eating=eating)
    before = hashes(original)
    final = recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert final["status"] == "completed"
    assert final["result"]["highlight_status"] == ("invalid" if eating == "invalid" else "not_found")
    assert final["result"]["story"]["status"] == "ready"
    assert final["result"]["video_url"] is None
    assert final["ai"]["call_count"] == 0
    assert hashes(original) == before


@pytest.mark.parametrize("story", ["not_found", "outward_only"])
def test_recovery_rejects_no_deliverable_product_before_creating_job(saved_failure, story):
    original = save_dual_failure(saved_failure, "selection", eating="absent", story=story)
    before = hashes(original)
    with pytest.raises(ValueError, match="片段|证据|视频|量化"):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert not (saved_failure / "jobs" / RECOVERY_ID).exists()
    assert hashes(original) == before


@pytest.mark.parametrize("field,value", [("story_enabled", "true"), ("story_enabled", 1),
                                        ("story_target_duration", 61), ("story_target_duration", float("nan"))])
def test_recovery_rejects_invalid_dual_options_before_creating_job(saved_failure, field, value):
    original = save_dual_failure(saved_failure)
    record = json.loads((original / "job.json").read_text(encoding="utf-8"))
    record["options"][field] = value
    media.write_json(original / "job.json", record)
    before = hashes(original)
    with pytest.raises(ValueError, match="参数|时长|story|不可读取"):
        recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert not (saved_failure / "jobs" / RECOVERY_ID).exists()
    assert hashes(original) == before


def test_monologue_recovery_keeps_subtitles_and_original_record_without_ai(saved_failure):
    original = save_dual_failure(saved_failure, eating="absent")
    record = json.loads((original / "job.json").read_text(encoding="utf-8"))
    record["options"].update(story_mode="inner_monologue", story_target_duration=3)
    media.write_json(original / "job.json", record)
    def add_captions(parsed):
        parsed["interaction_story"].update(narrative_arc="合成动作随后发生合成反应。", reviewed_full_video=True,
            shortfall_reason="", inner_monologues=[{"id": "m1", "clip_id": "s01", "event_id": "reaction",
                "start": 2., "end": 3.4, "frame_ids": ["F0003"], "text": "咦？"}])
    save_selection_failure(saved_failure, add_captions)
    before = hashes(original)
    final = recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert final["status"] == "completed" and final["ai"]["call_count"] == 0
    output = final["result"]["story"]
    assert output["status"] == "ready" and output["validation"]["subtitles_burned_in"] is True
    assert output["validation"]["narration_added"] is False
    assert output["inner_monologues"][0]["output_start"] == 1.
    assert (saved_failure / "jobs" / RECOVERY_ID / "interaction-story.srt").exists()
    assert hashes(original) == before


def test_photos_only_recovery_exports_saved_exact_frames_without_ai(saved_failure):
    from test_photos import sample_photos
    original = save_dual_failure(saved_failure, eating="invalid", story="not_found")
    record = json.loads((original / "job.json").read_text(encoding="utf-8"))
    record["options"]["photos_enabled"] = True
    media.write_json(original / "job.json", record)
    save_selection_failure(saved_failure, lambda parsed: parsed.update(daily_photos=sample_photos()))
    before = hashes(original)
    final = recovery.recover_render(saved_failure, SOURCE_ID, job_id=RECOVERY_ID)
    assert final["status"] == "completed" and final["ai"]["call_count"] == 0
    assert final["result"]["video_url"] is None
    assert all(p["status"] == "ready" for p in final["result"]["photos"].values())
    assert (saved_failure / "jobs" / RECOVERY_ID / "photo-decision.json").exists()
    assert hashes(original) == before
