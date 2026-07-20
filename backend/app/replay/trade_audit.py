"""Exact aggregate-trade archive audit with bounded page reads."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    RawAggTradeCursor,
)


def inclusive_date_bounds(start: date, end: date) -> tuple[int, int]:
    if start > end:
        raise ValueError("start date cannot exceed end date")
    start_ms = int(
        datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp()
        * 1000
    )
    end_ms = int(
        datetime.combine(
            end + timedelta(days=1),
            datetime.min.time(),
            tzinfo=timezone.utc,
        ).timestamp()
        * 1000
    ) - 1
    return start_ms, end_ms


def _daily_coverage_template(
    start: date,
    end: date,
    *,
    complete: bool,
) -> dict[str, dict[str, object]]:
    daily: dict[str, dict[str, object]] = {}
    current = start
    while current <= end:
        day_key = current.isoformat()
        daily[day_key] = {
            "date": day_key,
            "row_count": 0,
            "first_agg_trade_id": None,
            "last_agg_trade_id": None,
            "first_trade_time_ms": None,
            "last_trade_time_ms": None,
            "gap_count": 0,
            "duplicate_count": 0,
            "complete": complete,
        }
        current += timedelta(days=1)
    return daily


def _failed_freeze_report(
    archive: ParquetRawAggTradeArchive,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    start: date,
    end: date,
    start_ms: int,
    end_ms: int,
    page_rows: int,
    error: Exception,
) -> dict[str, object]:
    """Return a bounded diagnostic report without claiming an exact release."""

    coverage = archive.coverage(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        start_time_ms=start_ms,
        end_time_ms=end_ms,
    )
    daily = _daily_coverage_template(start, end, complete=False)
    cursor: RawAggTradeCursor | None = None
    previous_id: int | None = None
    previous_order: tuple[int, int] | None = None
    logical_duplicates = 0
    scan_error: str | None = None
    try:
        while True:
            page = archive.scan_page(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                start_time_ms=start_ms,
                end_time_ms=end_ms,
                after=cursor,
                limit=page_rows,
            )
            for row in page.rows:
                trade_id = int(row["agg_trade_id"])
                trade_time = int(row["trade_time_ms"])
                order = (trade_time, trade_id)
                day_key = datetime.fromtimestamp(
                    trade_time / 1000,
                    tz=timezone.utc,
                ).date().isoformat()
                item = daily[day_key]
                if previous_order is not None and order <= previous_order:
                    logical_duplicates += 1
                    item["duplicate_count"] = int(item["duplicate_count"]) + 1
                if previous_id is not None and trade_id > previous_id + 1:
                    item["gap_count"] = int(item["gap_count"]) + 1
                if item["first_agg_trade_id"] is None:
                    item["first_agg_trade_id"] = trade_id
                    item["first_trade_time_ms"] = trade_time
                item["row_count"] = int(item["row_count"]) + 1
                item["last_agg_trade_id"] = trade_id
                item["last_trade_time_ms"] = trade_time
                previous_id = trade_id
                previous_order = order
            if page.exhausted:
                break
            if page.next_cursor is None or page.next_cursor == cursor:
                raise RuntimeError("paged diagnostic audit cursor did not advance")
            cursor = page.next_cursor
    except Exception as exc:
        scan_error = str(exc)

    diagnostics = archive.diagnostics()
    durability_error = diagnostics.get("durability_error")
    return {
        "schema_version": "replay-trade-archive-audit.v1",
        "identity": {
            "exchange": coverage.exchange,
            "market_type": coverage.market_type,
            "symbol": coverage.symbol,
        },
        "start": start.isoformat(),
        "end": end.isoformat(),
        "data_epoch": None,
        "source_quality": None,
        "exact": False,
        "row_count": coverage.row_count,
        "expected_first_agg_trade_id": None,
        "expected_last_agg_trade_id": None,
        "observed_first_agg_trade_id": coverage.earliest_agg_trade_id,
        "observed_last_agg_trade_id": coverage.latest_agg_trade_id,
        "id_gaps": [
            {
                "start_agg_trade_id": gap.start_agg_trade_id,
                "end_agg_trade_id": gap.end_agg_trade_id,
                "missing_count": gap.missing_count,
            }
            for gap in coverage.gaps
        ],
        "duplicate_count": logical_duplicates,
        "duplicate_scope": "deduplicated_logical_view",
        "manifest_count": coverage.file_count,
        "manifest_checksums": [],
        "source_checksums": [],
        "checksum_status": "unreleased",
        "degraded": diagnostics.get("state") == "degraded",
        "degraded_marker": durability_error,
        "daily_coverage": [daily[key] for key in sorted(daily)],
        "eligible_windows": [],
        "audit_error": str(error),
        "diagnostic_scan_error": scan_error,
        "coverage_status": coverage.status,
        "coverage_error": coverage.error,
        "coverage_truncated": coverage.truncated,
    }


def audit_exact_trade_archive(
    archive: ParquetRawAggTradeArchive,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    start: date,
    end: date,
    page_rows: int = 50_000,
) -> dict[str, object]:
    if page_rows < 1 or page_rows > 50_000:
        raise ValueError("page_rows must be between 1 and 50000")
    start_ms, end_ms = inclusive_date_bounds(start, end)
    try:
        dataset_ref = archive.freeze_dataset(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_time_ms=start_ms,
            end_time_ms=end_ms,
            page_rows=page_rows,
        )
    except Exception as exc:
        return _failed_freeze_report(
            archive,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start=start,
            end=end,
            start_ms=start_ms,
            end_ms=end_ms,
            page_rows=page_rows,
            error=exc,
        )
    archive.validate_dataset(dataset_ref)
    daily = _daily_coverage_template(start, end, complete=True)
    cursor: RawAggTradeCursor | None = None
    previous_id: int | None = None
    previous_order: tuple[int, int] | None = None
    row_count = 0
    gaps: list[dict[str, int]] = []
    duplicates = 0
    while True:
        page = archive.scan_page(
            exchange=dataset_ref.exchange,
            market_type=dataset_ref.market_type,
            symbol=dataset_ref.symbol,
            start_time_ms=dataset_ref.start_time_ms,
            end_time_ms=dataset_ref.end_time_ms,
            start_agg_trade_id=dataset_ref.expected_first_agg_trade_id,
            end_agg_trade_id=dataset_ref.expected_last_agg_trade_id,
            after=cursor,
            limit=page_rows,
            dataset_ref=dataset_ref,
        )
        if page.data_epoch != dataset_ref.data_epoch:
            raise RuntimeError("paged audit data epoch changed")
        for row in page.rows:
            trade_id = int(row["agg_trade_id"])
            trade_time = int(row["trade_time_ms"])
            order = (trade_time, trade_id)
            if previous_order is not None and order <= previous_order:
                duplicates += 1
            if previous_id is not None and trade_id > previous_id + 1:
                gaps.append(
                    {
                        "start_agg_trade_id": previous_id + 1,
                        "end_agg_trade_id": trade_id - 1,
                        "missing_count": trade_id - previous_id - 1,
                    }
                )
            previous_id = trade_id
            previous_order = order
            day_key = datetime.fromtimestamp(
                trade_time / 1000,
                tz=timezone.utc,
            ).date().isoformat()
            item = daily[day_key]
            if item["first_agg_trade_id"] is None:
                item["first_agg_trade_id"] = trade_id
                item["first_trade_time_ms"] = trade_time
            item["row_count"] = int(item["row_count"]) + 1
            item["last_agg_trade_id"] = trade_id
            item["last_trade_time_ms"] = trade_time
            row_count += 1
        if page.exhausted:
            break
        if page.next_cursor is None or page.next_cursor == cursor:
            raise RuntimeError("paged audit cursor did not advance")
        cursor = page.next_cursor
    exact = (
        duplicates == 0
        and not gaps
        and row_count == dataset_ref.row_count
        and previous_id == dataset_ref.expected_last_agg_trade_id
    )
    if not exact:
        for item in daily.values():
            item["complete"] = False
    diagnostics = archive.diagnostics()
    return {
        "schema_version": "replay-trade-archive-audit.v1",
        "identity": {
            "exchange": dataset_ref.exchange,
            "market_type": dataset_ref.market_type,
            "symbol": dataset_ref.symbol,
        },
        "start": start.isoformat(),
        "end": end.isoformat(),
        "data_epoch": dataset_ref.data_epoch,
        "source_quality": dataset_ref.source_quality,
        "exact": exact,
        "row_count": row_count,
        "expected_first_agg_trade_id": dataset_ref.expected_first_agg_trade_id,
        "expected_last_agg_trade_id": dataset_ref.expected_last_agg_trade_id,
        "id_gaps": gaps,
        "duplicate_count": duplicates,
        "manifest_count": len(dataset_ref.objects),
        "manifest_checksums": sorted(
            {
                item.manifest_sha256
                for item in dataset_ref.objects
            }
        ),
        "source_checksums": sorted(
            {
                item.source_checksum_sha256
                for item in dataset_ref.objects
                if item.source_checksum_sha256 is not None
            }
        ),
        "degraded": diagnostics.get("state") == "degraded",
        "degraded_marker": diagnostics.get("durability_error"),
        "daily_coverage": [daily[key] for key in sorted(daily)],
        "eligible_windows": (
            [
                {
                    "start_time_ms": dataset_ref.start_time_ms,
                    "end_time_ms": dataset_ref.end_time_ms,
                    "expected_first_agg_trade_id": (
                        dataset_ref.expected_first_agg_trade_id
                    ),
                    "expected_last_agg_trade_id": (
                        dataset_ref.expected_last_agg_trade_id
                    ),
                    "data_epoch": dataset_ref.data_epoch,
                }
            ]
            if exact
            else []
        ),
    }


def audit_archive_path(
    archive_dir: Path,
    **kwargs: object,
) -> dict[str, object]:
    archive = ParquetRawAggTradeArchive(archive_dir)
    return audit_exact_trade_archive(archive, **kwargs)  # type: ignore[arg-type]


def exact_audit_passed(report: Mapping[str, object]) -> bool:
    return bool(report.get("exact")) and not bool(report.get("degraded"))


__all__ = [
    "audit_archive_path",
    "audit_exact_trade_archive",
    "exact_audit_passed",
    "inclusive_date_bounds",
]
