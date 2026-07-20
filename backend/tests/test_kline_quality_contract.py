from __future__ import annotations

import time
from types import SimpleNamespace

from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.models import BarData, SeriesKey
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.kline_quality import (
    FinalityTrust,
    kline_source_quality,
    source_rank,
)
from app.data_engine.storage import klines_repo


def _bar(
    time_s: int,
    close: float,
    *,
    source: str,
    is_closed: bool = True,
) -> BarData:
    return BarData(
        time=time_s,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=close,
        is_closed=is_closed,
        source=source,
    )


def _row(open_time_ms: int, close: float, *, source: str) -> dict:
    return {
        "open_time": open_time_ms,
        "close_time": open_time_ms + 59_999,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "volume": close,
        "quote_volume": close,
        "trades": 1,
        "taker_buy_base": 0.0,
        "taker_buy_quote": 0.0,
        "source": source,
    }


class _RangeStorage:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.query_calls: list[dict] = []
        self.before_calls: list[dict] = []

    def query_bars(self, **kwargs):
        self.query_calls.append(kwargs)
        return list(self.rows)

    def fetch_before(self, **kwargs):
        self.before_calls.append(kwargs)
        return list(self.rows)


def test_source_quality_is_centralized_and_unknown_fails_closed() -> None:
    trusted = {
        "backfill",
        "backfill_aggregated",
        "data_manager_amended",
        "backfill_rest_verified",
        "repair_binance_rest_verified",
        "data_manager_exchange_closed",
        "data_manager_composite_closed",
        "repair_derived_verified",
    }
    assert all(kline_source_quality(source).trusted_final for source in trusted)
    assert kline_source_quality("data_manager_closed").finality is FinalityTrust.AMBIGUOUS
    assert kline_source_quality("data_manager_closed").trusted_final is False
    assert kline_source_quality("settings_manual_repair").trusted_final is False
    assert kline_source_quality("").finality is FinalityTrust.UNTRUSTED
    assert source_rank("repair_binance_rest_verified") > source_rank("backfill")
    assert source_rank("backfill") > source_rank("data_manager_exchange_closed")
    assert source_rank("data_manager_exchange_closed") > source_rank("data_manager_closed")


def test_bar_data_retains_quality_without_changing_legacy_json_shape() -> None:
    bar = _bar(60, 2, source="BACKFILL")

    assert bar.source == "backfill"
    assert bar.quality == "trusted_final"
    assert bar.trusted_final is True
    assert bar.quality_rank == source_rank("backfill")
    assert bar.to_dict() == {
        "time": 60,
        "open": 2,
        "high": 2,
        "low": 2,
        "close": 2,
        "volume": 2,
        "is_closed": True,
    }

    legacy = BarData.from_dict(bar.to_dict())
    assert legacy.source == ""
    assert legacy.trusted_final is False


def test_bar_data_infers_explicit_exchange_close_from_phase1_state() -> None:
    state = SimpleNamespace(
        bucket_start_ms=60_000,
        open=1,
        high=2,
        low=1,
        close=2,
        volume=3,
        status=SimpleNamespace(value="closed"),
        enhanced_fields=(),
        requires_authoritative_close=True,
        last_close_received=True,
    )

    bar = BarData.from_bar_state(state)

    assert bar.source == "data_manager_exchange_closed"
    assert bar.trusted_final is True


def test_bar_data_never_promotes_explicit_provisional_state_from_legacy_flags() -> None:
    state = SimpleNamespace(
        bucket_start_ms=60_000,
        open=1,
        high=2,
        low=1,
        close=2,
        volume=3,
        status=SimpleNamespace(value="closed"),
        enhanced_fields=(),
        finality=SimpleNamespace(value="provisional"),
        close_reason=None,
        requires_authoritative_close=True,
        last_close_received=True,
    )

    bar = BarData.from_bar_state(state)

    assert bar.source == ""
    assert bar.trusted_final is False


def test_cache_never_regresses_a_timestamp_to_lower_quality() -> None:
    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m")
    verified = _bar(60, 10, source="backfill")
    ambiguous = _bar(60, 20, source="data_manager_closed")

    cache.append(key, verified)
    cache.append(key, ambiguous)
    assert cache.get_latest(key, 1)[0].close == 10

    cache.upsert(key, ambiguous)
    assert cache.get_latest(key, 1)[0].close == 10

    cache.bulk_load(key, [ambiguous])
    assert cache.get_latest(key, 1)[0].close == 10

    repaired = _bar(60, 30, source="repair_binance_rest_verified")
    cache.bulk_load(key, [repaired])
    assert cache.get_latest(key, 1)[0].close == 30
    assert cache.get_latest(key, 1)[0].source == "repair_binance_rest_verified"


def test_query_storage_quality_replaces_ambiguous_cache_at_same_timestamp() -> None:
    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m")
    cache.bulk_load(key, [_bar(60, 1, source="data_manager_closed")])
    storage = _RangeStorage([_row(60_000, 2, source="backfill")])
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=60_000,
        limit=1,
        auto_backfill=False,
    )

    assert len(storage.query_calls) == 1
    assert result.bars[0].close == 2
    assert result.bars[0].source == "backfill"
    assert result.complete is True
    assert result.metadata["all_rows_final"] is True
    assert cache.get_latest(key, 1)[0].source == "backfill"


def test_query_fresh_storage_wins_equal_quality_over_stale_cache() -> None:
    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m")
    cache.bulk_load(key, [_bar(60, 1, source="backfill")])
    storage = _RangeStorage([
        _row(60_000, 2, source="backfill"),
        _row(120_000, 3, source="backfill"),
    ])
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=120_000,
        limit=2,
        auto_backfill=False,
    )

    assert [bar.close for bar in result.bars] == [2, 3]
    assert [bar.close for bar in cache.get_latest(key, 2)] == [2, 3]


def test_query_contiguous_ambiguous_history_fails_closed_and_requests_repair() -> None:
    storage = _RangeStorage([_row(60_000, 1, source="data_manager_closed")])
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=60_000,
        limit=1,
        auto_backfill=False,
    )

    assert result.metadata["all_rows_final"] is False
    assert result.metadata["untrusted_final_rows"] == 1
    assert result.complete is False
    assert result.history_state == "pending"
    assert result.retryable is True
    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (60_000, 60_000, "query_untrusted_finality"),
    ]


def test_query_ignores_current_forming_tail_for_all_rows_final() -> None:
    minute_ms = 60_000
    forming_open_ms = (int(time.time() * 1000) // minute_ms) * minute_ms
    closed_open_ms = forming_open_ms - minute_ms
    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m")
    cache.bulk_load(key, [
        _bar(closed_open_ms // 1000, 1, source="backfill"),
        _bar(forming_open_ms // 1000, 2, source="", is_closed=False),
    ])
    storage = _RangeStorage([])
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=closed_open_ms,
        end_ms=forming_open_ms,
        limit=2,
        auto_backfill=False,
    )

    assert storage.query_calls == []
    assert result.complete is True
    assert result.metadata["all_rows_final"] is True
    assert result.metadata["expected_closed_rows"] == 1


def test_query_before_does_not_take_ambiguous_cache_fast_path() -> None:
    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m")
    cache.bulk_load(key, [_bar(60, 1, source="data_manager_closed")])
    storage = _RangeStorage([_row(60_000, 2, source="backfill")])
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query_before(
        "BTCUSDT",
        "1m",
        before_ms=120_000,
        limit=1,
        auto_backfill=False,
    )

    assert len(storage.before_calls) == 1
    assert result.bars[0].source == "backfill"
    assert result.bars[0].close == 2
    assert result.metadata["all_rows_final"] is True


def test_sqlite_upsert_uses_monotonic_source_rank_without_new_columns(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", tmp_path / "quality.sqlite")
    klines_repo.init_klines_storage()

    def write(close: float, source: str) -> None:
        row = _row(60_000, close, source=source)
        klines_repo.upsert_klines("BTCUSDT", "1m", [row], source=source)

    write(1, "data_manager_closed")
    # Storage continuity remains a timestamp-only statement.  QueryEngine's
    # additive all_rows_final contract is what fails closed on provenance.
    assert klines_repo.KlinesRepoAdapter().verify_contiguous_range(
        "BTCUSDT",
        "1m",
        60_000,
        60_000,
    )["verified_contiguous"] is True
    write(2, "backfill")
    write(3, "data_manager_closed")
    current = klines_repo.query_klines("BTCUSDT", "1m")
    assert current[0]["close"] == 2
    assert current[0]["source"] == "backfill"

    # Equal authority may publish a later revision.
    write(4, "backfill")
    assert klines_repo.query_klines("BTCUSDT", "1m")[0]["close"] == 4

    write(5, "repair_binance_rest_verified")
    write(6, "backfill")
    final = klines_repo.query_klines("BTCUSDT", "1m")
    assert final[0]["close"] == 5
    assert final[0]["source"] == "repair_binance_rest_verified"

    with klines_repo._connect() as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(klines)")}
    assert "quality_rank" not in columns
    assert "trusted_final" not in columns
