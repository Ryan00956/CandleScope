from __future__ import annotations

import asyncio
import time
from unittest.mock import patch

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.models import GapInfo, GapType
from app.data_engine.backfill.planner import BackfillPlanner
from app.data_engine.bar_aggregator import (
    BarAggregator,
    BarAggregatorConfig,
    BarInput,
    BarInputSource,
)
from app.data_engine.bar_aggregator.router import EventRouter
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.coordinator import StreamCoordinator
from app.data_engine.data_manager.models import SeriesKey, StreamStatus
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.data_manager.stream_policy import StreamEnsurePlanner
from app.data_engine.history import AlwaysOpenCalendar
from app.data_engine.interval_policy import IntervalAlignment, parse_interval_spec
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolver,
    IntervalRoute,
    IntervalRouteKind,
)
from app.exchanges.realtime import RealtimePolicy, RealtimeUpdateMode


def _row(open_ms: int, value: float = 1) -> dict:
    return {
        "open_time": open_ms,
        "close_time": open_ms + 1,
        "open": value,
        "high": value + 1,
        "low": value - 1,
        "close": value,
        "volume": value,
        "is_closed": True,
    }


class _Storage:
    def __init__(self, rows: dict[str, list[dict]]) -> None:
        self.rows = rows
        self.calls: list[str] = []

    def query_bars(self, **kwargs):
        interval = str(kwargs["interval"])
        self.calls.append(interval)
        values = list(self.rows.get(interval, ()))
        start_ms = kwargs.get("start_ms")
        end_ms = kwargs.get("end_ms")
        values = [
            row for row in values
            if (start_ms is None or row["open_time"] >= start_ms)
            and (end_ms is None or row["open_time"] <= end_ms)
        ]
        values.sort(key=lambda row: row["open_time"])
        return values[: int(kwargs.get("limit") or len(values))]

    def fetch_before(self, **kwargs):
        interval = str(kwargs["interval"])
        self.calls.append(interval)
        values = [
            row for row in self.rows.get(interval, ())
            if row["open_time"] < int(kwargs["before_ms"])
        ]
        values.sort(key=lambda row: row["open_time"])
        return values[-int(kwargs["limit"]):]


def test_query_range_and_before_use_exchange_resolved_base() -> None:
    eight_hours = 8 * 3_600_000
    sixteen_hours = 16 * 3_600_000
    target_open = (1_750_000_000_000 // sixteen_hours) * sixteen_hours
    storage = _Storage({
        "4h": [_row(target_open + index * 4 * 3_600_000, index + 1) for index in range(4)],
    })
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    ranged = engine.query(
        "BTC-USDT",
        "8h",
        start_ms=target_open,
        end_ms=target_open,
        limit=1,
        exchange="okx",
        auto_backfill=False,
    )
    before = engine.query_before(
        "BTC-USDT",
        "16h",
        target_open + sixteen_hours,
        1,
        exchange="okx",
        auto_backfill=False,
    )

    assert ranged.metadata["derived_from"] == "4h"
    assert before.metadata["derived_from"] == "4h"
    assert "4h" in storage.calls
    assert "1m" not in storage.calls


def test_query_alias_uses_one_canonical_storage_identity() -> None:
    open_ms = 1_750_000_000_000 // 3_600_000 * 3_600_000
    storage = _Storage({"1h": [_row(open_ms)]})
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )

    result = engine.query(
        "BTCUSDT",
        "60m",
        start_ms=open_ms,
        end_ms=open_ms,
        limit=1,
        auto_backfill=False,
    )

    assert result.interval == "1h"
    assert storage.calls == ["1h"]


def test_query_count_window_canonicalises_an_intra_bucket_exclusive_edge() -> None:
    engine = QueryEngine(
        cache=BarCache(),
        storage=_Storage({}),  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )
    key = SeriesKey("BTCUSDT", "47m")
    spec = parse_interval_spec("47m")
    assert spec is not None
    bucket_open = spec.floor_ms(1_750_000_000_000)

    first, last = engine._before_window(key, bucket_open + 12_345, 2)

    assert last == bucket_open
    assert first == spec.previous_ms(bucket_open)


def test_fixed_count_window_is_computed_without_per_bucket_iteration() -> None:
    class _FixedSpec:
        alignment = IntervalAlignment.FIXED_EPOCH
        nominal_ms = 60_000

        @staticmethod
        def floor_ms(timestamp_ms: int) -> int:
            return timestamp_ms // 60_000 * 60_000

        @staticmethod
        def previous_ms(_open_ms: int) -> int:
            raise AssertionError("fixed windows must not walk one bucket at a time")

    engine = QueryEngine(
        cache=BarCache(),
        storage=_Storage({}),  # type: ignore[arg-type]
        config=QueryConfig(auto_backfill=False),
    )
    before_ms = 1_750_000_012_345
    limit = 100_000
    last = (before_ms - 1) // 60_000 * 60_000

    for calendar in (None, AlwaysOpenCalendar()):
        with (
            patch.object(engine, "_calendar_for", return_value=calendar),
            patch(
                "app.data_engine.data_manager.query.parse_interval_spec",
                return_value=_FixedSpec(),
            ),
        ):
            first, actual_last = engine._before_window(
                SeriesKey("BTCUSDT", "1m"),
                before_ms,
                limit,
            )

        assert actual_last == last
        assert first == last - (limit - 1) * 60_000


def test_stream_plan_uses_resolved_native_base_and_alias_identity() -> None:
    planner = StreamEnsurePlanner()

    okx = planner.plan("BTC-USDT", "8h", exchange="okx")
    binance = planner.plan("BTCUSDT", "16h", exchange="binance")
    alias = planner.plan("BTCUSDT", "60m", exchange="binance")

    assert [key.interval for key in okx.prerequisite_streams] == ["4h"]
    assert {key.interval for key in okx.aggregation_targets} == {"8h", "4h"}
    assert [key.interval for key in binance.prerequisite_streams] == ["8h"]
    assert alias.requested.interval == "1h"


def test_stream_coordinator_keeps_canonical_identity_but_uses_native_protocol_spelling() -> None:
    class _AliasResolver:
        def resolve(self, **kwargs) -> IntervalRoute:
            spec = parse_interval_spec("1h")
            assert spec is not None
            purpose = kwargs["purpose"]
            if not isinstance(purpose, IntervalPurpose):
                purpose = IntervalPurpose(purpose)
            return IntervalRoute(
                exchange="stub",
                market_type="spot",
                requested_interval=str(kwargs["interval"]),
                canonical_interval="1h",
                purpose=purpose,
                kind=IntervalRouteKind.NATIVE,
                spec=spec,
                native_interval="60m",
            )

    class _Handle:
        async def stop(self) -> None:
            pass

    class _Factory:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        async def start(self, **kwargs):
            self.calls.append(kwargs)
            return _Handle()

    class _Aggregator:
        async def on_market_event(self, _event) -> None:
            pass

    async def _run() -> None:
        factory = _Factory()
        coordinator = StreamCoordinator(interval_resolver=_AliasResolver())  # type: ignore[arg-type]
        coordinator.set_ingestion_factory(factory)  # type: ignore[arg-type]
        coordinator.set_bar_aggregator(_Aggregator())

        info = await coordinator.ensure_stream(
            "BTC-USDT",
            "1h",
            exchange="stub",
            market_type="spot",
        )

        assert info.key.interval == "1h"
        assert factory.calls[0]["interval"] == "60m"
        await coordinator.stop_stream("BTC-USDT", "1h", exchange="stub")

    asyncio.run(_run())


def test_stream_coordinator_never_activates_derived_stream_when_base_start_fails() -> None:
    class _FailingFactory:
        async def start(self, **_kwargs):
            raise RuntimeError("injected base start failure")

    async def _run() -> None:
        coordinator = StreamCoordinator()
        coordinator.set_ingestion_factory(_FailingFactory())  # type: ignore[arg-type]
        coordinator.set_bar_aggregator(BarAggregator())

        info = await coordinator.ensure_stream("BTCUSDT", "45m")

        assert info.key.interval == "45m"
        assert info.status is StreamStatus.ERROR
        assert "injected base start failure" in str(info.error)
        assert not coordinator.has_stream("BTCUSDT", "45m")

    asyncio.run(_run())


def test_bar_input_aliases_share_one_dedup_identity() -> None:
    def _input(interval: str) -> BarInput:
        return BarInput(
            symbol="BTCUSDT",
            source_interval=interval,
            open_time_ms=0,
            close_time_ms=3_599_999,
            open=1,
            high=2,
            low=0.5,
            close=1.5,
            volume=10,
            source=BarInputSource.BACKFILL,
            is_closed=True,
        )

    alias = _input("60m")
    canonical = _input("1h")

    assert alias.source_interval == "1h"
    assert alias.input_key == canonical.input_key


def test_derived_standard_components_accumulate_and_close_on_last_component() -> None:
    async def _run() -> None:
        aggregator = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        aggregator.add_target("BTC-USDT", "8h", exchange="okx")
        closed = []

        async def _capture(event) -> None:
            closed.append(event.bar)

        aggregator.publisher.on_bar_closed(_capture)
        bucket_open = aggregator.compute_bucket("8h", int(time.time() * 1000))
        assert bucket_open is not None
        four_hours = 4 * 3_600_000
        rows = [
            {
                **_row(bucket_open, 1),
                "close_time": bucket_open + four_hours - 1,
            },
            {
                **_row(bucket_open + four_hours, 2),
                "close_time": bucket_open + 2 * four_hours - 1,
            },
        ]

        await aggregator.on_backfill_bars(
            "BTC-USDT",
            "4h",
            rows,
            exchange="okx",
        )

        assert len(closed) == 1
        assert closed[0].interval == "8h"
        assert closed[0].open == 1
        assert closed[0].close == 2
        assert closed[0].volume == 3
        assert closed[0].tick_count == 2

    asyncio.run(_run())


def test_monthly_backfill_tasks_step_on_real_month_opens() -> None:
    target = parse_interval_spec("5M")
    base = parse_interval_spec("1M")
    assert target is not None and base is not None
    timestamp_ms = 1_709_208_000_000  # 2024-02-29
    bucket_open = target.floor_ms(timestamp_ms)
    next_target = target.next_ms(bucket_open)
    expected_last_base = base.previous_ms(next_target)
    gap = GapInfo(
        symbol="BTCUSDT",
        interval="5M",
        gap_type=GapType.INTERIOR,
        start_ms=timestamp_ms,
        end_ms=timestamp_ms,
        missing_bars=1,
        exchange="binance",
        market_type="spot",
    )

    plan = BackfillPlanner(BackfillConfig()).plan([gap])

    assert len(plan.tasks) == 1
    assert plan.tasks[0].interval == "1M"
    assert plan.tasks[0].start_ms == bucket_open
    assert plan.tasks[0].end_ms == expected_last_base
    assert plan.tasks[0].estimated_bars == 5


def test_router_resolves_each_target_purpose_once_not_per_event() -> None:
    class _SpyResolver:
        def __init__(self) -> None:
            self.delegate = IntervalResolver()
            self.calls = 0

        def resolve(self, **kwargs):
            self.calls += 1
            return self.delegate.resolve(**kwargs)

    async def _run() -> None:
        resolver = _SpyResolver()
        router = EventRouter(
            BarAggregatorConfig(),
            interval_resolver=resolver,  # type: ignore[arg-type]
        )
        routed = []

        async def _capture(*args) -> None:
            routed.append(args)

        router.set_on_bar_input(_capture)
        router.register_target("BTC-USDT", "8h", exchange="okx")
        assert resolver.calls == 2  # history + realtime pre-resolution
        for index in range(3):
            await router.on_backfill_bars(
                "BTC-USDT",
                "4h",
                [_row(index * 4 * 3_600_000, index + 1)],
                exchange="okx",
            )

        assert resolver.calls == 2
        assert len(routed) == 3

    asyncio.run(_run())


def test_realtime_fanout_policy_uses_timeline_tiling_not_global_names() -> None:
    policy = RealtimePolicy(
        update_mode=RealtimeUpdateMode.BASE_INTERVAL_FANOUT,
        base_interval="1m",
    )

    assert policy.needs_base_stream("45m")
    assert policy.needs_base_stream("1w")
    assert policy.needs_base_stream("1M")
    assert not policy.needs_base_stream("60s")
    assert policy.should_fanout_realtime_base("60s", "45m")
