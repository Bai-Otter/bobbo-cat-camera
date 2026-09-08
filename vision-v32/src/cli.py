from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .analyzer import analyze_recording


def parse_bowl_roi(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("bowl ROI must be a JSON object")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cat-vision-inference")
    subparsers = parser.add_subparsers(dest="command")

    analyze = subparsers.add_parser("analyze", help="Analyze a local video path or playback URL.")
    analyze.add_argument("--source", required=True, help="Local video file path or playback URL.")
    analyze.add_argument("--recording-key", default="", help="Stable clip/recording identifier.")
    analyze.add_argument("--begin-time", default="", help="Recording begin time, e.g. 2026-07-06 08:30:00.")
    analyze.add_argument("--bowl-roi", default="", help="Optional bowl ROI JSON object.")
    analyze.add_argument(
        "--detection-target",
        default="cat",
        choices=["cat", "face"],
        help="Detection target. cat enables feeding behavior analysis; face keeps the legacy mode.",
    )
    analyze.add_argument(
        "--auto-bowl-detection",
        action="store_true",
        help="Enable the experimental Hough-circle bowl detector.",
    )
    analyze.add_argument(
        "--detector-backend",
        default="auto",
        choices=["auto", "opencv", "yolo"],
        help="Cat detector backend. auto prefers YOLO when available, then falls back to OpenCV.",
    )
    analyze.add_argument("--yolo-model", default="", help="Optional YOLO model path/name, e.g. yolo11s.pt.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "analyze":
        parser.print_help(sys.stderr)
        return 2

    try:
        bowl_roi = parse_bowl_roi(args.bowl_roi)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"error": "BOWL_ROI_INVALID", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2

    result = analyze_recording(
        {
            "sourceUrl": args.source,
            "recordingKey": args.recording_key,
            "beginTime": args.begin_time,
            "bowlRoi": bowl_roi,
            "detectionTarget": args.detection_target,
            "autoBowlDetection": args.auto_bowl_detection,
            "detectorBackend": args.detector_backend,
            "yoloModel": args.yolo_model,
        }
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
