from __future__ import annotations

import argparse
import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BOBBO 吃播调试台（仅本机）")
    parser.add_argument("--port", type=int, default=8876)
    args = parser.parse_args()
    uvicorn.run("mukbang.server:app", host="127.0.0.1", port=args.port, log_level="info")
