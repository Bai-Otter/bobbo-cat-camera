from __future__ import annotations

import json
import sys
from typing import Any

from .cute_segments import DEFAULT_CONFIG, build_cute_segments


ALGORITHM_VERSION = "cute-continuity-v3"


def select_requests(payload: dict[str, Any]) -> dict[str, Any]:
    requests = payload.get("requests")
    if not isinstance(requests, list):
        raise ValueError("REQUESTS_REQUIRED")
    config = payload.get("config")
    if config is not None and not isinstance(config, dict):
        raise ValueError("CONFIG_INVALID")
    results = []
    for index, request in enumerate(requests):
        if not isinstance(request, dict):
            raise ValueError(f"REQUEST_INVALID:{index}")
        request_id = str(request.get("id") or "").strip()
        frames = request.get("frames")
        if not request_id or not isinstance(frames, list):
            raise ValueError(f"REQUEST_INVALID:{index}")
        duration_sec = request.get("durationSec")
        segments = build_cute_segments(
            frames,
            duration_sec=float(duration_sec) if duration_sec is not None else None,
            config=config,
        )
        results.append({"id": request_id, "segments": segments})
    return {
        "ok": True,
        "algorithm": ALGORITHM_VERSION,
        "config": {**DEFAULT_CONFIG, **(config or {})},
        "results": results,
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = select_requests(payload)
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        result = {"ok": False, "error": str(error)}
        print(json.dumps(result, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
