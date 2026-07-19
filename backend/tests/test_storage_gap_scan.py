from __future__ import annotations

from datetime import datetime, timezone

from app.data_engine.storage import klines_repo


def _ms(year: int, month: int, day: int) -> int:
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1000)


def _row(open_time: int, close_time: int) -> dict:
    return {
        "open_time": open_time,
        "close_time": close_time,
        "open": 1.0,
        "high": 1.0,
        "low": 1.0,
        "close": 1.0,
        "volume": 1.0,
        "quote_volume": 1.0,
        "trades": 1,
        "taker_buy_base": 0.0,
        "taker_buy_quote": 0.0,
    }


def test_scan_klines_gaps_monthly_uses_calendar_open_sequence(tmp_path) -> None:
    klines_repo.KLINES_DB_PATH = tmp_path / "klines.sqlite"
    klines_repo.init_klines_storage()

    klines_repo.upsert_klines(
        "BTC-USDT",
        "1M",
        [
            _row(_ms(2024, 3, 1), _ms(2024, 4, 1) - 1),
            _row(_ms(2024, 6, 1), _ms(2024, 7, 1) - 1),
        ],
        source="test",
        exchange="okx",
        market_type="spot",
    )

    result = klines_repo.scan_klines_gaps(
        "BTC-USDT",
        "1M",
        start_ms=_ms(2024, 1, 1),
        end_ms=_ms(2024, 7, 15),
        exchange="okx",
        market_type="spot",
    )

    assert [
        (gap["reason"], gap["start_ms"], gap["end_ms"], gap["missing_bars"])
        for gap in result["gaps"]
    ] == [
        ("head_gap", _ms(2024, 1, 1), _ms(2024, 2, 1), 2),
        ("interior_gap", _ms(2024, 4, 1), _ms(2024, 5, 1), 2),
        ("tail_gap", _ms(2024, 7, 1), _ms(2024, 7, 1), 1),
    ]
    assert result["missing_bars"] == 5


def test_scan_klines_gaps_resume_cursor_reaches_gap_after_first_page(tmp_path) -> None:
    klines_repo.KLINES_DB_PATH = tmp_path / "klines.sqlite"
    klines_repo.init_klines_storage()
    minute = 60_000
    opens = [0, minute, 2 * minute, 3 * minute, 5 * minute, 6 * minute]
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_row(open_time, open_time + minute - 1) for open_time in opens],
        source="test",
    )

    first = klines_repo.scan_klines_gaps("BTCUSDT", "1m", limit=4)
    second = klines_repo.scan_klines_gaps(
        "BTCUSDT",
        "1m",
        start_ms=first["resume_from_ms"],
        limit=4,
    )

    assert first["truncated"] is True
    assert first["gaps"] == []
    assert first["resume_from_ms"] == 3 * minute
    assert second["truncated"] is False
    assert [
        (gap["reason"], gap["start_ms"], gap["end_ms"])
        for gap in second["gaps"]
    ] == [("interior_gap", 4 * minute, 4 * minute)]


def test_scan_klines_gaps_reports_closed_tail_only_with_explicit_end(tmp_path) -> None:
    klines_repo.KLINES_DB_PATH = tmp_path / "klines.sqlite"
    klines_repo.init_klines_storage()
    minute = 60_000
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_row(value, value + minute - 1) for value in (0, minute)],
        source="test",
    )

    interior_only = klines_repo.scan_klines_gaps("BTCUSDT", "1m")
    through_closed_tail = klines_repo.scan_klines_gaps(
        "BTCUSDT",
        "1m",
        end_ms=3 * minute,
    )

    assert interior_only["gaps"] == []
    assert [
        (gap["reason"], gap["start_ms"], gap["end_ms"])
        for gap in through_closed_tail["gaps"]
    ] == [("tail_gap", 2 * minute, 3 * minute)]


def test_exact_range_verifier_rejects_equal_count_off_grid_replacement(tmp_path) -> None:
    klines_repo.KLINES_DB_PATH = tmp_path / "klines.sqlite"
    klines_repo.init_klines_storage()
    minute = 60_000
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [
            _row(open_time, open_time + minute - 1)
            for open_time in (0, minute, 2 * minute)
        ],
        source="test",
    )
    adapter = klines_repo.KlinesRepoAdapter()

    assert adapter.verify_contiguous_range(
        "BTCUSDT",
        "1m",
        0,
        2 * minute,
    )["verified_contiguous"] is True

    klines_repo.delete_klines(
        "BTCUSDT",
        "1m",
        start_ms=minute,
        end_ms=minute,
    )
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_row(90_000, 149_999)],
        source="test",
    )

    assert adapter.count_bars("BTCUSDT", "1m", 0, 2 * minute) == 3
    result = adapter.verify_contiguous_range(
        "BTCUSDT",
        "1m",
        0,
        2 * minute,
    )
    assert result["verified_contiguous"] is False
    assert result["expected_open_time"] == minute
    assert result["actual_open_time"] == 90_000
