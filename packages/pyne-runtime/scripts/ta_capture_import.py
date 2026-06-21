"""Import TradingView plot exports into a TA golden fixture."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

from strategy_capture_import import parse_scalar
from ta_capture_prepare import CAPTURE_INDEX_TITLE


CHART_CSV_COLUMNS = {"", "time", "timestamp", "date", "datetime", "bar_index", "bar index", "open", "high", "low", "close", "volume", "Volume"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import TradingView exported plot values into a TA fixture.",
    )
    parser.add_argument("fixture", type=Path, help="Path to a TA fixture JSON file.")
    parser.add_argument("--values", required=True, type=Path, help="Path to exported CSV.")
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.0,
        help="Absolute tolerance used by the golden test.",
    )
    parser.add_argument(
        "--assertion",
        choices=["reference", "parity"],
        default="reference",
        help=(
            "How tests should treat this capture. 'reference' stores TradingView evidence "
            "without failing golden tests on known differences; 'parity' asserts it matches Pyne."
        ),
    )
    parser.add_argument(
        "--note",
        action="append",
        default=[],
        help="Optional capture note. May be repeated.",
    )
    args = parser.parse_args(argv)

    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    export = load_csv_capture(args.values, fixture)
    validate_capture_series(fixture, export["series"])

    fixture["external_capture"] = {
        "provider": "tradingview",
        "status": "captured",
        "assertion": args.assertion,
        "tolerance": args.tolerance,
        "series": export["series"],
        "bars": export["bars"],
    }
    if args.note:
        fixture["external_capture"]["notes"] = args.note

    args.fixture.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"updated {args.fixture} with {len(export['series'])} captured plot(s)")
    return 0


def load_csv_capture(path: Path, fixture: dict[str, Any]) -> dict[str, Any]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit("CSV export must contain a header row")
        fieldnames = [field for field in reader.fieldnames if field is not None]
        capture_index_title = CAPTURE_INDEX_TITLE
        if capture_index_title not in fieldnames:
            raise SystemExit(f"CSV export missing capture index column: {capture_index_title}")
        plot_titles = list(fixture.get("expected_series", {}))
        missing_titles = sorted(set(plot_titles) - set(fieldnames))
        if missing_titles:
            raise SystemExit("CSV export missing plot title(s): " + ", ".join(missing_titles))
        unknown_titles = sorted(
            set(
                field
                for field in fieldnames
                if not is_chart_csv_column(field)
            )
            - set(plot_titles)
            - {capture_index_title}
        )
        if unknown_titles:
            raise SystemExit("CSV export contains unknown plot title(s): " + ", ".join(unknown_titles))

        rows = [
            row for row in reader
            if (row.get(capture_index_title, "") or "").strip()
        ]

    expected_length = len(fixture.get("chart_bars", []))
    if len(rows) != expected_length:
        raise SystemExit(
            f"capture index row count must match fixture bar count {expected_length}; "
            f"got {len(rows)}"
        )

    bars = [parse_chart_bar(row) for row in rows]
    series: dict[str, list[dict[str, Any]]] = {title: [] for title in plot_titles}
    for row, bar in zip(rows, bars):
        for title in plot_titles:
            value = parse_scalar(row.get(title, ""))
            if value is not None:
                series[title].append({"time": bar["time"], "value": value})
    return {"series": series, "bars": bars}


def parse_chart_bar(row: dict[str, str]) -> dict[str, Any]:
    required = ["time", "open", "high", "low", "close"]
    missing = [field for field in required if not (row.get(field, "") or "").strip()]
    if missing:
        raise SystemExit("CSV export missing chart column(s): " + ", ".join(missing))
    return {
        "time": int(float(row["time"])),
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
        "volume": float(row.get("Volume") or row.get("volume") or 0.0),
    }


def validate_capture_series(
    fixture: dict[str, Any],
    series: dict[str, list[dict[str, Any]]],
) -> None:
    expected_titles = set(fixture.get("expected_series", {}))
    unknown_titles = sorted(set(series) - expected_titles)
    if unknown_titles:
        raise SystemExit(
            "capture contains plot title(s) not present in expected_series: "
            + ", ".join(unknown_titles)
        )
    missing_titles = sorted(expected_titles - set(series))
    if missing_titles:
        raise SystemExit("capture missing plot title(s): " + ", ".join(missing_titles))


def is_chart_csv_column(column: str) -> bool:
    return column.strip() in CHART_CSV_COLUMNS


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
