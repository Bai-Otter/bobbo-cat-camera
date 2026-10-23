"""Explicitly published, immutable reusable prompts and auditable proposals.

The caller supplies the existing job executor.  A proposal is an auditable
draft, never an automatic publication.  Legacy proposals are text-only;
satisfied-round proposals explicitly reuse the round's original input sheets.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import difflib
import hashlib
import json
import math
from pathlib import Path
import re
from threading import RLock
from typing import Any
import uuid

from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError, model_validator

from .timing import JobTimings, interrupted_snapshot
from .vision import redact


REQUEST_PATTERN = r"^[A-Za-z0-9_-]{16,64}$"
ID_PATTERN = r"^[0-9a-f]{12}$"
VERSION_PATTERN = r"^P[0-9]{4,}$"
TERMINAL = {"completed", "failed", "interrupted"}
TUNING_NOTE = "用户明确提交后的一次纯文字建议任务，0张图片；包含排队、请求和记录时间，不会自动发布。"


class PromptVersionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: StrictInt = Field(ge=0)
    request_id: str = Field(pattern=REQUEST_PATTERN)
    text: str = Field(min_length=1, max_length=40000)
    name: str = Field(default="", max_length=100)
    proposal_id: str | None = Field(default=None, pattern=ID_PATTERN)


class PromptActivation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: StrictInt = Field(ge=0)
    request_id: str = Field(pattern=REQUEST_PATTERN)
    version_id: str = Field(pattern=VERSION_PATTERN)


class ProposalSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str = Field(pattern=ID_PATTERN)
    feedback_version: StrictInt = Field(ge=0)


class ProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: StrictInt = Field(ge=0)
    request_id: str = Field(pattern=REQUEST_PATTERN)
    sources: list[ProposalSource] = Field(min_length=1, max_length=12)
    note: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def distinct_jobs(self):
        if len({source.job_id for source in self.sources}) != len(self.sources):
            raise ValueError("同一源任务不能重复提交")
        return self


class SatisfiedRoundRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: StrictInt = Field(ge=0)
    request_id: str = Field(pattern=REQUEST_PATTERN)
    job_id: str = Field(pattern=ID_PATTERN)


class LibraryError(ValueError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _clean(value: Any, secret: str = "") -> Any:
    """Redact values and keys before persistence; never retain private config."""
    if isinstance(value, dict):
        return {redact(str(k), secret): _clean(v, secret) for k, v in value.items()
                if str(k).lower() not in {"api_key", "authorization", "secret", "password"}}
    if isinstance(value, (tuple, list)):
        return [_clean(v, secret) for v in value]
    if isinstance(value, str):
        return redact(value, secret)
    if isinstance(value, float) and not math.isfinite(value):
        raise LibraryError(422, "建议资料含无效数字，未保存或发布")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise LibraryError(422, "建议资料格式不正确，请重新选择已保存的反馈")


def _validated(model, values: dict) -> dict:
    try:
        return model.model_validate(values).model_dump()
    except (ValidationError, ValueError, TypeError):
        raise LibraryError(422, "请求格式不正确，请刷新后重试") from None


def _fingerprint(kind: str, values: dict) -> str:
    payload = json.dumps({"kind": kind, "values": values}, sort_keys=True,
                         ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _request_key(ident: str) -> str:
    # A mistakenly pasted credential may also be a syntactically valid UUID.
    # Persist only its digest so idempotency never needs the plaintext token.
    return hashlib.sha256(ident.encode("utf-8")).hexdigest()


def _diff(before: str, after: str) -> str:
    # keepends preserves otherwise invisible newline-only edits. The explicit
    # marker is the usual unified-diff representation of an unterminated line.
    lines = difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                fromfile="生效基线", tofile="待发布全文")
    return "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n"
                   for line in lines)


def _generic_text(text: str) -> None:
    if not text.strip():
        raise LibraryError(422, "通用标准不能为空")
    if (re.search(r"(?<![A-Za-z0-9_])F[0-9]{4,}(?![A-Za-z0-9_])", text, re.I)
            or re.search(r"(?<![A-Za-z0-9_])[0-9a-f]{12}(?![A-Za-z0-9_])", text, re.I)
            or re.search(r"(?i)(?:[A-Z]:[/\\]|file://|\\\\[^\s\\]+\\|/(?:Users|home|tmp|mnt)/|/api/jobs/)", text)
            or re.search(r"[^\s/\\:<>\"']+\.(?:mp4|mov|mkv|avi|webm|m4v|jpg|jpeg|png|webp|gif)(?![A-Za-z])", text, re.I)
            or re.search(r"(?<![0-9])(?:[0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}(?:\.[0-9]+)?(?![0-9])", text)):
        raise LibraryError(400, "通用标准不能包含某个视频的局部帧ID、任务ID、文件或源时间轴")


class PromptLibrary:
    def __init__(self, data_dir: Path, initial_text: str, executor, caller=None):
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "prompt-library.json"
        self.proposals_dir = self.data_dir / "prompt-proposals"
        self.proposals_dir.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.executor = executor
        if caller is None:
            from .prompt_tuning import call_tuning
            caller = call_tuning
        self.caller = caller
        self.proposals: dict[str, dict] = {}
        self.timings: dict[str, JobTimings] = {}
        if self.path.exists():
            try:
                self.state = json.loads(self.path.read_text(encoding="utf-8"))
                self._validate_saved_state()
            except (OSError, ValueError, KeyError, TypeError):
                # Never erase an existing, damaged library with a fresh baseline.
                raise LibraryError(500, "通用标准库无法读取，原文件已保留，请检查本地资料") from None
        else:
            _generic_text(initial_text)
            self.state = {"schema_version": 1, "revision": 0, "active_version_id": "P0001",
                          "versions": [{"id": "P0001", "name": "初始标准", "text": initial_text,
                                        "created_at": _now(), "parent_version_id": None,
                                        "source_proposal_id": None, "summary": "应用初始通用标准", "diff": ""}],
                          "operations": {}}
            self._save_library()
        for path in self.proposals_dir.glob("*.json"):
            if not re.fullmatch(r"[0-9a-f]{12}", path.stem):
                continue
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if record["id"] != path.stem:
                    continue
                if record.get("status") not in TERMINAL:
                    record.update(status="interrupted", stage="建议已中断", progress=0,
                                  error="本地服务曾重启，建议任务未自动重新请求，请明确提交新的任务", updated_at=_now())
                    if record.get("timings", {}).get("available"):
                        record["timings"] = interrupted_snapshot(record["timings"])
                    self._save_proposal(record)
                self.proposals[record["id"]] = record
            except (ValueError, KeyError, OSError, TypeError):
                # Corrupt proposal evidence is not reconstructed or submitted.
                continue

    def _validate_saved_state(self) -> None:
        if not isinstance(self.state, dict) or type(self.state["revision"]) is not int or self.state["revision"] < 0:
            raise ValueError("invalid library")
        versions = self.state["versions"]
        if not isinstance(versions, list) or not versions:
            raise ValueError("invalid versions")
        ids = set()
        for version in versions:
            if (not isinstance(version, dict) or not re.fullmatch(VERSION_PATTERN, version["id"])
                    or version["id"] in ids or not isinstance(version["text"], str)):
                raise ValueError("invalid version")
            ids.add(version["id"])
        if self.state["active_version_id"] not in ids or not isinstance(self.state.get("operations", {}), dict):
            raise ValueError("invalid active version")
        self.state.setdefault("operations", {})

    @staticmethod
    def _atomic_json(path: Path, value: dict) -> None:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        temporary.replace(path)

    def _save_library(self) -> None:
        self._atomic_json(self.path, self.state)

    def _save_proposal(self, record: dict) -> None:
        self._atomic_json(self.proposals_dir / (record["id"] + ".json"), record)

    def public(self) -> dict:
        with self.lock:
            summaries = [{key: record.get(key) for key in (
                "id", "status", "stage", "progress", "base_revision", "base_version_id", "base_version_name",
                "summary", "created_at", "updated_at", "error")}
                for record in self.proposals.values()]
            summaries.sort(key=lambda row: row.get("created_at") or "", reverse=True)
            return deepcopy({"revision": self.state["revision"], "active_version_id": self.state["active_version_id"],
                             "versions": self.state["versions"], "proposals": summaries})

    def active(self) -> dict:
        with self.lock:
            return deepcopy(next(version for version in self.state["versions"]
                                 if version["id"] == self.state["active_version_id"]))

    def _check_revision(self, expected: int) -> None:
        if expected != self.state["revision"]:
            raise LibraryError(409, "通用标准已经改变，请刷新比较后再确认，编辑稿仍可保留")

    def _operation(self, values: dict, kind: str) -> bool:
        ident, fingerprint = _request_key(values["request_id"]), _fingerprint(kind, values)
        old = self.state["operations"].get(ident)
        if old is not None:
            if old.get("fingerprint") != fingerprint or old.get("kind") != kind:
                raise LibraryError(409, "同一请求标识不能用于不同内容，请重新明确提交")
            return True
        if any(record.get("request_key") == ident for record in self.proposals.values()):
            raise LibraryError(409, "同一请求标识不能用于不同内容，请重新明确提交")
        return False

    def _remember(self, values: dict, kind: str, version_id: str) -> None:
        self.state["operations"][_request_key(values["request_id"])] = {
            "kind": kind, "fingerprint": _fingerprint(kind, values),
            "version_id": version_id, "revision": self.state["revision"], "created_at": _now()}

    def create_version(self, values: dict, secret: str = "") -> dict:
        values = _validated(PromptVersionCreate, values)
        with self.lock:
            if self._operation(values, "publish"):
                return self.public()
            self._check_revision(values["expected_revision"])
            clean = _clean(values, secret)
            _generic_text(clean["text"])
            source = None
            if clean.get("proposal_id"):
                source = self.get_proposal(clean["proposal_id"])
                if source.get("status") != "completed" or not source.get("candidate_prompt", "").strip():
                    raise LibraryError(409, "建议尚未完成或没有可发布全文，请先查看结果")
                if source.get("base_revision") != values["expected_revision"]:
                    raise LibraryError(409, "这条建议的生效基线已经改变，请基于当前标准重新整理")
                if source.get("source_mode") == "satisfied_round":
                    from .prompt_tuning import validate_round_candidate
                    try:
                        validate_round_candidate(clean["text"], source["tuning_base_prompt"], source["base_prompt"])
                    except (ValueError, KeyError):
                        raise LibraryError(400, "满意轮次候选必须保留实际轮次和当前通用基线的技术原句，尚未发布") from None
            parent = self.active()
            number = max(int(version["id"][1:]) for version in self.state["versions"]) + 1
            version_id = f"P{number:04d}"
            version = {"id": version_id, "name": clean["name"].strip() or f"通用标准 {version_id}",
                       "text": clean["text"], "created_at": _now(), "parent_version_id": parent["id"],
                       "source_proposal_id": clean.get("proposal_id"),
                       "summary": _clean(source["summary"], secret) if source else "用户手动编辑并确认发布",
                       "diff": _clean(_diff(parent["text"], clean["text"]), secret)}
            previous = deepcopy(self.state)
            self.state["versions"].append(version)
            self.state["active_version_id"] = version_id
            self.state["revision"] += 1
            self._remember(values, "publish", version_id)
            try:
                self._save_library()
            except OSError:
                self.state = previous
                raise LibraryError(500, "保存通用标准未完成，原生效标准仍保留，请确认后重试") from None
            return self.public()

    def activate(self, values: dict, secret: str = "") -> dict:
        values = _validated(PromptActivation, values)
        with self.lock:
            if self._operation(values, "activate"):
                return self.public()
            self._check_revision(values["expected_revision"])
            if not any(version["id"] == values["version_id"] for version in self.state["versions"]):
                raise LibraryError(404, "没有找到这个通用标准版本")
            previous = deepcopy(self.state)
            self.state["active_version_id"] = values["version_id"]
            self.state["revision"] += 1
            self._remember(values, "activate", values["version_id"])
            try:
                self._save_library()
            except OSError:
                self.state = previous
                raise LibraryError(500, "切换通用标准未完成，原生效标准仍保留，请确认后重试") from None
            return self.public()

    def existing_proposal(self, values: dict) -> dict | None:
        values = _validated(ProposalRequest, values)
        return self._existing_proposal(values, "proposal")

    def existing_satisfied_round_proposal(self, values: dict) -> dict | None:
        return self._existing_proposal(_validated(SatisfiedRoundRequest, values), "satisfied_round")

    def _existing_proposal(self, values: dict, kind: str) -> dict | None:
        fingerprint = _fingerprint(kind, values)
        with self.lock:
            request_key = _request_key(values["request_id"])
            if request_key in self.state["operations"]:
                raise LibraryError(409, "同一请求标识不能用于不同内容，请重新明确提交")
            for record in self.proposals.values():
                if record.get("request_key") == request_key:
                    if record.get("request_fingerprint") != fingerprint:
                        raise LibraryError(409, "同一请求标识不能用于不同内容，请重新明确提交")
                    return self.get_proposal(record["id"])
            return None

    def create_proposal(self, values: dict, sources: list[dict], config: dict) -> dict:
        from .prompt_tuning import build_tuning_prompts
        values = _validated(ProposalRequest, values)
        with self.lock:
            previous = self.existing_proposal(values)
            if previous is not None:
                return previous
            self._check_revision(values["expected_revision"])
            secret = config.get("api_key", "")
            frozen = _clean(deepcopy(sources), secret)
            expected = [(row["job_id"], row["feedback_version"]) for row in values["sources"]]
            if (not isinstance(frozen, list) or len(frozen) != len(expected)
                    or [(row.get("job_id"), row.get("feedback_version")) for row in frozen
                        if isinstance(row, dict)] != expected):
                raise LibraryError(422, "建议来源与请求不一致，请重新选择已保存的反馈")
            base = self.active()
            note = _clean(values["note"], secret)
            try:
                prompts = _clean(build_tuning_prompts(base["text"], frozen, note), secret)
            except (ValueError, TypeError, KeyError):
                raise LibraryError(422, "建议资料格式不正确，请重新选择已保存的反馈") from None
            ident = uuid.uuid4().hex[:12]
            while ident in self.proposals:
                ident = uuid.uuid4().hex[:12]
            timer = JobTimings(on_update=lambda value: self._emit(ident, {"timings": value}, secret),
                               initial_stage="queue", scope="prompt_tuning", note=TUNING_NOTE)
            self.timings[ident] = timer
            self.proposals[ident] = {
                "id": ident, "status": "queued", "stage": "等待整理通用标准", "progress": 0,
                "created_at": timer.snapshot()["started_at"], "updated_at": _now(),
                "request_id": _clean(values["request_id"], secret), "request_key": _request_key(values["request_id"]),
                "request_fingerprint": _fingerprint("proposal", values),
                "base_revision": self.state["revision"], "base_version_id": base["id"],
                "base_version_name": base["name"], "base_prompt": _clean(base["text"], secret),
                "sources": frozen, "note": note, "prompt": prompts,
                "candidate_prompt": "", "summary": "", "changes": [], "warnings": [], "diff": "",
                "ai": {"call_count": 0, "text_call_count": 0, "visual_call_count": 0, "image_count": 0,
                       "successful_text_call_count": 0, "model": _clean(config.get("model", ""), secret),
                       "raw_response": "", "usage": {}}, "timings": timer.snapshot()}
            try:
                self._save_proposal(self.proposals[ident])
            except OSError:
                del self.proposals[ident]
                del self.timings[ident]
                raise LibraryError(500, "保存建议任务未完成，尚未请求AI，请确认后重试") from None
            try:
                self.executor.submit(self._run, ident, deepcopy(config))
            except Exception:
                self._finish(ident, "failed", {"stage": "建议未开始", "error": "建议任务未能排队，尚未请求AI"}, secret)
            return self.get_proposal(ident)

    def create_satisfied_round_proposal(self, values: dict, snapshot: dict, config: dict) -> dict:
        from . import vision
        from .prompt_tuning import build_round_tuning_prompts
        values = _validated(SatisfiedRoundRequest, values)
        with self.lock:
            previous = self.existing_satisfied_round_proposal(values)
            if previous is not None:
                return previous
            self._check_revision(values["expected_revision"])
            secret = config.get("api_key", "")
            frozen, base = _clean(deepcopy(snapshot), secret), self.active()
            if frozen.get("satisfied_round", {}).get("job_id") != values["job_id"]:
                raise LibraryError(422, "满意轮次来源与请求不一致")
            try:
                prompts = _clean(build_round_tuning_prompts(frozen["tuning_base_prompt"], base["text"], frozen["sources"],
                    frozen["frames"], frozen["sheets"], frozen["selected_frame_ids"]), secret)
                manifest = _clean(vision.request_manifest(prompts, frozen["sheets"], config), secret)
            except (ValueError, TypeError, KeyError):
                raise LibraryError(422, "满意轮次证据格式不正确，尚未请求AI") from None
            ident = uuid.uuid4().hex[:12]
            while ident in self.proposals:
                ident = uuid.uuid4().hex[:12]
            timer = JobTimings(on_update=lambda value: self._emit(ident, {"timings": value}, secret),
                               initial_stage="queue", scope="prompt_tuning",
                               note="满意轮次的一次明确多图提炼；使用原始拼图，失败不重试，不自动发布。")
            self.timings[ident] = timer
            self.proposals[ident] = {
                "id": ident, "source_mode": "satisfied_round", "status": "queued", "stage": "等待看图整理满意版本", "progress": 0,
                "created_at": timer.snapshot()["started_at"], "updated_at": _now(),
                "request_id": _clean(values["request_id"], secret), "request_key": _request_key(values["request_id"]),
                "request_fingerprint": _fingerprint("satisfied_round", values),
                "base_revision": self.state["revision"], "base_version_id": base["id"], "base_version_name": base["name"],
                "base_prompt": _clean(base["text"], secret), "tuning_base_prompt": frozen["tuning_base_prompt"],
                "satisfied_round": frozen["satisfied_round"], "sources": frozen["sources"], "note": "",
                "round_inputs": {key: frozen[key] for key in ("frames", "sheets", "selected_frame_ids")},
                "prompt": prompts, "request_manifest": manifest,
                "candidate_prompt": "", "summary": "", "changes": [], "warnings": [], "diff": "",
                "ai": {"type": "visual", "call_count": 0, "text_call_count": 0, "visual_call_count": 0,
                       "image_count": len(frozen["sheets"]), "successful_visual_call_count": 0,
                       "model": _clean(config.get("model", ""), secret), "request_manifest": manifest,
                       "raw_response": "", "usage": {}}, "timings": timer.snapshot()}
            try:
                self._save_proposal(self.proposals[ident])
            except OSError:
                del self.proposals[ident]
                del self.timings[ident]
                raise LibraryError(500, "保存满意轮次候选未完成，尚未请求AI") from None
            try:
                self.executor.submit(self._run_round, ident, deepcopy(config))
            except Exception:
                self._finish(ident, "failed", {"stage": "建议未开始", "error": "候选任务未能排队，尚未请求AI"}, secret)
            return self.get_proposal(ident)

    def get_proposal(self, ident: str) -> dict:
        with self.lock:
            if not isinstance(ident, str) or not re.fullmatch(ID_PATTERN, ident) or ident not in self.proposals:
                raise LibraryError(404, "没有找到这个通用标准建议任务")
            record = deepcopy(self.proposals[ident])
            if ident in self.timings:
                record["timings"] = self.timings[ident].snapshot()
            return record

    def _emit(self, ident: str, updates: dict, secret: str = "") -> None:
        with self.lock:
            self.proposals[ident].update(_clean(updates, secret))
            if ident in self.timings and "timings" not in updates:
                self.proposals[ident]["timings"] = self.timings[ident].snapshot()
            self.proposals[ident]["updated_at"] = _now()
            self._save_proposal(self.proposals[ident])

    def _finish(self, ident: str, status: str, updates: dict, secret: str = "") -> None:
        # Atomic terminal publication: readers must not observe running status
        # with completed timings. Timer callbacks reenter this RLock safely.
        with self.lock:
            timing = self.timings[ident].finish(status)
            self._emit(ident, {**updates, "status": status, "timings": timing}, secret)

    def _run(self, ident: str, config: dict) -> None:
        from .prompt_tuning import parse_tuning_result
        timer = self.timings[ident]
        secret = config.get("api_key", "")
        try:
            timer.end("queue")
            self._emit(ident, {"status": "analyzing", "stage": "整理明确反馈（纯文字，0图）", "progress": 10}, secret)
            with timer.measure("prepare_request"):
                record = self.get_proposal(ident)
                actual = deepcopy(record["prompt"])
            with timer.measure("ai_request"):
                ai = deepcopy(record["ai"])
                ai.update(call_count=1, text_call_count=1)
                self._emit(ident, {"ai": ai, "progress": 25}, secret)
                response = self.caller(actual, config)
                clean = _clean(response, secret)
                ai.update(raw_response=clean.get("text", ""), envelope=clean.get("envelope", {}),
                          usage=clean.get("usage", {}), elapsed_seconds=clean.get("elapsed_seconds"),
                          successful_text_call_count=1)
                self._emit(ident, {"ai": ai, "raw_response": clean.get("text", ""),
                                   "usage": clean.get("usage", {}), "progress": 75}, secret)
            with timer.measure("selection"):
                parsed = parse_tuning_result(clean["text"], record["base_prompt"], record["sources"], note=record["note"])
                _generic_text(parsed["candidate_prompt"])
                updates = {**parsed, "diff": _diff(record["base_prompt"], parsed["candidate_prompt"])}
                self._emit(ident, updates, secret)
            with timer.measure("final_validation"):
                # Publication deliberately remains a separate CAS operation.
                pass
            self._finish(ident, "completed", {"stage": "候选已生成，等待确认发布", "progress": 100}, secret)
        except Exception as exc:
            updates = {"stage": "建议未完成", "error": "整理建议失败，已保留文字输入和可用返回；没有自动发布或重试"}
            raw = getattr(exc, "raw_text", "")
            if isinstance(raw, str) and raw:
                ai = deepcopy(self.proposals[ident]["ai"])
                ai["raw_response"] = _clean(raw, secret)
                updates.update(ai=ai, raw_response=_clean(raw, secret))
            self._finish(ident, "failed", updates, secret)
        finally:
            config.clear()

    def _run_round(self, ident: str, config: dict) -> None:
        from . import media
        from .prompt_tuning import call_round_tuning, parse_round_tuning_result
        timer, secret = self.timings[ident], config.get("api_key", "")
        try:
            timer.end("queue")
            self._emit(ident, {"status": "analyzing", "stage": "看原始拼图整理满意版本", "progress": 10}, secret)
            with timer.measure("prepare_request"):
                record = self.get_proposal(ident)
                source_id = record["satisfied_round"]["job_id"]
                jobs = (self.data_dir / "jobs").resolve()
                directory = (jobs / source_id).resolve()
                if not re.fullmatch(ID_PATTERN, source_id) or directory.parent != jobs:
                    raise ValueError("满意轮次路径无效")
                sheets = record["round_inputs"]["sheets"]
                for sheet in sheets:
                    path = (directory / sheet["path"]).resolve()
                    if not path.is_relative_to(directory) or not path.is_file() or media.sha256(path) != sheet["sha256"]:
                        raise ValueError("满意轮次原始拼图在请求前发生变化")
            with timer.measure("ai_request"):
                ai = deepcopy(record["ai"])
                ai.update(call_count=1, visual_call_count=1)
                self._emit(ident, {"ai": ai, "progress": 25}, secret)
                response = call_round_tuning(record["prompt"], sheets, directory, config)
                clean = _clean(response, secret)
                ai.update(raw_response=clean.get("text", ""), envelope=clean.get("envelope", {}),
                          usage=clean.get("usage", {}), elapsed_seconds=clean.get("elapsed_seconds"),
                          successful_visual_call_count=1)
                self._emit(ident, {"ai": ai, "raw_response": clean.get("text", ""),
                                   "usage": clean.get("usage", {}), "progress": 75}, secret)
            with timer.measure("selection"):
                parsed = parse_round_tuning_result(clean["text"], record["tuning_base_prompt"], record["base_prompt"],
                                                    record["sources"], record["round_inputs"]["frames"])
                _generic_text(parsed["candidate_prompt"])
                self._emit(ident, {**parsed, "diff": _diff(record["base_prompt"], parsed["candidate_prompt"])}, secret)
            with timer.measure("final_validation"):
                pass
            self._finish(ident, "completed", {"stage": "候选已生成，等待确认设为通用", "progress": 100}, secret)
        except Exception as exc:
            updates = {"stage": "满意版本候选未完成", "error": "看图提炼失败，已保留输入及可用返回；没有自动发布或重试"}
            raw = getattr(exc, "raw_text", "")
            if isinstance(raw, str) and raw:
                ai = deepcopy(self.proposals[ident]["ai"])
                ai["raw_response"] = _clean(raw, secret)
                updates.update(ai=ai, raw_response=_clean(raw, secret))
            self._finish(ident, "failed", updates, secret)
        finally:
            config.clear()
