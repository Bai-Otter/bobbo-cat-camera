"""Prompt-contract regression, not a claim of semantic model accuracy."""
import re

from mukbang import vision


def prompts(**extra):
    options = dict(target_duration=40, min_duration=30, max_duration=50,
                   sample_interval=1, prompt="原吃播标准", story_enabled=True,
                   story_mode="inner_monologue", **extra)
    source = dict(duration=121, width=2560, height=1440)
    samples = dict(frames=[], sheets=[], frame_count=0, sheet_count=0, interval=1, frames_per_sheet=60)
    return vision.build_prompts(options, source, samples)


def test_closeup_v2_prioritizes_hero_style_without_fixed_source_references():
    system = vision.PHOTO_GALLERY_SYSTEM_APPENDIX
    assert "closeup-v2" in system
    assert "至少3张" in system
    assert "最多1张" in system
    assert "普通圆脸" in system and "不是丑萌" in system
    assert "亲亲/贴脸/抱抱" in system
    assert "不得为了凑4张" in system
    assert not re.search(r"F\d{4}|52秒|82秒|34秒|103秒", system)


def test_photo_refinement_keeps_both_video_prompt_prefixes_exact():
    base = prompts()
    new = prompts(photos_enabled=True, photo_mode="gallery")
    assert new["system"] == base["system"] + vision.PHOTO_GALLERY_SYSTEM_APPENDIX
    assert new["user"].startswith(base["user"])
    assert "closeup-v2" in new["user"]
    assert "普通圆脸" in new["user"]
    assert "亲亲" in new["user"]


def test_legacy_single_photo_prompt_is_unchanged():
    base = prompts()
    legacy = prompts(photos_enabled=True)
    assert legacy["system"] == base["system"] + vision.PHOTOS_SYSTEM_APPENDIX
    assert "closeup-v2" not in legacy["system"] + legacy["user"]
    assert prompts(photos_enabled=False, photo_mode="gallery") == base
