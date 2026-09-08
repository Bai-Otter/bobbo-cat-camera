from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any


def _load_chewmeter(cat_chew_dir: Path):
    module_path = cat_chew_dir / "chewmeter.py"
    if not module_path.is_file():
        raise FileNotFoundError(f"CAT_CHEW_MODULE_NOT_FOUND:{module_path}")
    spec = importlib.util.spec_from_file_location("bobbo_external_chewmeter", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("CAT_CHEW_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def windows_to_intervals(windows: list[dict[str, Any]], hop_seconds: float) -> list[dict[str, Any]]:
    intervals: list[dict[str, Any]] = []
    for window in windows:
        end = float(window.get("t") or 0)
        start = max(0.0, end - hop_seconds)
        state = "chewing" if window.get("eating") else "not_eating"
        if intervals and intervals[-1]["state"] == state and abs(intervals[-1]["endSec"] - start) < 1e-6:
            intervals[-1]["endSec"] = end
        elif end > start:
            intervals.append({"state": state, "startSec": start, "endSec": end})
    return intervals


def run_adapter(video: Path, cat_chew_dir: Path, max_seconds: float | None = None) -> dict[str, Any]:
    module = _load_chewmeter(cat_chew_dir)
    meter, _ = module.analyze_video(str(video), max_seconds=max_seconds, weights=(0.75, 0.25, 0.0))
    hop_seconds = float(meter.hop) / float(meter.fps)
    windows = [dict(item) for item in meter.history]
    return {
        "adapterVersion": "cat-chew-adapter-v1",
        "sourceAlgorithm": "ChewMeter prototype",
        "sourcePath": str(cat_chew_dir),
        "limitations": [
            "Binary rhythm output is mapped to chewing/not_eating.",
            "Licking is not classified by this prototype.",
            "Results are not accuracy claims without complete ground truth.",
        ],
        "summary": meter.summary(),
        "predictions": windows_to_intervals(windows, hop_seconds),
        "windows": windows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("--cat-chew-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-seconds", type=float)
    args = parser.parse_args()
    result = run_adapter(args.video.resolve(), args.cat_chew_dir.resolve(), args.max_seconds)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(args.output), "summary": result["summary"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
