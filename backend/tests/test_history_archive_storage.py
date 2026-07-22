from __future__ import annotations

import sqlite3

import pytest

from app.data_engine.storage import klines_repo


def _row(open_time: int, *, close: float = 105.0) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + 59_999,
        "open": 100.0,
        "high": 110.0,
        "low": 90.0,
        "close": close,
        "volume": 1.5,
        "quote_volume": 157.5,
        "trades": 10,
        "taker_buy_base": 0.75,
        "taker_buy_quote": 78.75,
    }


def _use_temp_db(monkeypatch, tmp_path):
    db_path = tmp_path / "candlescope.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    klines_repo.init_klines_storage()
    return db_path


def _receipt(*, digest: str = "a" * 64, row_count: int = 1) -> dict:
    return {
        "object_key": "binance-public-kline-v1:binance:spot:BTCUSDT:1m:monthly:2024-01",
        "provider_id": "binance-public-kline-v1",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "granularity": "monthly",
        "period": "2024-01",
        "start_ms": 0,
        "end_ms": 5_000_000,
        "content_sha256": digest,
        "provider_checksum": digest,
        "source_url": "https://data.binance.vision/example.zip",
        "row_count": row_count,
        "revision_changed": False,
        "import_version": "history-archive-import.v1",
    }


def test_archive_object_batch_rolls_back_as_one_transaction(monkeypatch, tmp_path) -> None:
    _use_temp_db(monkeypatch, tmp_path)
    valid = _row(0)
    invalid = _row(60_000)
    invalid["open"] = None
    receipt = _receipt(row_count=2)

    with pytest.raises(sqlite3.IntegrityError):
        klines_repo.import_history_archive(
            "BTCUSDT",
            "1m",
            [valid, invalid],
            receipt,
            source="backfill_archive_verified",
            exchange="binance",
            market_type="spot",
        )

    assert klines_repo.query_klines(
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    ) == []
    with klines_repo._connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM history_archive_imports"
        ).fetchone()[0] == 0


def test_archive_revision_receipt_invalidates_derived_rows(monkeypatch, tmp_path) -> None:
    _use_temp_db(monkeypatch, tmp_path)
    klines_repo.upsert_klines(
        "BTCUSDT",
        "89m",
        [_row(0), _row(10_000_000)],
        source="backfill_aggregated",
        exchange="binance",
        market_type="spot",
    )
    receipt = _receipt()
    receipt["revision_changed"] = True

    assert klines_repo.invalidate_archive_dependents([receipt]) == 1
    remaining = klines_repo.query_klines(
        "BTCUSDT",
        "89m",
        exchange="binance",
        market_type="spot",
    )
    assert [row["open_time"] for row in remaining] == [10_000_000]
    assert klines_repo.record_history_archive_imports([receipt]) == 1
    with klines_repo._connect() as connection:
        stored = connection.execute(
            "SELECT object_key, content_sha256, row_count, revision_changed "
            "FROM history_archive_imports"
        ).fetchone()
    assert dict(stored) == {
        "object_key": receipt["object_key"],
        "content_sha256": "a" * 64,
        "row_count": 1,
        "revision_changed": 1,
    }


def test_archive_import_is_idempotent_and_revision_is_atomic(
    monkeypatch,
    tmp_path,
) -> None:
    _use_temp_db(monkeypatch, tmp_path)
    rows = [_row(0), _row(60_000)]
    receipt = _receipt(row_count=2)

    first = klines_repo.import_history_archive(
        "BTCUSDT",
        "1m",
        rows,
        receipt,
        exchange="binance",
        market_type="spot",
    )
    second = klines_repo.import_history_archive(
        "BTCUSDT",
        "1m",
        rows,
        receipt,
        exchange="binance",
        market_type="spot",
    )

    assert first == {
        "written": 2,
        "imported": True,
        "skipped": False,
        "invalidated": 0,
        "revision_changed": False,
    }
    assert second["written"] == 0
    assert second["imported"] is False
    assert second["skipped"] is True

    klines_repo.upsert_klines(
        "BTCUSDT",
        "89m",
        [_row(0)],
        source="backfill_aggregated",
        exchange="binance",
        market_type="spot",
    )
    revised_rows = [_row(0, close=106), _row(60_000, close=107)]
    revised = _receipt(digest="b" * 64, row_count=2)
    outcome = klines_repo.import_history_archive(
        "BTCUSDT",
        "1m",
        revised_rows,
        revised,
        exchange="binance",
        market_type="spot",
    )

    assert outcome["imported"] is True
    assert outcome["revision_changed"] is True
    assert outcome["invalidated"] == 1
    assert klines_repo.query_klines(
        "BTCUSDT",
        "89m",
        exchange="binance",
        market_type="spot",
    ) == []
    stored = klines_repo.query_klines(
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    )
    assert [row["close"] for row in stored] == [106, 107]


def test_verified_rest_remains_stronger_than_archive(monkeypatch, tmp_path) -> None:
    _use_temp_db(monkeypatch, tmp_path)
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_row(0, close=101)],
        source="backfill_archive_verified",
        exchange="binance",
        market_type="spot",
    )
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_row(0, close=102)],
        source="backfill_rest_verified",
        exchange="binance",
        market_type="spot",
    )
    assert klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_row(0, close=103)],
        source="backfill_archive_verified",
        exchange="binance",
        market_type="spot",
    ) == 0

    stored = klines_repo.query_klines(
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    )[0]
    assert stored["close"] == 102
    assert stored["source"] == "backfill_rest_verified"
