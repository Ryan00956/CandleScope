"""Report TradingView external-capture status for request.security fixtures."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_GOLDEN_DIR = Path("tests") / "golden"
REQUEST_FIXTURE_GLOB = "request_security_*_capture.json"
PRIORITY_FIXTURES = [
    "request_security_htf_capture.json",
    "request_security_lower_tf_capture.json",
    "request_security_time_close_capture.json",
    "request_security_metadata_capture.json",
    "request_security_gaps_lookahead_capture.json",
    "request_security_daily_context_capture.json",
    "request_security_session_flags_capture.json",
    "request_security_timezone_capture.json",
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report TradingView capture status for request.security fixtures.",
    )
    parser.add_argument(
        "--golden-dir",
        type=Path,
        default=DEFAULT_GOLDEN_DIR,
        help="Directory containing golden fixture JSON files.",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON.")
    parser.add_argument(
        "--missing-only",
        action="store_true",
        help="Only list fixtures without a captured TradingView export.",
    )
    args = parser.parse_args(argv)

    report = build_report(args.golden_dir)
    if args.missing_only:
        fixtures = [fixture for fixture in report["fixtures"] if fixture["status"] != "captured"]
        report = {**report, "fixtures": fixtures}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_table(report)
    return 0


def build_report(golden_dir: Path) -> dict[str, Any]:
    fixtures: list[dict[str, Any]] = []
    for fixture_path in sorted(golden_dir.glob(REQUEST_FIXTURE_GLOB), key=_fixture_sort_key):
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        capture = fixture.get("external_capture")
        status = "missing" if capture is None else capture["status"]
        series = {} if capture is None else capture.get("series", {})
        fixtures.append(
            {
                "fixture": fixture_path.name,
                "name": fixture.get("name", fixture_path.stem),
                "priority": fixture_path.name in PRIORITY_FIXTURES,
                "provider": None if capture is None else capture["provider"],
                "status": status,
                "assertion": None if capture is None else capture.get("assertion"),
                "captured_plots": sorted(series),
                "plot_count": len(series),
            }
        )

    counts = {
        "total": len(fixtures),
        "captured": sum(fixture["status"] == "captured" for fixture in fixtures),
        "not_captured": sum(fixture["status"] == "not_captured" for fixture in fixtures),
        "missing": sum(fixture["status"] == "missing" for fixture in fixtures),
        "priority_total": sum(fixture["priority"] for fixture in fixtures),
        "priority_captured": sum(
            fixture["priority"] and fixture["status"] == "captured"
            for fixture in fixtures
        ),
    }
    return {"counts": counts, "fixtures": fixtures}


def print_table(report: dict[str, Any]) -> None:
    counts = report["counts"]
    print(
        "Request TradingView capture status: "
        f"{counts['captured']}/{counts['total']} captured, "
        f"{counts['not_captured']} not_captured, {counts['missing']} missing"
    )
    print(
        "Priority captures: "
        f"{counts['priority_captured']}/{counts['priority_total']} captured"
    )
    print()
    print(f"{'status':<13} {'priority':<8} {'fixture':<42} name")
    print("-" * 96)
    for fixture in report["fixtures"]:
        priority = "yes" if fixture["priority"] else "no"
        print(
            f"{fixture['status']:<13} {priority:<8} "
            f"{fixture['fixture']:<42} {fixture['name']}"
        )


def _fixture_sort_key(path: Path) -> tuple[int, str]:
    try:
        priority = PRIORITY_FIXTURES.index(path.name)
    except ValueError:
        priority = len(PRIORITY_FIXTURES)
    return priority, path.name


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
