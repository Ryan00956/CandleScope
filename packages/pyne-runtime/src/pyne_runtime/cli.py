"""Command-line interface for Pyne."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from ._version import __version__
from .api import read_ohlcv, run, validate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pyne")
    parser.add_argument("--version", action="version", version=f"pyne {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run a Pyne script against OHLCV CSV data")
    run_parser.add_argument("script")
    run_parser.add_argument("--ohlcv", required=True)
    run_parser.add_argument("--out")
    run_parser.add_argument("--security-mode")
    run_parser.add_argument("--executor-mode")
    run_parser.add_argument(
        "--param",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Override an input.* parameter. May be used multiple times.",
    )
    run_parser.add_argument(
        "--params-json",
        help="Parameter overrides as a JSON object or a path to a JSON file.",
    )

    validate_parser = subparsers.add_parser("validate", help="Validate a Pyne script")
    validate_parser.add_argument("script")

    schema_parser = subparsers.add_parser("schema", help="Print the Pyne input/output schema")
    schema_parser.set_defaults(schema=True)

    args = parser.parse_args(argv)

    if args.command == "run":
        try:
            params = _load_params(args.param, args.params_json)
        except ValueError as exc:
            parser.error(str(exc))

        data = read_ohlcv(args.ohlcv)
        result = run(
            Path(args.script),
            data,
            params=params,
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


def _load_params(param_items: list[str], params_json: str | None) -> dict[str, Any]:
    params: dict[str, Any] = {}

    if params_json:
        params.update(_load_params_json(params_json))

    for item in param_items:
        if "=" not in item:
            raise ValueError(f"--param must use KEY=VALUE format: {item}")
        key, raw_value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError("--param key cannot be empty")
        params[key] = _parse_param_value(raw_value)

    return params


def _load_params_json(value: str) -> dict[str, Any]:
    path = Path(value)
    raw = path.read_text(encoding="utf-8") if path.exists() else value
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"--params-json must be a JSON object: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise ValueError("--params-json must be a JSON object")
    return payload


def _parse_param_value(value: str) -> Any:
    raw = value.strip()
    if raw == "":
        return ""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return value


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
