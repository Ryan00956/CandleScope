"""Import TradingView plot exports into a request.security golden fixture."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

from request_capture_prepare import CAPTURE_INDEX_TITLE
from strategy_capture_import import parse_scalar


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
PROVIDER_FIELDS = ("time", "open", "high", "low", "close", "volume")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import TradingView exported plot values into a request fixture.",
    )
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--values", required=True, type=Path)
    parser.add_argument("--tolerance", type=float, default=0.0)
    parser.add_argument("--assertion", choices=["reference", "parity"], default="reference")
    parser.add_argument("--note", action="append", default=[])
    args = parser.parse_args(argv)

    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    export = load_csv_capture(args.values, fixture)
    validate_capture_series(fixture, export["series"])

    previous_capture = fixture.get("external_capture", {})
    capture = {
        "provider": "tradingview",
        "status": "captured",
        "assertion": args.assertion,
        "tolerance": args.tolerance,
        "series": export["series"],
        "bars": export["bars"],
        "provider_bars": export["provider_bars"],
    }
    if "provider_bar_plots" in previous_capture:
        capture["provider_bar_plots"] = previous_capture["provider_bar_plots"]
    if "provider_extra_bar_plots" in previous_capture:
        capture["provider_extra_bar_plots"] = previous_capture["provider_extra_bar_plots"]
    if "time_value_plots" in previous_capture:
        capture["time_value_plots"] = previous_capture["time_value_plots"]
    if "provider_close_plots" in previous_capture:
        capture["provider_close_plots"] = previous_capture["provider_close_plots"]
    if "provider_metadata" in previous_capture:
        capture["provider_metadata"] = previous_capture["provider_metadata"]
    if args.note:
        capture["notes"] = args.note
    fixture["external_capture"] = capture

    args.fixture.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"updated {args.fixture} with {len(export['series'])} captured plot(s) "
        f"and {len(export['provider_bars'])} provider bar(s)"
    )
    return 0


def load_csv_capture(path: Path, fixture: dict[str, Any]) -> dict[str, Any]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit("CSV export must contain a header row")
        fieldnames = [field for field in reader.fieldnames if field is not None]
        if CAPTURE_INDEX_TITLE not in fieldnames:
            raise SystemExit(f"CSV export missing capture index column: {CAPTURE_INDEX_TITLE}")
        plot_titles = list(fixture.get("expected_series", {}))
        missing_titles = sorted(set(plot_titles) - set(fieldnames))
        if missing_titles:
            raise SystemExit("CSV export missing plot title(s): " + ", ".join(missing_titles))
        unknown_titles = sorted(
            set(field for field in fieldnames if not is_chart_csv_column(field))
            - set(plot_titles)
            - {CAPTURE_INDEX_TITLE}
        )
        if unknown_titles:
            raise SystemExit(
                "CSV export contains unknown plot title(s): " + ", ".join(unknown_titles)
            )
        rows = [
            row for row in reader
            if (row.get(CAPTURE_INDEX_TITLE, "") or "").strip()
        ]

    expected_length = len(fixture.get("chart_bars", []))
    if len(rows) != expected_length:
        raise SystemExit(
            "capture index row count must match fixture bar count "
            f"{expected_length}; got {len(rows)}"
        )

    bars = [parse_chart_bar(row) for row in rows]
    series: dict[str, list[dict[str, Any]]] = {title: [] for title in plot_titles}
    for row, bar in zip(rows, bars):
        for title in plot_titles:
            value = parse_scalar(row.get(title, ""))
            if value is not None:
                series[title].append({"time": bar["time"], "value": value})
    normalize_provider_time_series(fixture, series)
    provider_bars = build_provider_bars(fixture, series)
    provider_bars = augment_provider_bars_from_extra_series(fixture, series, provider_bars)
    provider_bars = augment_provider_bars_from_close_series(fixture, series, provider_bars, bars)
    return {
        "series": series,
        "bars": bars,
        "provider_bars": provider_bars,
    }


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


def build_provider_bars(
    fixture: dict[str, Any],
    series: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    mapping = fixture.get("external_capture", {}).get("provider_bar_plots", {})
    if isinstance(mapping, list):
        return build_provider_bars_from_slot_plots(fixture, series, mapping)
    if not isinstance(mapping, dict):
        raise SystemExit("request fixture provider_bar_plots must be a mapping or slot list")
    missing_fields = [field for field in PROVIDER_FIELDS if field not in mapping]
    if missing_fields:
        raise SystemExit(
            "request fixture missing provider_bar_plots field(s): "
            + ", ".join(missing_fields)
        )

    by_chart_time = {
        field: {point["time"]: point["value"] for point in series.get(mapping[field], [])}
        for field in PROVIDER_FIELDS
    }
    provider_bars: list[dict[str, Any]] = []
    seen_provider_times: set[int] = set()
    for chart_time in sorted(by_chart_time["time"]):
        provider_time = normalize_provider_time(
            float(by_chart_time["time"][chart_time]),
            chart_time,
        )
        if provider_time in seen_provider_times:
            continue
        missing = [
            field for field in PROVIDER_FIELDS if chart_time not in by_chart_time[field]
        ]
        if missing:
            raise SystemExit(
                "provider bar plot values missing field(s) at chart time "
                f"{chart_time}: " + ", ".join(missing)
            )
        seen_provider_times.add(provider_time)
        provider_bars.append(
            {
                "time": provider_time,
                "open": float(by_chart_time["open"][chart_time]),
                "high": float(by_chart_time["high"][chart_time]),
                "low": float(by_chart_time["low"][chart_time]),
                "close": float(by_chart_time["close"][chart_time]),
                "volume": float(by_chart_time["volume"][chart_time]),
            }
        )
    return provider_bars


def build_provider_bars_from_slot_plots(
    fixture: dict[str, Any],
    series: dict[str, list[dict[str, Any]]],
    slot_mappings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    bars_by_time: dict[int, dict[str, Any]] = {}
    for slot_index, mapping in enumerate(slot_mappings):
        if not isinstance(mapping, dict):
            raise SystemExit("request fixture provider_bar_plots slot entries must be mappings")
        missing_fields = [field for field in PROVIDER_FIELDS if field not in mapping]
        if missing_fields:
            raise SystemExit(
                "request fixture missing provider_bar_plots field(s) for slot "
                f"{slot_index}: " + ", ".join(missing_fields)
            )
        by_chart_time = {
            field: {point["time"]: point["value"] for point in series.get(mapping[field], [])}
            for field in PROVIDER_FIELDS
        }
        for chart_time in sorted(by_chart_time["time"]):
            if chart_time not in by_chart_time["time"]:
                continue
            missing = [
                field for field in PROVIDER_FIELDS if chart_time not in by_chart_time[field]
            ]
            if missing:
                raise SystemExit(
                    "provider bar slot plot values missing field(s) at chart time "
                    f"{chart_time} slot {slot_index}: " + ", ".join(missing)
                )
            provider_time = normalize_provider_time(
                float(by_chart_time["time"][chart_time]),
                chart_time,
            )
            bars_by_time.setdefault(
                provider_time,
                {
                    "time": provider_time,
                    "open": float(by_chart_time["open"][chart_time]),
                    "high": float(by_chart_time["high"][chart_time]),
                    "low": float(by_chart_time["low"][chart_time]),
                    "close": float(by_chart_time["close"][chart_time]),
                    "volume": float(by_chart_time["volume"][chart_time]),
                },
            )
    return [bars_by_time[time] for time in sorted(bars_by_time)]


def augment_provider_bars_from_extra_series(
    fixture: dict[str, Any],
    series: dict[str, list[dict[str, Any]]],
    provider_bars: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    extra_plots = fixture.get("external_capture", {}).get("provider_extra_bar_plots", {})
    if not extra_plots:
        return provider_bars
    if not isinstance(extra_plots, dict):
        raise SystemExit("request fixture provider_extra_bar_plots must be a mapping")
    provider_mapping = fixture.get("external_capture", {}).get("provider_bar_plots", {})
    if not isinstance(provider_mapping, dict) or "time" not in provider_mapping:
        raise SystemExit(
            "request fixture provider_extra_bar_plots requires mapping provider_bar_plots"
        )

    time_title = provider_mapping["time"]
    if time_title not in series:
        return provider_bars
    chart_to_provider_time = {
        point["time"]: normalize_provider_time(float(point["value"]), int(point["time"]))
        for point in series[time_title]
    }
    bars_by_time = {bar["time"]: dict(bar) for bar in provider_bars}
    for field, title in extra_plots.items():
        if title not in series:
            continue
        for point in series[title]:
            provider_time = chart_to_provider_time.get(point["time"])
            if provider_time is None or provider_time not in bars_by_time:
                continue
            bars_by_time[provider_time][field] = normalize_provider_extra_value(
                str(field),
                point["value"],
            )
    return [bars_by_time[time] for time in sorted(bars_by_time)]


def normalize_provider_extra_value(field: str, value: Any) -> Any:
    if field.startswith("session_") or field in {"ismarket", "isfirstbar", "islastbar"}:
        if isinstance(value, (int, float)):
            return bool(value)
        return bool(value)
    return value


def normalize_provider_time_series(
    fixture: dict[str, Any],
    series: dict[str, list[dict[str, Any]]],
) -> None:
    capture = fixture.get("external_capture", {})
    mapping = capture.get("provider_bar_plots", {})
    if isinstance(mapping, list):
        titles = [
            slot.get("time")
            for slot in mapping
            if isinstance(slot, dict) and slot.get("time")
        ]
    elif isinstance(mapping, dict):
        titles = [mapping.get("time")]
    else:
        titles = []
    time_value_plots = capture.get("time_value_plots", [])
    if isinstance(time_value_plots, str):
        titles.append(time_value_plots)
    elif isinstance(time_value_plots, list):
        titles.extend(title for title in time_value_plots if isinstance(title, str))
    elif time_value_plots:
        raise SystemExit("request fixture time_value_plots must be a string or list")
    chart_times = fixture.get("chart_bars", [])
    chart_time = int(chart_times[0]["time"]) if chart_times else 0
    for title in dict.fromkeys(title for title in titles if title):
        if title not in series:
            continue
        for point in series[title]:
            point["value"] = normalize_provider_time(float(point["value"]), chart_time)


def normalize_provider_time(raw_provider_time: float, chart_time: int) -> int:
    provider_time = int(raw_provider_time)
    if abs(provider_time) >= 100_000_000_000 and abs(chart_time) < 100_000_000_000:
        return int(provider_time / 1000)
    return provider_time


def augment_provider_bars_from_close_series(
    fixture: dict[str, Any],
    series: dict[str, list[dict[str, Any]]],
    provider_bars: list[dict[str, Any]],
    chart_bars: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    close_plots = fixture.get("external_capture", {}).get("provider_close_plots")
    if not close_plots or len(provider_bars) < 2 or len(chart_bars) < 2:
        return provider_bars

    interval = provider_bars[1]["time"] - provider_bars[0]["time"]
    chart_step = chart_bars[1]["time"] - chart_bars[0]["time"]
    if interval <= 0 or chart_step <= 0:
        return provider_bars

    bars_by_time = {bar["time"]: dict(bar) for bar in provider_bars}
    first_provider_time = provider_bars[0]["time"]
    last_provider_time = provider_bars[-1]["time"]
    first_confirmation_time = first_provider_time + interval - chart_step
    known_closes = {bar["close"] for bar in provider_bars}

    current_title = close_plots.get("current")
    if current_title in series:
        previous_points = [
            point for point in series[current_title]
            if point["time"] < first_confirmation_time
        ]
        if previous_points:
            _add_close_only_provider_bar(
                bars_by_time,
                first_provider_time - interval,
                previous_points[-1]["value"],
            )

    previous_title = close_plots.get("previous")
    if previous_title in series:
        previous_previous_points = [
            point for point in series[previous_title]
            if point["time"] < first_confirmation_time
        ]
        if previous_previous_points:
            _add_close_only_provider_bar(
                bars_by_time,
                first_provider_time - 2 * interval,
                previous_previous_points[0]["value"],
            )

    lookahead_title = close_plots.get("lookahead")
    if lookahead_title in series:
        for point in reversed(series[lookahead_title]):
            if point["value"] not in known_closes:
                _add_close_only_provider_bar(
                    bars_by_time,
                    last_provider_time + interval,
                    point["value"],
                )
                break

    return [bars_by_time[time] for time in sorted(bars_by_time)]


def _add_close_only_provider_bar(
    bars_by_time: dict[int, dict[str, Any]],
    time: int,
    close: Any,
) -> None:
    bars_by_time.setdefault(
        time,
        {
            "time": time,
            "open": None,
            "high": None,
            "low": None,
            "close": float(close),
            "volume": None,
        },
    )


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
