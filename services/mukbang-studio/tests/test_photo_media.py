import shutil

from PIL import Image
import pytest

from mukbang import media, photos
from test_photos import sample_photos


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_native_photos_match_exact_selected_frames_and_not_video_covers(tmp_path):
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i",
               "testsrc2=size=320x180:rate=10:duration=4", "-c:v", "libx264", str(source)])
    digest = media.sha256(source)
    info = media.video_info(media.probe(source), media.frame_times(source))
    frames = [{"id": f"F{i+1:04d}", "time": float(i), "source_frame_index": i*10,
               "source_pts": info["pts"][i*10]} for i in range(4)]
    decisions = photos.validate_photos(sample_photos(), frames, 4.)
    result = photos.export_photos(tmp_path, source, decisions, info, {"frames": frames}, digest)
    assert all(p["status"] == "ready" for p in result.values())
    for category, frame_number in (("portrait", 10), ("ugly_cute", 20)):
        expected = tmp_path / f"expected-{category}.png"
        media.run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-i", str(source), "-vf",
                   f"select=eq(n\\,{frame_number})", "-fps_mode", "passthrough", "-frames:v", "1", str(expected)])
        with Image.open(expected) as first, Image.open(tmp_path / "photos" / f"{category}.png") as second:
            assert first.size == second.size == (320, 180)
            assert first.tobytes() == second.tobytes()
        assert result[category]["validation"]["additional_visual_api_calls"] == 0
    assert media.sha256(source) == digest


def test_corrupted_frame_identity_fails_before_export(tmp_path, monkeypatch):
    from test_photos import frame_list
    frames = frame_list()
    choices = photos.validate_photos(sample_photos(), frames, 5.)
    frames[1]["source_pts"] = 999
    choices["ugly_cute"] = {"status": "not_found", "reason": "没有合适表情"}
    monkeypatch.setattr(media, "run", lambda *a, **k: pytest.fail("must not decode with corrupt evidence"))
    out = photos.export_photos(tmp_path, tmp_path / "unused.mp4", choices,
                              {"pts": list(range(50)), "origin_pts": 0, "time_base": "1/10"}, {"frames": frames}, "hash")
    assert out["portrait"]["status"] == "failed"
    assert out["ugly_cute"]["status"] == "not_found"


def test_photo_cancellation_is_terminal_even_when_no_photo_qualifies(tmp_path):
    with pytest.raises(media.Cancelled):
        photos.export_photos(tmp_path, tmp_path / "unused.mp4", {}, {}, {}, "hash", lambda: True)
    assert not (tmp_path / "photos").exists()
