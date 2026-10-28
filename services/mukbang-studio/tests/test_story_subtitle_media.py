import shutil

import pytest
from PIL import Image, ImageChops

from mukbang import media, story_subtitles


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
@pytest.mark.parametrize("color_range", ["tv", "pc"])
def test_real_subtitles_burn_once_preserving_frames_audio_range_and_blank_space(tmp_path, color_range):
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
               "color=c=black:size=640x360:rate=10:duration=8", "-f", "lavfi", "-i",
               "sine=frequency=440:sample_rate=8000:duration=8", "-vf", f"setparams=range={color_range}",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", color_range,
               "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
               "-c:a", "aac", "-ac", "1", str(source)])
    info = media.video_info(media.probe(source), media.frame_times(source))
    clips = media.quantize_clips([{"id": "s", "start": 0., "end": 8.}], info)
    paths = story_subtitles.write_subtitles(tmp_path, [{"text": "哎？怎么又回来了。", "output_start": 2., "output_end": 4.2}], info)
    baseline, captioned = tmp_path / "baseline.mp4", tmp_path / "interaction-story.mp4"
    media.render_video(source, baseline, clips, info)
    report = media.render_video(source, captioned, clips, info, subtitle_file=paths["ass"])
    assert report["full_decode_pass"] and report["frame_count_match"]
    assert report["native_color_range_preserved"]
    assert report["decoded_frames"] == 80
    assert report["audio_sample_rate"] == 8000 and report["audio_channels"] == 1
    assert "ass=filename=interaction-story.ass" in captioned.with_suffix(".filters.txt").read_text(encoding="utf-8")
    def audio_hash(path):
        return media.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a", "-c:a", "pcm_s16le", "-f", "hash", "-hash", "sha256", "-"])
    assert audio_hash(baseline) == audio_hash(captioned), "Captioning must not change the original-sound path"
    def pixel_hash(path, moment):
        return media.run(["ffmpeg", "-v", "error", "-ss", str(moment), "-i", str(path), "-frames:v", "1",
                          "-an", "-pix_fmt", "rgb24", "-f", "hash", "-hash", "sha256", "-"])
    assert pixel_hash(baseline, .5) == pixel_hash(captioned, .5)
    assert pixel_hash(baseline, 3.) != pixel_hash(captioned, 3.), "Subtitle glyphs must actually appear"
    # Inter-frame lossy encoding may leave <=a few levels of quantization
    # difference after a cue. Test absence of glyphs, not lossless equality.
    images = []
    for video in (baseline, captioned):
        image = tmp_path / f"{video.stem}-blank.png"
        media.run(["ffmpeg", "-v", "error", "-ss", "6", "-i", str(video), "-frames:v", "1", "-y", str(image)])
        with Image.open(image) as opened:
            images.append(opened.convert("RGB"))
    assert max(high for _, high in ImageChops.difference(*images).getextrema()) <= 3


def test_subtitle_filter_never_accepts_a_model_path_or_another_directory(tmp_path):
    outer = tmp_path / "outside"
    outer.mkdir()
    foreign = outer / "interaction-story.ass"
    foreign.write_text("not used", encoding="utf-8")
    info = {"audio_stream": None, "time_base": "1/10", "pts": list(range(10)), "origin_pts": 0, "end_pts": 10}
    clips = media.quantize_clips([{"id": "s", "start": 0., "end": 1.}], info)
    with pytest.raises(ValueError, match="本任务"):
        media._render_command(tmp_path / "source.mp4", tmp_path / "out.mp4", clips, info, subtitle_file=foreign)
