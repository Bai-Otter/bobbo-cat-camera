"""Independent dual-product regressions; every model decision is synthetic.

The real-media check verifies technical extraction only, not cat recognition.
No test invokes a live provider or reviews additional images.
"""
import json
import shutil

import pytest

from mukbang import media, pipeline, vision
from test_pipeline import instrumented_pipeline


def interaction_story():
    return {"status": "ready", "episode_id": "synthetic-interaction", "title": "合成动作与反应",
            "summary": "仅为验证时间映射的合成事件，不是真实猫咪判断。",
            "clips": [{"id": "s01", "episode_id": "synthetic-interaction", "start": 1., "end": 4.,
                       "title": "合成同镜互动", "reason": "测试声明，不代表视觉识别结果",
                       "frame_ids": ["F0002", "F0003", "F0004"],
                       "co_visible_frame_ids": ["F0002", "F0003", "F0004"]}],
            "events": [{"id": "action", "clip_id": "s01", "start": 1., "end": 2.,
                        "phase": "action", "human_action": "合成动作", "pet_action": "合成等待",
                        "frame_ids": ["F0002"], "human_visible": True, "pet_visible": True},
                       {"id": "reaction", "clip_id": "s01", "start": 2., "end": 4.,
                        "phase": "reaction", "human_action": "合成动作后的停顿", "pet_action": "合成反应",
                        "frame_ids": ["F0003", "F0004"], "human_visible": True, "pet_visible": True,
                        "reacts_to_event_id": "action"}], "warnings": []}


def run_instrumented(tmp_path, state, emit=lambda _: None, cancelled=lambda: False):
    state["options"].update(story_enabled=True, story_target_duration=30.)
    state["parsed"]["interaction_story"] = interaction_story()
    return pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], emit, cancelled)


def test_invalid_eating_schema_preserves_independent_valid_story(tmp_path, instrumented_pipeline):
    state = instrumented_pipeline
    state["parsed"]["selected_frames"] = "malformed eating-only field"
    result = run_instrumented(tmp_path, state)
    assert state["calls"] == result["ai"]["call_count"] == 1
    assert result["result"]["highlight_status"] == "invalid"
    assert result["result"]["video_url"] is None
    assert result["result"]["story"]["status"] == "ready"
    assert result["result"]["story"]["video_duration"] == 3.
    assert result["result"]["story"]["events"][1]["output_start"] == 1.


@pytest.mark.parametrize("phase", ["quantization", "render"])
def test_eating_local_failure_does_not_erase_valid_story(tmp_path, instrumented_pipeline, monkeypatch, phase):
    state = instrumented_pipeline
    if phase == "quantization":
        original = media.quantize_clips

        def fail_eating(clips, info):
            if clips[0]["id"].startswith("c"):
                raise RuntimeError("synthetic eating quantization failure")
            return original(clips, info)

        monkeypatch.setattr(media, "quantize_clips", fail_eating)
    else:
        original = media.render_video

        def fail_eating(source, destination, *args, **kwargs):
            if destination.name == "highlights.mp4":
                raise RuntimeError("synthetic eating render failure")
            return original(source, destination, *args, **kwargs)

        monkeypatch.setattr(media, "render_video", fail_eating)
    result = run_instrumented(tmp_path, state)
    assert result["result"]["highlight_status"] == "failed"
    assert result["result"]["video_url"] is None
    assert result["result"]["story"]["status"] == "ready"
    assert result["result"]["story"]["video_duration"] == 3.
    assert state["calls"] == 1


def test_story_cancellation_remains_terminal_instead_of_partial_success(tmp_path, instrumented_pipeline, monkeypatch):
    state, updates = instrumented_pipeline, []
    original = media.render_video

    def cancel_story(source, destination, *args, **kwargs):
        if destination.name == "interaction-story.mp4":
            raise media.Cancelled("synthetic cancellation during story render")
        return original(source, destination, *args, **kwargs)

    monkeypatch.setattr(media, "render_video", cancel_story)
    with pytest.raises(media.Cancelled):
        run_instrumented(tmp_path, state, updates.append)
    assert state["calls"] == 1
    assert not any(update.get("status") == "completed" for update in updates)
    timing = json.loads((tmp_path / "timings.json").read_text(encoding="utf-8"))
    assert timing["status"] == "cancelled"
    story = next(row for row in timing["stages"] if row["id"] == "render_story")
    assert story["status"] == "cancelled"


def test_both_invalid_products_never_publish_completed_or_video_urls(tmp_path, instrumented_pipeline):
    state, updates = instrumented_pipeline, []
    state["options"].update(story_enabled=True)
    state["parsed"]["selected_frames"] = "malformed eating schema"
    state["parsed"]["interaction_story"] = {"status": "ready", "clips": []}
    with pytest.raises(RuntimeError, match="没有可交付"):
        pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], updates.append, lambda: False)
    saved = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert saved["highlight_status"] == saved["story"]["status"] == "invalid"
    assert saved["video_url"] is saved["story"]["video_url"] is None
    assert not any(update.get("status") == "completed" for update in updates)
    assert state["calls"] == 1


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg is required")
def test_real_dual_video_outputs_keep_source_audio_dimensions_frames_and_one_call(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
               "testsrc2=size=128x96:rate=10:duration=6", "-f", "lavfi", "-i",
               "sine=frequency=440:sample_rate=8000:duration=6", "-ac", "2", "-c:a", "aac",
               "-b:a", "48k", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
    original_digest = media.sha256(source)
    original_probe = media.probe(source)
    calls, sampling_calls, updates = [], [], []
    real_sample = media.sample_video

    def once_sample(*args, **kwargs):
        sampling_calls.append(1)
        assert len(sampling_calls) == 1, "the extra product must not sample the source again"
        return real_sample(*args, **kwargs)

    def fake_model(prompts, sheets, job_dir, config):
        calls.append(1)
        payload = vision.make_payload(prompts, sheets, job_dir, config)
        assert len(payload["input"][0]["content"]) == len(sheets) + 1
        result = {"summary": "合成媒体技术测试，不是真实猫咪识别", "selected_frames": [
            {"frame_id": "F0002", "score": 95, "reason": "synthetic eating evidence", "labels": ["fixture"]},
            {"frame_id": "F0005", "score": 90, "reason": "synthetic eating evidence", "labels": ["fixture"]}],
            "highlight_clips": [
                {"id": "c01", "start": 0., "end": 2., "context_start": 0., "context_end": 2.,
                 "title": "synthetic one", "reason": "fixture", "score": 95, "frame_ids": ["F0002"]},
                {"id": "c02", "start": 4., "end": 6., "context_start": 4., "context_end": 6.,
                 "title": "synthetic two", "reason": "fixture", "score": 90, "frame_ids": ["F0005"]}],
            "memes": [], "warnings": [], "interaction_story": interaction_story()}
        return {"text": json.dumps(result, ensure_ascii=False), "envelope": {"test_only": True}, "usage": {}}

    monkeypatch.setattr(media, "sample_video", once_sample)
    monkeypatch.setattr(vision, "call_vision", fake_model)
    options = {"target_duration": 4, "min_duration": 3, "max_duration": 5, "sample_interval": 1,
               "prompt": "synthetic technical integration only", "story_enabled": True, "story_target_duration": 30}
    config = {"model": "offline-synthetic", "api_style": "responses", "base_url": "https://offline.invalid/v1", "api_key": ""}
    final = pipeline.run_pipeline(tmp_path, source, options, config, updates.append, lambda: False)
    assert len(calls) == len(sampling_calls) == final["ai"]["call_count"] == 1
    assert original_digest == media.sha256(source)
    eating, story = final["result"], final["result"]["story"]
    assert eating["highlight_status"] == story["status"] == "ready"
    assert eating["video_duration"] == 4 and story["video_duration"] == 3
    for name, result, frame_count in (("highlights.mp4", eating, 40), ("interaction-story.mp4", story, 30)):
        output = tmp_path / name
        assert output.is_file() and output.stat().st_size > 0
        metadata = media.probe(output)
        video = next(row for row in metadata["streams"] if row["codec_type"] == "video")
        audio = next(row for row in metadata["streams"] if row["codec_type"] == "audio")
        assert (video["width"], video["height"]) == (128, 96)
        assert int(audio["sample_rate"]) == 8000 and int(audio["channels"]) == 2
        assert len(media.frame_times(output)) == frame_count
        assert result["validation"]["source_speed_preserved"] is True
        assert result["validation"]["full_decode_pass"] is True
        assert "source audio only" in result["validation"]["audio_policy"]
        assert result["poster_url"].startswith(f"/api/jobs/{tmp_path.name}/files/samples/")
    assert len(original_probe["streams"]) == 2
    assert story["events"][0]["source_start"] == 1 and story["events"][0]["output_start"] == 0
    assert story["events"][1]["source_start"] == 2 and story["events"][1]["output_start"] == 1
    stages = {row["id"]: row for row in final["timings"]["stages"]}
    assert stages["render_highlight"]["seconds"] > 0 and stages["render_story"]["seconds"] > 0
    assert stages["render_highlight"]["status"] == stages["render_story"]["status"] == "completed"
    assert all(update.get("status") != "completed" for update in updates[:-1])
