from __future__ import annotations

from datetime import date
from pathlib import Path

from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeDay,
)
from app.replay.trade_audit import audit_exact_trade_archive, exact_audit_passed
from tests.fixtures.replay.trade_fakes import START_MS, make_trade_row


DAY = date(2026, 6, 1)


def test_audit_reports_daily_gaps_when_exact_generation_cannot_freeze(
    tmp_path: Path,
) -> None:
    archive = ParquetRawAggTradeArchive(tmp_path / "archive")
    archive.append([make_trade_row(0), make_trade_row(2)])

    report = audit_exact_trade_archive(
        archive,
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start=DAY,
        end=DAY,
        page_rows=1,
    )

    assert report["exact"] is False
    assert report["eligible_windows"] == []
    assert report["expected_first_agg_trade_id"] is None
    assert report["expected_last_agg_trade_id"] is None
    assert report["id_gaps"] == [
        {
            "start_agg_trade_id": 101,
            "end_agg_trade_id": 101,
            "missing_count": 1,
        }
    ]
    assert report["checksum_status"] == "unreleased"
    assert report["daily_coverage"] == [
        {
            "date": DAY.isoformat(),
            "row_count": 2,
            "first_agg_trade_id": 100,
            "last_agg_trade_id": 102,
            "first_trade_time_ms": START_MS,
            "last_trade_time_ms": START_MS + 2,
            "gap_count": 1,
            "duplicate_count": 0,
            "complete": False,
        }
    ]
    assert not exact_audit_passed(report)


def test_audit_releases_verified_checksum_generation(tmp_path: Path) -> None:
    archive = ParquetRawAggTradeArchive(tmp_path / "archive")
    rows = [make_trade_row(index) for index in range(3)]
    checksum = "a" * 64
    archive.import_verified_day(
        rows,
        VerifiedRawAggTradeDay(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            date=DAY.isoformat(),
            source_url="https://data.binance.vision/example.zip",
            source_file="BTCUSDT-aggTrades-2026-06-01.zip",
            source_checksum_sha256=checksum,
            row_count=3,
            first_agg_trade_id=100,
            last_agg_trade_id=102,
            first_trade_time_ms=START_MS,
            last_trade_time_ms=START_MS + 2,
        ),
    )

    report = audit_exact_trade_archive(
        archive,
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start=DAY,
        end=DAY,
        page_rows=1,
    )

    assert exact_audit_passed(report)
    assert report["row_count"] == 3
    assert report["id_gaps"] == []
    assert report["duplicate_count"] == 0
    assert report["source_checksums"] == [checksum]
    assert len(report["manifest_checksums"]) == 1
    assert report["daily_coverage"][0]["complete"] is True
    assert len(report["eligible_windows"]) == 1
