"""Small offline fixtures for shared decoding and non-overlapping step timings."""
from copy import deepcopy
from itertools import count
from pathlib import Path
import shutil

import pytest

from mukbang import media


def test_frame_probe_threads_default_is_four(monkeypatch):
    monkeypatch.delenv("MUKBANG_FFPROBE_THREADS", raising=False)
    assert media.frame_probe_threads() == 4


@pytest.mark.parametrize("value", ["0", "1", "4", "32"])
def test_frame_probe_threads_accept_integer_boundaries(monkeypatch, value):
    monkeypatch.setenv("MUKBANG_FFPROBE_THREADS", value)
    assert media.frame_probe_threads() == int(value)


@pytest.mark.parametrize("value", ["", "-1", "33", "4.0", "1e1", "four", "4x", "0x4", " 4", "4 ", "+4", "４", "9" * 5000])
def test_frame_probe_threads_reject_invalid_values_before_running(monkeypatch, tmp_path, value):
    monkeypatch.setenv("MUKBANG_FFPROBE_THREADS", value)
    calls = []
    monkeypatch.setattr(media, "run", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(ValueError, match="MUKBANG_FFPROBE_THREADS"):
        media.frame_times(tmp_path / "source.mp4")
    assert calls == []


@pytest.mark.parametrize("value", ["0", "4"])
def test_thread_configuration_only_applies_to_frame_probe(monkeypatch, tmp_path, value):
    monkeypatch.setenv("MUKBANG_FFPROBE_THREADS", value)
    commands, cancellations = [], []

    def capture(args, cancelled=None):
        commands.append(args)
        cancellations.append(cancelled)
        return '{"frames": [], "streams": []}'

    monkeypatch.setattr(media, "run", capture)
    source = tmp_path / "input.mp4"
    cancelled = lambda: False
    media.probe(source, cancelled)
    assert media.frame_times(source, cancelled) == []
    metadata_command, scan_command = commands
    assert "-threads:v" not in metadata_command
    assert scan_command[0] == "ffprobe"
    assert scan_command[scan_command.index("-threads:v") + 1] == value
    assert scan_command.index("-threads:v") < len(scan_command) - 1
    assert scan_command[-1] == str(source)
    assert "-show_frames" in scan_command and "-count_frames" not in scan_command
    assert scan_command[scan_command.index("-protocol_whitelist") + 1] == "file,pipe"
    assert scan_command[scan_command.index("-show_entries") + 1] == (
        "frame=best_effort_timestamp,best_effort_timestamp_time,duration,duration_time")
    assert cancellations == [cancelled, cancelled]

    rows = [{"best_effort_timestamp": 0, "duration": 1},
            {"best_effort_timestamp": 1, "duration": 1}]
    info = media.video_info({"streams": [{"codec_type": "video", "time_base": "1/1",
                                          "width": 64, "height": 96}]}, rows)
    clips = media.quantize_clips([{"id": "c01", "start": 0, "end": 2}], info)
    encode_command = media._render_command(source, tmp_path / "output.mp4", clips, info)
    assert "-threads:v" not in encode_command and "-threads" not in encode_command
    assert encode_command[encode_command.index("-preset") + 1] == "fast"
    assert encode_command[encode_command.index("-crf") + 1] == "20"


@pytest.fixture
def validation_fixture(tmp_path, monkeypatch):
    output = tmp_path / "output.mp4"
    output.write_bytes(b"offline validation fixture")
    source_frames = [
        {"best_effort_timestamp": "0", "best_effort_timestamp_time": "0", "duration": "10"},
        {"best_effort_timestamp": "10", "best_effort_timestamp_time": "1", "duration": "10"},
    ]
    source_video = {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p",
                    "color_range": "tv", "width": 64, "height": 96, "time_base": "1/10",
                    "duration_ts": 20, "start_pts": 0}
    info = media.video_info({"streams": [source_video]}, source_frames)
    clips = media.quantize_clips([{"id": "c01", "start": 0., "end": 2.}], info)
    metadata = {"streams": [{"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p",
                             "color_range": "tv", "width": 64, "height": 96, "duration": "2"}],
                "format": {"duration": "2"}}
    calls, scans, commands = [], [], []
    actual_frames = deepcopy(source_frames)

    def probe(path, cancelled=None, *, count=False):
        calls.append(count)
        assert count is False, "frame count must come from the same real PTS scan"
        return deepcopy(metadata)

    def frame_times(path, cancelled=None):
        scans.append(path)
        return deepcopy(actual_frames)

    def run(args, *unused, **kwargs):
        commands.append(args)
        return ""

    monkeypatch.setattr(media, "probe", probe)
    monkeypatch.setattr(media, "frame_times", frame_times)
    monkeypatch.setattr(media, "run", run)
    return {"output": output, "info": info, "clips": clips, "metadata": metadata,
            "frames": actual_frames, "probes": calls, "scans": scans, "commands": commands}


def test_verification_counts_and_checks_pts_with_one_real_scan(validation_fixture):
    fixture = validation_fixture
    result = media.verify_video(fixture["output"], fixture["clips"], fixture["info"])
    assert fixture["probes"] == [False]
    assert fixture["scans"] == [fixture["output"]]
    assert result["decoded_frames"] == result["expected_frames"] == 2
    assert result["full_decode_pass"] and result["frame_count_match"]
    assert len(fixture["commands"]) == 1
    command = fixture["commands"][0]
    assert command[0] == "ffmpeg" and "-xerror" in command
    assert command[command.index("-i") + 1] == str(fixture["output"])
    assert "0:a:0?" in command and command[-2:] == ["null", "-"]


@pytest.mark.parametrize("broken", ["missing_frame", "wrong_pts"])
def test_single_scan_still_rejects_missing_frames_and_wrong_pts(validation_fixture, broken):
    fixture = validation_fixture
    if broken == "missing_frame":
        fixture["frames"].pop()
    else:
        fixture["frames"][1]["best_effort_timestamp_time"] = "1.5"
    with pytest.raises(RuntimeError, match="帧数|时间戳|时轴"):
        media.verify_video(fixture["output"], fixture["clips"], fixture["info"])
    assert len(fixture["scans"]) == 1
    assert fixture["commands"] == []


def test_verify_callback_uses_monotonic_disjoint_actual_steps(validation_fixture, monkeypatch):
    fixture, steps = validation_fixture, []
    ticks = count(10)
    monkeypatch.setattr(media.time, "monotonic", lambda: next(ticks))
    media.verify_video(fixture["output"], fixture["clips"], fixture["info"],
                       on_step=lambda *step: steps.append(step))
    assert [step[0] for step in steps] == ["probe_output", "scan_frames", "strict_decode"]
    assert all(step[2:] == (1, "completed") for step in steps)
    assert all(isinstance(step[1], str) and step[1] for step in steps)


@pytest.mark.parametrize("failure", [RuntimeError("decode fixture failed"), media.Cancelled("cancelled fixture")])
def test_failed_and_cancelled_actual_steps_are_recorded(validation_fixture, monkeypatch, failure):
    fixture, steps = validation_fixture, []

    def fail(*unused, **kwargs):
        raise failure

    monkeypatch.setattr(media, "run", fail)
    with pytest.raises(type(failure), match=str(failure)):
        media.verify_video(fixture["output"], fixture["clips"], fixture["info"],
                           on_step=lambda *step: steps.append(step))
    assert [step[0] for step in steps] == ["probe_output", "scan_frames", "strict_decode"]
    assert steps[-1][3] == ("cancelled" if isinstance(failure, media.Cancelled) else "failed")
    assert all(step[2] >= 0 for step in steps)


def test_step_callback_exception_is_not_swallowed(validation_fixture):
    fixture = validation_fixture

    def broken_observer(*unused):
        raise RuntimeError("observer fixture failed")

    with pytest.raises(RuntimeError, match="observer fixture failed"):
        media.verify_video(fixture["output"], fixture["clips"], fixture["info"], on_step=broken_observer)
    assert fixture["scans"] == []


def test_failed_encode_records_its_step_without_starting_verification(validation_fixture, monkeypatch):
    fixture, steps = validation_fixture, []

    def fail(*unused, **kwargs):
        raise RuntimeError("encoding fixture failed")

    monkeypatch.setattr(media, "run", fail)
    with pytest.raises(RuntimeError, match="encoding fixture failed"):
        media.render_video(Path("fixture-source.mp4"), fixture["output"], fixture["clips"], fixture["info"],
                           on_step=lambda *step: steps.append(step))
    assert [(step[0], step[3]) for step in steps] == [("encode_video", "failed")]
    assert fixture["probes"] == fixture["scans"] == []


def _source(tmp_path, codec, audio, full_range, rotation):
    raw = tmp_path / "raw.mp4"
    args = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
            "testsrc2=size=64x96:rate=10:duration=6"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=6",
                 "-ac", "2", "-c:a", "aac", "-b:a", "48k",
                 "-af", "aselect=not(between(t\\,2\\,2.4))"]
    video_filter = "select=not(between(t\\,1\\,1.4))"
    if full_range:
        video_filter += ",scale=in_range=tv:out_range=pc,format=yuv420p"
    args += ["-vf", video_filter, "-fps_mode", "vfr", "-c:v", codec, "-pix_fmt", "yuv420p",
             "-color_range", "pc" if full_range else "tv", "-colorspace", "bt709",
             "-color_primaries", "bt709", "-color_trc", "bt709", str(raw)]
    media.run(args)
    if rotation:
        source = tmp_path / "rotated.mp4"
        media.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-display_rotation:v:0", "90",
                   "-i", str(raw), "-c", "copy", str(source)])
    else:
        source = raw
    info = media.video_info(media.probe(source), media.frame_times(source))
    return source, info


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg/ffprobe required")
@pytest.mark.parametrize("codec", ["libx264", "libx265"])
def test_frame_probe_timing_fields_match_auto_single_and_four_threads(tmp_path, monkeypatch, codec):
    if codec == "libx265" and "libx265" not in media.run(["ffmpeg", "-hide_banner", "-encoders"]):
        pytest.skip("HEVC fixture encoder unavailable")
    source, _ = _source(tmp_path, codec, False, False, False)
    timing_fields = ("best_effort_timestamp", "best_effort_timestamp_time", "duration", "duration_time")
    scans = []
    for threads in ("0", "1", "4"):
        monkeypatch.setenv("MUKBANG_FFPROBE_THREADS", threads)
        scans.append([{key: row[key] for key in timing_fields if key in row}
                      for row in media.frame_times(source)])
    assert len(scans[0]) > 1
    assert all(set(row) == set(timing_fields) for row in scans[0])
    assert scans[0] == scans[1] == scans[2]


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg/ffprobe required")
@pytest.mark.parametrize("codec,audio,full_range,rotation", [
    ("libx264", False, False, False),
    ("libx264", True, False, False),
    ("libx265", True, True, False),
    ("libx264", True, False, True),
])
def test_meme_shares_one_lossless_source_branch_for_mp4_and_gif(
        tmp_path, monkeypatch, codec, audio, full_range, rotation):
    if codec == "libx265" and "libx265" not in media.run(["ffmpeg", "-hide_banner", "-encoders"]):
        pytest.skip("HEVC fixture encoder unavailable")
    source, info = _source(tmp_path, codec, audio, full_range, rotation)
    before = media.sha256(source)
    real_run, commands, steps = media.run, [], []

    def capture(args, *args_rest, **kwargs):
        commands.append(args)
        return real_run(args, *args_rest, **kwargs)

    monkeypatch.setattr(media, "run", capture)
    result = media.render_meme(source, tmp_path,
                               {"id": "m01", "start": 0.5, "end": 3.5, "frame_ids": ["F0002"]}, info,
                               on_step=lambda *step: steps.append(step))
    original_decodes = [args for args in commands if args[0] == "ffmpeg" and "-i" in args
                        and args[args.index("-i") + 1] == str(source)]
    assert len(original_decodes) == 1
    shared = original_decodes[0]
    assert shared.count("-i") == 1 and "-ss" not in shared
    assert str(tmp_path / result["video_path"]) in shared and str(tmp_path / result["gif_path"]) in shared
    graph = (tmp_path / "memes/m01.filters.txt").read_text(encoding="utf-8")
    assert "split" in graph and "palettegen" in graph and "paletteuse" in graph
    assert shared[shared.index("-c:v") + 1] == "libx264"
    assert shared[shared.index("-preset") + 1] == "fast"
    assert shared[shared.index("-crf") + 1] == "20"
    assert not any("-count_frames" in args and str(tmp_path / result["video_path"]) in args for args in commands)
    assert [step[0] for step in steps] == ["encode_av_gif", "probe_output", "scan_frames", "strict_decode", "verify_gif"]
    assert all(step[2] >= 0 and step[3] == "completed" for step in steps)
    validation = result["validation"]
    assert validation["full_decode_pass"] and validation["frame_count_match"]
    assert validation["source_speed_preserved"] and validation["native_dimensions_preserved"]
    assert validation["native_color_range_preserved"]
    assert validation["output_effective_color_range"] == ("full" if full_range else "limited")
    assert validation["audio_sample_rate"] == (8000 if audio else None)
    assert validation["audio_channels"] == (2 if audio else None)
    assert media.sha256(source) == before
    assert result["duration"] == pytest.approx(3)
    assert result["repeated_in_main_video"] is False

    # Pixel-level reference: old GIF construction directly from native decoded
    # source pixels, not from the already-lossy MP4 output.
    reference = tmp_path / "reference.gif"
    graph = (f"trim=start_pts={result['source_start_pts']}:end_pts={result['source_end_pts']},setpts=PTS-STARTPTS,"
             "fps=10,scale=320:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];"
             "[b][p]paletteuse=dither=sierra2_4a")
    real_run(["ffmpeg", "-v", "error", "-nostdin", "-y"] + media.SAFE_INPUT_OPTIONS + [
        "-i", str(source), "-filter_complex", graph, "-an", "-loop", "0", str(reference)])
    assert (tmp_path / result["gif_path"]).read_bytes() == reference.read_bytes()
