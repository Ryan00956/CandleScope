"""Report TradingView external-capture status for strategy pine-equivalent fixtures."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_GOLDEN_DIR = Path("tests") / "golden"
STRATEGY_FIXTURE_GLOB = "strategy_pine_equivalent*.json"
PRIORITY_FIXTURES = [
    "strategy_pine_equivalent_smoke.json",
    "strategy_pine_equivalent_bracket_exit.json",
    "strategy_pine_equivalent_cost_allocation.json",
    "strategy_pine_equivalent_reversal_pyramiding.json",
    "strategy_pine_equivalent_margin_order_cancel.json",
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report TradingView capture status for strategy pine-equivalent fixtures.",
    )
    parser.add_argument(
        "--golden-dir",
        type=Path,
        default=DEFAULT_GOLDEN_DIR,
        help="Directory containing golden fixture JSON files.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON instead of a table.",
    )
    parser.add_argument(
        "--missing-only",
        action="store_true",
        help="Only list cases without a captured TradingView export.",
    )
    args = parser.parse_args(argv)

    report = build_report(args.golden_dir)
    cases = report["cases"]
    if args.missing_only:
        cases = [case for case in cases if case["status"] != "captured"]
        report = {**report, "cases": cases}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_table(report)
    return 0


def build_report(golden_dir: Path) -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    for fixture_path in sorted(golden_dir.glob(STRATEGY_FIXTURE_GLOB), key=_fixture_sort_key):
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        for case in fixture["cases"]:
            capture = case.get("external_capture")
            status = "missing" if capture is None else capture["status"]
            values = {} if capture is None else capture.get("values", {})
            cases.append(
                {
                    "fixture": fixture_path.name,
                    "case": case["name"],
                    "priority": fixture_path.name in PRIORITY_FIXTURES,
                    "provider": None if capture is None else capture["provider"],
                    "status": status,
                    "assertion": None if capture is None else capture.get("assertion"),
                    "captured_plots": sorted(values),
                    "plot_count": len(values),
                }
            )

    counts = {
        "total": len(cases),
        "captured": sum(case["status"] == "captured" for case in cases),
        "not_captured": sum(case["status"] == "not_captured" for case in cases),
        "missing": sum(case["status"] == "missing" for case in cases),
        "priority_total": sum(case["priority"] for case in cases),
        "priority_captured": sum(
            case["priority"] and case["status"] == "captured" for case in cases
        ),
    }
    return {"counts": counts, "cases": cases}


def print_table(report: dict[str, Any]) -> None:
    counts = report["counts"]
    print(
        "Strategy TradingView capture status: "
        f"{counts['captured']}/{counts['total']} captured, "
        f"{counts['not_captured']} not_captured, {counts['missing']} missing"
    )
    print(
        "Priority captures: "
        f"{counts['priority_captured']}/{counts['priority_total']} captured"
    )
    print()
    print(f"{'status':<13} {'priority':<8} {'fixture':<55} case")
    print("-" * 100)
    for case in report["cases"]:
        priority = "yes" if case["priority"] else "no"
        print(
            f"{case['status']:<13} {priority:<8} "
            f"{case['fixture']:<55} {case['case']}"
        )


def _fixture_sort_key(path: Path) -> tuple[int, str]:
    try:
        priority = PRIORITY_FIXTURES.index(path.name)
    except ValueError:
        priority = len(PRIORITY_FIXTURES)
    return priority, path.name


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
