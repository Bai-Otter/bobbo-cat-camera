from pathlib import Path
import shutil

import pytest

from mukbang import media
from mukbang.timing import JobTimings


def test_three_minutes_at_one_fps_is_three_60_frame_sheets():
    times = media.sampling_times(180, 1)
    assert len(times) == 180
    assert times[0] == 0 and times[-1] == 179
    assert (len(times) + 59) // 60 == 3
    assert len(media.sampling_times(180.02, 1)) == 181


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_real_three_minute_sampling_emits_180_frames_and_three_sheets(tmp_path):
    """Exercise the actual AVExpr parser, not only the sampling-time math."""
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
               "testsrc2=size=64x96:rate=2:duration=180", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
    info = media.video_info(media.probe(source), media.frame_times(source))
    assert info["duration"] == 180
    sampling = media.sample_video(source, tmp_path, info, 1)
    assert sampling["frame_count"] == 180 and sampling["sheet_count"] == 3
    assert [s["count"] for s in sampling["sheets"]] == [60, 60, 60]
    assert [f["id"] for f in sampling["frames"]] == [f"F{i + 1:04d}" for i in range(180)]
    assert [f["time"] for f in sampling["frames"]] == list(range(180))
    assert [f["source_frame_index"] for f in sampling["frames"]] == list(range(0, 360, 2))
    assert [f["source_pts"] for f in sampling["frames"]] == info["pts"][::2]
    assert len(list((tmp_path / "samples").glob("*.jpg"))) == 180
    assert all((tmp_path / sheet["path"]).is_file() for sheet in sampling["sheets"])


def test_frame_select_expression_depth_is_logarithmic():
    expression = media._frame_select_expression(list(range(450)))
    assert expression.count("eq(n\\,") == 450
    depth, maximum = 0, 0
    for character in expression:
        if character == "(":
            depth += 1
            maximum = max(maximum, depth)
        elif character == ")":
            depth -= 1
    assert depth == 0 and maximum <= 10


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_real_sampling_measures_extraction_and_sheets_separately(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    _synthetic_source(source, False)
    info = media.video_info(media.probe(source), media.frame_times(source))
    class Clock:
        value = 0.0
        def __call__(self):
            return self.value
    clock, updates = Clock(), []
    real_run, real_sheets = media.run, media.create_sheets
    def run_with_cost(*args, **kwargs):
        result = real_run(*args, **kwargs)
        clock.value += 3
        return result
    def sheets_with_cost(*args, **kwargs):
        result = real_sheets(*args, **kwargs)
        clock.value += 2
        return result
    monkeypatch.setattr(media, "run", run_with_cost)
    monkeypatch.setattr(media, "create_sheets", sheets_with_cost)
    timings = JobTimings(clock=clock, on_update=updates.append)
    sampling = media.sample_video(source, tmp_path, info, 1, timings=timings)
    value = timings.finish("completed")
    rows = {row["id"]: row for row in value["stages"]}
    assert sampling["frame_count"] == 8 and sampling["sheet_count"] == 1
    assert rows["extract_frames"]["seconds"] == 3
    assert rows["build_sheets"]["seconds"] == 2
    assert rows["ai_request"]["seconds"] is None
    assert [update["active_stage"] for update in updates] == ["extract_frames", None, "build_sheets", None, None]


def _synthetic_source(path: Path, audio: bool):
    args = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=128x192:rate=10:duration=8"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=8", "-ac", "2", "-c:a", "aac", "-b:a", "48k",
                 "-af", "aselect=not(between(t\\,3\\,3.5))"]
    args += ["-vf", "select=not(between(t\\,2\\,2.5))", "-fps_mode", "vfr",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    media.run(args)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
@pytest.mark.parametrize("audio", [False, True])
def test_synthetic_render_preserves_native_speed_audio_and_gif(tmp_path, audio):
    source = tmp_path / "source.mp4"
    _synthetic_source(source, audio)
    frames = media.frame_times(source)
    info = media.video_info(media.probe(source), frames)
    assert len(set(b - a for a, b in zip(info["pts"], info["pts"][1:]))) > 1
    sampling = media.sample_video(source, tmp_path, info, 1)
    assert sampling["frame_count"] == 8
    assert sampling["sheet_count"] == 1
    assert len(list((tmp_path / "samples").glob("*.jpg"))) == 8
    clips = media.quantize_clips([
        {"id": "c01", "start": 1.0, "end": 3.0, "context_end": 4.0},
        {"id": "c02", "start": 5.0, "end": 7.0, "context_end": 8.0}], info)
    validation = media.render_video(source, tmp_path / "output.mp4", clips, info)
    assert validation["frame_count_match"] and validation["full_decode_pass"]
    assert validation["expected_duration_seconds"] == 4
    assert validation["audio_sample_rate"] == (8000 if audio else None)
    assert validation["audio_channels"] == (2 if audio else None)
    meme = media.render_meme(source, tmp_path, {"id": "m01", "start": 1., "end": 2.5, "frame_ids": ["F0002"]}, info)
    assert (tmp_path / meme["gif_path"]).is_file()
    assert meme["repeated_in_main_video"] is False
    original_hash = sampling["sheets"][0]["sha256"]
    media.annotate_sheets(tmp_path, sampling, [{"frame_id": "F0002", "score": 90, "reason": "synthetic fixture", "labels": ["test"]}], [meme])
    assert sampling["frames"][1]["selected"]
    assert sampling["frames"][1]["meme_selected"]
    assert sampling["sheets"][0]["selected_count"] == 1
    assert media.sha256(tmp_path / sampling["sheets"][0]["path"]) == original_hash


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
@pytest.mark.parametrize("source_codec", ["libx264", "libx265"])
def test_real_full_range_render_preserves_range_and_passes_validation(tmp_path, source_codec):
    if source_codec == "libx265" and "libx265" not in media.run(["ffmpeg", "-hide_banner", "-encoders"]):
        pytest.skip("FFmpeg HEVC encoder not installed")
    source, output = tmp_path / "full-range.mp4", tmp_path / "output.mp4"
    # Convert the synthetic limited-range samples as well as declaring their
    # range. Merely adding a pc tag would not reproduce a genuine full-range
    # source safely.
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
               "testsrc2=size=64x96:rate=10:duration=3", "-vf",
               "scale=in_range=tv:out_range=pc,format=yuv420p", "-c:v", source_codec,
               "-pix_fmt", "yuv420p", "-color_range", "pc", str(source)])
    info = media.video_info(media.probe(source), media.frame_times(source))
    assert info["video_stream"]["codec_name"] == ("hevc" if source_codec == "libx265" else "h264")
    assert info["video_stream"]["pix_fmt"] == "yuvj420p"
    assert info["video_stream"]["color_range"] == "pc"
    clips = media.quantize_clips([{"id": "c01", "start": 0.5, "end": 2.5,
                                   "context_end": 2.5}], info)

    validation = media.render_video(source, output, clips, info)

    assert validation["full_decode_pass"] and validation["frame_count_match"]
    assert validation["source_pix_fmt"] == "yuvj420p"
    assert validation["output_pix_fmt"] == "yuvj420p"
    assert validation["source_color_range"] == validation["output_color_range"] == "pc"
    assert validation["source_effective_color_range"] == validation["output_effective_color_range"] == "full"
    assert validation["native_color_range_preserved"] is True


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_real_limited_range_render_audits_declared_range(tmp_path):
    source, output = tmp_path / "limited-range.mp4", tmp_path / "output.mp4"
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
               "testsrc2=size=64x96:rate=10:duration=3", "-c:v", "libx264",
               "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709",
               "-color_primaries", "bt709", "-color_trc", "bt709", str(source)])
    info = media.video_info(media.probe(source), media.frame_times(source))
    assert info["video_stream"]["color_range"] == "tv"
    clips = media.quantize_clips([{"id": "c01", "start": 0.5, "end": 2.5,
                                   "context_end": 2.5}], info)

    validation = media.render_video(source, output, clips, info)

    assert validation["full_decode_pass"] and validation["frame_count_match"]
    assert validation["source_pix_fmt"] == validation["output_pix_fmt"] == "yuv420p"
    assert validation["source_color_range"] == validation["output_color_range"] == "tv"
    assert validation["source_effective_color_range"] == validation["output_effective_color_range"] == "limited"
    assert validation["native_color_range_preserved"] is True


@pytest.fixture
def color_validation_case(tmp_path, monkeypatch):
    """Keep range/format cases independent of FFmpeg's own tag normalization."""
    path = tmp_path / "technical-metadata-fixture.mp4"
    path.write_bytes(b"metadata-only unit-test fixture")
    frames = [{"best_effort_timestamp": str(pts), "best_effort_timestamp_time": str(pts / 10),
               "duration": "10"} for pts in (0, 10)]
    monkeypatch.setattr(media, "frame_times", lambda *args, **kwargs: frames)
    monkeypatch.setattr(media, "run", lambda *args, **kwargs: "")

    def validate(source_fields, output_fields):
        source_video = {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p",
                        "color_range": "tv", "width": 64, "height": 96, "time_base": "1/10",
                        "duration_ts": 20, "start_pts": 0, **source_fields}
        output_video = {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p",
                        "color_range": "tv", "width": 64, "height": 96, "nb_read_frames": "2",
                        "duration": "2", **output_fields}
        for stream in (source_video, output_video):
            if stream.get("color_range") is None:
                stream.pop("color_range", None)
        info = media.video_info({"streams": [source_video]}, frames)
        clips = media.quantize_clips([{"id": "c01", "start": 0., "end": 2., "context_end": 2.}], info)
        monkeypatch.setattr(media, "probe", lambda *args, **kwargs:
                            {"streams": [output_video], "format": {"duration": "2"}})
        return media.verify_video(path, clips, info)

    return validate


@pytest.mark.parametrize("source_fmt,source_range,output_fmt,output_range,effective,preserved", [
    ("yuv420p", "tv", "yuv420p", "tv", "limited", True),
    ("yuv420p", "limited", "yuv420p", "mpeg", "limited", True),
    ("yuvj420p", "pc", "yuvj420p", "pc", "full", True),
    ("yuvj420p", "pc", "yuv420p", "pc", "full", True),
    ("yuv420p", "full", "yuvj420p", "jpeg", "full", True),
    ("yuv420p", None, "yuv420p", None, "unknown", None),
    ("yuv420p", "unknown", "yuv420p", "unspecified", "unknown", None),
    ("yuv420p", None, "yuv420p", "tv", "limited", None),
])
def test_video_range_validation_accepts_consistent_8bit_420_and_audits_unknown(
        color_validation_case, source_fmt, source_range, output_fmt, output_range, effective, preserved):
    result = color_validation_case({"pix_fmt": source_fmt, "color_range": source_range},
                                   {"pix_fmt": output_fmt, "color_range": output_range})
    assert result["full_decode_pass"]
    assert result["source_pix_fmt"] == source_fmt and result["output_pix_fmt"] == output_fmt
    assert result["source_color_range"] == source_range and result["output_color_range"] == output_range
    assert result["source_effective_color_range"] == ("unknown" if preserved is None else effective)
    assert result["output_effective_color_range"] == effective
    assert result["native_color_range_preserved"] is preserved


@pytest.mark.parametrize("codec,pix_fmt,color_range", [
    ("hevc", "yuv420p", "tv"),
    ("vp9", "yuv420p", "tv"),
    ("h264", "yuv420p10le", "tv"),
    ("h264", "yuv420p12le", "tv"),
    ("h264", "yuv422p", "tv"),
    ("h264", "yuvj422p", "pc"),
    ("h264", "yuv444p", "tv"),
    ("h264", "yuvj444p", "pc"),
    ("h264", "nv12", "tv"),
])
def test_video_validation_still_rejects_wrong_codec_bit_depth_or_subsampling(
        color_validation_case, codec, pix_fmt, color_range):
    with pytest.raises(RuntimeError, match="编码或像素格式不符"):
        color_validation_case({}, {"codec_name": codec, "pix_fmt": pix_fmt, "color_range": color_range})


@pytest.mark.parametrize("source_fmt,source_range,output_fmt,output_range", [
    ("yuvj420p", "pc", "yuvj420p", "tv"),
    ("yuvj420p", "pc", "yuvj420p", "unknown"),
    ("yuvj420p", "pc", "yuvj420p", None),
    ("yuvj420p", "pc", "yuv420p", "tv"),
    ("yuvj420p", "pc", "yuv420p", None),
    ("yuv420p", "pc", "yuv420p", "unknown"),
    ("yuv420p", "tv", "yuv420p", "pc"),
    ("yuv420p", "tv", "yuv420p", None),
    ("yuv420p", None, "yuv420p", "pc"),
    ("yuv420p", None, "yuvj420p", "pc"),
    ("yuvj420p", "tv", "yuvj420p", "pc"),
    ("yuvj420p", None, "yuvj420p", "pc"),
    ("yuv420p", "invalid", "yuv420p", "tv"),
    ("yuv420p", "tv", "yuv420p", "invalid"),
])
def test_video_validation_rejects_contradictory_missing_or_changed_known_range(
        color_validation_case, source_fmt, source_range, output_fmt, output_range):
    with pytest.raises(RuntimeError, match="色阶"):
        color_validation_case({"pix_fmt": source_fmt, "color_range": source_range},
                              {"pix_fmt": output_fmt, "color_range": output_range})


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_phone_rotation_preserves_displayed_framing(tmp_path):
    raw, source = tmp_path / "raw.mp4", tmp_path / "source.mp4"
    _synthetic_source(raw, False)
    media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-display_rotation:v:0", "90",
               "-i", str(raw), "-c", "copy", str(source)])
    info = media.video_info(media.probe(source), media.frame_times(source))
    assert (info["width"], info["height"]) == (192, 128)
    clips = media.quantize_clips([{"id": "c01", "start": 4., "end": 6., "context_end": 6.}], info)
    validation = media.render_video(source, tmp_path / "rotated-output.mp4", clips, info)
    assert validation["native_dimensions_preserved"]


@pytest.mark.skipif(not shutil.which("ffprobe"), reason="FFprobe not installed")
def test_playlist_disguised_as_mp4_is_rejected_without_network(tmp_path):
    fake = tmp_path / "pretend.mp4"
    # Reserved local port is only inert fixture text: protocols/format must
    # reject this before the manifest can open any secondary URL.
    fake.write_text("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttp://127.0.0.1:9/never-contacted.ts\n#EXT-X-ENDLIST\n", encoding="utf-8")
    with pytest.raises(RuntimeError):
        media.probe(fake)
    playlist = tmp_path / "pretend.m3u8"
    playlist.write_bytes(fake.read_bytes())
    with pytest.raises(RuntimeError, match="whitelist"):
        media.probe(playlist)


def test_media_subprocess_inputs_have_container_and_protocol_allowlists(monkeypatch, tmp_path):
    commands = []
    def capture(args, *unused, **kwargs):
        commands.append(args)
        return '{"frames": [], "streams": []}'
    monkeypatch.setattr(media, "run", capture)
    media.probe(tmp_path / "input.mp4")
    media.frame_times(tmp_path / "input.mp4")
    assert len(commands) == 2
    for command in commands:
        assert command[command.index("-protocol_whitelist") + 1] == "file,pipe"
        assert "hls" not in command[command.index("-format_whitelist") + 1]
