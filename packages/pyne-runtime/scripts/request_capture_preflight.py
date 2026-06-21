"""Preflight TradingView CSV exports before importing request captures."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


CHART_CSV_COLUMNS = {
    "",
    "time",
    "timestamp",
    "date",
    "datetime",
    "bar_index",
    "bar index",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "Volume",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate TradingView CSV exports against a request capture manifest.",
    )
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--export-dir", type=Path, default=None)
    parser.add_argument("--fixture", action="append", default=[])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    export_dir = args.export_dir if args.export_dir is not None else args.manifest.parent
    report = build_report(
        manifest=manifest,
        export_dir=export_dir,
        fixture_filter=set(args.fixture),
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_table(report)
    return 1 if report["counts"]["issues"] else 0


def build_report(
    *,
    manifest: dict[str, Any],
    export_dir: Path,
    fixture_filter: set[str],
) -> dict[str, Any]:
    fixtures: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for entry in manifest.get("entries", []):
        if fixture_filter and entry["fixture"] not in fixture_filter:
            continue
        fixture_report = check_entry(entry, export_dir)
        fixtures.append(fixture_report)
        issues.extend(fixture_report["issues"])
    return {
        "counts": {
            "fixtures": len(fixtures),
            "ok": sum(not fixture["issues"] for fixture in fixtures),
            "issues": len(issues),
        },
        "fixtures": fixtures,
        "issues": issues,
    }


def check_entry(entry: dict[str, Any], export_dir: Path) -> dict[str, Any]:
    fixture_report: dict[str, Any] = {
        "fixture": entry["fixture"],
        "export_file": entry["expected_export_file"],
        "bar_count": entry["bar_count"],
        "plot_titles": entry["plot_titles"],
        "issues": [],
    }
    export_path = export_dir / entry["expected_export_file"]
    if not export_path.exists():
        add_issue(fixture_report, "missing_export", f"missing export file: {export_path}")
        return fixture_report

    export = read_csv(export_path)
    capture_index_title = entry["capture_index_title"]
    expected_plots = set(entry["plot_titles"])
    allowed_plots = expected_plots | {capture_index_title}
    plot_columns = [
        column
        for column in export["fieldnames"]
        if not is_chart_csv_column(column)
    ]
    missing_plots = sorted(expected_plots - set(plot_columns))
    unknown_plots = sorted(set(plot_columns) - allowed_plots)
    if capture_index_title not in plot_columns:
        add_issue(
            fixture_report,
            "missing_capture_index",
            f"missing capture index plot column: {capture_index_title}",
        )
    if missing_plots:
        add_issue(fixture_report, "missing_plot", "missing plot column(s): " + ", ".join(missing_plots))
    if unknown_plots:
        add_issue(fixture_report, "unknown_plot", "unknown plot column(s): " + ", ".join(unknown_plots))

    active_rows = [
        row for row in export["rows"]
        if (row.get(capture_index_title, "") or "").strip()
    ]
    if len(active_rows) != entry["bar_count"]:
        add_issue(
            fixture_report,
            "row_count",
            f"capture index row count {len(active_rows)} does not match expected bar count {entry['bar_count']}",
        )
    return fixture_report


def read_csv(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit(f"{path}: CSV export must contain a header row")
        return {
            "fieldnames": [field for field in reader.fieldnames if field is not None],
            "rows": list(reader),
        }


def is_chart_csv_column(column: str) -> bool:
    return column.strip() in CHART_CSV_COLUMNS


def add_issue(fixture_report: dict[str, Any], kind: str, message: str) -> None:
    fixture_report["issues"].append(
        {
            "fixture": fixture_report["fixture"],
            "kind": kind,
            "message": message,
        }
    )


def print_table(report: dict[str, Any]) -> None:
    counts = report["counts"]
    print(
        "Request TradingView capture preflight: "
        f"{counts['ok']}/{counts['fixtures']} ok, {counts['issues']} issue(s)"
    )
    if not report["issues"]:
        return
    print()
    print(f"{'fixture':<42} {'kind':<22} message")
    print("-" * 118)
    for issue in report["issues"]:
        print(f"{issue['fixture']:<42} {issue['kind']:<22} {issue['message']}")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
