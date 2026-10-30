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


def test_bad_optional_meme_does_not_block_both_videos_or_retry_vision(tmp_path, instrumented_pipeline):
    state = instrumented_pipeline
    state["parsed"]["interaction_story"] = ready_story()
    state["parsed"]["memes"][0].update(end=1.7)
    output = run_dual(tmp_path, state)
    assert output["result"]["highlight_status"] == "ready"
    assert output["result"]["story"]["status"] == "ready"
    assert output["result"]["memes"] == []
    assert any(a["type"] == "skip_invalid_meme" for a in output["result"]["adjustments"])
    assert state["calls"] == 1


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


@pytest.mark.parametrize("head_mode", [False, True])
def test_monologue_upgrades_same_story_render_and_never_creates_a_third_video(tmp_path, instrumented_pipeline, monkeypatch, head_mode):
    state = instrumented_pipeline
    value = ready_story()
    value.update(narrative_arc="人摸猫，猫随后回头看手。", reviewed_full_video=True, shortfall_reason="",
                 inner_monologues=[{"id": "m1", "clip_id": "s01", "event_id": "e01", "start": 1., "end": 2.4,
                                    "frame_ids": ["F0002"], "text": "咦？"}])
    state["parsed"]["interaction_story"] = value
    state["options"].update(story_enabled=True, story_mode="inner_monologue", story_target_duration=4)
    if head_mode:
        value["inner_monologues"][0]["caption_placement"] = {
            "mode":"head_top", "anchors":[{"frame_id":"F0002","head_box":[.4,.5,.6,.8],"confidence":.9}]}
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
    if head_mode:
        assert story_result["subtitle_layout"] == "forehead-v2"
        assert story_result["validation"]["additional_caption_visual_api_calls"] == 0
        assert story_result["inner_monologues"][0]["caption_placement"]["anchors"][0]["source_time"] == 1.
        assert (tmp_path / "story-caption-layout.json").is_file()
        assert "\\pos(" in (tmp_path / "interaction-story.ass").read_text(encoding="utf-8")


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


@pytest.mark.parametrize('music_failure',[False,True])
@pytest.mark.parametrize('mood_status',['ready','invalid','missing'])
def test_production_profile_mixes_bgm_in_normal_pipeline_once(tmp_path,instrumented_pipeline,monkeypatch,music_failure,mood_status):
    from mukbang import narration,story_music,story_profile
    state=instrumented_pipeline
    value=ready_story()
    value.update(narrative_arc='人摸猫，猫回头看手。',reviewed_full_video=True,shortfall_reason='',
                 inner_monologues=[{'id':'m1','clip_id':'s01','event_id':'e01','start':1.,'end':2.4,
                                    'frame_ids':['F0002'],'text':'给咪的？','performance_direction':'先疑惑再得意。'}])
    state['parsed']['interaction_story']=value
    if mood_status != 'missing':
        value['music_mood'] = {'category':'warm','confidence':.9,'reason':'人轻摸猫头，猫停在手旁',
                               'evidence_frame_ids':['F0002' if mood_status == 'ready' else 'F0008']}
    state['options'].update(story_enabled=True,story_mode='inner_monologue',story_target_duration=4)
    monkeypatch.setenv('MUKBANG_BREEZE_ENABLED','1')
    monkeypatch.setattr(story_profile,'load',lambda:{'version':'mi-production-v1','voice_id':'clone',
                        'music_label':'参考音乐','music_rights':'local_preview_only'})
    monkeypatch.setattr(narration,'configured',lambda:object())
    def synth(config,cues,*args):
        assert cues[0]['performance_direction']=='先疑惑再得意。'
        return {'status':'ready','voice_label':'已确认的咪参考克隆','clips':[{'duration':1.2}],'seconds':1}
    monkeypatch.setattr(narration,'synthesize',synth)
    monkeypatch.setattr(narration,'mix_video',lambda *args:{'narration_added':True,'actual_container_duration_seconds':4})
    music_calls=[]
    def mix(*args):
        music_calls.append(args)
        if music_failure: raise ValueError('bad music')
        return {'status':'ready','bgm_added':True,'steps_seconds':{'mix':.1},'label':'参考音乐'}
    monkeypatch.setattr(story_music,'mix',mix)
    original=media.render_video
    def render(source,destination,clips,info,*args,subtitle_file=None,**kwargs):
        return {**original(source,destination,clips,info,*args,**kwargs),'actual_container_duration_seconds':sum(c['duration'] for c in clips)}
    monkeypatch.setattr(media,'render_video',render)
    output=pipeline.run_pipeline(tmp_path,state['source'],state['options'],state['config'],lambda _:None,lambda:False)
    story=output['result']['story']
    assert state['calls']==1 and len(music_calls)==1
    assert story['music_mood']['status'] == mood_status
    assert music_calls[0][5] == story['music_mood']
    assert json.loads((tmp_path/'story-decision.json').read_text(encoding='utf-8'))['music_mood'] == story['music_mood']
    assert story['style_version']=='mi-inner-v2'
    assert story['narration']['voice_label']=='已确认的咪参考克隆'
    assert story['validation']['bgm_added'] is (not music_failure)
    assert story['video_url'].endswith('interaction-story-voiced.mp4' if music_failure else 'interaction-story-mi.mp4')
    assert story['bgm']['status']==('failed' if music_failure else 'ready')
