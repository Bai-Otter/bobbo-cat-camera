"""Fail-closed offline export recovery from genuine, saved AI evidence.

This module never loads provider settings or credentials, and never calls AI.
Run only with the local service stopped; all original task files stay untouched.
"""
from __future__ import annotations

from copy import deepcopy
import json
import math
from pathlib import Path
import re
import shutil
import socket
import time
import uuid

from . import media, pipeline, selection, vision
from .timing import JobTimings, wall_now


_JOB_ID = re.compile(r"[0-9a-f]{12}")
_JOB_TERMINAL = {"completed", "failed", "cancelled"}
_PROPOSAL_TERMINAL = {"completed", "failed", "interrupted"}
_RECOVERABLE_FAILURES = {"selection", "render_highlight", "export_memes", "final_validation"}
_EVIDENCE = ("prompt.json", "request-manifest.json", "ai-raw-response.txt",
             "ai-selection-original.json", "ai-response-envelope.json")


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"),
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (OSError, ValueError):
        raise ValueError(f"保存的{path.name}缺失或不可读取；不会重新抽帧或调用AI") from None
    if not isinstance(value, dict):
        raise ValueError(f"保存的{path.name}必须为JSON对象")
    return value


def _atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def _service_running(port: int) -> bool:
    try:
        # Windows loopback refusal can arrive after about two seconds. Keep
        # uncertainty fail-closed, but allow the OS to return a real refusal.
        with socket.create_connection(("127.0.0.1", port), timeout=3):
            return True
    except ConnectionRefusedError:
        return False
    except OSError as exc:
        # A timeout or unexpected socket problem is not evidence of shutdown.
        raise ValueError("无法确认本地服务已停止，请检查后再恢复") from exc


def _assert_idle(data_dir: Path, port: int) -> Path:
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("本地服务端口无效")
    if _service_running(port):
        raise ValueError("本地服务仍在运行，请安全停止服务后再执行离线恢复")
    jobs = data_dir / "jobs"
    if not jobs.is_dir() or jobs.is_symlink():
        raise ValueError("任务数据目录不存在或为重定向路径")
    for directory in jobs.iterdir():
        if not directory.is_dir() or not _JOB_ID.fullmatch(directory.name):
            continue
        if directory.is_symlink():
            raise ValueError("任务路径不能为重定向目录")
        record = _read_json(directory / "job.json")
        if record.get("id") != directory.name or record.get("status") not in _JOB_TERMINAL:
            raise ValueError("有未结束或不可确认状态的任务，已停止离线恢复")
    proposals = data_dir / "prompt-proposals"
    if proposals.is_symlink():
        raise ValueError("Prompt建议目录不能为重定向路径")
    if proposals.exists():
        for path in proposals.glob("*.json"):
            record = _read_json(path)
            if record.get("status") not in _PROPOSAL_TERMINAL:
                raise ValueError("有未结束的Prompt建议，已停止离线恢复")
    return jobs


def _file(root: Path, name: str) -> Path:
    candidate = root / name
    if not candidate.resolve().is_relative_to(root) or not candidate.is_file():
        raise ValueError(f"保存的{name}缺失或路径越界；不会请求AI补全")
    return candidate


def _hashes(directory: Path) -> dict[str, str]:
    values = {}
    for path in sorted(directory.rglob("*")):
        if not path.resolve().is_relative_to(directory):
            raise ValueError("原任务包含越界路径，已停止恢复")
        if path.is_file():
            values[path.relative_to(directory).as_posix()] = media.sha256(path)
    return values


def _options(value) -> dict:
    if not isinstance(value, dict):
        raise ValueError("原任务生成参数无效")
    options = deepcopy(value)
    for name, low, high in (("target_duration", 1, 120), ("min_duration", 1, 120),
                            ("max_duration", 1, 120), ("sample_interval", .25, 3)):
        number = options.get(name)
        if (isinstance(number, bool) or not isinstance(number, (int, float)) or
                not math.isfinite(number) or not low <= number <= high):
            raise ValueError(f"原任务{name}参数无效")
    if not options["min_duration"] <= options["target_duration"] <= options["max_duration"]:
        raise ValueError("原任务时长参数顺序无效")
    if not isinstance(options.get("prompt"), str) or len(options["prompt"]) > 40000:
        raise ValueError("原任务Prompt参数无效")
    return options


def _evidence(directory: Path, ident: str) -> dict:
    record = _read_json(_file(directory, "job.json"))
    if record.get("id") != ident or record.get("status") != "failed":
        raise ValueError("只允许恢复原始失败任务，不覆盖成功任务")
    timings = record.get("timings")
    stage = timings.get("failed_stage") if isinstance(timings, dict) else None
    if stage not in _RECOVERABLE_FAILURES:
        raise ValueError("原任务不是已有完整AI结果的选片或导出失败，不能使用离线恢复")
    if record.get("iteration") or record.get("feedback") or record.get("comparison"):
        raise ValueError("离线恢复暂不支持带人工反馈的迭代任务，避免绕开反馈约束")
    options = _options(record.get("options"))
    ai = record.get("ai")
    if not isinstance(ai, dict) or type(ai.get("call_count")) is not int or ai["call_count"] != 1:
        raise ValueError("原任务必须有且只有一次已保存的真实AI调用")
    prompts = _read_json(_file(directory, "prompt.json"))
    if (set(prompts) != {"system", "user"} or
            any(not isinstance(text, str) or not text.strip() for text in prompts.values()) or
            record.get("prompt") != prompts):
        raise ValueError("原任务Prompt记录不一致")
    manifest = _read_json(_file(directory, "request-manifest.json"))
    if (ai.get("request_manifest") != manifest or
            any(manifest.get(key) != prompts[key] for key in ("system", "user")) or
            manifest.get("model") != ai.get("model") or not isinstance(ai.get("model"), str) or
            manifest.get("api_style") != ai.get("api_style")):
        raise ValueError("原任务请求清单与Prompt或模型记录不一致")
    sampling = _read_json(_file(directory, "sampling.json"))
    sheets = sampling.get("sheets")
    try:
        images = [{key: sheet[key] for key in ("id", "path", "width", "height", "sha256")} | {"detail": "high"}
                  for sheet in sheets]
    except (TypeError, KeyError):
        raise ValueError("原任务采样拼图清单无效") from None
    if (not images or type(manifest.get("image_count")) is not int or
            manifest["image_count"] != len(images) or manifest.get("images") != images or
            manifest.get("automatic_retries") != 0):
        raise ValueError("原任务发送图片清单与实际采样不一致")
    raw_path = _file(directory, "ai-raw-response.txt")
    try:
        raw = raw_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise ValueError("原任务AI原始返回无法读取") from None
    try:
        parsed = vision.parse_model_json(raw)
    except vision.VisionError as exc:
        raise ValueError("原任务AI原始返回不是有效的保存决定；不会调用AI补全") from exc
    saved = _read_json(_file(directory, "ai-selection-original.json"))
    if parsed != saved or parsed != ai.get("parsed") or raw != ai.get("raw_response"):
        raise ValueError("原任务AI原始返回与保存的选片决定不一致")
    envelope = _read_json(_file(directory, "ai-response-envelope.json"))
    style = manifest["api_style"]
    if style == "responses":
        complete = (envelope.get("status") == "completed" and not envelope.get("error") and
                    not envelope.get("incomplete_details"))
        if "instructions" in envelope and envelope["instructions"] != prompts["system"]:
            raise ValueError("原任务返回中的系统Prompt不一致")
    elif style == "chat_completions":
        choices = envelope.get("choices", [])
        complete = bool(choices and isinstance(choices[0], dict) and choices[0].get("finish_reason") == "stop")
    else:
        raise ValueError("原任务API格式不受支持")
    try:
        response_text = vision.extract_text(envelope, style)
    except vision.VisionError as exc:
        raise ValueError("原任务AI响应缺少可读取的返回文本") from exc
    if (not complete or envelope.get("model") != ai["model"] or
            response_text != raw or envelope.get("usage", {}) != ai.get("usage", {})):
        raise ValueError("原任务没有相互吻合的已完成AI响应证据")
    filename = record.get("filename")
    suffix = Path(filename).suffix.lower() if isinstance(filename, str) else ""
    if suffix not in {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}:
        raise ValueError("原任务视频文件名或容器格式无效")
    return {"record": record, "options": options, "ai": ai, "prompts": prompts, "manifest": manifest,
            "sampling": sampling,
            "parsed": parsed, "raw": raw, "source_name": "source" + suffix, "stage": stage}


def _preflight_selection(directory: Path, evidence: dict) -> None:
    """Reject unusable saved decisions without creating a destination.

    Rebuild timing from cached native PTS, never rounded sampling targets. Full
    input hashing/mapping verification still happens in reuse_inputs, followed
    by another validation against those verified inputs before any rendering.
    """
    metadata = _read_json(_file(directory, "source-metadata.json"))
    pts_record = _read_json(_file(directory, "source-pts.json"))
    integrity_path = directory / "input-cache-integrity.json"
    if integrity_path.exists():
        integrity = _read_json(_file(directory, "input-cache-integrity.json"))
        if (integrity.get("metadata_sha256") != media.sha256(directory / "source-metadata.json") or
                integrity.get("pts_sha256") != media.sha256(directory / "source-pts.json")):
            raise ValueError("原任务元数据或PTS摘要不一致；不会创建恢复任务")
    try:
        points, end_pts = pts_record["pts"], pts_record["end_pts"]
        if (not isinstance(points, list) or not points or
                any(type(point) is not int for point in points) or type(end_pts) is not int or
                end_pts <= points[-1] or any(left >= right for left, right in zip(points, points[1:]))):
            raise ValueError("原任务源PTS缓存无效")
        restored = [{"best_effort_timestamp": point,
                     "duration": (points[index + 1] if index + 1 < len(points) else end_pts) - point}
                    for index, point in enumerate(points)]
        info = media.video_info(metadata, restored)
        if (any(info[name] != pts_record[name] for name in ("time_base", "origin_pts", "end_pts", "pts")) or
                not 0 < info["duration"] <= 600.001):
            raise ValueError("原任务元数据与源PTS不一致")
        frames = evidence["sampling"]["frames"]
        if (not isinstance(frames, list) or not frames or
                any(not isinstance(frame, dict) or not isinstance(frame.get("id"), str) or
                    isinstance(frame.get("time"), bool) or not isinstance(frame.get("time"), (int, float)) or
                    not math.isfinite(frame["time"]) for frame in frames)):
            raise ValueError("原任务采样帧时间清单无效")
    except (KeyError, TypeError, IndexError, ZeroDivisionError, OverflowError):
        raise ValueError("原任务采样或时间戳缓存无效；不会创建恢复任务") from None
    choices = selection.validate_and_adjust(deepcopy(evidence["parsed"]), frames, info["duration"], evidence["options"])
    if not choices["clips"]:
        raise selection.SelectionError("保存的AI结果没有可用于精选的片段；不会创建恢复任务")


def recover_render(data_dir: Path, source_job_id: str, *, job_id: str | None = None,
                   port: int = 8876, emit=None) -> dict:
    """Create a new terminal task using saved decisions, without an AI fallback.

    The returned record is also atomically persisted for normal job history.
    Failures after destination creation remain inspectable and are re-raised.
    """
    if not isinstance(source_job_id, str) or not _JOB_ID.fullmatch(source_job_id):
        raise ValueError("原任务ID无效")
    ident = uuid.uuid4().hex[:12] if job_id is None else job_id
    if not isinstance(ident, str) or not _JOB_ID.fullmatch(ident) or ident == source_job_id:
        raise ValueError("恢复任务ID无效或与原任务相同")
    started_monotonic, started_at = time.monotonic(), wall_now()
    data_dir = Path(data_dir).resolve()
    jobs = _assert_idle(data_dir, port)
    original = (jobs / source_job_id).resolve()
    if original.parent != jobs or not original.is_dir():
        raise ValueError("原任务不存在或路径越界")
    target = jobs / ident
    if target.exists():
        raise ValueError("恢复任务目录已存在，拒绝覆盖")
    before = _hashes(original)
    evidence = _evidence(original, source_job_id)
    if evidence["stage"] == "selection":
        _preflight_selection(original, evidence)
    if _hashes(original) != before:
        raise ValueError("读取或预检期间原任务文件发生变化；不会创建恢复任务")
    inherited = evidence["record"]
    provenance = {"source_job_id": source_job_id, "source_failed_stage": evidence["stage"],
                  "source_ai_call_count": 1, "source_response_sha256": before["ai-raw-response.txt"],
                  "source_ai_usage": deepcopy(evidence["ai"].get("usage", {})), "no_ai_calls": True,
                  "source_prompt_is_historical": True, "original_artifact_hashes": before}
    ai = {key: deepcopy(evidence["ai"][key]) for key in ("model", "provider", "api_style")
          if key in evidence["ai"]}
    ai.update(call_count=0, reused_response_from_job=source_job_id, raw_response=evidence["raw"],
              parsed=evidence["parsed"], request_manifest=evidence["manifest"])
    target.mkdir()
    record = {"id": ident, "filename": inherited["filename"], "status": "preparing", "stage": "离线恢复导出",
              "progress": 0, "message": "复用已有 AI 结果，本次未调用 AI；原失败任务保持不变",
              "created_at": started_at, "updated_at": wall_now(), "options": evidence["options"],
              "ai": ai, "recovery": provenance, "prompt": evidence["prompts"]}
    if "prompt_standard" in inherited:
        record["prompt_standard"] = deepcopy(inherited["prompt_standard"])

    def persist(update):
        record.update(deepcopy(update))
        record["updated_at"] = wall_now()
        if "timings" in record:
            _atomic_json(target / "timings.json", record["timings"])
        _atomic_json(target / "job.json", record)
        if emit is not None:
            emit(deepcopy(record))

    timer = JobTimings(on_update=lambda snapshot: persist({"timings": snapshot}), scope="render_recovery",
                       started_monotonic=started_monotonic, started_at=started_at,
                       note="本次仅计离线校验、缓存复用及重新导出；AI调用和抽帧均跳过，不计入原任务耗时或用量。")
    try:
        persist({"timings": timer.snapshot()})
        with timer.measure("reuse_inputs"):
            revision = {"reuse_from": original, "parent_job_id": source_job_id,
                        "root_job_id": source_job_id, "round": 1}
            source = target / evidence["source_name"]
            info, sampling, digest = media.reuse_inputs(target, source, revision,
                                                       float(evidence["options"]["sample_interval"]))
            for name in _EVIDENCE:
                shutil.copy2(_file(original, name), target / name)
                if media.sha256(target / name) != before[name]:
                    raise ValueError("复制期间原任务AI证据发生变化，已停止恢复")
            media.write_json(target / "recovery-provenance.json", provenance)
            media.write_json(target / "sampling.json", sampling)
        public_source = pipeline._public_source(info, target, source)
        persist({"source": public_source, "sampling": sampling, "progress": 25,
                 "message": "已核验并复用源片、原始拼图及真实AI返回；不发送任何新请求"})
        with timer.measure("selection"):
            choices = selection.validate_and_adjust(deepcopy(evidence["parsed"]), sampling["frames"], info["duration"], evidence["options"])
        fields = pipeline.render_choices(target, source, evidence["options"], info, sampling, digest, choices,
                                         public_source, evidence["prompts"], ai, persist, lambda: False, timer,
                                         recovery=provenance)
        if _hashes(original) != before:
            raise RuntimeError("恢复期间原任务文件发生变化；恢复结果未标为成功")
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, (media.Cancelled, KeyboardInterrupt)) else "failed"
        snapshot = timer.finish(status)
        persist({"status": status, "stage": "离线恢复未完成", "error": str(exc)[:6000] or type(exc).__name__,
                 "message": "离线恢复失败；未调用AI，原任务与本次调试记录均保留", "timings": snapshot})
        raise
    snapshot = timer.finish("completed")
    persist({**fields, "status": "completed", "stage": "生成完成", "timings": snapshot})
    return deepcopy(record)
