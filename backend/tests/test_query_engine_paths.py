from __future__ import annotations

from datetime import datetime, timezone

from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.models import BarData, QuerySource, SeriesKey
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.history import SessionCalendar


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
    assert result.history_state == "ready"
    assert result.complete is True
    assert result.retryable is False
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

    assert result.metadata["storage_reads"] == 1
    assert result.metadata["storage_rows"] == 2
    assert result.metadata["row_decode_rows"] == 2
    assert result.metadata["projected_storage_reads"] == 0
    assert result.metadata["projected_storage_rows"] == 0
    assert result.metadata["compact_row_decode_rows"] == 0
    assert result.metadata["legacy_row_decode_rows"] == 2
    snapshot = engine.snapshot()
    assert snapshot["storage_reads"] == 1
    assert snapshot["storage_rows"] == 2
    assert snapshot["row_decode_rows"] == 2
    assert snapshot["projected_storage_reads"] == 0
    assert snapshot["compact_row_decode_rows"] == 0
    assert snapshot["legacy_row_decode_rows"] == 2
    assert snapshot["storage_read_ms"] >= 0
    assert snapshot["row_decode_ms"] >= 0
    assert snapshot["custom_intervals"]["logical_queries"] == 0


def test_query_engine_prefers_compact_storage_projection() -> None:
    class _CompactStorage:
        def __init__(self) -> None:
            self.compact_calls: list[dict] = []

        def query_bar_components(self, **kwargs):
            self.compact_calls.append(kwargs)
            return [
                (120_000, 2, 3, 1, 2, 20, 40, 2, 12, 24),
                (60_000, 1, 2, 0, 1, 10, 20, 1, 6, 12),
            ]

        def query_bars(self, **kwargs):
            raise AssertionError("legacy projection must not be queried")

    storage = _CompactStorage()
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=120_000,
        limit=2,
        exchange="binance",
        market_type="spot",
    )

    assert [bar.time for bar in result.bars] == [60, 120]
    assert storage.compact_calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "start_ms": 60_000,
        "end_ms": 120_000,
        "limit": 2,
        "order": "DESC",
        "exchange": "binance",
        "market_type": "spot",
    }]
    assert result.metadata["projected_storage_reads"] == 1
    assert result.metadata["projected_storage_rows"] == 2
    assert result.metadata["compact_row_decode_rows"] == 2
    assert result.metadata["legacy_row_decode_rows"] == 0
    snapshot = engine.snapshot()
    assert snapshot["projected_storage_reads"] == 1
    assert snapshot["projected_storage_rows"] == 2
    assert snapshot["compact_row_decode_rows"] == 2
    assert snapshot["legacy_row_decode_rows"] == 0


def test_query_before_prefers_compact_storage_projection() -> None:
    class _CompactBeforeStorage:
        def __init__(self) -> None:
            self.compact_calls: list[dict] = []

        def fetch_before_bar_components(self, **kwargs):
            self.compact_calls.append(kwargs)
            return [
                (60_000, 1, 2, 0, 1, 10, 20, 1, 6, 12),
                (120_000, 2, 3, 1, 2, 20, 40, 2, 12, 24),
            ]

        def fetch_before(self, **kwargs):
            raise AssertionError("legacy projection must not be queried")

    storage = _CompactBeforeStorage()
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query_before(
        "BTCUSDT",
        "1m",
        before_ms=180_000,
        limit=2,
        exchange="binance",
        market_type="spot",
        auto_backfill=False,
    )

    assert [bar.time for bar in result.bars] == [60, 120]
    assert storage.compact_calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "before_ms": 180_000,
        "limit": 2,
        "exchange": "binance",
        "market_type": "spot",
    }]
    assert result.metadata["projected_storage_reads"] == 1
    assert result.metadata["projected_storage_rows"] == 2
    assert result.metadata["compact_row_decode_rows"] == 2
    assert result.metadata["legacy_row_decode_rows"] == 0


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


def test_explicit_count_full_cache_page_still_reports_missing_right_edge() -> None:
    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m")
    cache.bulk_load(key, [_bar(60), _bar(120)])
    engine = QueryEngine(cache=cache, config=QueryConfig(auto_backfill=False))

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=180_000,
        limit=2,
        auto_backfill=False,
    )

    assert [bar.time for bar in result.bars] == [60, 120]
    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (180_000, 180_000, "query_tail_gap"),
    ]
    assert result.history_state == "pending"
    assert result.complete is False


def test_cache_only_query_reports_interior_gap_without_storage_or_submission() -> None:
    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m")
    cache.bulk_load(key, [_bar(60), _bar(180)])
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=cache,
        config=QueryConfig(auto_backfill=False),
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=180_000,
        limit=3,
        auto_backfill=False,
    )

    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (120_000, 120_000, "query_interior_gap"),
    ]
    assert result.backfill_triggered is False
    assert result.history_state == "pending"
    assert triggered == []


def test_monthly_gap_bounds_are_calendar_aligned_without_history_policy() -> None:
    engine = QueryEngine(cache=BarCache(), config=QueryConfig(auto_backfill=False))
    january = 1_767_225_600  # 2026-01-01 UTC, seconds
    march = 1_772_323_200  # 2026-03-01 UTC, seconds

    start_ms, end_ms, missing_bars = engine._missing_bounds_between(
        january,
        march,
        "1M",
    )

    assert start_ms == 1_769_904_000_000  # 2026-02-01 UTC
    assert end_ms == 1_769_904_000_000
    assert missing_bars == 1


def test_before_window_uses_the_last_session_open_strictly_before_cursor() -> None:
    calendar = SessionCalendar(
        calendar_id="test.before.0930.utc",
        timezone_name="UTC",
        weekly_sessions={weekday: (("09:30", "17:00"),) for weekday in range(5)},
    )

    class _HistoryPolicy:
        def calendar_for(self, _series):
            return calendar

    engine = QueryEngine(
        cache=BarCache(),
        config=QueryConfig(auto_backfill=False),
        history_policy=_HistoryPolicy(),  # type: ignore[arg-type]
    )
    day = datetime(2026, 7, 20, tzinfo=timezone.utc)
    key = SeriesKey("BTCUSDT", "1h")

    start_ms, end_ms = engine._before_window(
        key,
        int(day.replace(hour=16, minute=10).timestamp() * 1000),
        2,
    )
    assert start_ms == int(day.replace(hour=14, minute=30).timestamp() * 1000)
    assert end_ms == int(day.replace(hour=15, minute=30).timestamp() * 1000)

    _, exact_end_ms = engine._before_window(
        key,
        int(day.replace(hour=16, minute=30).timestamp() * 1000),
        1,
    )
    assert exact_end_ms == int(day.replace(hour=15, minute=30).timestamp() * 1000)


def test_high_factor_custom_query_pages_fully_stored_base_without_false_backfill() -> None:
    rows = [_row(index * 60_000) for index in range(182)]

    class _PagedStorage:
        def fetch_before(self, **kwargs):
            before_ms = int(kwargs["before_ms"])
            limit = int(kwargs["limit"])
            eligible = [row for row in rows if int(row["open_time"]) < before_ms]
            return eligible[-limit:]

        def query_bars(self, **kwargs):
            start_ms = kwargs.get("start_ms")
            end_ms = kwargs.get("end_ms")
            limit = int(kwargs["limit"])
            eligible = [
                row for row in rows
                if (start_ms is None or int(row["open_time"]) >= int(start_ms))
                and (end_ms is None or int(row["open_time"]) <= int(end_ms))
            ]
            ordered = sorted(
                eligible,
                key=lambda row: int(row["open_time"]),
                reverse=kwargs.get("order") == "DESC",
            )
            return ordered[:limit]

    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=_PagedStorage(),  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False, max_limit=10),
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before(
        "BTCUSDT",
        "91m",
        before_ms=182 * 60_000,
        limit=2,
        auto_backfill=False,
    )

    assert [bar.time_ms for bar in result.bars] == [0, 91 * 60_000]
    assert [bar.volume for bar in result.bars] == [910, 910]
    assert result.missing_ranges == []
    assert result.complete is True
    assert result.retryable is False
    assert result.has_more is False
    assert triggered == []
    snapshot = engine.snapshot()
    assert result.metadata["base_page_count"] >= 2
    assert result.metadata["storage_reads"] > 1
    assert snapshot["storage_reads"] == result.metadata["storage_reads"]
    assert snapshot["storage_rows"] == result.metadata["storage_rows"]
    assert snapshot["query_before_calls"] > result.metadata["base_page_count"]


def test_query_before_keeps_has_more_when_backfill_is_deferred_to_facade() -> None:
    class _BeforeStorage:
        def fetch_before(self, **kwargs):
            return []

    engine = QueryEngine(
        cache=BarCache(),
        storage=_BeforeStorage(),  # type: ignore[arg-type]
    )

    result = engine.query_before(
        "BTCUSDT",
        "1h",
        before_ms=36_000_000,
        limit=2,
        exchange="binance",
        market_type="spot",
    )

    assert result.bars == []
    assert result.backfill_triggered is False
    assert result.has_more is True
    assert [r.to_dict() for r in result.missing_ranges] == [{
        "symbol": "BTCUSDT",
        "interval": "1h",
        "exchange": "binance",
        "market_type": "spot",
        "start_ms": 28_800_000,
        "end_ms": 32_400_000,
        "reason": "load_more_shortfall",
        "status": "detected",
        "missing_bars": 2,
    }]


def test_query_before_full_cache_page_repairs_an_interior_gap() -> None:
    class _BeforeStorage:
        def __init__(self) -> None:
            self.before_calls: list[dict] = []
            self.gap_calls: list[dict] = []

        def fetch_before(self, **kwargs):
            self.before_calls.append(kwargs)
            return []

        def query_bars(self, **kwargs):
            self.gap_calls.append(kwargs)
            return []

    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m", exchange="binance", market_type="spot")
    cache.bulk_load(key, [_bar(value) for value in (0, 60, 180, 240, 300)])
    storage = _BeforeStorage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before("BTCUSDT", "1m", before_ms=360_000, limit=5)

    assert [bar.time for bar in result.bars] == [0, 60, 180, 240, 300]
    assert len(storage.before_calls) == 1
    assert [(call["start_ms"], call["end_ms"]) for call in storage.gap_calls] == [
        (120_000, 120_000),
    ]
    assert [(item.start_ms, item.end_ms, item.missing_bars) for item in result.missing_ranges] == [
        (120_000, 120_000, 1),
    ]
    assert triggered == [
        ("BTCUSDT", "1m", 120_000, 120_000, "binance", "spot"),
    ]


def test_query_before_full_storage_page_repairs_an_interior_gap() -> None:
    class _BeforeStorage:
        def __init__(self) -> None:
            self.gap_calls: list[dict] = []

        def fetch_before(self, **kwargs):
            return [_row(value * 1000) for value in (0, 60, 180, 240, 300)]

        def query_bars(self, **kwargs):
            self.gap_calls.append(kwargs)
            return []

    storage = _BeforeStorage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before("BTCUSDT", "1m", before_ms=360_000, limit=5)

    assert len(result.bars) == 5
    assert [(call["start_ms"], call["end_ms"]) for call in storage.gap_calls] == [
        (120_000, 120_000),
    ]
    assert [(item.start_ms, item.end_ms) for item in result.missing_ranges] == [
        (120_000, 120_000),
    ]
    assert triggered == [
        ("BTCUSDT", "1m", 120_000, 120_000, "binance", "spot"),
    ]


def test_query_before_full_contiguous_cache_page_stays_on_fast_path() -> None:
    class _UnexpectedStorage:
        def fetch_before(self, **kwargs):
            raise AssertionError("contiguous full cache page must not read storage")

        def query_bars(self, **kwargs):
            raise AssertionError("contiguous full cache page must not scan gaps")

    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m", exchange="binance", market_type="spot")
    cache.bulk_load(key, [_bar(value) for value in (60, 120, 180, 240, 300)])
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=cache,
        storage=_UnexpectedStorage(),  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before("BTCUSDT", "1m", before_ms=360_000, limit=5)

    assert [bar.time for bar in result.bars] == [60, 120, 180, 240, 300]
    assert result.source == QuerySource.CACHE
    assert result.missing_ranges == []
    assert triggered == []


def test_query_before_full_contiguous_cache_page_repairs_right_boundary_gap() -> None:
    class _BeforeStorage:
        def __init__(self) -> None:
            self.before_calls: list[dict] = []
            self.gap_calls: list[dict] = []

        def fetch_before(self, **kwargs):
            self.before_calls.append(kwargs)
            return []

        def query_bars(self, **kwargs):
            self.gap_calls.append(kwargs)
            return []

    cache = BarCache()
    key = SeriesKey("BTCUSDT", "1m", exchange="binance", market_type="spot")
    cache.bulk_load(key, [_bar(value) for value in (0, 60, 120, 180, 240)])
    storage = _BeforeStorage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before("BTCUSDT", "1m", before_ms=600_000, limit=5)

    assert len(storage.before_calls) == 1
    assert [(call["start_ms"], call["end_ms"]) for call in storage.gap_calls] == [
        (300_000, 540_000),
    ]
    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (300_000, 540_000, "query_before_right_gap"),
    ]
    assert triggered == [
        ("BTCUSDT", "1m", 300_000, 540_000, "binance", "spot"),
    ]
    assert result.backfill_triggered is True


def test_query_before_full_contiguous_storage_page_repairs_right_boundary_gap() -> None:
    class _BeforeStorage:
        def __init__(self) -> None:
            self.gap_calls: list[dict] = []

        def fetch_before(self, **kwargs):
            return [_row(value) for value in (0, 60_000, 120_000, 180_000, 240_000)]

        def query_bars(self, **kwargs):
            self.gap_calls.append(kwargs)
            return []

    storage = _BeforeStorage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before("BTCUSDT", "1m", before_ms=600_000, limit=5)

    assert [(call["start_ms"], call["end_ms"]) for call in storage.gap_calls] == [
        (300_000, 540_000),
    ]
    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (300_000, 540_000, "query_before_right_gap"),
    ]
    assert triggered == [
        ("BTCUSDT", "1m", 300_000, 540_000, "binance", "spot"),
    ]
    assert result.backfill_triggered is True


def test_query_before_reports_right_boundary_gap_without_resubmitting() -> None:
    class _BeforeStorage:
        def fetch_before(self, **kwargs):
            return [_row(value) for value in (0, 60_000, 120_000, 180_000, 240_000)]

        def query_bars(self, **kwargs):
            return []

    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=_BeforeStorage(),  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before(
        "BTCUSDT",
        "1m",
        before_ms=600_000,
        limit=5,
        auto_backfill=False,
    )

    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (300_000, 540_000, "query_before_right_gap"),
    ]
    assert result.backfill_triggered is False
    assert result.history_state == "pending"
    assert result.complete is False
    assert result.retryable is True
    assert triggered == []


def test_query_before_partial_storage_fill_reports_only_remaining_page_gap() -> None:
    class _PartialStorage:
        def __init__(self) -> None:
            self.gap_calls: list[dict] = []

        def fetch_before(self, **kwargs):
            # Count-full, but the expected page window is 180_000..420_000.
            # The two older rows only occupy slots left by missing page bars.
            return [_row(value) for value in (0, 60_000, 300_000, 360_000, 420_000)]

        def query_bars(self, **kwargs):
            self.gap_calls.append(kwargs)
            # Storage can fill 180_000, but 240_000 is still absent.
            return [_row(180_000)]

    storage = _PartialStorage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
    )

    result = engine.query_before("BTCUSDT", "1m", before_ms=480_000, limit=5)

    assert [(call["start_ms"], call["end_ms"]) for call in storage.gap_calls] == [
        (180_000, 240_000),
    ]
    assert [(item.start_ms, item.end_ms, item.missing_bars) for item in result.missing_ranges] == [
        (240_000, 240_000, 1),
    ]
    assert triggered == [
        ("BTCUSDT", "1m", 240_000, 240_000, "binance", "spot"),
    ]
    assert result.backfill_triggered is True
    assert result.has_more is True
