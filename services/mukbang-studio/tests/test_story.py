"""Offline validation of independent, same-frame interaction evidence."""
from copy import deepcopy

import pytest

from mukbang import story
from mukbang.selection import SelectionError


@pytest.fixture
def frames():
    return [{"id": f"F{i:04d}", "time": i - 1 + 0.125} for i in range(1, 81)]


@pytest.fixture
def decision():
    return {
        "status": "ready", "episode_id": "water-then-touch", "title": "小脑袋凑过来",
        "summary": "人伸手到碗边，小猫靠近手，随后转头。", "warnings": [],
        "clips": [{"id": "s01", "episode_id": "water-then-touch", "start": 1.0, "end": 5.0,
                   "title": "伸手与靠近", "reason": "同镜的人手伸出，猫随后靠近并转头",
                   "frame_ids": ["F0002", "F0003", "F0004"],
                   "co_visible_frame_ids": ["F0002", "F0003", "F0004", "F0005"]}],
        "events": [
            {"id": "e01", "clip_id": "s01", "phase": "setup", "start": 1.0, "end": 2.0,
             "human_action": "人的手放在碗边", "pet_action": "猫面朝碗边", "human_visible": True,
             "pet_visible": True, "frame_ids": ["F0002"]},
            {"id": "e02", "clip_id": "s01", "phase": "action", "start": 2.0, "end": 3.0,
             "human_action": "人向猫头伸手", "pet_action": "猫转向手", "human_visible": True,
             "pet_visible": True, "frame_ids": ["F0003"]},
            {"id": "e03", "clip_id": "s01", "phase": "reaction", "start": 3.0, "end": 4.0,
             "human_action": "手停在猫头旁", "pet_action": "猫鼻嘴靠近人手后转头", "human_visible": True,
             "pet_visible": True, "frame_ids": ["F0004"], "reacts_to_event_id": "e02"},
        ],
    }


def validate(row, frames, **options):
    return story.validate_story(row, frames, 80.0, {"story_enabled": True, **options})


def test_ready_story_has_exact_unchanged_source_times_and_independent_evidence(decision, frames):
    before = deepcopy(decision)
    result = validate(decision, frames)
    assert result["status"] == "ready"
    assert result["duration"] == 4.0
    assert result["clips"] == decision["clips"]
    assert result["events"][1]["source_times"] == [{"frame_id": "F0003", "time": 2.125}]
    assert decision == before
    assert result["warnings"]
    # Nothing in this API requires eating-selected-frame membership.
    assert "selected_frames" not in result


def test_explicit_no_story_is_valid_but_missing_is_not(frames):
    result = validate({"status": "not_found", "reason": "只有猫在吃，没有同镜交互",
                       "clips": [], "events": [], "warnings": []}, frames)
    assert result["status"] == "not_found" and result["duration"] == 0
    assert result["reason"] == "只有猫在吃，没有同镜交互"
    for absent in (None, {}, [], "not_found"):
        with pytest.raises(story.StoryError):
            validate(absent, frames)


@pytest.mark.parametrize("field,value", [("clips", [{"id": "fake"}]), ("events", [{}]),
                                        ("reason", ""), ("warnings", "nothing")])
def test_no_story_cannot_hide_nonempty_or_malformed_outputs(frames, field, value):
    row = {"status": "not_found", "reason": "无交互", "clips": [], "events": [], "warnings": []}
    row[field] = value
    with pytest.raises(story.StoryError):
        validate(row, frames)


@pytest.mark.parametrize("value", [True, False, float("nan"), float("inf"), "2", None])
@pytest.mark.parametrize("field", ["start", "end"])
def test_source_clip_times_reject_bool_nonfinite_and_nonnumber(decision, frames, field, value):
    decision["clips"][0][field] = value
    with pytest.raises(story.StoryError):
        validate(decision, frames)


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), "2", None])
def test_event_times_reject_bool_nonfinite_and_nonnumber(decision, frames, value):
    decision["events"][1]["start"] = value
    with pytest.raises(story.StoryError):
        validate(decision, frames)


@pytest.mark.parametrize("field,value", [("frame_ids", ["UNKNOWN"]),
                                        ("frame_ids", []), ("frame_ids", ["F0003", "F0003"]),
                                        ("co_visible_frame_ids", ["F0002", "F0003", "F0004"]),
                                        ("co_visible_frame_ids", ["F0002", "F0003", "F0004", "F0005", "F0006"])])
def test_unknown_refs_duplicates_and_missing_co_visibility_rejected(decision, frames, field, value):
    decision["clips"][0][field] = value
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_all_refs_obey_exact_half_open_right_boundary(decision, frames):
    decision["events"][2]["end"] = 3.125
    # F0004 is exactly the event's excluded right endpoint.
    with pytest.raises(story.StoryError, match="半开|区间"):
        validate(decision, frames)


def test_decimal_source_pts_are_not_rounded_to_fit(decision, frames):
    decision["events"][1]["start"] = 2.126
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_event_cannot_cite_outside_clip_or_unlisted_clip_evidence(decision, frames):
    decision["clips"][0]["frame_ids"].remove("F0004")
    with pytest.raises(story.StoryError):
        validate(decision, frames)
    decision["clips"][0]["frame_ids"].append("F0004")
    decision["events"][2]["end"] = 5.1
    with pytest.raises(story.StoryError):
        validate(decision, frames)


@pytest.mark.parametrize("field,value", [("human_visible", False), ("pet_visible", False),
                                        ("human_visible", 1), ("pet_visible", "true"),
                                        ("human_action", ""), ("pet_action", "")])
def test_every_event_requires_same_frame_visible_human_and_pet_actions(decision, frames, field, value):
    decision["events"][1][field] = value
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_story_requires_action_and_matching_later_reaction(decision, frames):
    decision["events"].pop()
    with pytest.raises(story.StoryError, match="反应"):
        validate(decision, frames)


@pytest.mark.parametrize("reference", ["e01", "e03", "UNKNOWN", "", None])
def test_reaction_must_reference_preceding_action(decision, frames, reference):
    decision["events"][2]["reacts_to_event_id"] = reference
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_reverse_event_order_and_overlapping_events_are_not_repaired(decision, frames):
    decision["events"][1:3] = reversed(decision["events"][1:3])
    with pytest.raises(story.StoryError):
        validate(decision, frames)
    decision["events"][1:3] = reversed(decision["events"][1:3])
    decision["events"][1]["end"] = 3.1
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def _add_second_exchange(decision):
    clip = {"id": "s02", "episode_id": decision["episode_id"], "start": 5.0, "end": 7.0,
            "title": "再伸手", "reason": "接着伸手后猫转头",
            "frame_ids": ["F0006", "F0007"], "co_visible_frame_ids": ["F0006", "F0007"]}
    decision["clips"].append(clip)
    decision["events"].extend([
        {"id": "e04", "clip_id": "s02", "phase": "action", "start": 5., "end": 6.,
         "human_action": "人再次伸手", "pet_action": "猫望向手", "human_visible": True,
         "pet_visible": True, "frame_ids": ["F0006"]},
        {"id": "e05", "clip_id": "s02", "phase": "reaction", "start": 6., "end": 7.,
         "human_action": "人把手停下", "pet_action": "猫转头靠近", "human_visible": True,
         "pet_visible": True, "frame_ids": ["F0007"], "reacts_to_event_id": "e04"}])


def test_repeated_action_reaction_sequence_and_optional_setup_are_allowed(decision, frames):
    _add_second_exchange(decision)
    decision["events"].pop(0)
    assert validate(decision, frames)["duration"] == 6.0


def test_disconnected_declared_episodes_are_rejected(decision, frames):
    _add_second_exchange(decision)
    decision["clips"][1]["episode_id"] = "unrelated-scene"
    with pytest.raises(story.StoryError, match="故事|事件|episode"):
        validate(decision, frames)


def test_duplicate_or_reverse_clip_playback_is_rejected(decision, frames):
    _add_second_exchange(decision)
    decision["clips"].reverse()
    with pytest.raises(story.StoryError):
        validate(decision, frames)
    decision["clips"].reverse()
    decision["clips"][1]["start"] = 4.9
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_every_clip_must_have_its_own_interaction_evidence(decision, frames):
    _add_second_exchange(decision)
    decision["events"] = decision["events"][:3]
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_no_duration_padding_or_crop_is_applied(decision, frames):
    result = validate(decision, frames, story_target_duration=40)
    assert result["duration"] == 4.0
    assert result["clips"][0]["start"] == 1.0
    assert result["clips"][0]["end"] == 5.0
    with pytest.raises(story.StoryError, match="上限|60"):
        validate(decision, frames, story_max_duration=3)


def test_sixty_second_hard_cap_is_not_relaxed(decision, frames):
    decision["clips"][0]["end"] = 61.000001
    decision["clips"][0]["co_visible_frame_ids"] = [f["id"] for f in frames if 1 <= f["time"] < 61.000001]
    with pytest.raises(story.StoryError, match="上限|60"):
        validate(decision, frames)


@pytest.mark.parametrize("key,value", [("story_target_duration", True), ("story_target_duration", float("nan")),
                                      ("story_target_duration", 0), ("story_target_duration", 61),
                                      ("story_max_duration", 61), ("story_max_duration", 0)])
def test_story_parameters_are_finite_and_bounded(decision, frames, key, value):
    with pytest.raises(story.StoryError):
        validate(decision, frames, **{key: value})


def test_error_is_selection_compatible(decision, frames):
    with pytest.raises(SelectionError):
        validate(None, frames)


@pytest.mark.parametrize("bad_duration", [True, 0, float("nan"), -1])
def test_invalid_source_metadata_fails_closed(decision, frames, bad_duration):
    with pytest.raises(story.StoryError):
        story.validate_story(decision, frames, bad_duration, {})


@pytest.mark.parametrize("value", [[], {}, True, 10**1000])
def test_malformed_status_is_a_story_error_not_a_type_error(decision, frames, value):
    decision["status"] = value
    with pytest.raises(story.StoryError):
        validate(decision, frames)


@pytest.mark.parametrize("field,value", [("phase", []), ("phase", {}),
                                        ("reacts_to_event_id", []), ("reacts_to_event_id", {})])
def test_malformed_event_discriminators_fail_closed(decision, frames, field, value):
    decision["events"][1][field] = value
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_extreme_json_integer_does_not_escape_as_overflow(decision, frames):
    decision["clips"][0]["end"] = 10**1000
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_source_frame_metadata_duplicates_and_invalid_pts_rejected(decision, frames):
    frames[-1]["id"] = frames[0]["id"]
    with pytest.raises(story.StoryError):
        validate(decision, frames)
    frames[-1]["id"] = "F0080"
    frames[-1]["time"] = 80.
    with pytest.raises(story.StoryError):
        validate(decision, frames)


def test_canonical_event_pts_cannot_be_forged_by_model(decision, frames):
    decision["events"][1]["source_times"] = [{"frame_id": "F0003", "time": 999}]
    assert validate(decision, frames)["events"][1]["source_times"] == [{"frame_id": "F0003", "time": 2.125}]
