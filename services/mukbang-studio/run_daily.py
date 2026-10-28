"""Independent loopback preview; its data never replaces the legacy service."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BOBBO 每日双视频手机预览（仅本机）")
    parser.add_argument("--port", type=int, default=8880)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent / "data" / "daily")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be in 1..65535")
    # Select the independent store BEFORE importing server: importing its
    # ASGI app must not scan or mark interrupted jobs in the legacy store.
    os.environ["MUKBANG_APP_DATA_DIR"] = str(args.data_dir.resolve())
    from mukbang.server import app
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
