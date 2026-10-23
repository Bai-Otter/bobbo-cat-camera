from copy import deepcopy

import pytest

from mukbang.timing import JobTimings, interrupted_snapshot


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def row(snapshot, stage):
    return next(item for item in snapshot["stages"] if item["id"] == stage)


def test_separate_phases_and_overhead_reconcile_with_total():
    clock = Clock()
    timer = JobTimings(clock=clock)
    clock.advance(0.5)
    with timer.measure("extract_frames"):
        clock.advance(2)
    with timer.measure("build_sheets"):
        clock.advance(1)
    with timer.measure("ai_request"):
        clock.advance(10)
    clock.advance(0.5)
    value = timer.finish("completed")
    assert value["total_seconds"] == 14
    assert row(value, "extract_frames")["seconds"] == 2
    assert row(value, "build_sheets")["seconds"] == 1
    assert row(value, "ai_request")["seconds"] == 10
    assert row(value, "overhead")["seconds"] == 1
    assert sum(stage["seconds"] or 0 for stage in value["stages"]) == pytest.approx(value["total_seconds"])
    assert row(value, "render_highlight")["status"] == "skipped"
    assert row(value, "render_highlight")["seconds"] is None


def test_request_start_and_upload_initial_stage_cover_body_parsing():
    clock = Clock()
    clock.advance(3)
    timer = JobTimings(clock=clock, started_monotonic=100, started_at="2026-10-22T20:00:00+08:00", initial_stage="upload")
    clock.advance(1)
    timer.end("upload")
    timer.begin("queue")
    clock.advance(5)
    timer.end("queue")
    value = timer.finish("completed")
    assert value["started_at"] == "2026-10-22T20:00:00+08:00"
    assert value["scope"] == "server_request_to_terminal"
    assert value["total_seconds"] == 9
    assert row(value, "upload")["seconds"] == 4
    assert row(value, "queue")["seconds"] == 5


def test_running_snapshot_is_live_but_never_changes_earlier_snapshot():
    clock, updates = Clock(), []
    timer = JobTimings(clock=clock, on_update=updates.append)
    timer.begin("ai_request")
    clock.advance(1)
    first = timer.snapshot()
    clock.advance(4)
    second = timer.snapshot()
    assert row(first, "ai_request")["seconds"] == 1
    assert row(second, "ai_request")["seconds"] == 5
    assert row(second, "ai_request")["status"] == "running"
    assert updates and updates[0]["total_seconds"] == 0
    assert row(second, "render_highlight")["seconds"] is None
    assert row(second, "render_highlight")["status"] == "pending"


def test_reentering_a_stage_accumulates_without_counting_other_stage():
    clock = Clock()
    timer = JobTimings(clock=clock)
    with timer.measure("selection"):
        clock.advance(1)
    with timer.measure("annotate_sheets"):
        clock.advance(3)
    with timer.measure("selection"):
        clock.advance(2)
    value = timer.finish("completed")
    assert row(value, "selection")["seconds"] == 3
    assert row(value, "annotate_sheets")["seconds"] == 3
    assert value["total_seconds"] == 6


def test_exception_keeps_partial_stage_and_skips_later_steps():
    clock = Clock()
    timer = JobTimings(clock=clock)
    with pytest.raises(RuntimeError):
        with timer.measure("ai_request"):
            clock.advance(7)
            raise RuntimeError("fixture connection failure")
    value = timer.finish("failed")
    assert value["status"] == "failed"
    assert value["failed_stage"] == "ai_request"
    assert row(value, "ai_request")["status"] == "failed"
    assert row(value, "ai_request")["seconds"] == 7
    assert row(value, "export_memes")["status"] == "skipped"
    assert "fixture connection failure" not in str(value)


def test_cancellation_freezes_the_timer_and_is_idempotent():
    clock = Clock()
    timer = JobTimings(clock=clock, initial_stage="queue")
    clock.advance(4)
    first = timer.finish("cancelled")
    clock.advance(100)
    assert timer.finish("completed") == first
    assert timer.snapshot() == first
    assert row(first, "queue")["status"] == "cancelled"
    assert first["finished_at"]
    with pytest.raises(RuntimeError):
        timer.begin("ai_request")


def test_cancelled_exception_is_not_presented_as_network_failure():
    clock = Clock()
    timer = JobTimings(clock=clock)
    with pytest.raises(RuntimeError):
        with timer.measure("extract_frames"):
            clock.advance(0.25)
            raise RuntimeError("cooperative cancellation")
    value = timer.finish("cancelled")
    assert row(value, "extract_frames")["status"] == "cancelled"
    assert value.get("failed_stage") is None


def test_zero_time_is_measured_not_missing_and_overlaps_are_rejected():
    timer = JobTimings(clock=Clock())
    with timer.measure("extract_frames"):
        with pytest.raises(RuntimeError):
            timer.begin("build_sheets")
    value = timer.finish("completed")
    assert row(value, "extract_frames")["seconds"] == 0
    assert row(value, "extract_frames")["percent"] == 0
    assert row(value, "build_sheets")["seconds"] is None
    assert value["total_seconds"] == 0


def test_interruption_freezes_only_last_saved_measurements():
    clock = Clock()
    timer = JobTimings(clock=clock)
    timer.begin("ai_request")
    clock.advance(5)
    saved = timer.snapshot()
    original = deepcopy(saved)
    clock.advance(1000)
    value = interrupted_snapshot(saved)
    assert saved == original
    assert value["total_seconds"] == 5
    assert value["status"] == "interrupted"
    assert value["is_partial"] is True
    assert row(value, "ai_request")["status"] == "interrupted"
    assert row(value, "render_highlight")["status"] == "skipped"
    assert "最后" in value["note"]
