import json

import pytest

from mukbang import media, pipeline
from test_pipeline import instrumented_pipeline  # Existing entirely offline phase fixture.


def ready_story():
    return {"status": "ready", "episode_id": "petting1", "title": "摸一下，再看看你", "summary": "人伸手摸猫，猫转头看向手。",
            "clips": [{"id": "s01", "episode_id": "petting1", "start": 0., "end": 4.,
                       "title": "摸摸与回头", "reason": "同镜头里可见手抚摸猫以及猫转头",
                       "frame_ids": ["F0002", "F0003"], "co_visible_frame_ids": [f"F{i:04d}" for i in range(1, 5)]}],
            "events": [{"id": "e01", "clip_id": "s01", "start": 1., "end": 2., "phase": "action",
                        "human_action": "手轻摸猫头", "pet_action": "猫停在手边", "frame_ids": ["F0002"],
                        "human_visible": True, "pet_visible": True},
                       {"id": "e02", "clip_id": "s01", "start": 2., "end": 3., "phase": "reaction",
                        "human_action": "手仍停在猫头旁", "pet_action": "猫转头看手", "frame_ids": ["F0003"],
                        "human_visible": True, "pet_visible": True, "reacts_to_event_id": "e01"}], "warnings": []}


def run_dual(tmp_path, state):
    state["options"].update(story_enabled=True, story_target_duration=30.)
    return pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], lambda _: None, lambda: False)


def test_same_response_produces_independent_two_videos_and_measured_cost(tmp_path, instrumented_pipeline):
    state = instrumented_pipeline
    state["parsed"]["interaction_story"] = ready_story()
    result = run_dual(tmp_path, state)
    outputs = result["result"]
    assert state["calls"] == result["ai"]["call_count"] == 1
    assert outputs["highlight_status"] == "ready"
    assert outputs["video_duration"] == 8.
    assert outputs["story"]["status"] == "ready"
    assert outputs["story"]["video_duration"] == 4.
    assert outputs["story"]["video_url"].endswith("interaction-story.mp4")
    assert outputs["story"]["events"][1]["output_start"] == 2.
    assert outputs["story"]["validation"]["visual_api_call_count"] == 1
    row = next(x for x in result["timings"]["stages"] if x["id"] == "render_story")
    assert row["seconds"] == 5. and row["status"] == "completed"
    assert json.loads((tmp_path / "story-timeline.json").read_text(encoding="utf-8"))["duration"] == 4.


@pytest.mark.parametrize("story_value,status", [
    ({"status": "not_found", "reason": "只有猫独自吃饭，没有可见人宠互动", "clips": [], "events": [], "warnings": []}, "not_found"),
    (None, "invalid"),
    ({"status": "ready", "clips": []}, "invalid"),
])
def test_missing_or_invalid_story_never_breaks_original_eating(tmp_path, instrumented_pipeline, story_value, status):
    state = instrumented_pipeline
    state["parsed"]["interaction_story"] = story_value
    result = run_dual(tmp_path, state)
    assert state["calls"] == 1
    assert result["result"]["video_duration"] == 8.
    assert result["result"]["story"]["status"] == status
    assert result["result"]["story"].get("video_url") is None
    assert not (tmp_path / "interaction-story.mp4").exists()


def test_valid_story_without_eating_does_not_invent_eating_clip(tmp_path, instrumented_pipeline):
    state = instrumented_pipeline
    state["parsed"].update(selected_frames=[], highlight_clips=[], memes=[], interaction_story=ready_story())
    result = run_dual(tmp_path, state)
    assert state["calls"] == 1
    assert result["result"]["video_url"] is None
    assert result["result"]["highlight_status"] == "not_found"
    assert result["result"]["story"]["status"] == "ready"


def test_story_render_failure_preserves_eating_and_never_retries(tmp_path, instrumented_pipeline, monkeypatch):
    state = instrumented_pipeline
    state["parsed"]["interaction_story"] = ready_story()
    original_render = media.render_video
    def render(source, destination, *args, **kwargs):
        if destination.name == "interaction-story.mp4":
            raise RuntimeError("offline story encode failure")
        return original_render(source, destination, *args, **kwargs)
    monkeypatch.setattr(media, "render_video", render)
    result = run_dual(tmp_path, state)
    assert result["result"]["highlight_status"] == "ready"
    assert result["result"]["story"]["status"] == "failed"
    assert "encode failure" in result["result"]["story"]["reason"]
    assert state["calls"] == 1


def test_no_eating_no_story_completes_analysis_with_no_fake_video(tmp_path, instrumented_pipeline):
    state = instrumented_pipeline
    state["parsed"].update(selected_frames=[], highlight_clips=[], memes=[], interaction_story={
        "status": "not_found", "reason": "没有可见交互", "clips": [], "events": [], "warnings": []})
    result = run_dual(tmp_path, state)
    assert result["result"]["highlight_status"] == result["result"]["story"]["status"] == "not_found"
    assert result["result"]["video_url"] is None
    assert result["result"]["story"].get("video_url") is None


def test_legacy_mode_does_not_add_story_output_or_render_cost(tmp_path, instrumented_pipeline):
    state = instrumented_pipeline
    state["parsed"]["interaction_story"] = ready_story()
    result = pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], lambda _: None, lambda: False)
    assert "story" not in result["result"]
    assert "highlight_status" not in result["result"]
    assert state["calls"] == 1


def test_monologue_upgrades_same_story_render_and_never_creates_a_third_video(tmp_path, instrumented_pipeline, monkeypatch):
    state = instrumented_pipeline
    value = ready_story()
    value.update(narrative_arc="人摸猫，猫随后回头看手。", reviewed_full_video=True, shortfall_reason="",
                 inner_monologues=[{"id": "m1", "clip_id": "s01", "event_id": "e01", "start": 1., "end": 2.4,
                                    "frame_ids": ["F0002"], "text": "咦？"}])
    state["parsed"]["interaction_story"] = value
    state["options"].update(story_enabled=True, story_mode="inner_monologue", story_target_duration=4)
    original_render, rendered = media.render_video, []
    def render(source, destination, clips, info, *args, subtitle_file=None, **kwargs):
        rendered.append((destination.name, subtitle_file))
        report = original_render(source, destination, clips, info, *args, **kwargs)
        return {**report, "actual_container_duration_seconds": sum(c["duration"] for c in clips)}
    monkeypatch.setattr(media, "render_video", render)
    result = pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], lambda _: None, lambda: False)
    assert state["calls"] == 1 and len(rendered) == 2
    assert rendered[0][1] is None
    assert rendered[1][0] == "interaction-story.mp4" and rendered[1][1].name == "interaction-story.ass"
    story_result = result["result"]["story"]
    assert story_result["validation"]["subtitles_burned_in"] is True
    assert story_result["validation"]["narration_added"] is False
    assert story_result["validation"]["bgm_added"] is False
    assert story_result["inner_monologues"][0]["output_start"] == 1.
    assert story_result["subtitle_url"].endswith(".srt")
    assert (tmp_path / "story-inner-monologues.json").exists()
    assert result["result"]["highlight_status"] == "ready"


def test_invalid_monologue_preserves_eating_without_a_second_ai_call(tmp_path, instrumented_pipeline):
    state = instrumented_pipeline
    state["parsed"]["interaction_story"] = ready_story()  # deliberately missing all new caption fields
    state["options"].update(story_enabled=True, story_mode="inner_monologue", story_target_duration=35)
    result = pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], lambda _: None, lambda: False)
    assert state["calls"] == 1
    assert result["result"]["highlight_status"] == "ready"
    assert result["result"]["story"]["status"] == "invalid"


@pytest.mark.parametrize("failure", [False, True])
def test_optional_paid_narration_success_or_fallback(tmp_path, instrumented_pipeline, monkeypatch, failure):
    from mukbang import narration
    state = instrumented_pipeline
    value = ready_story()
    value.update(narrative_arc="人摸猫，猫随后回头看手。", reviewed_full_video=True, shortfall_reason="",
                 inner_monologues=[{"id":"m1","clip_id":"s01","event_id":"e01","start":1.,"end":2.4,
                                    "frame_ids":["F0002"],"text":"咦？"}])
    state["parsed"]["interaction_story"] = value
    state["options"].update(story_enabled=True,story_mode="inner_monologue",story_target_duration=4)
    monkeypatch.setenv("MUKBANG_BREEZE_ENABLED", "1")
    monkeypatch.setattr(narration,"configured",lambda: object())
    def synth(*args):
        if failure:
            raise narration.NarrationError("Breeze配音失败（HTTP 429），未自动重试")
        return {"status":"ready","clips":[{"duration":1.5}],"seconds":1}
    monkeypatch.setattr(narration,"synthesize",synth)
    monkeypatch.setattr(narration,"mix_video",lambda *args: {"narration_added":True,"actual_container_duration_seconds":4})
    original_render = media.render_video
    def render(source,destination,clips,info,*args,subtitle_file=None,**kwargs):
        report=original_render(source,destination,clips,info,*args,**kwargs)
        return {**report,"actual_container_duration_seconds":sum(c["duration"] for c in clips)}
    monkeypatch.setattr(media,"render_video",render)
    output = pipeline.run_pipeline(tmp_path,state["source"],state["options"],state["config"],lambda _:None,lambda:False)
    result = output["result"]["story"]
    assert result["status"] == "ready"
    assert result["validation"]["narration_added"] is (not failure)
    assert state["calls"] == 1
    assert result["narration"]["status"] == ("failed" if failure else "ready")
    assert result["video_url"].endswith("interaction-story.mp4" if failure else "interaction-story-voiced.mp4")
