"""Add TradingView external-capture placeholders to strategy fixtures."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


DEFAULT_GOLDEN_DIR = Path("tests") / "golden"
STRATEGY_FIXTURE_GLOB = "strategy_pine_equivalent*.json"
PLACEHOLDER = (
    '      "external_capture": {\n'
    '        "provider": "tradingview",\n'
    '        "status": "not_captured",\n'
    '        "notes": [\n'
    '          "Populate values from TradingView\'s exported plot data when an external capture is available."\n'
    "        ]\n"
    "      },\n"
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Ensure strategy pine-equivalent fixtures have TradingView capture placeholders.",
    )
    parser.add_argument(
        "fixtures",
        nargs="*",
        type=Path,
        help="Fixture JSON files to update. Defaults to all strategy pine-equivalent fixtures.",
    )
    parser.add_argument(
        "--golden-dir",
        type=Path,
        default=DEFAULT_GOLDEN_DIR,
        help="Directory containing golden fixture JSON files.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Report missing placeholders without writing files.",
    )
    args = parser.parse_args(argv)

    fixture_paths = args.fixtures or sorted(args.golden_dir.glob(STRATEGY_FIXTURE_GLOB))
    changed_paths: list[Path] = []
    added_count = 0
    for path in fixture_paths:
        added = scaffold_fixture(path, check=args.check)
        added_count += added
        if added:
            changed_paths.append(path)

    if args.check and changed_paths:
        for path in changed_paths:
            print(f"missing TradingView capture placeholder(s): {path}")
        return 1

    action = "would add" if args.check else "added"
    print(f"{action} {added_count} placeholder(s) across {len(changed_paths)} fixture file(s)")
    return 0


def scaffold_fixture(path: Path, *, check: bool = False) -> int:
    text = path.read_text(encoding="utf-8")
    fixture = json.loads(text)
    cases = fixture.get("cases", [])
    if not isinstance(cases, list):
        raise SystemExit(f"{path}: fixture must contain a cases list")

    missing_case_indexes = [
        index
        for index, case in enumerate(cases)
        if isinstance(case, dict) and "external_capture" not in case
    ]
    if not missing_case_indexes:
        return 0

    if check:
        return len(missing_case_indexes)

    updated = add_placeholders(text, cases, missing_case_indexes, path)
    path.write_text(updated, encoding="utf-8")
    return len(missing_case_indexes)


def add_placeholders(
    text: str,
    cases: list[Any],
    missing_case_indexes: list[int],
    path: Path,
) -> str:
    bar_matches = list(re.finditer(r'^      "bars": \[\r?$', text, re.MULTILINE))
    if len(bar_matches) != len(cases):
        raise SystemExit(
            f"{path}: expected one top-level bars block per case, "
            f"found {len(bar_matches)} for {len(cases)} case(s)"
        )

    updated = text
    for index in reversed(missing_case_indexes):
        insert_at = bar_matches[index].start()
        updated = updated[:insert_at] + PLACEHOLDER + updated[insert_at:]
    return updated


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
