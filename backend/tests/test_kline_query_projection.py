from __future__ import annotations

from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.storage import klines_repo


def _bar(open_time: int, *, buy_base: float = 6) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + 59_999,
        "open": 100.123456789,
        "high": 110.123456789,
        "low": 90.123456789,
        "close": 105.123456789,
        "volume": 10,
        "quote_volume": 1_000,
        "trades": 25,
        "taker_buy_base": buy_base,
        "taker_buy_quote": 650,
    }


def test_sqlite_adapter_compact_projection_matches_full_rows(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", tmp_path / "klines.sqlite")
    klines_repo.init_klines_storage()
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_bar(60_000), _bar(120_000)],
        exchange="binance",
        market_type="spot",
    )
    adapter = klines_repo.KlinesRepoAdapter()

    full_rows = adapter.query_bars("BTCUSDT", "1m", order="ASC")
    compact_rows = adapter.query_bar_components("BTCUSDT", "1m", order="ASC")
    expected = [
        (
            row["open_time"],
            row["open"],
            row["high"],
            row["low"],
            row["close"],
            row["volume"],
            row["quote_volume"],
            row["trades"],
            row["taker_buy_base"],
            row["taker_buy_quote"],
        )
        for row in full_rows
    ]

    assert compact_rows == expected
    assert adapter.fetch_before_bar_components(
        "BTCUSDT",
        "1m",
        before_ms=180_000,
        limit=2,
    ) == expected


def test_sqlite_compact_query_keeps_invalid_enhancements_fail_closed(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", tmp_path / "klines.sqlite")
    klines_repo.init_klines_storage()
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_bar(60_000, buy_base=12)],
        exchange="binance",
        market_type="spot",
    )
    engine = QueryEngine(
        BarCache(),
        klines_repo.KlinesRepoAdapter(),
        QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=60_000,
        limit=1,
        auto_backfill=False,
    )

    assert len(result.bars) == 1
    payload = result.bars[0].to_kline_dict()
    assert payload["taker_buy_base"] is None
    assert payload["order_flow"] is None
    assert result.metadata["projected_storage_reads"] == 1
    assert result.metadata["compact_row_decode_rows"] == 1
