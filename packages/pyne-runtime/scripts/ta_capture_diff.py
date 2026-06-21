"""Compare captured TradingView plot series with current Pyne TA output."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import pyne_runtime as pn


DEFAULT_GOLDEN_DIR = Path("tests") / "golden"
TA_FIXTURE_GLOB = "ta_*_indicators.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Diff captured TradingView plot series against Pyne TA output.",
    )
    parser.add_argument(
        "fixtures",
        nargs="*",
        type=Path,
        help="Fixture JSON files to inspect. Defaults to all TA golden fixtures.",
    )
    parser.add_argument(
        "--golden-dir",
        type=Path,
        default=DEFAULT_GOLDEN_DIR,
        help="Directory containing golden fixture JSON files.",
    )
    parser.add_argument(
        "--fixture",
        action="append",
        default=[],
        help="Only inspect a named fixture file. May be repeated.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON instead of a table.",
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Print grouped difference counts instead of point-level rows.",
    )
    parser.add_argument(
        "--assertion",
        choices=["parity", "reference", "all"],
        default="parity",
        help=(
            "Which captured assertion mode to inspect. Defaults to parity so "
            "quality gates do not fail on newly imported reference evidence."
        ),
    )
    args = parser.parse_args(argv)

    fixture_paths = args.fixtures or sorted(args.golden_dir.glob(TA_FIXTURE_GLOB))
    report = build_report(fixture_paths, set(args.fixture), args.assertion)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif args.summary:
        print_summary(report)
    else:
        print_table(report)

    for error in report["fixture_filter_errors"]:
        if error["reason"] == "not_found":
            print(
                f"Fixture filter error: no fixture named {error['fixture']!r}",
                file=sys.stderr,
            )
        else:
            print(
                "Fixture filter error: "
                f"no captured {args.assertion!r} fixture inspected for {error['fixture']!r}",
                file=sys.stderr,
            )

    counts = report["counts"]
    return (
        1
        if counts["differences"]
        or counts["runtime_errors"]
        or report["fixture_filter_errors"]
        else 0
    )


def build_report(
    fixture_paths: list[Path],
    fixture_filter: set[str],
    assertion_filter: str,
) -> dict[str, Any]:
    fixtures: list[dict[str, Any]] = []
    differences: list[dict[str, Any]] = []
    matched_fixture_names: set[str] = set()
    inspected_fixture_names: set[str] = set()
    runtime_errors = 0
    plot_count = 0
    point_count = 0
    skipped = 0

    for fixture_path in fixture_paths:
        if fixture_filter and fixture_path.name not in fixture_filter:
            continue
        if fixture_filter:
            matched_fixture_names.add(fixture_path.name)
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        capture = fixture.get("external_capture")
        if capture is None or capture.get("status") != "captured":
            skipped += 1
            continue

        assertion = capture.get("assertion", "parity")
        if assertion_filter != "all" and assertion != assertion_filter:
            skipped += 1
            continue

        fixture_report = diff_fixture(fixture_path, fixture, capture)
        fixture_report["assertion"] = assertion
        fixtures.append(fixture_report)
        inspected_fixture_names.add(fixture_path.name)
        plot_count += fixture_report["plot_count"]
        point_count += fixture_report["point_count"]
        differences.extend(fixture_report["differences"])
        if fixture_report["runtime_error"] is not None:
            runtime_errors += 1

    fixture_filter_errors = build_fixture_filter_errors(
        fixture_filter,
        matched_fixture_names,
        inspected_fixture_names,
    )

    return {
        "counts": {
            "captured_fixtures": len(fixtures),
            "skipped_fixtures": skipped,
            "plots": plot_count,
            "points": point_count,
            "differences": len(differences),
            "runtime_errors": runtime_errors,
        },
        "fixtures": fixtures,
        "differences": differences,
        "summary": build_summary(fixtures, differences),
        "fixture_filter_errors": fixture_filter_errors,
    }


def build_fixture_filter_errors(
    fixture_filter: set[str],
    matched_fixture_names: set[str],
    inspected_fixture_names: set[str],
) -> list[dict[str, str]]:
    if not fixture_filter:
        return []

    errors: list[dict[str, str]] = []
    for fixture_name in sorted(fixture_filter - matched_fixture_names):
        errors.append({"fixture": fixture_name, "reason": "not_found"})
    for fixture_name in sorted(matched_fixture_names - inspected_fixture_names):
        errors.append({"fixture": fixture_name, "reason": "not_inspected"})
    return errors


def build_summary(
    fixtures: list[dict[str, Any]],
    differences: list[dict[str, Any]],
) -> dict[str, Any]:
    fixture_rows: list[dict[str, Any]] = []
    plot_counts: dict[str, int] = {}

    for fixture in fixtures:
        plot_counts_for_fixture: dict[str, int] = {}
        for row in fixture["differences"]:
            plot = row.get("plot")
            if plot is None:
                continue
            plot_counts_for_fixture[plot] = plot_counts_for_fixture.get(plot, 0) + 1

        fixture_rows.append(
            {
                "fixture": fixture["fixture"],
                "differences": fixture["difference_count"],
                "runtime_error": fixture["runtime_error"] is not None,
                "plots": [
                    {"plot": plot, "differences": count}
                    for plot, count in sorted(plot_counts_for_fixture.items())
                ],
            }
        )

    for row in differences:
        plot = row.get("plot")
        if plot is None:
            continue
        plot_counts[plot] = plot_counts.get(plot, 0) + 1

    return {
        "fixtures": fixture_rows,
        "plots": [
            {"plot": plot, "differences": count}
            for plot, count in sorted(plot_counts.items())
        ],
    }


def diff_fixture(
    fixture_path: Path,
    fixture: dict[str, Any],
    capture: dict[str, Any],
) -> dict[str, Any]:
    fixture_report: dict[str, Any] = {
        "fixture": fixture_path.name,
        "tolerance": capture.get("tolerance", 0.0),
        "plot_count": len(capture.get("series", {})),
        "point_count": 0,
        "difference_count": 0,
        "runtime_error": None,
        "differences": [],
    }

    bars = capture.get("bars") or fixture["chart_bars"]
    result = pn.run(fixture["script"], bars, executor_mode="inline")
    if not result.ok:
        fixture_report["runtime_error"] = result.error
        fixture_report["difference_count"] = 1
        fixture_report["differences"] = [
            {
                "fixture": fixture_path.name,
                "kind": "runtime_error",
                "error": result.error,
            }
        ]
        return fixture_report

    default_tolerance = float(capture.get("tolerance", 0.0))
    plot_tolerances = capture.get("plot_tolerances", {})
    for title, expected_points in capture.get("series", {}).items():
        tolerance = float(plot_tolerances.get(title, default_tolerance))
        actual_points = result.get_series(title)
        point_count = max(len(expected_points), len(actual_points))
        fixture_report["point_count"] += point_count
        for index in range(point_count):
            expected = expected_points[index] if index < len(expected_points) else None
            actual = actual_points[index] if index < len(actual_points) else None
            difference = compare_point(
                fixture_path.name,
                title,
                index,
                expected,
                actual,
                tolerance,
            )
            if difference is not None:
                fixture_report["differences"].append(difference)

    fixture_report["difference_count"] = len(fixture_report["differences"])
    return fixture_report


def compare_point(
    fixture: str,
    title: str,
    index: int,
    expected: Any,
    actual: Any,
    tolerance: float,
) -> dict[str, Any] | None:
    if expected is None or actual is None:
        if expected is actual:
            return None
        return diff_row(fixture, title, index, expected, actual, None, tolerance)

    if expected.get("time") != actual.get("time"):
        return diff_row(fixture, title, index, expected, actual, None, tolerance)

    expected_value = expected.get("value")
    actual_value = actual.get("value")
    if expected_value is None or actual_value is None:
        if expected_value is actual_value:
            return None
        return diff_row(fixture, title, index, expected, actual, None, tolerance)

    try:
        delta = float(actual_value) - float(expected_value)
    except (TypeError, ValueError):
        if actual_value == expected_value:
            return None
        return diff_row(fixture, title, index, expected, actual, None, tolerance)

    if abs(delta) <= tolerance:
        return None
    return diff_row(fixture, title, index, expected, actual, delta, tolerance)


def diff_row(
    fixture: str,
    title: str,
    index: int,
    expected: Any,
    actual: Any,
    delta: float | None,
    tolerance: float,
) -> dict[str, Any]:
    return {
        "fixture": fixture,
        "kind": "value_mismatch",
        "plot": title,
        "point_index": index,
        "tradingview": expected,
        "pyne": actual,
        "delta": delta,
        "tolerance": tolerance,
    }


def print_table(report: dict[str, Any]) -> None:
    print_header(report)
    if not report["differences"]:
        return

    print()
    print(f"{'fixture':<36} {'plot':<30} {'idx':>5} {'tv':>18} {'pyne':>18} {'delta':>14}")
    print("-" * 130)
    for row in report["differences"]:
        if row["kind"] == "runtime_error":
            print(f"{row['fixture']:<36} runtime error: {row['error']}")
            continue
        print(
            f"{row['fixture']:<36} "
            f"{row['plot']:<30} "
            f"{row['point_index']:>5} "
            f"{format_point(row['tradingview']):>18} "
            f"{format_point(row['pyne']):>18} "
            f"{format_value(row['delta']):>14}"
        )


def print_summary(report: dict[str, Any]) -> None:
    print_header(report)
    if not report["differences"]:
        return

    summary = report["summary"]
    print()
    print("Differences by fixture:")
    print(f"{'fixture':<36} {'diffs':>6} {'runtime':>8}")
    print("-" * 56)
    for row in summary["fixtures"]:
        if row["differences"] == 0 and not row["runtime_error"]:
            continue
        print(
            f"{row['fixture']:<36} "
            f"{row['differences']:>6} "
            f"{str(row['runtime_error']):>8}"
        )

    print()
    print("Differences by plot:")
    print(f"{'plot':<30} {'diffs':>6}")
    print("-" * 38)
    for row in summary["plots"]:
        print(f"{row['plot']:<30} {row['differences']:>6}")


def print_header(report: dict[str, Any]) -> None:
    counts = report["counts"]
    print(
        "TA TradingView capture diff: "
        f"{counts['captured_fixtures']} captured fixture(s), "
        f"{counts['plots']} plot(s), {counts['points']} point(s), "
        f"{counts['differences']} difference(s), "
        f"{counts['runtime_errors']} runtime error(s), "
        f"{counts['skipped_fixtures']} skipped"
    )


def format_point(point: Any) -> str:
    if point is None:
        return "None"
    if isinstance(point, dict):
        return f"{point.get('time')}:{format_value(point.get('value'))}"
    return str(point)


def format_value(value: Any) -> str:
    if value is None:
        return "None"
    if isinstance(value, float):
        return f"{value:.12g}"
    return str(value)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
