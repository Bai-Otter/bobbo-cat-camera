from copy import deepcopy
import pytest

from mukbang import photo_gallery
from test_photos import sample_photos


def gallery_fixture():
    frames = [{"id": f"F{i+1:04d}", "time": float(i), "source_frame_index": i*10, "source_pts": i*10} for i in range(12)]
    portrait = {"status": "ready", "frame_id": "F0002", "time": 1., "title": "陪你吃饭", "reason": "人的手和猫同时可见",
                "human_visible": True, "pet_visible": True, "human_presence": "hand"}
    items = [{**sample_photos()["ugly_cute"], "frame_id": f"F{i+1:04d}", "time": float(i),
              "difference": f"独特瞬间{i}"} for i in (2, 4, 6, 8)]
    return frames, {"portrait": portrait, "ugly_cute": {"status": "ready", "reviewed_all_samples": True,
                     "shortfall_reason": "", "items": items}}


@pytest.mark.parametrize("part", ["hand", "leg", "body", "face"])
def test_partial_human_and_four_distinct_cute_photos(part):
    frames, raw = gallery_fixture()
    raw["portrait"]["human_presence"] = part
    before = deepcopy(raw)
    result = photo_gallery.validate_gallery(raw, frames, 12.)
    assert result["portrait"]["status"] == "ready"
    assert "human_face_visible" not in result["portrait"]
    assert len(result["ugly_cute"]["items"]) == 4
    assert result["ugly_cute"]["count_goal"]["met"] is True
    assert raw == before


def test_no_portrait_requires_real_absence_not_unflattering_angle():
    frames, raw = gallery_fixture()
    raw["portrait"] = {"status": "not_found", "reason": "脸裁切了"}
    assert photo_gallery.validate_gallery(raw, frames, 12.)["portrait"]["status"] == "invalid"
    raw["portrait"].update(human_present=False, reviewed_all_samples=True, reason="所有采样里都只有猫，没有人")
    assert photo_gallery.validate_gallery(raw, frames, 12.)["portrait"]["status"] == "not_found"
    assert photo_gallery.validate_gallery(raw, frames, 12., known_human_visible=True)["portrait"]["status"] == "invalid"


def test_under_four_requires_explanation_and_is_not_marked_on_target():
    frames, raw = gallery_fixture()
    raw["ugly_cute"]["items"] = raw["ugly_cute"]["items"][:2]
    assert photo_gallery.validate_gallery(raw, frames, 12.)["ugly_cute"]["status"] == "invalid"
    raw["ugly_cute"]["shortfall_reason"] = "其余采样猫已经离开，仅有两个不同表情。"
    result = photo_gallery.validate_gallery(raw, frames, 12.)
    assert result["ugly_cute"]["count_goal"]["met"] is False
    assert result["ugly_cute"]["count_goal"]["actual"] == 2


@pytest.mark.parametrize("mutation", [
    lambda x: x["items"].append(x["items"][0]),
    lambda x: x["items"][0].update(difference=""),
    lambda x: x["items"][0].update(frame_id="F9999"),
    lambda x: x.update(reviewed_all_samples=False),
    lambda x: x.update(items=x["items"]*2),
])
def test_invalid_gallery_does_not_remove_good_portrait(mutation):
    frames, raw = gallery_fixture()
    mutation(raw["ugly_cute"])
    result = photo_gallery.validate_gallery(raw, frames, 12.)
    assert result["ugly_cute"]["status"] == "invalid"
    assert result["portrait"]["status"] == "ready"
