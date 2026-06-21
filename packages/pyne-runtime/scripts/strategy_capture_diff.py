"""Compare captured TradingView plot values with current Pyne strategy output."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import pyne_runtime as pn


DEFAULT_GOLDEN_DIR = Path("tests") / "golden"
STRATEGY_FIXTURE_GLOB = "strategy_pine_equivalent*.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Diff captured TradingView plot values against Pyne output.",
    )
    parser.add_argument(
        "fixtures",
        nargs="*",
        type=Path,
        help="Fixture JSON files to inspect. Defaults to all strategy pine-equivalent fixtures.",
    )
    parser.add_argument(
        "--golden-dir",
        type=Path,
        default=DEFAULT_GOLDEN_DIR,
        help="Directory containing golden fixture JSON files.",
    )
    parser.add_argument(
        "--case",
        action="append",
        default=[],
        help="Only inspect a named case. May be repeated.",
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

    fixture_paths = args.fixtures or sorted(args.golden_dir.glob(STRATEGY_FIXTURE_GLOB))
    report = build_report(fixture_paths, set(args.case), args.assertion)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif args.summary:
        print_summary(report)
    else:
        print_table(report)

    for error in report["case_filter_errors"]:
        if error["reason"] == "not_found":
            print(
                f"Case filter error: no fixture case named {error['case']!r}",
                file=sys.stderr,
            )
        else:
            print(
                "Case filter error: "
                f"no captured {args.assertion!r} case inspected for {error['case']!r}",
                file=sys.stderr,
            )

    counts = report["counts"]
    return (
        1
        if counts["differences"]
        or counts["runtime_errors"]
        or report["case_filter_errors"]
        else 0
    )


def build_report(
    fixture_paths: list[Path],
    case_filter: set[str],
    assertion_filter: str,
) -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    differences: list[dict[str, Any]] = []
    matched_case_names: set[str] = set()
    inspected_case_names: set[str] = set()
    runtime_errors = 0
    plot_count = 0
    point_count = 0
    skipped = 0

    for fixture_path in fixture_paths:
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        for case in fixture.get("cases", []):
            case_name = case.get("name")
            if case_filter and case_name not in case_filter:
                continue
            if case_filter:
                matched_case_names.add(case_name)

            capture = case.get("external_capture")
            if capture is None or capture.get("status") != "captured":
                skipped += 1
                continue

            assertion = capture.get("assertion", "parity")
            if assertion_filter != "all" and assertion != assertion_filter:
                skipped += 1
                continue

            case_report = diff_case(fixture_path, case, capture)
            case_report["assertion"] = assertion
            cases.append(case_report)
            inspected_case_names.add(case_name)
            plot_count += case_report["plot_count"]
            point_count += case_report["point_count"]
            differences.extend(case_report["differences"])
            if case_report["runtime_error"] is not None:
                runtime_errors += 1

    case_filter_errors = build_case_filter_errors(
        case_filter,
        matched_case_names,
        inspected_case_names,
    )

    return {
        "counts": {
            "captured_cases": len(cases),
            "skipped_cases": skipped,
            "plots": plot_count,
            "points": point_count,
            "differences": len(differences),
            "runtime_errors": runtime_errors,
        },
        "cases": cases,
        "differences": differences,
        "summary": build_summary(cases, differences),
        "case_filter_errors": case_filter_errors,
    }


def build_case_filter_errors(
    case_filter: set[str],
    matched_case_names: set[str],
    inspected_case_names: set[str],
) -> list[dict[str, str]]:
    if not case_filter:
        return []

    errors: list[dict[str, str]] = []
    for case_name in sorted(case_filter - matched_case_names):
        errors.append({"case": case_name, "reason": "not_found"})
    for case_name in sorted(matched_case_names - inspected_case_names):
        errors.append({"case": case_name, "reason": "not_inspected"})
    return errors


def build_summary(
    cases: list[dict[str, Any]],
    differences: list[dict[str, Any]],
) -> dict[str, Any]:
    case_rows: list[dict[str, Any]] = []
    plot_counts: dict[str, int] = {}

    for case in cases:
        plot_counts_for_case: dict[str, int] = {}
        for row in case["differences"]:
            plot = row.get("plot")
            if plot is None:
                continue
            plot_counts_for_case[plot] = plot_counts_for_case.get(plot, 0) + 1

        case_rows.append(
            {
                "fixture": case["fixture"],
                "case": case["case"],
                "differences": case["difference_count"],
                "runtime_error": case["runtime_error"] is not None,
                "plots": [
                    {"plot": plot, "differences": count}
                    for plot, count in sorted(plot_counts_for_case.items())
                ],
            }
        )

    for row in differences:
        plot = row.get("plot")
        if plot is None:
            continue
        plot_counts[plot] = plot_counts.get(plot, 0) + 1

    return {
        "cases": case_rows,
        "plots": [
            {"plot": plot, "differences": count}
            for plot, count in sorted(plot_counts.items())
        ],
    }


def diff_case(
    fixture_path: Path,
    case: dict[str, Any],
    capture: dict[str, Any],
) -> dict[str, Any]:
    case_report: dict[str, Any] = {
        "fixture": fixture_path.name,
        "case": case["name"],
        "tolerance": capture.get("tolerance", 0.0),
        "plot_count": len(capture.get("values", {})),
        "point_count": 0,
        "difference_count": 0,
        "runtime_error": None,
        "differences": [],
    }

    bars = capture.get("bars") or case["bars"]
    result = pn.run(case["script"], bars, executor_mode="inline")
    if not result.ok:
        case_report["runtime_error"] = result.error
        case_report["difference_count"] = 1
        case_report["differences"] = [
            {
                "fixture": fixture_path.name,
                "case": case["name"],
                "kind": "runtime_error",
                "error": result.error,
            }
        ]
        return case_report

    tolerance = float(capture.get("tolerance", 0.0))
    for title, expected_values in capture.get("values", {}).items():
        actual_values = result.values(title)
        point_count = max(len(expected_values), len(actual_values))
        case_report["point_count"] += point_count
        for index in range(point_count):
            expected = expected_values[index] if index < len(expected_values) else None
            actual = actual_values[index] if index < len(actual_values) else None
            difference = compare_point(
                fixture_path.name,
                case["name"],
                title,
                index,
                expected,
                actual,
                tolerance,
            )
            if difference is not None:
                case_report["differences"].append(difference)

    case_report["difference_count"] = len(case_report["differences"])
    return case_report


def compare_point(
    fixture: str,
    case_name: str,
    title: str,
    index: int,
    expected: Any,
    actual: Any,
    tolerance: float,
) -> dict[str, Any] | None:
    if expected is None or actual is None:
        if expected is actual:
            return None
        return diff_row(fixture, case_name, title, index, expected, actual, None, tolerance)

    try:
        delta = float(actual) - float(expected)
    except (TypeError, ValueError):
        if actual == expected:
            return None
        return diff_row(fixture, case_name, title, index, expected, actual, None, tolerance)

    if abs(delta) <= tolerance:
        return None
    return diff_row(fixture, case_name, title, index, expected, actual, delta, tolerance)


def diff_row(
    fixture: str,
    case_name: str,
    title: str,
    index: int,
    expected: Any,
    actual: Any,
    delta: float | None,
    tolerance: float,
) -> dict[str, Any]:
    return {
        "fixture": fixture,
        "case": case_name,
        "kind": "value_mismatch",
        "plot": title,
        "bar_index": index,
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
    print(
        f"{'fixture':<48} {'case':<44} {'plot':<18} "
        f"{'bar':>5} {'tv':>14} {'pyne':>14} {'delta':>14}"
    )
    print("-" * 165)
    for row in report["differences"]:
        if row["kind"] == "runtime_error":
            print(f"{row['fixture']:<48} {row['case']:<44} runtime error: {row['error']}")
            continue
        print(
            f"{row['fixture']:<48} "
            f"{row['case']:<44} "
            f"{row['plot']:<18} "
            f"{row['bar_index']:>5} "
            f"{format_value(row['tradingview']):>14} "
            f"{format_value(row['pyne']):>14} "
            f"{format_value(row['delta']):>14}"
        )


def print_summary(report: dict[str, Any]) -> None:
    print_header(report)
    if not report["differences"]:
        return

    summary = report["summary"]
    print()
    print("Differences by case:")
    print(f"{'fixture':<48} {'case':<44} {'diffs':>6} {'runtime':>8}")
    print("-" * 110)
    for row in summary["cases"]:
        if row["differences"] == 0 and not row["runtime_error"]:
            continue
        print(
            f"{row['fixture']:<48} "
            f"{row['case']:<44} "
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
        "Strategy TradingView capture diff: "
        f"{counts['captured_cases']} captured case(s), "
        f"{counts['plots']} plot(s), {counts['points']} point(s), "
        f"{counts['differences']} difference(s), "
        f"{counts['runtime_errors']} runtime error(s), "
        f"{counts['skipped_cases']} skipped"
    )


def format_value(value: Any) -> str:
    if value is None:
        return "None"
    if isinstance(value, float):
        return f"{value:.12g}"
    return str(value)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
