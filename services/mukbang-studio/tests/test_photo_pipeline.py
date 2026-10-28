from copy import deepcopy
import json

from PIL import Image
import pytest

from mukbang import media, pipeline, vision
from test_pipeline import instrumented_pipeline
from test_dual_pipeline import ready_story
from test_photos import sample_photos


def run_photos(tmp_path, state, monkeypatch, *, export_fails=False):
    state["options"].update(story_enabled=True, photos_enabled=True)
    def extract(args, *unused, **kwargs):
        state["clock"].advance(2)
        if export_fails:
            raise RuntimeError("test-only photo export failure")
        for i in range(1, 6 if state["options"].get("photo_mode") == "gallery" else 3):
            Image.new("RGB", (128, 192), (i * 50, 0, 0)).save(tmp_path / "photos" / f"selected-{i:02}.png")
        return ""
    monkeypatch.setattr(media, "run", extract)
    return pipeline.run_pipeline(tmp_path, state["source"], state["options"], state["config"], lambda _: None, lambda: False)


def test_four_products_one_call_and_separate_photo_time(tmp_path, instrumented_pipeline, monkeypatch):
    state = instrumented_pipeline
    state["parsed"].update(interaction_story=ready_story(), daily_photos=sample_photos())
    raw = deepcopy(state["parsed"])
    result = run_photos(tmp_path, state, monkeypatch)
    assert state["calls"] == 1
    assert result["result"]["highlight_status"] == result["result"]["story"]["status"] == "ready"
    assert all(p["status"] == "ready" for p in result["result"]["photos"].values())
    assert state["parsed"] == raw
    assert json.loads((tmp_path / "photo-decision.json").read_text(encoding="utf-8"))["portrait"]["frame_id"] == "F0002"
    assert next(x for x in result["timings"]["stages"] if x["id"] == "export_photos")["seconds"] >= 2
    assert sum(x["seconds"] or 0 for x in result["timings"]["stages"]) == result["timings"]["total_seconds"]


def test_photo_export_failure_does_not_hide_the_two_videos(tmp_path, instrumented_pipeline, monkeypatch):
    state = instrumented_pipeline
    state["parsed"].update(interaction_story=ready_story(), daily_photos=sample_photos())
    result = run_photos(tmp_path, state, monkeypatch, export_fails=True)
    assert state["calls"] == 1 and result["status"] == "completed"
    assert result["result"]["highlight_status"] == result["result"]["story"]["status"] == "ready"
    assert all(p["status"] == "failed" for p in result["result"]["photos"].values())


def test_photo_directory_failure_still_preserves_completed_videos(tmp_path, instrumented_pipeline, monkeypatch):
    state = instrumented_pipeline
    state["parsed"].update(interaction_story=ready_story(), daily_photos=sample_photos())
    (tmp_path / "photos").write_text("blocked output directory", encoding="utf-8")
    result = run_photos(tmp_path, state, monkeypatch)
    assert result["status"] == "completed" and state["calls"] == 1
    assert result["result"]["highlight_status"] == result["result"]["story"]["status"] == "ready"
    assert all(p["status"] == "failed" for p in result["result"]["photos"].values())
    assert next(x for x in result["timings"]["stages"] if x["id"] == "export_photos")["status"] == "failed"


def test_valid_photos_are_delivered_even_when_both_video_contracts_fail(tmp_path, instrumented_pipeline, monkeypatch):
    state = instrumented_pipeline
    state["parsed"].update(highlight_clips="bad", interaction_story=None, daily_photos=sample_photos())
    result = run_photos(tmp_path, state, monkeypatch)
    assert result["status"] == "completed" and state["calls"] == 1
    assert result["result"]["video_url"] is None
    assert all(p["status"] == "ready" for p in result["result"]["photos"].values())


def test_legacy_vision_input_unchanged_and_photos_only_append_to_shared_prompt():
    options = {"target_duration": 40, "min_duration": 30, "max_duration": 50, "sample_interval": 1, "prompt": "same eating"}
    source = {"duration": 60, "width": 1280, "height": 720}
    sampling = {"frames": [], "sheets": [], "frame_count": 0, "sheet_count": 0, "interval": 1, "frames_per_sheet": 60}
    old = vision.build_prompts(options, source, sampling)
    assert vision.build_prompts({**options, "photos_enabled": False}, source, sampling) == old
    both = vision.build_prompts({**options, "story_enabled": True, "story_mode": "inner_monologue"}, source, sampling)
    four = vision.build_prompts({**options, "story_enabled": True, "story_mode": "inner_monologue", "photos_enabled": True}, source, sampling)
    assert four["system"] == both["system"] + vision.PHOTOS_SYSTEM_APPENDIX
    assert four["user"].startswith(both["user"])
    gallery = vision.build_prompts({**options, "story_enabled": True, "story_mode": "inner_monologue", "photos_enabled": True, "photo_mode": "gallery"}, source, sampling)
    assert gallery["system"] == both["system"] + vision.PHOTO_GALLERY_SYSTEM_APPENDIX
    assert gallery["user"].startswith(both["user"])


@pytest.mark.parametrize("failure", [None, "decode", "directory"])
def test_gallery_preserves_two_videos_and_one_call_even_on_local_failure(tmp_path, instrumented_pipeline, monkeypatch, failure):
    from test_photo_gallery import gallery_fixture
    from mukbang.photo_gallery import ready_count
    state = instrumented_pipeline
    _, raw = gallery_fixture()
    state["parsed"].update(interaction_story=ready_story(), daily_photos=raw)
    state["options"]["photo_mode"] = "gallery"
    if failure == "directory":
        (tmp_path / "photos").write_text("blocked directory", encoding="utf-8")
    result = run_photos(tmp_path, state, monkeypatch, export_fails=failure == "decode")
    assert state["calls"] == result["ai"]["call_count"] == 1
    assert result["result"]["highlight_status"] == result["result"]["story"]["status"] == "ready"
    photos = result["result"]["photos"]
    assert ready_count(photos) == (0 if failure else 5)
    assert photos["ugly_cute"]["count_goal"]["actual"] == (0 if failure else 4)
    assert ("合拍0张，丑萌0张" if failure else "合拍1张，丑萌4张") in result["message"]
