"""Offline CLI; deliberately does not import the server or provider settings."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mukbang.recovery import recover_render


def main() -> int:
    parser = argparse.ArgumentParser(description="复用失败任务已保存的AI结果，只补导出，不调用AI。请先停止本地服务。")
    parser.add_argument("source_job_id", help="原失败任务的12位十六进制ID")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--job-id", help="可选的新12位任务ID；已有目录绝不覆盖")
    parser.add_argument("--port", type=int, default=8876, help="必须已停止的本地服务端口，默认8876")
    parser.add_argument("--retry-incomplete-story", action="store_true",
                        help="允许为整体完成但小剧场失败的任务新建恢复任务；不覆盖原结果")
    args = parser.parse_args()
    last_stage = None
    def progress(record):
        nonlocal last_stage
        stage = (record.get("stage"), record.get("progress"), record.get("status"))
        if stage != last_stage:
            print(json.dumps({"id": record["id"], "status": stage[2], "stage": stage[0],
                              "progress": stage[1], "ai_call_count": record["ai"]["call_count"]},
                             ensure_ascii=False), flush=True)
            last_stage = stage
    try:
        result = recover_render(args.data_dir, args.source_job_id, job_id=args.job_id, port=args.port, emit=progress,
                                retry_incomplete_story=args.retry_incomplete_story)
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc), "ai_call_count": 0}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"id": result["id"], "status": result["status"], "source_job_id": args.source_job_id,
                      "video_url": result["result"]["video_url"], "ai_call_count": 0,
                      "total_seconds": result["timings"]["total_seconds"]}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
