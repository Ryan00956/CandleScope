"""Import TradingView plot exports into a strategy pine-equivalent fixture."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


IGNORED_CSV_COLUMNS = {
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
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import TradingView exported plot values into a strategy fixture.",
    )
    parser.add_argument("fixture", type=Path, help="Path to a strategy fixture JSON file.")
    parser.add_argument("--case", required=True, help="Fixture case name to update.")
    parser.add_argument("--values", required=True, type=Path, help="Path to exported JSON or CSV.")
    parser.add_argument(
        "--format",
        choices=["auto", "json", "csv"],
        default="auto",
        help="Input format for --values.",
    )
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
    parser.add_argument(
        "--allow-partial-plots",
        action="store_true",
        help="Allow the export to omit plot titles declared by the fixture.",
    )
    parser.add_argument(
        "--allow-length-mismatch",
        action="store_true",
        help="Allow exported plot sequences to differ from the fixture bar count.",
    )
    args = parser.parse_args(argv)

    export = load_export(args.values, args.format)
    values = export["values"]
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    case = find_case(fixture, args.case)
    validate_capture_values(
        case,
        values,
        allow_partial_plots=args.allow_partial_plots,
        allow_length_mismatch=args.allow_length_mismatch,
    )

    case["external_capture"] = {
        "provider": "tradingview",
        "status": "captured",
        "assertion": args.assertion,
        "tolerance": args.tolerance,
        "values": values,
    }
    if export.get("bars"):
        case["external_capture"]["bars"] = export["bars"]
    if args.note:
        case["external_capture"]["notes"] = args.note

    args.fixture.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"updated {args.fixture}::{args.case} with {len(values)} captured plot(s)")
    return 0


def load_values(path: Path, format_name: str) -> dict[str, list[float | None]]:
    return load_export(path, format_name)["values"]


def load_export(path: Path, format_name: str) -> dict[str, Any]:
    resolved_format = detect_format(path, format_name)
    if resolved_format == "json":
        return load_json_export(path)
    if resolved_format == "csv":
        return load_csv_export(path)
    raise ValueError(f"unsupported values format: {resolved_format}")


def detect_format(path: Path, format_name: str) -> str:
    if format_name != "auto":
        return format_name
    suffix = path.suffix.lower()
    if suffix == ".json":
        return "json"
    if suffix == ".csv":
        return "csv"
    raise SystemExit("--format is required when --values is not .json or .csv")


def load_json_values(path: Path) -> dict[str, list[float | None]]:
    return load_json_export(path)["values"]


def load_json_export(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload.get("values", payload) if isinstance(payload, dict) else None
    if not isinstance(values, dict):
        raise SystemExit("JSON export must be an object or contain a values object")
    export: dict[str, Any] = {"values": normalize_values(values)}
    if isinstance(payload, dict) and isinstance(payload.get("bars"), list):
        export["bars"] = normalize_bars(payload["bars"])
    return export


def load_csv_values(path: Path) -> dict[str, list[float | None]]:
    return load_csv_export(path)["values"]


def load_csv_export(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit("CSV export must contain a header row")
        columns = [
            column
            for column in reader.fieldnames
            if column is not None and column.strip().lower() not in IGNORED_CSV_COLUMNS
        ]
        chart_columns = chart_column_map(reader.fieldnames)
        values: dict[str, list[float | None]] = {column: [] for column in columns}
        bars: list[dict[str, Any]] = []
        for row in reader:
            parsed = {column: parse_scalar(row.get(column, "")) for column in columns}
            if columns and all(value is None for value in parsed.values()):
                continue
            for column, value in parsed.items():
                values[column].append(value)
            bar = parse_chart_bar(row, chart_columns)
            if bar is not None:
                bars.append(bar)
    export: dict[str, Any] = {"values": values}
    if bars:
        export["bars"] = bars
    return export


def normalize_values(raw_values: dict[str, Any]) -> dict[str, list[float | None]]:
    values: dict[str, list[float | None]] = {}
    for title, series in raw_values.items():
        if not isinstance(title, str):
            raise SystemExit("plot titles must be strings")
        if not isinstance(series, list):
            raise SystemExit(f"plot {title!r} must be a list")
        values[title] = [parse_scalar(value) for value in series]
    return values


def normalize_bars(raw_bars: list[Any]) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    for item in raw_bars:
        if not isinstance(item, dict):
            raise SystemExit("bars entries must be objects")
        bars.append(
            {
                "time": int(float(item["time"])),
                "open": float(item["open"]),
                "high": float(item["high"]),
                "low": float(item["low"]),
                "close": float(item["close"]),
                "volume": float(item.get("volume", 0.0)),
            }
        )
    return bars


def validate_capture_values(
    case: dict[str, Any],
    values: dict[str, list[float | None]],
    *,
    allow_partial_plots: bool,
    allow_length_mismatch: bool,
) -> None:
    plot_titles = set(case.get("values", {}))
    if not plot_titles:
        raise SystemExit(f"case {case.get('name', '<unknown>')!r} has no fixture values")

    unknown_titles = sorted(set(values) - plot_titles)
    if unknown_titles:
        raise SystemExit(
            "export contains plot title(s) not present in fixture values: "
            + ", ".join(unknown_titles)
        )

    missing_titles = sorted(plot_titles - set(values))
    if missing_titles and not allow_partial_plots:
        raise SystemExit(
            "export missing fixture plot title(s): " + ", ".join(missing_titles)
        )

    if allow_length_mismatch:
        return

    expected_length = expected_capture_length(case)
    mismatches = [
        f"{title}={len(series)}"
        for title, series in values.items()
        if len(series) != expected_length
    ]
    if mismatches:
        raise SystemExit(
            f"export length must match fixture bar count {expected_length}; got "
            + ", ".join(mismatches)
        )


def expected_capture_length(case: dict[str, Any]) -> int:
    bars = case.get("bars")
    if isinstance(bars, list):
        return len(bars)

    value_lengths = {
        len(series)
        for series in case.get("values", {}).values()
        if isinstance(series, list)
    }
    if len(value_lengths) == 1:
        return next(iter(value_lengths))
    raise SystemExit(
        f"case {case.get('name', '<unknown>')!r} has no unambiguous capture length"
    )


def parse_scalar(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    raw = str(value).strip()
    if raw == "" or raw.lower() in {"na", "nan", "null"}:
        return None
    return float(raw)


def chart_column_map(fieldnames: list[str | None]) -> dict[str, str]:
    normalized = {
        field.strip().lower(): field
        for field in fieldnames
        if field is not None and field.strip()
    }
    return {
        key: normalized[key]
        for key in ("time", "open", "high", "low", "close", "volume")
        if key in normalized
    }


def parse_chart_bar(row: dict[str, str], columns: dict[str, str]) -> dict[str, Any] | None:
    required = ("time", "open", "high", "low", "close")
    if any(key not in columns for key in required):
        return None
    try:
        time_value = parse_scalar(row.get(columns["time"], ""))
        open_value = parse_scalar(row.get(columns["open"], ""))
        high_value = parse_scalar(row.get(columns["high"], ""))
        low_value = parse_scalar(row.get(columns["low"], ""))
        close_value = parse_scalar(row.get(columns["close"], ""))
        volume_value = parse_scalar(row.get(columns["volume"], "")) if "volume" in columns else 0.0
    except ValueError:
        return None
    if None in {time_value, open_value, high_value, low_value, close_value}:
        return None
    return {
        "time": int(time_value),
        "open": float(open_value),
        "high": float(high_value),
        "low": float(low_value),
        "close": float(close_value),
        "volume": float(volume_value or 0.0),
    }


def find_case(fixture: dict[str, Any], case_name: str) -> dict[str, Any]:
    for case in fixture.get("cases", []):
        if case.get("name") == case_name:
            return case
    raise SystemExit(f"case not found: {case_name}")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
