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
