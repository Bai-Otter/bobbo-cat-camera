"""Monotonic, non-overlapping generation timings; never inferred from files."""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime
import math
from threading import RLock
import time


STAGES = {
    "upload": "接收并保存视频",
    "queue": "排队等待",
    "reuse_inputs": "复用源片与采样缓存",
    "source_probe": "读取视频与源时间戳",
    "extract_frames": "抽取采样帧",
    "build_sheets": "生成采样拼图",
    "prepare_request": "准备 Prompt 与请求",
    "ai_request": "AI 调用",
    "selection": "解析与验证选片",
    "annotate_sheets": "生成圈选图",
    "render_highlight": "精选剪辑与校验",
    "render_story": "互动小剧场剪辑与校验",
    "export_memes": "表情包导出与校验",
    "final_validation": "最终检查与保存",
}
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
NOTE = ("从本地服务收到生成请求到处理结束，包含接收保存与排队；"
        "不含选文件、请求抵达前的时间和网页轮询延迟。AI 调用包含请求准备编码、传输、等待与接收响应。")


def wall_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class JobTimings:
    def __init__(self, on_update=None, *, started_monotonic=None, started_at=None,
                 initial_stage=None, clock=None, scope="server_request_to_terminal", note=None):
        self._clock = clock if clock is not None else time.monotonic
        self._start = self._clock() if started_monotonic is None else started_monotonic
        self._started_at = started_at or wall_now()
        self._scope = scope
        self._note = note or NOTE
        self._end = None
        self._finished_at = None
        self._status = "running"
        self._rows = {key: {"elapsed": 0.0, "status": "pending"} for key in STAGES}
        self._details = {}
        self._active = None
        self._active_start = None
        self._failed_stage = None
        self._on_update = on_update
        self._lock = RLock()
        if initial_stage is not None:
            self._rows[initial_stage]["status"] = "running"
            self._active, self._active_start = initial_stage, self._start

    def _notify(self) -> dict:
        value = self.snapshot()
        # Never invoke job persistence while holding the timing lock: job GET
        # takes the manager lock before reading a timing snapshot.
        if self._on_update is not None:
            self._on_update(deepcopy(value))
        return value

    def begin(self, stage_id: str) -> None:
        with self._lock:
            if self._status in TERMINAL:
                raise RuntimeError("计时已结束，不能开始新的环节")
            if self._active is not None:
                raise RuntimeError("环节计时不能重叠或嵌套")
            if stage_id not in self._rows:
                if stage_id != "processing":
                    raise ValueError("未知的生成计时环节")
                self._rows[stage_id] = {"elapsed": 0.0, "status": "pending"}
            self._active, self._active_start = stage_id, self._clock()
            self._rows[stage_id]["status"] = "running"
        self._notify()

    def _end_locked(self, stage_id: str, status: str, now: float) -> None:
        if self._active != stage_id:
            raise RuntimeError("停止的计时环节不是当前环节")
        row = self._rows[stage_id]
        row["elapsed"] += max(0.0, now - self._active_start)
        row["status"] = status
        if status == "failed":
            self._failed_stage = stage_id
        self._active, self._active_start = None, None

    def end(self, stage_id: str, status: str = "completed") -> None:
        if status not in TERMINAL:
            raise ValueError("无效的环节结束状态")
        with self._lock:
            self._end_locked(stage_id, status, self._clock())
        self._notify()

    def record_detail(self, stage_id: str, detail_id: str, label: str, seconds: float, status: str) -> None:
        """Publish measured child work; it is already included in its parent.

        Details are observations, not nested stage timers or additions to the
        total. The caller measures sequential media operations with monotonic
        time, including the partial duration of a failed operation.
        """
        with self._lock:
            if self._status in TERMINAL or self._active != stage_id:
                raise RuntimeError("只能在所属环节运行时记录媒体细项")
            if (isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or
                    not math.isfinite(seconds) or seconds < 0 or status not in TERMINAL):
                raise ValueError("媒体细项必须包含有效的耗时和结束状态")
            if (not isinstance(detail_id, str) or not detail_id or not isinstance(label, str) or not label):
                raise ValueError("媒体细项缺少标识或名称")
            details = self._details.setdefault(stage_id, {})
            previous = details.get(detail_id)
            if previous is not None and previous["label"] != label:
                raise ValueError("同一媒体细项的名称不能改变")
            details[detail_id] = {"id": detail_id, "label": label,
                                  "seconds": (previous["seconds"] if previous else 0.0) + seconds,
                                  "status": status if status != "completed" or previous is None else previous["status"]}
        self._notify()

    @contextmanager
    def measure_detail(self, stage_id: str, detail_id: str, label: str):
        with self._lock:
            if self._status in TERMINAL or self._active != stage_id:
                raise RuntimeError("只能在所属环节运行时记录媒体细项")
            started = self._clock()
        status = "failed"
        try:
            yield
            status = "completed"
        finally:
            self.record_detail(stage_id, detail_id, label, max(0.0, self._clock() - started), status)

    @contextmanager
    def measure(self, stage_id: str):
        self.begin(stage_id)
        try:
            yield
        except BaseException:
            self.end(stage_id, "failed")
            raise
        else:
            self.end(stage_id)

    def finish(self, status: str) -> dict:
        if status not in TERMINAL:
            raise ValueError("无效的任务结束状态")
        with self._lock:
            if self._status in TERMINAL:
                return self.snapshot()
            now = self._clock()
            if self._active is not None:
                self._end_locked(self._active, status, now)
            if status in {"cancelled", "interrupted"}:
                for row in self._rows.values():
                    if row["status"] == "failed":
                        row["status"] = status
                for details in self._details.values():
                    for detail in details.values():
                        if detail["status"] == "failed":
                            detail["status"] = status
                self._failed_stage = None
            elif status == "failed" and self._failed_stage is None:
                self._failed_stage = "overhead"
            for row in self._rows.values():
                if row["status"] == "pending":
                    row["status"] = "skipped"
            self._status, self._end = status, now
            self._finished_at = wall_now()
        return self._notify()

    def snapshot(self) -> dict:
        with self._lock:
            now = self._clock() if self._end is None else self._end
            total = max(0.0, now - self._start)
            stages, accounted = [], 0.0
            for key, row in self._rows.items():
                elapsed = row["elapsed"]
                if key == self._active:
                    elapsed += max(0.0, now - self._active_start)
                recorded = row["status"] not in {"pending", "skipped"}
                seconds = round(elapsed, 6) if recorded else None
                accounted += elapsed
                stage = {"id": key, "label": STAGES.get(key, "处理任务"),
                         "seconds": seconds, "status": row["status"],
                         "percent": round(elapsed / total * 100, 2) if recorded and total > 0 else 0 if recorded else None}
                if self._details.get(key):
                    stage["details"] = [{**detail, "seconds": round(detail["seconds"], 6),
                                         "percent": round(detail["seconds"] / elapsed * 100, 2) if elapsed > 0 else 0}
                                        for detail in self._details[key].values()]
                stages.append(stage)
            overhead = max(0.0, total - accounted)
            stages.append({"id": "overhead", "label": "调度与记录", "seconds": round(overhead, 6),
                           "status": "failed" if self._failed_stage == "overhead" else
                                     "running" if self._status == "running" else "completed",
                           "percent": round(overhead / total * 100, 2) if total > 0 else 0})
            return {"schema_version": 1, "available": True, "status": self._status,
                    "total_seconds": round(total, 6), "started_at": self._started_at,
                    "finished_at": self._finished_at, "scope": self._scope,
                    "is_partial": self._status == "interrupted", "active_stage": self._active,
                    "failed_stage": self._failed_stage, "note": self._note, "stages": stages}


def interrupted_snapshot(saved: dict) -> dict:
    """Freeze the last persisted observation; do not invent restart downtime."""
    value = deepcopy(saved)
    value.update(status="interrupted", is_partial=True, active_stage=None,
                 note="服务重启中断：耗时仅截至最后一次保存的记录，未计入未记录时段与停机时间。")
    for row in value.get("stages", []):
        if row.get("status") == "running":
            row["status"] = "interrupted"
        elif row.get("status") == "pending":
            row["status"] = "skipped"
        for detail in row.get("details", []):
            if detail.get("status") == "running":
                detail["status"] = "interrupted"
    return value
