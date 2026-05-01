from __future__ import annotations

from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.models import BarData, QuerySource, SeriesKey
from app.data_engine.data_manager.query import QueryEngine


def _bar(time_s: int, close: float = 1) -> BarData:
    return BarData(
        time=time_s,
        open=close,
        high=close + 1,
        low=close - 1,
        close=close,
        volume=close * 10,
    )


def _row(open_time_ms: int, close: float = 1) -> dict:
    return {
        "open_time": open_time_ms,
        "open": close,
        "high": close + 1,
        "low": close - 1,
        "close": close,
        "volume": close * 10,
    }


class _Storage:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.calls: list[dict] = []

    def query_bars(self, **kwargs):
        self.calls.append(kwargs)
        return list(self.rows)


def test_query_engine_serves_complete_explicit_range_from_cache() -> None:
    cache = BarCache()
    key = SeriesKey("BTC-USDT", "1m", exchange="okx", market_type="spot")
    cache.bulk_load(key, [_bar(60, close=1), _bar(120, close=2)])
    storage = _Storage(rows=[])
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query(
        "BTC-USDT",
        "1m",
        start_ms=60_000,
        end_ms=120_000,
        limit=2,
        exchange="okx",
        market_type="spot",
    )

    assert result.source == QuerySource.CACHE
    assert result.cache_hit is True
    assert [bar.time for bar in result.bars] == [60, 120]
    assert storage.calls == []
    assert triggered == []


def test_query_engine_falls_back_to_storage_and_warms_cache() -> None:
    cache = BarCache()
    storage = _Storage(rows=[_row(120_000, close=2), _row(60_000, close=1)])
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTC-USDT",
        "1m",
        start_ms=60_000,
        end_ms=120_000,
        limit=2,
        exchange="okx",
        market_type="spot",
    )

    assert result.source == QuerySource.STORAGE
    assert result.cache_hit is False
    assert [bar.time for bar in result.bars] == [60, 120]
    assert storage.calls == [{
        "symbol": "BTC-USDT",
        "interval": "1m",
        "start_ms": 60_000,
        "end_ms": 120_000,
        "limit": 2,
        "order": "DESC",
        "exchange": "okx",
        "market_type": "spot",
    }]

    warmed = cache.query(
        SeriesKey("BTC-USDT", "1m", exchange="okx", market_type="spot"),
        start_time=60,
        end_time=120,
        limit=2,
    )
    assert [bar.time for bar in warmed] == [60, 120]


def test_query_engine_triggers_backfill_when_cache_and_storage_are_empty() -> None:
    cache = BarCache()
    storage = _Storage(rows=[])
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query(
        "BTC-USDT",
        "1m",
        start_ms=60_000,
        end_ms=120_000,
        limit=2,
        exchange="okx",
        market_type="spot",
    )

    assert result.source == QuerySource.EMPTY
    assert result.backfill_triggered is True
    assert [r.to_dict() for r in result.missing_ranges] == [{
        "symbol": "BTC-USDT",
        "interval": "1m",
        "exchange": "okx",
        "market_type": "spot",
        "start_ms": 60_000,
        "end_ms": 120_000,
        "reason": "query_empty",
        "status": "detected",
        "missing_bars": 2,
    }]
    assert result.bars == []
    assert storage.calls[0]["exchange"] == "okx"
    assert storage.calls[0]["market_type"] == "spot"
    assert triggered == [("BTC-USDT", "1m", 60_000, 120_000, "okx", "spot")]


def test_query_engine_reports_interior_missing_ranges() -> None:
    class _GapStorage:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def query_bars(self, **kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                return [_row(180_000, close=3), _row(60_000, close=1)]
            return []

    cache = BarCache()
    storage = _GapStorage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query(
        "BTC-USDT",
        "1m",
        start_ms=60_000,
        end_ms=180_000,
        limit=3,
        exchange="okx",
        market_type="spot",
    )

    assert [bar.time for bar in result.bars] == [60, 180]
    assert result.backfill_triggered is True
    assert [r.to_dict() for r in result.missing_ranges] == [{
        "symbol": "BTC-USDT",
        "interval": "1m",
        "exchange": "okx",
        "market_type": "spot",
        "start_ms": 120_000,
        "end_ms": 120_000,
        "reason": "query_interior_gap",
        "status": "detected",
        "missing_bars": 1,
    }]
    assert triggered == [("BTC-USDT", "1m", 120_000, 120_000, "okx", "spot")]
