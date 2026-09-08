from __future__ import annotations

import argparse
import json
from pathlib import Path

from .cute_annotation import (
    CuteAnnotationError,
    evaluate_dataset,
    load_dataset,
    rank_positive,
    rank_timeline,
    tune_policy,
)


def main() -> int:
    parser = argparse.ArgumentParser(prog="cute-annotation")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("evaluate", "tune", "rank-positive"):
        command = subparsers.add_parser(name)
        command.add_argument("dataset")
        command.add_argument("--out", default="")
        command.add_argument("--top-fraction", type=float, default=0.2)
    timeline = subparsers.add_parser("rank-timeline")
    timeline.add_argument("timeline")
    timeline.add_argument("--out", default="")
    timeline.add_argument("--top-fraction", type=float, default=0.2)
    args = parser.parse_args()
    try:
        if args.command == "rank-timeline":
            with Path(args.timeline).open("r", encoding="utf-8") as handle:
                result = rank_timeline(json.load(handle), args.top_fraction)
        else:
            dataset = load_dataset(args.dataset)
            if args.command == "evaluate":
                result = evaluate_dataset(dataset)
            elif args.command == "tune":
                result = tune_policy(dataset)
            else:
                result = rank_positive(dataset, args.top_fraction)
    except (CuteAnnotationError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, indent=2))
        return 2
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
