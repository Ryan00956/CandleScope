from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.models import GapInfo, GapType
from app.data_engine.backfill.planner import BackfillPlanner
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import CacheConfig, QueryConfig
from app.data_engine.data_manager.custom_query import CustomIntervalQueryService
from app.data_engine.data_manager.models import (
    BarData,
    QueryResult,
    QuerySource,
    SeriesKey,
)
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.history import AlwaysOpenCalendar
from app.data_engine.interval_policy import compute_bucket_start_ms


def _row(
    open_time_ms: int,
    value: float = 1,
    *,
    is_closed: bool = True,
) -> dict:
    return {
        "open_time": open_time_ms,
        "open": value,
        "high": value + 1,
        "low": value - 1,
        "close": value,
        "volume": value,
        "is_closed": is_closed,
    }


class _IntervalStorage:
    def __init__(self, rows_by_interval: dict[str, list[dict]]) -> None:
        self.rows_by_interval = rows_by_interval
        self.calls: list[dict] = []

    def query_bars(self, **kwargs):
        self.calls.append(dict(kwargs))
        rows = list(self.rows_by_interval.get(str(kwargs["interval"]), ()))
        start_ms = kwargs.get("start_ms")
        end_ms = kwargs.get("end_ms")
        rows = [
            row for row in rows
            if (start_ms is None or int(row["open_time"]) >= int(start_ms))
            and (end_ms is None or int(row["open_time"]) <= int(end_ms))
        ]
        rows.sort(
            key=lambda row: int(row["open_time"]),
            reverse=kwargs.get("order") == "DESC",
        )
        return rows[: int(kwargs.get("limit") or len(rows))]

    def fetch_before(self, **kwargs):
        self.calls.append(dict(kwargs))
        before_ms = int(kwargs["before_ms"])
        rows = [
            row for row in self.rows_by_interval.get(str(kwargs["interval"]), ())
            if int(row["open_time"]) < before_ms
        ]
        rows.sort(key=lambda row: int(row["open_time"]))
        return rows[-int(kwargs["limit"]):]


def test_custom_intervals_reuse_bounded_shared_base_history() -> None:
    minute_ms = 60_000
    storage = _IntervalStorage({
        "1m": [_row(index * minute_ms, index + 1) for index in range(154)],
    })
    cache = BarCache(CacheConfig(
        max_bars_per_series=5,
        max_series=20,
        history_max_bars_per_series=100,
        history_max_series=1,
    ))
    engine = QueryEngine(
        cache=cache,
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(default_limit=10, max_limit=10, auto_backfill=False),
    )
    before_ms = 154 * minute_ms

    first = engine.query_before(
        "BTCUSDT",
        "7m",
        before_ms=before_ms,
        limit=8,
        auto_backfill=False,
    )
    first_base_reads = int(first.metadata["base_storage_reads"])
    assert len(first.bars) == 8
    assert first_base_reads == 7
    assert first.metadata["base_cache_reserved_rows"] == 70
    assert cache.series_count(SeriesKey("BTCUSDT", "1m")) == 70

    storage.calls.clear()
    second = engine.query_before(
        "BTCUSDT",
        "11m",
        before_ms=before_ms,
        limit=5,
        auto_backfill=False,
    )
    assert len(second.bars) == 5
    assert second.metadata["base_storage_reads"] == 1
    assert second.metadata["target_storage_reads"] == 1
    assert second.metadata["base_cache_reserved_rows"] == 77
    assert cache.series_count(SeriesKey("BTCUSDT", "1m")) == 77

    cache.invalidate(SeriesKey("BTCUSDT", "1m"))
    cache.invalidate(SeriesKey("BTCUSDT", "11m"))
    storage.calls.clear()
    after_invalidation = engine.query_before(
        "BTCUSDT",
        "11m",
        before_ms=before_ms,
        limit=5,
        auto_backfill=False,
    )
    assert after_invalidation.bars == second.bars
    assert after_invalidation.metadata["base_storage_reads"] == 8


def test_custom_query_reuses_complete_materialized_target_storage() -> None:
    storage = _IntervalStorage({
        "45m": [_row(0, 10), _row(2_700_000, 20)],
        "15m": [_row(index * 900_000) for index in range(6)],
    })
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "45m",
        start_ms=0,
        end_ms=2_700_000,
        limit=2,
        auto_backfill=False,
    )

    assert [bar.time_ms for bar in result.bars] == [0, 2_700_000]
    assert [bar.close for bar in result.bars] == [10, 20]
    assert result.source is QuerySource.STORAGE
    assert result.metadata["target_materialized"] is True
    assert [call["interval"] for call in storage.calls] == ["45m"]


def test_custom_query_derives_only_after_materialized_target_is_incomplete() -> None:
    storage = _IntervalStorage({
        "45m": [_row(0, 10)],
        "15m": [_row(index * 900_000, index + 1) for index in range(6)],
    })
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "45m",
        start_ms=0,
        end_ms=2_700_000,
        limit=2,
        auto_backfill=False,
    )

    assert [bar.time_ms for bar in result.bars] == [0, 2_700_000]
    assert result.bars[0].close == 3  # current base rebuild wins on overlap
    assert result.bars[1].close == 6
    assert result.metadata["target_materialized"] is False
    assert result.metadata["target_materialized_rows"] == 1
    assert "15m" in [call["interval"] for call in storage.calls]


def test_custom_query_rebuilds_forming_materialized_tail_from_base() -> None:
    storage = _IntervalStorage({
        "45m": [_row(0, 10, is_closed=False)],
        "15m": [
            _row(0, 12),
            _row(900_000, 16),
            _row(1_800_000, 20, is_closed=False),
        ],
    })
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "45m",
        start_ms=0,
        end_ms=0,
        limit=1,
        auto_backfill=False,
    )

    assert len(result.bars) == 1
    assert result.bars[0].close == 20
    assert result.bars[0].volume == 48
    assert result.bars[0].is_closed is False
    assert result.metadata["target_materialized"] is False
    assert result.metadata["target_materialized_rows"] == 1
    assert [call["interval"] for call in storage.calls] == ["45m", "15m"]


def test_identical_custom_derivations_singleflight_base_work() -> None:
    entered = threading.Event()
    release = threading.Event()
    calls: list[int] = []
    base_bars = [
        BarData(time=index * 900, open=1, high=2, low=1, close=2, volume=1)
        for index in range(3)
    ]

    def _base_query(*args, **kwargs) -> QueryResult:
        calls.append(1)
        entered.set()
        assert release.wait(timeout=2)
        return QueryResult(
            bars=base_bars,
            symbol="BTCUSDT",
            interval="15m",
            source=QuerySource.STORAGE,
            total=len(base_bars),
            complete=True,
        )

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(default_limit=1, max_limit=10),
        base_query=_base_query,
    )

    def _query() -> QueryResult:
        return service.query_from_base(
            symbol="BTCUSDT",
            interval="45m",
            start_ms=0,
            end_ms=0,
            limit=1,
            started_at=time.monotonic(),
            auto_backfill=False,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(_query)
        assert entered.wait(timeout=1)
        second = executor.submit(_query)
        time.sleep(0.05)
        release.set()
        first_result = first.result(timeout=2)
        second_result = second.result(timeout=2)

    assert len(calls) == 1
    assert first_result.bars == second_result.bars
    assert first_result is not second_result
    assert first_result.metadata is not second_result.metadata
    assert first_result.metadata["singleflight_role"] == "owner"
    assert second_result.metadata["singleflight_role"] == "join"
    assert service.snapshot()["singleflight_owners"] == 1
    assert service.snapshot()["singleflight_joins"] == 1


def test_fixed_custom_aggregation_avoids_generic_row_materialization() -> None:
    bars = [
        BarData(
            time=index * 60,
            open=1,
            high=2,
            low=1,
            close=2,
            volume=1,
            is_closed=True,
        )
        for index in range(37)
    ]

    with patch.object(
        BarData,
        "to_aggregation_dict",
        side_effect=AssertionError(
            "fixed-width fast path must not build row dictionaries"
        ),
    ):
        results = [
            CustomIntervalQueryService._aggregate_read_only(
                bars,
                "37m",
                37 * 60,
                source_interval="1m",
                calendar=calendar,
            )
            for calendar in (None, AlwaysOpenCalendar())
        ]

    assert [len(result) for result in results] == [1, 1]
    assert [result[0].volume for result in results] == [37, 37]


def test_custom_base_pagination_is_hard_bounded_without_inventing_a_gap() -> None:
    calls: list[int] = []

    def _base_query(*args, **kwargs) -> QueryResult:
        raise AssertionError("directional custom pagination must use query_before")

    def _base_query_before(
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
        **kwargs,
    ) -> QueryResult:
        calls.append(before_ms)
        open_ms = ((int(before_ms) - 1) // 60_000) * 60_000
        return QueryResult(
            bars=[BarData(
                time=open_ms // 1000,
                open=1,
                high=2,
                low=1,
                close=2,
                volume=1,
            )],
            symbol=symbol,
            interval=interval,
            source=QuerySource.STORAGE,
            total=1,
            has_more=True,
            complete=True,
        )

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(default_limit=1, max_limit=1),
        base_query=_base_query,
        base_query_before=_base_query_before,
    )

    result = service.query_before(
        "BTCUSDT",
        "91m",
        before_ms=1_000_000_000,
        limit=10_000,
        auto_backfill=False,
    )

    assert len(calls) == 32
    assert result.metadata["base_pagination_capped"] is True
    assert result.has_more is True
    assert result.history_state == "ready"
    assert result.retryable is False
    assert result.missing_ranges == []


def test_custom_range_pagination_caps_the_final_page_to_remaining_source_rows() -> None:
    page_limits: list[int] = []

    def _base_query(*args, **kwargs) -> QueryResult:
        raise AssertionError("the seeded range should not issue another base range query")

    def _base_query_before(
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
        **kwargs,
    ) -> QueryResult:
        page_limits.append(limit)
        last_open = ((before_ms - 1) // 60_000) * 60_000
        first_open = last_open - (limit - 1) * 60_000
        bars = [
            BarData(
                time=open_ms // 1000,
                open=1,
                high=2,
                low=1,
                close=2,
                volume=1,
            )
            for open_ms in range(first_open, last_open + 1, 60_000)
        ]
        return QueryResult(
            bars=bars,
            symbol=symbol,
            interval=interval,
            source=QuerySource.STORAGE,
            total=len(bars),
            has_more=True,
            complete=True,
        )

    initial = QueryResult(
        bars=[
            BarData(
                time=index * 60,
                open=1,
                high=2,
                low=1,
                close=2,
                volume=1,
            )
            for index in range(20, 30)
        ],
        symbol="BTCUSDT",
        interval="1m",
        source=QuerySource.STORAGE,
        total=10,
        has_more=True,
        complete=True,
    )
    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(default_limit=10, max_limit=10),
        base_query=_base_query,
        base_query_before=_base_query_before,
    )

    result = service._page_base_history(
        symbol="BTCUSDT",
        interval="1m",
        before_ms=30 * 60_000,
        target_limit=25,
        lower_bound_ms=5 * 60_000,
        exchange="binance",
        market_type="spot",
        auto_backfill=False,
        initial_result=initial,
    )

    assert page_limits == [10, 5]
    assert [bar.time_ms for bar in result.bars] == list(range(5 * 60_000, 30 * 60_000, 60_000))
    assert result.metadata["base_page_count"] == 3
    assert result.metadata["base_rows_fetched"] == 25
    assert result.metadata["base_rows_unique"] == 25
    assert result.metadata["base_rows_returned"] == 25
    assert result.metadata["base_page_overfetch_rows"] == 0


def test_base_repair_projection_uses_canonical_containing_open_for_47m() -> None:
    calendar = AlwaysOpenCalendar()
    # Use a deliberately non-target-aligned 1m component open.
    component_open_ms = 1_753_009_640_000
    expected_open_ms = compute_bucket_start_ms(
        component_open_ms,
        47 * 60_000,
        interval="47m",
    )
    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(),
        base_query=lambda *args, **kwargs: QueryResult(),
        calendar_provider=lambda _key: calendar,
    )

    projected = service.project_base_repair_to_target(
        symbol="BTCUSDT",
        target_interval="47m",
        base_interval="1m",
        start_ms=component_open_ms,
        end_ms=component_open_ms,
        exchange="binance",
        market_type="spot",
    )

    assert projected == {
        "interval": "47m",
        "start_ms": expected_open_ms,
        "end_ms": expected_open_ms,
    }
    assert calendar.first_expected_open(
        expected_open_ms,
        expected_open_ms,
        "47m",
    ) == expected_open_ms
    assert expected_open_ms % 1000 == 0


def test_calendar_range_reads_the_complete_requested_final_bucket() -> None:
    calls: list[dict] = []
    base_bars = [
        BarData(
            time=index * 900,
            open=index + 1,
            high=index + 2,
            low=index,
            close=index + 1,
            volume=1,
        )
        for index in range(6)
    ]

    def _base_query(*args, **kwargs) -> QueryResult:
        calls.append(dict(kwargs))
        return QueryResult(
            bars=base_bars,
            symbol="BTCUSDT",
            interval="15m",
            source=QuerySource.STORAGE,
            total=len(base_bars),
            complete=True,
        )

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(default_limit=2, max_limit=10),
        base_query=_base_query,
        calendar_provider=lambda _key: AlwaysOpenCalendar(),
    )

    result = service.query_from_base(
        symbol="BTCUSDT",
        interval="45m",
        start_ms=0,
        end_ms=2_700_000,
        limit=2,
        started_at=time.monotonic(),
        auto_backfill=False,
    )

    assert calls[0]["end_ms"] == 5_399_999
    assert [bar.time_ms for bar in result.bars] == [0, 2_700_000]


def test_okx_unsupported_standard_target_is_repaired_from_native_components() -> None:
    planner = BackfillPlanner(BackfillConfig())
    gap = GapInfo(
        symbol="BTC-USDT",
        interval="8h",
        gap_type=GapType.INTERIOR,
        start_ms=0,
        end_ms=8 * 60 * 60 * 1000,
        missing_bars=2,
        exchange="okx",
        market_type="spot",
    )

    plan = planner.plan([gap])

    assert plan.tasks
    assert all(task.interval != "8h" for task in plan.tasks)
    assert {task.interval for task in plan.tasks} == {"4h"}
    assert plan.custom_intervals == ["8h"]
