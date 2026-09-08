from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2

from src.analyzer import analyze_recording
from evaluation.cute_annotation import positive_rank_score
from evaluation.cute_segments import (
    DEFAULT_CONFIG as SEGMENT_CONFIG,
    build_cute_segments,
    normalize_cute_samples,
    segment_for_offset,
    smooth_cute_samples,
)


THRESHOLD = 0.65


def _number(value: Any) -> float:
    try:
        value = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return value if math.isfinite(value) else 0.0


def _nearest(frames: list[dict[str, Any]], offset: float) -> dict[str, Any]:
    if not frames:
        return {}
    return min(frames, key=lambda item: abs(_number(item.get("offsetSec")) - offset))


def _label(frame: dict[str, Any], rank: float, top_offsets: set[float]) -> str:
    fixed = "PASS" if rank >= THRESHOLD else "BELOW"
    top = "TOP20" if any(abs(_number(offset) - _number(frame.get("offsetSec"))) < 0.01 for offset in top_offsets) else "-"
    return f"Cute rank {rank:.2f} | Gate {THRESHOLD:.2f} {fixed} | {top}"


def _rank(frame: dict[str, Any]) -> float:
    evidence = frame.get("cuteEvidence")
    if isinstance(evidence, dict):
        return positive_rank_score({**frame, **evidence})
    return positive_rank_score(frame)


def _draw(
    frame: Any,
    evidence: dict[str, Any],
    rank: float,
    continuity_score: float,
    top_offsets: set[float],
    offset: float,
    segment_hit: tuple[int, dict[str, Any]] | None,
) -> Any:
    height, width = frame.shape[:2]
    cat = bool(evidence.get("hasCat"))
    cute = evidence.get("cuteEvidence") or {}
    relation = str(cute.get("faceRelation") or evidence.get("faceRelation") or "unknown")
    status = _label({"offsetSec": offset}, rank, top_offsets)
    if segment_hit:
        segment_number, segment = segment_hit
        is_peak = abs(offset - _number(segment.get("anchorOffsetSec"))) <= 0.3
        role = "PEAK" if is_peak else "CONTEXT"
        segment_line = (
            f"Segment {segment_number:02d} {segment['startSec']:.1f}-{segment['endSec']:.1f}s "
            f"{segment['durationSec']:.1f}s {role}"
        )
    else:
        role = "EXCLUDE"
        segment_line = "Segment -- EXCLUDE"
    lines = [
        f"{status} | {role}",
        segment_line,
        f"Cat {'YES' if cat else 'NO'} | Rel {relation}",
        f"cute {_number(cute.get('cuteScore')):.2f} | rank {rank:.2f} | smooth {continuity_score:.2f}",
        f"size {_number(cute.get('sizeScore')):.2f} | pitch {_number(cute.get('pitchScore')):.2f} | vis {_number(cute.get('visibilityScore')):.2f}",
        f"t={offset:06.1f}s | EXPERIMENTAL THRESHOLD",
    ]
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.55, width / 2200.0)
    thickness = max(1, int(round(width / 900.0)))
    line_height = int(38 * font_scale)
    box_height = line_height * len(lines) + 24
    overlay = frame.copy()
    cv2.rectangle(overlay, (18, 18), (min(width - 18, 900), min(height - 18, box_height)), (12, 18, 28), -1)
    frame = cv2.addWeighted(overlay, 0.78, frame, 0.22, 0)
    for index, line in enumerate(lines):
        color = (
            (80, 220, 120)
            if index == 0 and role == "PEAK"
            else (80, 200, 235) if index == 0 and role == "CONTEXT" else (230, 230, 230)
        )
        cv2.putText(frame, line, (34, 48 + index * line_height), font, font_scale, color, thickness, cv2.LINE_AA)

    for box in evidence.get("catBoxes") or evidence.get("targetBoxes") or []:
        x = int(max(0, min(width - 1, _number(box.get("x")))))
        y = int(max(0, min(height - 1, _number(box.get("y")))))
        w = int(max(1, min(width - x, _number(box.get("width")))))
        h = int(max(1, min(height - y, _number(box.get("height")))))
        color = (40, 220, 100) if rank >= THRESHOLD else (80, 170, 220)
        cv2.rectangle(frame, (x, y), (x + w, y + h), color, max(2, thickness))
    return frame


def render(source: str, output: str, report_path: str, model: str | None = None, analysis_path: str | None = None) -> dict[str, Any]:
    if analysis_path:
        cached = json.loads(Path(analysis_path).read_text(encoding="utf-8"))
        analysis = {"frames": cached.get("frames") or [], "detectorBackend": cached.get("analysisDetectorBackend"), "bowlRoi": cached.get("bowlRoi")}
    else:
        analysis = analyze_recording(
        {
            "sourceUrl": source,
            "recordingKey": Path(source).stem,
            "detectionTarget": "cat",
            "detectorBackend": "yolo",
            "yoloModel": model or "",
            "autoBowlDetection": True,
            "cuteAnalysisAllScales": True,
            }
        )
    frames = list(analysis.get("frames") or [])
    ranked = [{**frame, "rankScore": _rank(frame)} for frame in frames]
    sampled = smooth_cute_samples(normalize_cute_samples(ranked))
    for item in ranked:
        sample = _nearest(sampled, _number(item.get("offsetSec")))
        item["continuityScore"] = _number(sample.get("continuityScore"))
    ordered = sorted(ranked, key=lambda item: (-_number(item.get("rankScore")), _number(item.get("offsetSec"))))
    top_count = max(1, math.ceil(len(ordered) * 0.20)) if ordered else 0
    top_offsets = {_number(item.get("offsetSec")) for item in ordered[:top_count]}

    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        raise RuntimeError("VIDEO_OPEN_FAILED")
    fps = capture.get(cv2.CAP_PROP_FPS) or 20.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_limit = int(round(120.0 * fps))
    duration_sec = min(120.0, frame_limit / fps if fps else 120.0)
    segments = build_cute_segments(ranked, duration_sec=duration_sec)
    writer = cv2.VideoWriter(output, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise RuntimeError("VIDEO_WRITER_FAILED")

    pass_count = 0
    top_count_seen = 0
    segment_frame_count = 0
    peak_frame_count = 0
    context_frame_count = 0
    frame_count = 0
    while frame_count < frame_limit:
        ok, image = capture.read()
        if not ok:
            break
        offset = frame_count / fps
        evidence = _nearest(frames, offset)
        rank = _rank(evidence)
        sample = _nearest(sampled, offset)
        segment_hit = segment_for_offset(segments, offset)
        if rank >= THRESHOLD:
            pass_count += 1
        if any(abs(_number(item.get("offsetSec")) - _number(evidence.get("offsetSec"))) < 0.01 for item in ordered[:top_count]):
            top_count_seen += 1
        if segment_hit:
            segment_frame_count += 1
            if abs(offset - _number(segment_hit[1].get("anchorOffsetSec"))) <= 0.3:
                peak_frame_count += 1
            else:
                context_frame_count += 1
        writer.write(_draw(image, evidence, rank, _number(sample.get("continuityScore")), top_offsets, offset, segment_hit))
        frame_count += 1
    capture.release()
    writer.release()

    report = {
        "source": source,
        "output": output,
        "durationSec": round(frame_count / fps, 3) if fps else 0.0,
        "fps": fps,
        "width": width,
        "height": height,
        "analysisFrameCount": len(frames),
        "renderedFrameCount": frame_count,
        "fixedExperimentalThreshold": THRESHOLD,
        "segmentConfig": SEGMENT_CONFIG,
        "segments": segments,
        "segmentStats": {
            "segmentCount": len(segments),
            "segmentFrameCount": segment_frame_count,
            "peakFrameCount": peak_frame_count,
            "contextFrameCount": context_frame_count,
            "totalSegmentDurationSec": round(sum(item["durationSec"] for item in segments), 3),
            "minSegmentDurationSec": round(min((item["durationSec"] for item in segments), default=0.0), 3),
            "maxSegmentDurationSec": round(max((item["durationSec"] for item in segments), default=0.0), 3),
            "meanSegmentDurationSec": round(
                sum(item["durationSec"] for item in segments) / len(segments), 3
            ) if segments else 0.0,
            "missingCatDurationSec": round(sum(item["missingCatSec"] for item in segments), 3),
            "badTransitionDurationSec": round(sum(item["badTransitionSec"] for item in segments), 3),
        },
        "topFraction": 0.20,
        "passFrameCount": pass_count,
        "top20SampleFrameCount": top_count_seen,
        "analysisDetectorBackend": analysis.get("detectorBackend"),
        "bowlRoi": analysis.get("bowlRoi"),
        "warning": "Rank score and thresholds are experimental candidate signals, not validated classifier probabilities.",
        "frames": ranked,
    }
    Path(report_path).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--model", default="")
    parser.add_argument("--analysis", default="")
    args = parser.parse_args()
    report = render(args.source, args.output, args.report, args.model, args.analysis or None)
    print(json.dumps({key: value for key, value in report.items() if key != "frames"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
