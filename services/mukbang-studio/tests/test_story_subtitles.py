from copy import deepcopy

import pytest

from mukbang import story, story_subtitles


def test_twelve_character_cue_requires_readable_duration_not_relaxed_gate():
    original = [{"start": 1., "end": 3., "text": "你手里那口，是给我的吧？"},
                {"start": 5., "end": 7., "text": "让我尝尝。"}]
    with pytest.raises(story.StoryError, match="显示时间不足"):
        story_subtitles.validate_cue_rhythm(original, 20.)
    corrected = deepcopy(original)
    corrected[0]["end"] = 3.4
    story_subtitles.validate_cue_rhythm(corrected, 20.)
    assert original[0]["end"] == 3.
    assert corrected[0]["text"] == original[0]["text"]


def sample_story():
    frames = [{"id": f"F{i+1:04d}", "time": float(i)} for i in range(60)]
    clips, events, captions = [], [], []
    for index, start in enumerate((0., 20., 40.)):
        clip_id, action_id, reaction_id = f"s{index}", f"a{index}", f"r{index}"
        fid = lambda offset: f"F{int(start + offset) + 1:04d}"
        clips.append({"id": clip_id, "episode_id": "meal", "start": start, "end": start+10,
                      "title": "同一次备餐的互动", "reason": "手拿食物靠近，猫抬头回应",
                      "frame_ids": [fid(1), fid(4)], "co_visible_frame_ids": [fid(i) for i in range(10)]})
        events.extend([
            {"id": action_id, "clip_id": clip_id, "start": start, "end": start+4, "phase": "action",
             "human_action": "人伸手拿食物", "pet_action": "猫看向手", "human_visible": True,
             "pet_visible": True, "frame_ids": [fid(1)]},
            {"id": reaction_id, "clip_id": clip_id, "start": start+4, "end": start+10, "phase": "reaction",
             "human_action": "手停在碗边", "pet_action": "猫向前凑近", "human_visible": True,
             "pet_visible": True, "frame_ids": [fid(4)], "reacts_to_event_id": action_id}])
        captions.append({"id": f"m{index}", "clip_id": clip_id, "event_id": reaction_id,
                         "start": start+4, "end": start+6.8, "frame_ids": [fid(4)],
                         "text": ("这是给我的吗？", "先让我闻一下。", "好啦，我先吃一口。")[index]})
    return frames, {"status": "ready", "episode_id": "meal", "title": "小布的开饭时间",
                    "summary": "人在备餐，猫靠近并回应。", "clips": clips, "events": events, "warnings": [],
                    "narrative_arc": "同一次备餐中，看食物、凑近、进食依次发生。",
                    "reviewed_full_video": True, "shortfall_reason": "", "inner_monologues": captions}


def validate(value, frames, target=35):
    return story.validate_story(value, frames, 60., {"story_enabled": True,
                                "story_mode": "inner_monologue", "story_target_duration": target})


def test_fuller_connected_story_has_sparse_monologues_and_target_band():
    frames, value = sample_story()
    before = deepcopy(value)
    result = validate(value, frames)
    assert result["duration"] == 30
    assert result["duration_goal"] == {"target": 35., "minimum": 30., "maximum": 40., "met": True, "shortfall_reason": ""}
    assert result["inner_monologues"] == value["inner_monologues"]
    assert result["story_mode"] == "inner_monologue"
    assert value == before


def cross_cut_story():
    frames, value = sample_story()
    value["inner_monologues"][0].update(start=7., end=10., frame_ids=["F0009"])
    value["events"][1]["frame_ids"].append("F0009")
    value["clips"][0]["frame_ids"].append("F0009")
    value["inner_monologues"][1].update(event_id="a1", start=21., end=24., frame_ids=["F0022"])
    return frames, value


def test_small_cross_cut_gap_shortens_only_excess_hold_with_audit():
    frames, value = cross_cut_story()
    before = deepcopy(value)
    result = validate(value, frames)
    assert result["inner_monologues"][0]["end"] == 9.5
    assert result["inner_monologues"][0]["start"] == 7.
    assert result["inner_monologues"][0]["frame_ids"] == ["F0009"]
    assert result["caption_timing_adjustments"][0]["before_end"] == 10.
    assert value == before


@pytest.mark.parametrize("condition", ["reading", "evidence", "anchor", "large"])
def test_cross_cut_gap_repair_must_keep_reading_evidence_and_small_bound(condition):
    frames, value = cross_cut_story()
    cue = value["inner_monologues"][0]
    if condition == "reading":
        cue["text"] = "这次给我的是什么好吃的呀？"
    elif condition == "evidence":
        frames[9]["time"] = 9.7
        cue["frame_ids"] = ["F0010"]
        value["events"][1]["frame_ids"].append("F0010")
        value["clips"][0]["frame_ids"].append("F0010")
    elif condition == "anchor":
        frames[9]["time"] = 9.7
        cue["caption_placement"] = {"mode": "forehead", "anchors": [
            {"frame_id": "F0010", "head_box": [.1,.1,.8,.8], "confidence": .9}]}
    else:
        value["inner_monologues"][1]["start"] = 20.5
    with pytest.raises(story.StoryError, match="过密"):
        validate(value, frames)


def test_performance_direction_survives_validation_but_rejects_code():
    frames,value=sample_story()
    value['inner_monologues'][0]['performance_direction']='前半句疑问，后半句小得意。'
    assert validate(value,frames)['inner_monologues'][0]['performance_direction']==value['inner_monologues'][0]['performance_direction']
    value['inner_monologues'][0]['performance_direction']='<script>bad</script>'
    with pytest.raises(story.StoryError): validate(value,frames)


@pytest.mark.parametrize("change", [
    lambda v: v.pop("inner_monologues"),
    lambda v: v.update(inner_monologues=[]),
    lambda v: v.update(reviewed_full_video=False),
    lambda v: v.update(narrative_arc=""),
    lambda v: v["inner_monologues"][0].update(event_id="missing"),
    lambda v: v["inner_monologues"][0].update(event_id="r1"),
    lambda v: v["inner_monologues"][0].update(start=2., end=4.8),
    lambda v: v["inner_monologues"][0].update(end=10.1),
    lambda v: v["inner_monologues"][0].update(end=4.1),
    lambda v: v["inner_monologues"][0].update(text="{\\pos(0,0)}你好"),
    lambda v: v["inner_monologues"][0].update(text="<script>hi</script>"),
    lambda v: v["inner_monologues"][0].update(text="一"*37),
    lambda v: v["inner_monologues"][0].update(text="你好\n坏字幕"),
    lambda v: v["inner_monologues"][1].update(id="m0"),
])
def test_bad_or_ungrounded_monologues_are_rejected(change):
    frames, value = sample_story()
    change(value)
    with pytest.raises(story.StoryError):
        validate(value, frames)


def test_short_story_requires_explicit_full_scan_shortfall_and_is_not_on_target():
    frames, value = sample_story()
    value["clips"] = value["clips"][:1]
    value["events"] = value["events"][:2]
    value["inner_monologues"] = value["inner_monologues"][:1]
    with pytest.raises(story.StoryError, match="时长"):
        validate(value, frames)
    value["shortfall_reason"] = "扫描其余段落后，人已离开镜头，未找到更多同镜互动。"
    result = validate(value, frames)
    assert result["duration_goal"]["met"] is False
    assert any("10" in warning and "35" in warning for warning in result["warnings"])


def test_over_target_band_is_rejected_instead_of_cutting_a_caption_or_action():
    frames, value = sample_story()
    with pytest.raises(story.StoryError, match="时长"):
        validate(value, frames, target=20)


def test_old_story_requests_do_not_gain_subtitles_or_a_new_lower_bound():
    frames, value = sample_story()
    result = story.validate_story(value, frames, 60., {"story_enabled": True})
    assert "inner_monologues" not in result
    assert "story_mode" not in result


def test_subtitle_cues_are_mapped_to_output_clock_and_exported(tmp_path):
    cues = [{"id": "m1", "text": "你去哪里？等一下，我也去。", "output_start": 1.2, "output_end": 4.0}]
    paths = story_subtitles.write_subtitles(tmp_path, cues, {"width": 1280, "height": 720})
    assert paths["srt"].read_text(encoding="utf-8").startswith("1\n00:00:01,200 --> 00:00:04,000")
    ass = paths["ass"].read_text(encoding="utf-8")
    assert "PlayResX: 1280" in ass and "Microsoft YaHei" in ass
    assert "0:00:01.20,0:00:04.00" in ass
    assert "你去哪里" in ass


@pytest.mark.parametrize("width,height", [(2560, 1440), (1280, 720), (720, 1280)])
def test_caption_style_is_phone_readable_and_keeps_side_margins(tmp_path, width, height):
    paths = story_subtitles.write_subtitles(tmp_path, [], {"width": width, "height": height})
    style = next(line for line in paths["ass"].read_text(encoding="utf-8").splitlines() if line.startswith("Style:"))
    fields = style.split(",")
    size = int(fields[2])
    left, right = int(fields[19]), int(fields[20])
    assert size * 18 + left + right <= width
    assert size / width >= .047


def test_dense_or_overlapping_output_cues_rejected_even_when_source_gaps_are_large():
    for cues in [
        [{"text": "好啦。", "start": 0., "end": 2.}, {"text": "我看看。", "start": 3., "end": 5.}],
        [{"text": "好啦。", "start": 0., "end": 5.5}, {"text": "我看看。", "start": 7., "end": 12.5}],
    ]:
        with pytest.raises(story.StoryError):
            story_subtitles.validate_cue_rhythm(cues, 19.)


def test_subtitle_source_to_output_mapping_matches_the_final_cuts():
    from mukbang.daily_outputs import map_story_monologues, quantize_story
    frames, parsed = sample_story()
    for frame in frames:
        frame["source_frame_index"] = int(frame["time"] * 10)
    info = {"time_base": "1/10", "origin_pts": 0, "end_pts": 600, "pts": list(range(600))}
    decision = validate(parsed, frames)
    clips, _, _ = quantize_story(decision, info, frames)
    captions = map_story_monologues(decision, clips, frames, info)
    assert [cue["output_start"] for cue in captions] == [4., 14., 24.]
    assert [cue["source_start"] for cue in captions] == [4., 24., 44.]
    assert captions[-1]["source_times"][0]["output_time"] == 24.
