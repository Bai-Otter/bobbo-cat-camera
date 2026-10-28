from copy import deepcopy
import pytest

from mukbang import photos


def sample_photos():
    return {
        "portrait": {"status": "ready", "frame_id": "F0002", "time": 1., "title": "一起等开饭",
                     "reason": "人的脸与猫脸同镜，侧脸相望，主体清晰。", "pet_face_visible": True,
                     "human_face_visible": True, "clear_enough": True, "no_major_occlusion": True},
        "ugly_cute": {"status": "ready", "frame_id": "F0003", "time": 2., "title": "鼻子先到啦",
                      "reason": "猫贴镜头，鼻口显大，两眼露出，表情傻乎乎。", "pet_face_visible": True,
                      "clear_enough": True, "no_major_occlusion": True, "traits": ["extreme_closeup", "big_nose"]}}


def frame_list():
    return [{"id": f"F{i+1:04d}", "time": float(i), "source_frame_index": i * 10, "source_pts": i * 10} for i in range(5)]


def test_two_distinct_photos_are_grounded_and_do_not_mutate_raw_response():
    raw = sample_photos()
    before = deepcopy(raw)
    result = photos.validate_photos(raw, frame_list(), 5.)
    assert all(row["status"] == "ready" for row in result.values())
    assert result["portrait"]["source_frame_index"] == 10
    assert raw == before


@pytest.mark.parametrize("change", [
    lambda x: x.update(frame_id="F9999"), lambda x: x.update(time=True),
    lambda x: x.update(time=float("nan")), lambda x: x.update(time=3.),
    lambda x: x.update(time=10**1000),
    lambda x: x.update(clear_enough=False), lambda x: x.update(human_face_visible=False),
    lambda x: x.update(no_major_occlusion="true"), lambda x: x.update(reason=""),
])
def test_bad_portrait_does_not_break_ugly_cute(change):
    raw = sample_photos()
    change(raw["portrait"])
    result = photos.validate_photos(raw, frame_list(), 5.)
    assert result["portrait"]["status"] == "invalid"
    assert result["ugly_cute"]["status"] == "ready"


def test_absence_missing_and_duplicate_are_distinct():
    result = photos.validate_photos({"portrait": {"status": "not_found", "reason": "人物没有露脸。"}}, frame_list(), 5.)
    assert result["portrait"]["status"] == "not_found"
    assert result["ugly_cute"]["status"] == "invalid"
    raw = sample_photos()
    raw["ugly_cute"].update(frame_id="F0002", time=1.)
    assert photos.validate_photos(raw, frame_list(), 5.)["ugly_cute"]["status"] == "invalid"


@pytest.mark.parametrize("traits", [[], ["normal_eating"], "big_nose", [True], ["big_nose", "big_nose"]])
def test_ugly_cute_needs_specific_valid_visual_traits(traits):
    raw = sample_photos()
    raw["ugly_cute"]["traits"] = traits
    assert photos.validate_photos(raw, frame_list(), 5.)["ugly_cute"]["status"] == "invalid"
