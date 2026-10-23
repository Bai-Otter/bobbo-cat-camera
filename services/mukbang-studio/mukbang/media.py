"""Deterministic media operations; source imagery is never reviewed here."""
from __future__ import annotations

from bisect import bisect_left
from contextlib import contextmanager, nullcontext
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from typing import Callable

from PIL import Image, ImageDraw, ImageFont


# Accept actual self-contained media containers, not playlists or network
# manifests disguised as an uploaded .mp4. Never grant network protocols to a
# media subprocess; provider HTTP is exclusively handled by vision.py.
SAFE_INPUT_OPTIONS = ["-protocol_whitelist", "file,pipe", "-format_whitelist",
                      "mov,matroska,webm,avi,mpegts,mpeg,ogg,flv,gif"]


class Cancelled(RuntimeError):
    pass


def check_cancelled(cancelled: Callable[[], bool] | None) -> None:
    if cancelled and cancelled():
        raise Cancelled("任务已取消")


def run(args: list[str], cancelled=None, timeout=900) -> str:
    check_cancelled(cancelled)
    started = time.monotonic()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", errors="replace")
    try:
        while True:
            check_cancelled(cancelled)
            try:
                stdout, stderr = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() - started > timeout:
                    raise RuntimeError("媒体处理超时；输入与调试资料已保留")
    except BaseException:
        process.kill()
        process.communicate()
        raise
    if process.returncode:
        raise RuntimeError("媒体处理失败：" + stderr[-5000:])
    return stdout


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def artifact_url(job_dir: Path, relative: str | Path) -> str:
    from urllib.parse import quote
    return f"/api/jobs/{quote(job_dir.name, safe='')}/files/{quote(Path(relative).as_posix(), safe='/')}"


_FRAME_INPUT_FIELDS = ("id", "time", "requested_time", "source_frame_index", "source_pts",
                       "path", "sheet_id", "row", "col", "box")


def _frame_input(frame: dict) -> dict:
    return {name: frame[name] for name in _FRAME_INPUT_FIELDS}


def write_input_cache_integrity(job_dir: Path, source: Path, sampling: dict, source_digest: str) -> dict:
    """Record only reusable, immutable inputs, never annotations or credentials."""
    value = {"version": 1, "source_path": source.name, "source_sha256": source_digest,
             "metadata_sha256": sha256(job_dir / "source-metadata.json"),
             "pts_sha256": sha256(job_dir / "source-pts.json"),
             "interval": sampling["interval"],
             "frames": [{**_frame_input(frame), "sha256": sha256(job_dir / frame["path"])}
                        for frame in sampling["frames"]],
             "sheets": [{"id": sheet["id"], "path": sheet["path"], "sha256": sheet["sha256"],
                         "frame_ids": [frame["id"] for frame in sheet["frames"]]}
                        for sheet in sampling["sheets"]]}
    write_json(job_dir / "input-cache-integrity.json", value)
    return value


def reuse_inputs(job_dir: Path, source: Path, revision: dict, interval: float, cancelled=None) -> tuple[dict, dict, str]:
    """Copy verified same-video inputs without probing, decoding or sampling.

    Older jobs have no input-cache-integrity manifest. Their stored sheet
    digests and PTS mapping can still be verified; missing historic source or
    per-frame digests are explicitly recorded, not retrospectively invented.
    """
    check_cancelled(cancelled)
    root, target = Path(revision["reuse_from"]).resolve(), Path(job_dir).resolve()
    source = Path(source).resolve()
    if root == target or not root.is_dir() or not source.is_relative_to(target) or source.parent != target:
        raise ValueError("复用任务或源视频路径无效")
    if source.exists():
        raise ValueError("复用任务已有源视频，已停止以避免覆盖")

    def cached(relative: str | Path) -> Path:
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("原任务输入缓存缺失或路径越界；不会重新抽帧或追加AI调用")
        return path

    def load(relative: str) -> dict:
        try:
            value = json.loads(cached(relative).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ValueError(f"原任务{relative}缓存不可读取；不会重新抽帧") from None
        if not isinstance(value, dict):
            raise ValueError(f"原任务{relative}缓存结构无效")
        return value

    metadata, pts_record, original = (load(name) for name in
                                      ("source-metadata.json", "source-pts.json", "sampling.json"))
    try:
        stored_interval = float(original["interval"])
        if not math.isfinite(stored_interval) or abs(stored_interval - interval) > 1e-9:
            raise ValueError("同视频重选不能更改采样间隔")
        points = pts_record["pts"]
        end_pts = pts_record["end_pts"]
        if (not isinstance(points, list) or not points or
                any(not isinstance(p, int) or isinstance(p, bool) for p in points) or
                not isinstance(end_pts, int) or isinstance(end_pts, bool) or
                end_pts <= points[-1] or any(a >= b for a, b in zip(points, points[1:]))):
            raise ValueError("原任务源PTS缓存无效")
        restored_frames = [{"best_effort_timestamp": point,
                            "duration": (points[index + 1] if index + 1 < len(points) else end_pts) - point}
                           for index, point in enumerate(points)]
        info = video_info(metadata, restored_frames)
        if any(info[name] != pts_record[name] for name in ("time_base", "origin_pts", "end_pts", "pts")):
            raise ValueError("原任务元数据与源PTS不一致")
        if not 0 < info["duration"] <= 600.001:
            raise ValueError("原任务源视频时长无效")
        raw_frames, raw_sheets = original["frames"], original["sheets"]
        if (not isinstance(raw_frames, list) or not raw_frames or not isinstance(raw_sheets, list) or
                original["frame_count"] != len(raw_frames) or original["sheet_count"] != len(raw_sheets) or
                original["frames_per_sheet"] != 60 or len(raw_sheets) != math.ceil(len(raw_frames) / 60)):
            raise ValueError("原任务采样数量或拼图数量不一致")
        # Recompute index arithmetic only: no image decode or frame extraction.
        source_times = [(p - info["origin_pts"]) * float(Fraction(info["time_base"])) for p in points]
        expected = []
        for request in sampling_times(info["duration"], interval):
            right = bisect_left(source_times, request)
            candidates = [index for index in (right - 1, right) if 0 <= index < len(points)]
            index = min(candidates, key=lambda i: abs(source_times[i] - request))
            if not expected or expected[-1][0] != index:
                expected.append((index, request))
        if len(expected) != len(raw_frames):
            raise ValueError("原任务采样帧与源PTS数量不匹配")
        frames = []
        for number, (frame, (index, request)) in enumerate(zip(raw_frames, expected), 1):
            clean = _frame_input(frame)
            if (clean["id"] != f"F{number:04d}" or clean["path"] != f"samples/frame-{number:05d}.jpg" or
                    clean["source_frame_index"] != index or clean["source_pts"] != points[index] or
                    clean["time"] != round(source_times[index], 6) or clean["requested_time"] != request):
                raise ValueError("原任务采样帧ID、路径或源时间映射不一致")
            clean["url"] = artifact_url(target, clean["path"])
            frames.append(clean)
        sheets = []
        for number, sheet in enumerate(raw_sheets, 1):
            group = frames[(number - 1) * 60:number * 60]
            expected_id = f"S{number:02d}"
            if (sheet["id"] != expected_id or sheet["index"] != number or
                    sheet["path"] != f"sheets/{expected_id}-input.jpg" or sheet["count"] != len(group) or
                    not isinstance(sheet["width"], int) or not isinstance(sheet["height"], int) or
                    sheet["width"] <= 0 or sheet["height"] <= 0 or
                    not isinstance(sheet["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", sheet["sha256"]) or
                    [_frame_input(frame) for frame in sheet["frames"]] != [_frame_input(frame) for frame in group]):
                raise ValueError("原任务拼图身份或帧清单不一致")
            for frame in group:
                if (frame["sheet_id"] != expected_id or not isinstance(frame["row"], int) or
                        not isinstance(frame["col"], int) or frame["row"] < 1 or frame["col"] < 1 or
                        not isinstance(frame["box"], list) or len(frame["box"]) != 4 or
                        any(not isinstance(n, int) or isinstance(n, bool) for n in frame["box"]) or
                        min(frame["box"][:2]) < 0 or min(frame["box"][2:]) <= 0 or
                        frame["box"][0] + frame["box"][2] > sheet["width"] or
                        frame["box"][1] + frame["box"][3] > sheet["height"]):
                    raise ValueError("原任务拼图坐标不一致")
            sheets.append({name: sheet[name] for name in
                           ("id", "index", "path", "count", "width", "height", "sha256")})
            sheets[-1].update(url=artifact_url(target, sheet["path"]), frames=group)
    except (KeyError, TypeError, IndexError, ZeroDivisionError, OverflowError):
        raise ValueError("原任务采样或时间戳缓存无效；不会重新抽帧") from None

    parent_source = cached(source.name)
    baseline = sha256(parent_source)
    integrity_path = root / "input-cache-integrity.json"
    integrity = load("input-cache-integrity.json") if integrity_path.exists() else None
    expected_source, expected_from = None, None
    timeline_path = root / "edit-timeline.json"
    if timeline_path.exists():
        expected_source = load("edit-timeline.json").get("source_sha256")
        if expected_source is not None:
            expected_from = "edit-timeline.json.source_sha256"
    if integrity is not None:
        if integrity.get("version") != 1 or integrity.get("source_path") != source.name:
            raise ValueError("原任务输入完整性清单无效")
        manifest_source = integrity.get("source_sha256")
        if not isinstance(manifest_source, str) or not re.fullmatch(r"[a-f0-9]{64}", manifest_source):
            raise ValueError("原任务完整性清单缺少有效的源视频摘要")
        if expected_source is not None and manifest_source != expected_source:
            raise ValueError("原任务源视频摘要记录互相矛盾")
        expected_source, expected_from = manifest_source, "input-cache-integrity.json.source_sha256"
    elif expected_source is None and (root / "reuse-provenance.json").exists():
        expected_source = load("reuse-provenance.json").get("source_baseline_sha256")
        if expected_source is not None:
            expected_from = "reuse-provenance.json.source_baseline_sha256"
    if expected_source is not None and (not isinstance(expected_source, str) or
            not re.fullmatch(r"[a-f0-9]{64}", expected_source) or expected_source != baseline):
        raise ValueError("原任务源视频摘要不一致；不会重新抽帧或发送AI")
    provenance = {"parent_job_id": revision["parent_job_id"], "root_job_id": revision["root_job_id"],
                  "round": revision["round"], "source_baseline_sha256": baseline,
                  "expected_source_sha256": expected_source, "expected_source_sha256_from": expected_from,
                  "historic_source_hash_available": expected_source is not None,
                  "historic_frame_hashes_available": integrity is not None,
                  "reused_without_probe_or_resampling": True,
                  "notice": "历史摘要存在时逐项核验；缺失的历史源或单帧摘要不追溯伪造，本轮以当前已核验输入建立新基线"}
    write_json(target / "reuse-provenance.json", provenance)
    if integrity is not None:
        if (integrity.get("interval") != original["interval"] or
                integrity.get("metadata_sha256") != sha256(cached("source-metadata.json")) or
                integrity.get("pts_sha256") != sha256(cached("source-pts.json")) or
                len(integrity.get("frames", [])) != len(frames) or
                len(integrity.get("sheets", [])) != len(sheets)):
            raise ValueError("原任务元数据、PTS或输入完整性清单不一致")
        for frame, recorded in zip(frames, integrity["frames"]):
            if _frame_input(frame) != {name: recorded.get(name) for name in _FRAME_INPUT_FIELDS}:
                raise ValueError("原任务帧ID或源PTS映射与完整性清单不一致")
        if integrity["sheets"] != [{"id": s["id"], "path": s["path"], "sha256": s["sha256"],
                                    "frame_ids": [f["id"] for f in s["frames"]]} for s in sheets]:
            raise ValueError("原任务拼图身份与完整性清单不一致")

    files = [(source.name, baseline), ("source-metadata.json", sha256(cached("source-metadata.json"))),
             ("source-pts.json", sha256(cached("source-pts.json")))]
    for index, frame in enumerate(frames):
        digest = sha256(cached(frame["path"]))
        if integrity is not None and digest != integrity["frames"][index].get("sha256"):
            raise ValueError("原任务采样帧摘要不一致")
        files.append((frame["path"], digest))
    for sheet in sheets:
        if sha256(cached(sheet["path"])) != sheet["sha256"]:
            raise ValueError("原任务拼图摘要不一致；不会重新生成拼图")
        files.append((sheet["path"], sheet["sha256"]))
    for relative, expected_digest in files:
        check_cancelled(cancelled)
        destination = (target / relative).resolve()
        if not destination.is_relative_to(target) or destination.exists():
            raise ValueError("复用输出路径无效或已有文件；不会覆盖")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cached(relative), destination)
        if sha256(destination) != expected_digest:
            raise ValueError("复制期间输入缓存发生变化；已停止")
    sampling = {"interval": original["interval"], "frames_per_sheet": 60, "frame_count": len(frames),
                "sheet_count": len(sheets), "frames": frames, "sheets": sheets,
                "sampling_notice": original.get("sampling_notice", "复用同一批采样帧；短于采样间隔的动作可能漏检")}
    write_input_cache_integrity(target, source, sampling, baseline)
    return info, sampling, baseline


def probe(path: Path, cancelled=None, *, count=False) -> dict:
    args = ["ffprobe", "-v", "error"]
    if count:
        args.append("-count_frames")
    return json.loads(run(args + SAFE_INPUT_OPTIONS + ["-show_streams", "-show_format", "-of", "json", str(path)], cancelled))


def frame_probe_threads() -> int:
    """Bound only ffprobe's frame-scan decoder; zero preserves FFmpeg auto."""
    raw = os.environ.get("MUKBANG_FFPROBE_THREADS", "4")
    error = "MUKBANG_FFPROBE_THREADS 必须是 0–32 之间的整数（0 表示自动）"
    if re.fullmatch(r"[0-9]+", raw) is None:
        raise ValueError(error)
    try:
        threads = int(raw)
    except ValueError:
        raise ValueError(error) from None
    if not 0 <= threads <= 32:
        raise ValueError(error)
    return threads


def frame_times(path: Path, cancelled=None) -> list[dict]:
    value = json.loads(run(["ffprobe", "-v", "error"] + SAFE_INPUT_OPTIONS + ["-threads:v", str(frame_probe_threads()),
                           "-select_streams", "v:0", "-show_frames",
                           "-show_entries", "frame=best_effort_timestamp,best_effort_timestamp_time,duration,duration_time",
                           "-of", "json", str(path)], cancelled))
    return value.get("frames", [])


def video_info(metadata: dict, frames: list[dict]) -> dict:
    videos = [s for s in metadata.get("streams", []) if s.get("codec_type") == "video"]
    if not videos or not frames:
        raise ValueError("上传文件没有可解码的视频画面")
    stream = videos[0]
    time_base = Fraction(stream["time_base"])
    try:
        pts = [int(f["best_effort_timestamp"]) for f in frames]
    except (ValueError, TypeError, KeyError):
        raise ValueError("视频缺少可靠的逐帧时间戳，无法审计原速剪辑") from None
    if any(a >= b for a, b in zip(pts, pts[1:])):
        raise ValueError("视频帧时间戳不是严格递增，暂不支持自动剪辑")
    final_duration = int(frames[-1].get("duration", 0) or 0)
    if final_duration <= 0:
        final_duration = pts[-1] - pts[-2] if len(pts) > 1 else max(1, round(1 / float(time_base) / 25))
    end_pts = pts[-1] + final_duration
    duration_ts = int(stream.get("duration_ts", 0) or 0)
    declared_end = int(stream.get("start_pts", pts[0])) + duration_ts
    # Container end may contain trailing empty time. Only the last frame's hold
    # is meaningful; use declared duration if it is within one observed frame.
    if duration_ts and pts[-1] < declared_end <= end_pts + max(final_duration, 1):
        end_pts = declared_end
    duration = float((end_pts - pts[0]) * time_base)
    audio = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "audio"), None)
    width, height = int(stream["width"]), int(stream["height"])
    rotation = 0.0
    for side_data in stream.get("side_data_list", []):
        if "rotation" in side_data:
            rotation = float(side_data["rotation"])
            break
    if not rotation and stream.get("tags", {}).get("rotate"):
        rotation = float(stream["tags"]["rotate"])
    if abs(rotation / 90 - round(rotation / 90)) > 0.00001:
        raise ValueError("视频使用非直角旋转矩阵，当前不能在保持原画幅的前提下处理")
    if round(rotation / 90) % 2:
        width, height = height, width
    if width % 2 or height % 2:
        raise ValueError("当前原尺寸H.264输出要求视频宽高均为偶数")
    return {"duration": duration, "width": width, "height": height,
            "fps": len(pts) / duration, "time_base": str(time_base), "origin_pts": pts[0],
            "end_pts": end_pts, "pts": pts, "video_stream": stream, "audio_stream": audio,
            "display_rotation": rotation,
            "audio_sample_rate": int(audio["sample_rate"]) if audio else None,
            "audio_channels": int(audio["channels"]) if audio else None}


def sampling_times(duration: float, interval: float) -> list[float]:
    if not math.isfinite(duration) or not math.isfinite(interval) or duration <= 0 or interval <= 0:
        raise ValueError("采样时长和间隔必须是正数")
    count = max(1, math.ceil(duration / interval - 1e-8))
    return [round(i * interval, 9) for i in range(count)]


def _font(size: int):
    for path in ("C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def timestamp(value: float) -> str:
    ms = round(value * 1000)
    return f"{ms // 60000:02d}:{(ms // 1000) % 60:02d}.{ms % 1000:03d}"


def _frame_select_expression(indexes: list[int]) -> str:
    """Build a balanced AVExpr tree instead of a recursion-heavy linear sum.

    FFmpeg's expression parser/evaluator has a bounded recursion depth. Even
    ~123 left-associative eq terms can hit it; balanced sums keep the depth
    logarithmic while selecting exactly the same decoded source frame IDs.
    """
    if not indexes:
        raise ValueError("采样索引不能为空")
    def build(left: int, right: int) -> str:
        if right - left == 1:
            return f"eq(n\\,{indexes[left]})"
        middle = (left + right) // 2
        return f"({build(left, middle)}+{build(middle, right)})"
    return build(0, len(indexes))


def sample_video(source: Path, job_dir: Path, info: dict, interval: float, cancelled=None, timings=None) -> dict:
    """Cache only requested samples, not all decoded original frames."""
    phase = timings.measure if timings is not None else lambda _: nullcontext()
    with phase("extract_frames"):
        folder = job_dir / "samples"
        folder.mkdir(exist_ok=True)
        tb = Fraction(info["time_base"])
        source_times = [(p - info["origin_pts"]) * float(tb) for p in info["pts"]]
        indexes, requests = [], []
        for requested in sampling_times(info["duration"], interval):
            i = bisect_left(source_times, requested)
            choices = [j for j in (i - 1, i) if 0 <= j < len(source_times)]
            index = min(choices, key=lambda j: abs(source_times[j] - requested))
            if indexes and indexes[-1] == index:
                continue
            indexes.append(index)
            requests.append(requested)
        # Chunk expressions keep native Windows CreateProcess below 32K chars.
        thumb_w = 216 if info["height"] >= info["width"] else 320
        for start in range(0, len(indexes), 450):
            chunk = indexes[start:start + 450]
            expression = _frame_select_expression(chunk)
            run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"] + SAFE_INPUT_OPTIONS + [
                 "-i", str(source), "-vf", f"select={expression},scale={thumb_w}:-2:flags=lanczos",
                 "-fps_mode", "passthrough", "-frames:v", str(len(chunk)), "-q:v", "2",
                 "-start_number", str(start + 1), str(folder / "frame-%05d.jpg")], cancelled)
        frames = []
        for n, (index, request) in enumerate(zip(indexes, requests), 1):
            rel = Path("samples") / f"frame-{n:05d}.jpg"
            if not (job_dir / rel).is_file():
                raise RuntimeError("采样帧提取不完整，已停止以避免错误的ID映射")
            frames.append({"id": f"F{n:04d}", "time": round(source_times[index], 6), "requested_time": request,
                           "source_frame_index": index, "source_pts": info["pts"][index],
                           "path": rel.as_posix(), "url": artifact_url(job_dir, rel)})
    with phase("build_sheets"):
        sheets = create_sheets(job_dir, frames, portrait=info["height"] >= info["width"])
    return {"interval": interval, "frames_per_sheet": 60, "frame_count": len(frames),
            "sheet_count": len(sheets), "sheets": sheets, "frames": frames,
            "sampling_notice": "每格是一张抽样帧，不是源视频所有帧；短于采样间隔的动作可能漏检"}


def create_sheets(job_dir: Path, frames: list[dict], *, portrait=True) -> list[dict]:
    folder = job_dir / "sheets"
    folder.mkdir(exist_ok=True)
    columns, image_width = (10, 216) if portrait else (6, 320)
    with Image.open(job_dir / frames[0]["path"]) as first:
        image_height = round(image_width * first.height / first.width)
    gap, label, header = 10, 32, 52
    tile_w, tile_h = image_width, image_height + label
    font, heading = _font(18), _font(23)
    result = []
    for offset in range(0, len(frames), 60):
        check_cancelled(None)
        group = frames[offset:offset + 60]
        sheet_id = f"S{offset // 60 + 1:02d}"
        rows = math.ceil(len(group) / columns)
        width = columns * (tile_w + gap) + gap
        height = header + rows * (tile_h + gap) + gap
        board = Image.new("RGB", (width, height), "#eeece5")
        draw = ImageDraw.Draw(board)
        draw.text((gap, 12), f"{sheet_id}  |  {group[0]['id']} - {group[-1]['id']}  |  {len(group)} sampled frames", fill="#202520", font=heading)
        for j, frame in enumerate(group):
            row, col = divmod(j, columns)
            x, y = gap + col * (tile_w + gap), header + gap + row * (tile_h + gap)
            with Image.open(job_dir / frame["path"]) as image:
                image = image.convert("RGB").resize((image_width, image_height), Image.Resampling.LANCZOS)
                board.paste(image, (x, y + label))
            draw.rectangle((x, y, x + tile_w, y + label), fill="#1f2521")
            draw.text((x + 5, y + 5), f"{frame['id']} {timestamp(frame['time'])}", fill="white", font=font)
            frame.update(sheet_id=sheet_id, row=row + 1, col=col + 1, box=[x, y, tile_w, tile_h])
        rel = Path("sheets") / f"{sheet_id}-input.jpg"
        board.save(job_dir / rel, quality=94, subsampling=0)
        result.append({"id": sheet_id, "index": offset // 60 + 1, "path": rel.as_posix(),
                       "url": artifact_url(job_dir, rel), "count": len(group), "width": width, "height": height,
                       "sha256": sha256(job_dir / rel), "frames": group})
    return result


def annotate_sheets(job_dir: Path, sampling: dict, selected: list[dict], memes: list[dict]) -> None:
    chosen = {s["frame_id"]: s for s in selected}
    meme_ids = {f for m in memes for f in m["frame_ids"]}
    for frame in sampling["frames"]:
        choice = chosen.get(frame["id"])
        frame.update(selected=bool(choice), meme_selected=frame["id"] in meme_ids)
        if choice:
            frame.update(score=choice["score"], reason=choice["reason"], labels=choice["labels"])
    for sheet in sampling["sheets"]:
        with Image.open(job_dir / sheet["path"]) as original:
            board = original.convert("RGB")
        draw = ImageDraw.Draw(board)
        count = 0
        for frame in sheet["frames"]:
            if frame["id"] not in chosen:
                continue
            count += 1
            x, y, w, h = frame["box"]
            draw.ellipse((x - 3, y + 20, x + w + 3, y + h + 3), outline="#f3422f", width=7)
            if frame["id"] in meme_ids:
                draw.rounded_rectangle((x + w - 59, y + 37, x + w - 5, y + 65), radius=5, fill="#ffc647")
                draw.text((x + w - 54, y + 41), "MEME", font=_font(17), fill="#241e0e")
        rel = Path("sheets") / f"{sheet['id']}-selected.jpg"
        board.save(job_dir / rel, quality=94, subsampling=0)
        sheet.update(annotated_url=artifact_url(job_dir, rel), annotated_path=rel.as_posix(), selected_count=count)


def quantize_clips(clips: list[dict], info: dict) -> list[dict]:
    tb = Fraction(info["time_base"])
    points = info["pts"] + [info["end_pts"]]
    relative = [(p - info["origin_pts"]) * float(tb) for p in points]
    result, offset_pts = [], 0
    for clip in clips:
        left = bisect_left(relative, clip["start"] - 1e-8)
        right = bisect_left(relative, clip["end"] - 1e-8)
        right = min(right, len(points) - 1)
        if "context_end" in clip and relative[right] > clip["context_end"] + 1e-7:
            right -= 1
        if left >= right:
            raise ValueError(f"片段{clip['id']}没有完整视频帧")
        start_pts, end_pts = points[left], points[right]
        delta = end_pts - start_pts
        result.append({**clip, "requested_start": clip["start"], "requested_end": clip["end"],
                       "start": relative[left], "end": relative[right], "duration": float(delta * tb),
                       "source_start_pts": start_pts, "source_end_pts": end_pts,
                       "source_first_frame_index": left, "source_end_frame_index_exclusive": right,
                       "frame_count": right - left, "output_start_pts": offset_pts,
                       "output_start": float(offset_pts * tb), "output_end": float((offset_pts + delta) * tb)})
        offset_pts += delta
    chronological = sorted(result, key=lambda c: c["start"])
    if any(a["end"] > b["start"] + 1e-7 for a, b in zip(chronological, chronological[1:])):
        raise ValueError("量化剪点后发现同源重叠画面，已停止而不是重播")
    return result


def filter_graph(clips: list[dict], info: dict) -> str:
    rows = []
    audio = info["audio_stream"]
    tb = Fraction(info["time_base"])
    sample_rate = int(audio["sample_rate"]) if audio else None
    for index, clip in enumerate(clips):
        rows.append(f"[0:v:0]trim=start_pts={clip['source_start_pts']}:end_pts={clip['source_end_pts']},setpts=PTS-STARTPTS[v{index}]")
        if audio:
            samples = round(clip["duration"] * sample_rate)
            absolute_start = float(clip["source_start_pts"] * tb)
            absolute_end = float(clip["source_end_pts"] * tb)
            first_audio_pts = round(float(info["origin_pts"] * tb) * sample_rate)
            rows.append(f"[0:a:0]aresample={sample_rate}:async=1:first_pts={first_audio_pts}:min_comp=0:"
                        f"min_hard_comp={1 / sample_rate:.9f}:max_soft_comp=0,"
                        f"atrim=start={absolute_start:.9f}:end={absolute_end:.9f},asetpts=PTS-STARTPTS,"
                        f"apad=whole_len={samples},atrim=end_sample={samples}[a{index}]")
    expression, frame_offset = "PREV_OUTPTS+PTS-PREV_INPTS", 0
    anchors = []
    for clip in clips:
        anchors.append((frame_offset, clip["output_start_pts"]))
        frame_offset += clip["frame_count"]
    for count, pts in reversed(anchors):
        expression = f"if(eq(N\\,{count})\\,{pts}\\,{expression})"
    rows.append("".join(f"[v{i}]" for i in range(len(clips))) +
                f"concat=n={len(clips)}:v=1:a=0,settb=expr={info['time_base']},setpts={expression}[vout]")
    if audio:
        rows.append("".join(f"[a{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=0:a=1[aout]")
    return ";".join(rows)


@contextmanager
def _media_step(on_step, ident: str, label: str):
    """Report one actual, non-overlapping operation; observers may fail loudly."""
    if on_step is None:
        yield
        return
    started, status = time.monotonic(), "completed"
    try:
        yield
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, (Cancelled, KeyboardInterrupt)) else "failed"
        raise
    finally:
        on_step(ident, label, max(0.0, time.monotonic() - started), status)


def _render_command(source: Path, destination: Path, clips: list[dict], info: dict,
                    *, gif_destination: Path | None = None) -> list[str]:
    """Build one source decode, optionally sharing native pixels with a GIF."""
    destination.parent.mkdir(exist_ok=True)
    graph_path = destination.with_suffix(".filters.txt")
    graph = filter_graph(clips, info)
    video_output = "[vout]"
    if gif_destination is not None:
        # Branch before either output's encoder/format conversion.  In
        # particular, the GIF never decodes the already-lossy MP4 output.
        graph += (";[vout]split=2[vmp4][vgif];[vgif]fps=10,scale=320:-2:flags=lanczos,"
                  "split[gif_a][gif_b];[gif_a]palettegen=stats_mode=diff[gif_palette];"
                  "[gif_b][gif_palette]paletteuse=dither=sierra2_4a[gifout]")
        video_output = "[vmp4]"
    graph_path.write_text(graph, encoding="utf-8")
    tb = Fraction(info["time_base"])
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"] + SAFE_INPUT_OPTIONS + [
            "-i", str(source), "-filter_complex_script", str(graph_path), "-map", video_output]
    audio = info["audio_stream"]
    if audio:
        sr, channels = int(audio["sample_rate"]), int(audio["channels"])
        args += ["-map", "[aout]", "-c:a", "aac", "-profile:a", "aac_low", "-ar", str(sr),
                 "-ac", str(channels), "-b:a", str(min(192000, max(16000, sr * channels * 3)))]
    else:
        args += ["-an"]
    # No B-frame reordering means encoded packet N maps to presentation frame
    # N. Explicitly preserve the final source frame's hold duration: otherwise
    # a VFR cut ending after a long held frame is silently shortened by x264.
    last = clips[-1]
    last_frame_duration = last["source_end_pts"] - info["pts"][last["source_end_frame_index_exclusive"] - 1]
    frame_count = sum(c["frame_count"] for c in clips)
    duration_bsf = f"setts=duration=if(eq(N\\,{frame_count - 1})\\,{last_frame_duration}\\,DURATION):time_base={info['time_base']}"
    args += ["-map_metadata", "-1", "-sn", "-dn", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-bf", "0",
             "-pix_fmt", "yuv420p", "-fps_mode:v", "vfr", "-enc_time_base:v", info["time_base"],
             "-video_track_timescale", str(tb.denominator), "-bsf:v", duration_bsf,
             "-movflags", "+faststart", str(destination)]
    if gif_destination is not None:
        args += ["-map", "[gifout]", "-an", "-sn", "-dn", "-map_metadata", "-1", "-loop", "0", str(gif_destination)]
    return args


def render_video(source: Path, destination: Path, clips: list[dict], info: dict, cancelled=None,
                 *, on_step=None) -> dict:
    """Render with optional on_step(id, label, seconds, status) observations."""
    with _media_step(on_step, "encode_video", "源视频解码与MP4编码"):
        run(_render_command(source, destination, clips, info), cancelled)
    return verify_video(destination, clips, info, cancelled, on_step=on_step)


def _effective_color_range(stream: dict) -> str:
    declared = stream.get("color_range")
    if declared in ("pc", "full", "jpeg"):
        effective = "full"
    elif declared in ("tv", "limited", "mpeg"):
        effective = "limited"
    elif declared in (None, "", "unknown", "unspecified"):
        effective = "unknown"
    else:
        raise RuntimeError("视频色阶范围声明不支持")
    # FFprobe's legacy yuvj aliases describe full-range samples, not a
    # different bit depth or chroma layout. Require matching explicit range
    # evidence instead of accepting the alias despite contradictory tags.
    if stream.get("pix_fmt", "").startswith("yuvj") and effective != "full":
        raise RuntimeError("视频像素格式与色阶范围声明不一致")
    return effective


def verify_video(path: Path, clips: list[dict], info: dict, cancelled=None, *, on_step=None) -> dict:
    expected_count = sum(c["frame_count"] for c in clips)
    expected_duration = sum(c["duration"] for c in clips)
    source_video = info.get("video_stream", {})
    tb = float(Fraction(info["time_base"]))
    with _media_step(on_step, "probe_output", "读取输出元信息并校验画幅、色阶与音轨"):
        # Counting here would decode the video once more.  The mandatory PTS
        # scan below supplies the real decoded frame count as well as timing.
        metadata = probe(path, cancelled)
        video = next(s for s in metadata["streams"] if s["codec_type"] == "video")
        audio = next((s for s in metadata["streams"] if s["codec_type"] == "audio"), None)
        if video.get("codec_name") != "h264" or video.get("pix_fmt") not in ("yuv420p", "yuvj420p"):
            raise RuntimeError("输出视频编码或像素格式不符")
        source_range, output_range = _effective_color_range(source_video), _effective_color_range(video)
        if source_range != "unknown" and output_range != source_range:
            raise RuntimeError("输出未保留原始视频色阶范围")
        if source_range == "unknown" and output_range == "full":
            raise RuntimeError("源视频未声明色阶范围，不能验证全范围输出")
        if (video["width"], video["height"]) != (info["width"], info["height"]):
            raise RuntimeError("输出画面尺寸发生变化")
        if bool(audio) != bool(info["audio_stream"]):
            raise RuntimeError("输出音轨数量与输入不符")
        if audio and (int(audio["sample_rate"]), int(audio["channels"])) != (info["audio_sample_rate"], info["audio_channels"]):
            raise RuntimeError("输出未保留原始采样率或声道")
        if audio:
            expected_samples = sum(round(c["duration"] * info["audio_sample_rate"]) for c in clips)
            audio_duration = float(audio.get("duration", 0))
            if abs(audio_duration - expected_samples / info["audio_sample_rate"]) > max(0.002, 2 / info["audio_sample_rate"]):
                raise RuntimeError("输出音轨未保持剪辑时长，可能发生截断或时轴偏移")
        actual_duration = float(metadata["format"]["duration"])
        tolerance = max(0.1, 1024 / info["audio_sample_rate"] + 0.002) if audio else max(0.1, tb * 2)
        if abs(actual_duration - expected_duration) > tolerance:
            raise RuntimeError("输出时长与原速剪辑时间轴不符")
    with _media_step(on_step, "scan_frames", "单次逐帧扫描，核对帧数及原速时间轴"):
        expected_times, offset = [], 0.0
        for clip in clips:
            expected_times += [offset + (pts - clip["source_start_pts"]) * tb
                               for pts in info["pts"][clip["source_first_frame_index"]:clip["source_end_frame_index_exclusive"]]]
            offset += clip["duration"]
        actual_times = [float(row["best_effort_timestamp_time"]) for row in frame_times(path, cancelled)]
        if len(actual_times) != expected_count or len(actual_times) != len(expected_times):
            raise RuntimeError("输出帧数不符，存在丢帧或重复帧")
        error = max(abs(a - b) for a, b in zip(actual_times, expected_times))
        if error > max(0.004, tb * 2):
            raise RuntimeError("输出发生非预期变速或拼接时轴偏移")
    with _media_step(on_step, "strict_decode", "严格完整解码输出音视频"):
        run(["ffmpeg", "-v", "error", "-xerror", "-nostdin"] + SAFE_INPUT_OPTIONS + ["-i", str(path), "-map", "0:v:0",
             "-map", "0:a:0?", "-f", "null", "-"], cancelled)
    return {"full_decode_pass": True, "frame_count_match": True, "expected_frames": expected_count,
            "decoded_frames": len(actual_times), "source_speed_preserved": True,
            "max_frame_timestamp_error_seconds": error, "native_dimensions_preserved": True,
            "native_audio_sample_rate_preserved": bool(audio), "native_audio_channels_preserved": bool(audio),
            "audio_sample_rate": int(audio["sample_rate"]) if audio else None,
            "audio_channels": int(audio["channels"]) if audio else None,
            "audio_duration_seconds": float(audio.get("duration", 0)) if audio else None,
            "audio_policy": "source audio only; hard timestamp-gap compensation, no time-stretch; missing source samples are silence",
            "source_pix_fmt": source_video.get("pix_fmt"), "output_pix_fmt": video["pix_fmt"],
            "source_color_range": source_video.get("color_range"), "output_color_range": video.get("color_range"),
            "source_effective_color_range": source_range, "output_effective_color_range": output_range,
            "native_color_range_preserved": True if source_range != "unknown" else None,
            "expected_duration_seconds": expected_duration, "actual_container_duration_seconds": actual_duration,
            "actual_video_duration_seconds": float(video.get("duration", actual_duration)),
            "bytes": path.stat().st_size, "sha256": sha256(path), "manual_visual_review_count": 0}


def render_meme(source: Path, job_dir: Path, meme: dict, info: dict, cancelled=None, *, on_step=None) -> dict:
    folder = job_dir / "memes"
    folder.mkdir(exist_ok=True)
    quantized = quantize_clips([meme], info)
    clip = quantized[0]
    video_rel = Path("memes") / f"{meme['id']}.mp4"
    gif_rel = Path("memes") / f"{meme['id']}.gif"
    with _media_step(on_step, "encode_av_gif", "同一次源解码，分别编码MP4与原始画面GIF"):
        args = _render_command(source, job_dir / video_rel, quantized, info, gif_destination=job_dir / gif_rel)
        run(args, cancelled)
    validation = verify_video(job_dir / video_rel, quantized, info, cancelled, on_step=on_step)
    # Decoder/metadata checks are technical, not an additional image review.
    with _media_step(on_step, "verify_gif", "完整读取并检查独立GIF"):
        gif_metadata = probe(job_dir / gif_rel, cancelled, count=True)
        if gif_metadata["streams"][0]["codec_name"] != "gif":
            raise RuntimeError("表情包GIF验证失败")
    return {**clip, "gif_url": artifact_url(job_dir, gif_rel), "video_url": artifact_url(job_dir, video_rel),
            "gif_path": gif_rel.as_posix(), "video_path": video_rel.as_posix(), "validation": validation,
            "gif_fps": 10, "speed": 1, "repeated_in_main_video": False}
