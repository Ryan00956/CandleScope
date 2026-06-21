"""Print the next request.security TradingView capture task and commands."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from request_capture_status import DEFAULT_GOLDEN_DIR, build_report


DEFAULT_EXPORT_DIR = Path(".tmp") / "tradingview-request"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Show the next pending TradingView request capture task.",
    )
    parser.add_argument("--golden-dir", type=Path, default=DEFAULT_GOLDEN_DIR)
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    report = build_report(args.golden_dir)
    manifest = load_manifest(args.manifest)
    export_dir = args.manifest.parent if args.manifest is not None else DEFAULT_EXPORT_DIR
    task = find_next_task(
        report["fixtures"],
        manifest,
        include_all=args.all,
        export_dir=export_dir,
    )
    if task is None:
        payload = {"status": "complete", "message": "no pending request capture task"}
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(payload["message"])
        return 0

    if args.json:
        print(json.dumps(task, ensure_ascii=False, indent=2))
    else:
        print_task(task)
    return 0


def load_manifest(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def find_next_task(
    status_fixtures: list[dict[str, Any]],
    manifest: dict[str, Any] | None,
    *,
    include_all: bool,
    export_dir: Path,
) -> dict[str, Any] | None:
    pending = [
        fixture
        for fixture in status_fixtures
        if fixture["status"] != "captured" and (include_all or fixture["priority"])
    ]
    if not pending:
        return None
    fixture = pending[0]
    entry = find_manifest_entry(manifest, fixture["fixture"])
    return build_task(fixture, entry, include_all=include_all, export_dir=export_dir)


def find_manifest_entry(
    manifest: dict[str, Any] | None,
    fixture_name: str,
) -> dict[str, Any] | None:
    if manifest is None:
        return None
    for entry in manifest.get("entries", []):
        if entry.get("fixture") == fixture_name:
            return entry
    return None


def build_task(
    status_fixture: dict[str, Any],
    manifest_entry: dict[str, Any] | None,
    *,
    include_all: bool,
    export_dir: Path,
) -> dict[str, Any]:
    fixture = status_fixture["fixture"]
    export_dir_text = export_dir.as_posix()
    prepare_flags = " --all" if include_all else ""
    task = {
        "status": "pending",
        "fixture": fixture,
        "name": status_fixture["name"],
        "priority": status_fixture["priority"],
        "capture_status": status_fixture["status"],
        "prepare_command": (
            "python scripts/request_capture_prepare.py "
            f"--out-dir {export_dir_text} --clean{prepare_flags}"
        ),
        "preflight_command": (
            "python scripts/request_capture_preflight.py "
            f"{export_dir_text}/manifest.json --fixture {fixture}"
        ),
        "import_command": (
            "python scripts/request_capture_import.py "
            f"tests/golden/{fixture} --values {export_dir_text}/<export.csv> "
            f"--tolerance 1e-9 --assertion {capture_diff_assertion(status_fixture)} "
            '--note "TradingView export YYYY-MM-DD"'
        ),
        "diff_command": (
            "python scripts/request_capture_diff.py "
            f"--assertion {capture_diff_assertion(status_fixture)} tests/golden/{fixture}"
        ),
    }
    if manifest_entry is not None:
        task.update(
            {
                "pine_file": manifest_entry["pine_file"],
                "bars_file": manifest_entry["bars_file"],
                "expected_export_file": manifest_entry["expected_export_file"],
                "plot_titles": manifest_entry["plot_titles"],
                "capture_index_title": manifest_entry["capture_index_title"],
                "bar_count": manifest_entry["bar_count"],
                "import_command": manifest_entry["import_command"].replace(
                    "<export-dir>",
                    export_dir_text,
                ),
                "diff_command": manifest_entry["diff_command"],
            }
        )
    return task


def capture_diff_assertion(status_fixture: dict[str, Any]) -> str:
    if status_fixture["status"] == "captured":
        return status_fixture.get("assertion", "parity")
    if status_fixture.get("assertion") in {"parity", "reference"}:
        return status_fixture["assertion"]
    return "reference"


def print_task(task: dict[str, Any]) -> None:
    print("Next request TradingView capture task")
    print(f"fixture: {task['fixture']}")
    print(f"name: {task['name']}")
    print(f"priority: {'yes' if task['priority'] else 'no'}")
    print(f"status: {task['capture_status']}")
    if "pine_file" in task:
        print(f"pine file: {task['pine_file']}")
        print(f"bars file: {task['bars_file']}")
        print(f"expected export: {task['expected_export_file']}")
        print(f"bar count: {task['bar_count']}")
        print("plots: " + ", ".join(task["plot_titles"]))
        print(f"capture index plot: {task['capture_index_title']}")
    print()
    print("Commands:")
    print(task["prepare_command"])
    print(task["preflight_command"])
    print(task["import_command"])
    print(task["diff_command"])
    print("python -m pytest tests/test_golden_request_security.py -q")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
