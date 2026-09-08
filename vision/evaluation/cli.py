from __future__ import annotations

import argparse
import json

from .dataset import DatasetValidationError, load_manifest, validate_manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("manifest")
    validate_parser.add_argument("--verify-hashes", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "validate":
            result = validate_manifest(load_manifest(args.manifest), verify_hashes=args.verify_hashes)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
    except DatasetValidationError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, indent=2))
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
