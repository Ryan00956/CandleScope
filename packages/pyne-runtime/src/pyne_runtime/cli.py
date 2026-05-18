"""Command-line interface for Pyne."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .api import read_ohlcv, run, validate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pyne")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run a Pyne script against OHLCV CSV data")
    run_parser.add_argument("script")
    run_parser.add_argument("--ohlcv", required=True)
    run_parser.add_argument("--out")
    run_parser.add_argument("--security-mode")
    run_parser.add_argument("--executor-mode")

    validate_parser = subparsers.add_parser("validate", help="Validate a Pyne script")
    validate_parser.add_argument("script")

    schema_parser = subparsers.add_parser("schema", help="Print the Pyne input/output schema")
    schema_parser.set_defaults(schema=True)

    args = parser.parse_args(argv)

    if args.command == "run":
        data = read_ohlcv(args.ohlcv)
        result = run(
            Path(args.script),
            data,
            security_mode=args.security_mode,
            executor_mode=args.executor_mode,
        )
        payload = result.to_dict()
        if args.out:
            Path(args.out).write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        else:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if result.ok else 1

    if args.command == "validate":
        diagnostics = validate(Path(args.script))
        print(json.dumps({"ok": not diagnostics, "diagnostics": diagnostics}, indent=2))
        return 0 if not diagnostics else 1

    if args.command == "schema":
        from .api import schema

        print(json.dumps(schema(), indent=2))
        return 0

    parser.error("unknown command")
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
