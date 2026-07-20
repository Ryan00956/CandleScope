from __future__ import annotations

import asyncio
import time as py_time
from unittest.mock import patch

from app.data_engine.bar_aggregator import (
    BarAggregator,
    BarAggregatorConfig,
    BarEvent,
    BarEventType,
    BarState,
)
from app.data_engine.data_manager.aggregator_bridge import AggregatorBridge
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.event_bus import DataEventBus
from app.data_engine.data_manager.models import DataEventType, SeriesKey
from app.data_engine.data_manager.warm_start import AggregatorWarmStartService


def _row(open_time_ms: int, interval_ms: int, close: float) -> dict:
    return {
        "open_time": open_time_ms,
        "close_time": open_time_ms + interval_ms - 1,
        "open": close,
        "high": close + 2,
        "low": close - 1,
        "close": close + 1,
        "volume": close * 10,
        "quote_volume": close * 100,
        "trades": int(close),
        "taker_buy_base": close,
        "taker_buy_quote": close * 2,
    }


class _Storage:
    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows = rows or []
        self.query_calls: list[dict] = []
        self.upsert_calls: list[dict] = []

    def query_bars(self, **kwargs):
        self.query_calls.append(kwargs)
        return list(self.rows)

    def upsert_bars(
        self,
        symbol,
        interval,
        rows,
        source,
        exchange,
        market_type,
    ) -> None:
        self.upsert_calls.append({
            "symbol": symbol,
            "interval": interval,
            "rows": rows,
            "source": source,
            "exchange": exchange,
            "market_type": market_type,
        })


async def _wait_until(predicate, *, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    assert predicate()


def _service(
    *,
    cache: BarCache,
    aggregator: BarAggregator,
    storage: _Storage,
    triggers: list[tuple],
    base_interval: str = "1m",
) -> AggregatorWarmStartService:
    return AggregatorWarmStartService(
        cache=cache,
        bar_aggregator=aggregator,
        base_interval=base_interval,
        storage_provider=lambda: storage,  # type: ignore[return-value]
        backfill_trigger_provider=lambda: (lambda *args: triggers.append(args)),
    )


def test_warm_start_standard_interval_seeds_active_bar_without_events() -> None:
    async def _run() -> None:
        fixed_now_ms = int(py_time.time() * 1000)
        fixed_time = fixed_now_ms / 1000
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "1m", exchange="okx", market_type="spot")
        bucket_start_ms = agg.compute_bucket("1m", fixed_now_ms)
        assert bucket_start_ms is not None

        events = []

        async def _capture(event):
            events.append(event)

        agg.publisher.on_bar_event(_capture)
        storage = _Storage(rows=[_row(bucket_start_ms, 60_000, close=10)])
        cache = BarCache()
        triggers: list[tuple] = []
        service = _service(
            cache=cache,
            aggregator=agg,
            storage=storage,
            triggers=triggers,
        )

        with patch("app.data_engine.data_manager.warm_start.time.time", return_value=fixed_time):
            await service.seed_if_needed(
                "BTC-USDT",
                "1m",
                exchange="okx",
                market_type="spot",
                had_stream=False,
            )

        state = agg.get_bucket_state(
            "BTC-USDT",
            "1m",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.open == 10
        assert state.high == 12
        assert state.low == 9
        assert state.close == 11
        assert state.volume == 100
        assert state.quote_volume == 1_000
        assert state.enhanced_fields == frozenset({"quote_volume"})
        assert state.exchange == "okx"
        assert state.market_type == "spot"
        assert storage.query_calls == [{
            "symbol": "BTC-USDT",
            "interval": "1m",
            "start_ms": bucket_start_ms,
            "end_ms": bucket_start_ms,
            "limit": 1,
            "order": "ASC",
            "exchange": "okx",
            "market_type": "spot",
        }]
        assert events == []
        assert triggers == []

    asyncio.run(_run())


def test_warm_start_custom_interval_replays_components_and_warms_cache() -> None:
    async def _run() -> None:
        fixed_now_ms = int(py_time.time() * 1000)
        fixed_time = fixed_now_ms / 1000
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        bucket_start_ms = agg.compute_bucket("45m", fixed_now_ms)
        assert bucket_start_ms is not None

        base_ms = 15 * 60_000
        elapsed_ms = max(0, fixed_now_ms - bucket_start_ms)
        component_count = max(1, min(3, int(elapsed_ms // base_ms) + 1))
        rows = [
            _row(bucket_start_ms + (idx * base_ms), base_ms, close=10 + idx)
            for idx in range(component_count)
        ]
        storage = _Storage(rows=rows)
        cache = BarCache()
        triggers: list[tuple] = []
        service = _service(
            cache=cache,
            aggregator=agg,
            storage=storage,
            triggers=triggers,
            base_interval="15m",
        )

        with patch("app.data_engine.data_manager.warm_start.time.time", return_value=fixed_time):
            await service.seed_if_needed(
                "BTC-USDT",
                "45m",
                exchange="okx",
                market_type="spot",
                had_stream=True,
            )

        state = agg.get_bucket_state(
            "BTC-USDT",
            "45m",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.open == 10
        assert state.high == max(row["high"] for row in rows)
        assert state.low == min(row["low"] for row in rows)
        assert state.close == rows[-1]["close"]
        assert state.volume == sum(row["volume"] for row in rows)
        assert state.quote_volume == sum(row["quote_volume"] for row in rows)
        assert state.enhanced_fields == frozenset({"quote_volume"})
        assert state.tick_count == len(rows)
        assert len(state.source_snapshots) == len(rows)

        cached = cache.get_latest(
            SeriesKey("BTC-USDT", "45m", exchange="okx", market_type="spot"),
            1,
        )
        assert cached and cached[0].close == state.close
        assert cached[0].quote_volume == state.quote_volume
        assert storage.query_calls[0]["interval"] == "15m"
        assert storage.query_calls[0]["exchange"] == "okx"
        assert storage.query_calls[0]["market_type"] == "spot"
        assert triggers == []

    asyncio.run(_run())


def test_warm_start_exchange_derived_standard_uses_resolved_four_hour_base() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "8h", exchange="okx", market_type="spot")
        bucket_start_ms = agg.compute_bucket("8h", 1_750_000_000_000)
        assert bucket_start_ms is not None
        fixed_now_ms = bucket_start_ms + 5 * 3_600_000
        four_hours_ms = 4 * 3_600_000
        rows = [
            _row(bucket_start_ms, four_hours_ms, close=10),
            _row(bucket_start_ms + four_hours_ms, four_hours_ms, close=20),
        ]
        storage = _Storage(rows=rows)
        service = _service(
            cache=BarCache(),
            aggregator=agg,
            storage=storage,
            triggers=[],
            base_interval="1m",
        )

        with patch(
            "app.data_engine.data_manager.warm_start.time.time",
            return_value=fixed_now_ms / 1000,
        ):
            await service.seed_if_needed(
                "BTC-USDT",
                "8h",
                exchange="okx",
                market_type="spot",
                had_stream=True,
            )

        state = agg.get_bucket_state(
            "BTC-USDT",
            "8h",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert storage.query_calls[0]["interval"] == "4h"
        assert state is not None
        assert state.open == 10
        assert state.close == 21
        assert state.volume == 300
        assert state.tick_count == 2

    asyncio.run(_run())


def test_custom_sync_ignores_rows_from_previous_target_bucket() -> None:
    bucket_start = 45 * 60_000
    base_ms = 15 * 60_000
    previous = _row(bucket_start - base_ms, base_ms, close=9)
    current = [
        _row(bucket_start, base_ms, close=10),
        _row(bucket_start + base_ms, base_ms, close=11),
    ]
    current[-1]["is_closed"] = False
    state = BarState(
        symbol="BTC-USDT",
        interval="45m",
        bucket_start_ms=bucket_start,
        bucket_end_ms=bucket_start + (45 * 60_000),
        open=current[0]["open"],
        high=max(row["high"] for row in current),
        low=min(row["low"] for row in current),
        close=current[-1]["close"],
        volume=sum(row["volume"] for row in current),
        exchange="okx",
        market_type="spot",
        quote_volume=sum(row["quote_volume"] for row in current),
        trades=sum(row["trades"] for row in current),
        taker_buy_base=sum(row["taker_buy_base"] for row in current),
        taker_buy_quote=sum(row["taker_buy_quote"] for row in current),
        enhanced_fields=frozenset({"quote_volume"}),
        tick_count=len(current),
    )

    assert AggregatorWarmStartService._custom_bucket_is_synced(
        state,
        [previous, *current],
        exchange="okx",
        market_type="spot",
    )


def test_warm_start_marks_full_subscription_base_backfill_priority() -> None:
    async def _run() -> None:
        fixed_now_ms = (10 * 60 * 60 * 1000) + (50 * 60 * 1000)
        fixed_time = fixed_now_ms / 1000
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        bucket_start_ms = agg.compute_bucket("45m", fixed_now_ms)
        assert bucket_start_ms is not None

        storage = _Storage(rows=[])
        cache = BarCache()
        calls: list[tuple[tuple, dict]] = []
        service = AggregatorWarmStartService(
            cache=cache,
            bar_aggregator=agg,
            base_interval="15m",
            storage_provider=lambda: storage,  # type: ignore[return-value]
            backfill_trigger_provider=lambda: (
                lambda *args, **kwargs: calls.append((args, kwargs))
            ),
        )

        with patch("app.data_engine.data_manager.warm_start.time.time", return_value=fixed_time):
            await service.seed_if_needed(
                "BTC-USDT",
                "45m",
                exchange="okx",
                market_type="spot",
                had_stream=True,
                focus_scope="subscription",
                subscription_tier="full",
            )

        assert len(calls) == 1
        args, kwargs = calls[0]
        assert args == (
            "BTC-USDT",
            "15m",
            bucket_start_ms,
            fixed_now_ms,
            "okx",
            "spot",
        )
        assert kwargs["reason"] == "full_subscription_warmup"
        assert kwargs["priority"] == 60
        assert kwargs["requester"] == "warm_start_custom_seed"
        assert kwargs["metadata"]["focus_scope"] == "subscription"
        assert kwargs["metadata"]["subscription_tier"] == "full"
        assert kwargs["metadata"]["requested_interval"] == "45m"

    asyncio.run(_run())


def test_aggregator_bridge_persists_closed_and_amended_events() -> None:
    async def _run() -> None:
        cache = BarCache()
        bus = DataEventBus()
        storage = _Storage()
        marked: list[SeriesKey] = []
        events = []

        async def _capture(event):
            events.append(event)

        bus.subscribe(_capture)
        bridge = AggregatorBridge(
            cache=cache,
            event_bus=bus,
            storage_provider=lambda: storage,  # type: ignore[return-value]
            mark_bar_received=marked.append,
            is_started=lambda: True,
        )

        original = BarState(
            symbol="BTC-USDT",
            interval="1m",
            bucket_start_ms=60_000,
            bucket_end_ms=120_000,
            open=1,
            high=3,
            low=0.5,
            close=2,
            volume=10,
            exchange="okx",
            market_type="spot",
        )
        amended = BarState(
            symbol="BTC-USDT",
            interval="1m",
            bucket_start_ms=60_000,
            bucket_end_ms=120_000,
            open=1.5,
            high=4,
            low=1,
            close=3,
            volume=20,
            exchange="okx",
            market_type="spot",
        )

        await bridge.on_bar_event(BarEvent(BarEventType.CLOSED, original))
        await bridge.on_bar_event(
            BarEvent(BarEventType.AMENDED, amended, previous_bar=original)
        )

        key = SeriesKey("BTC-USDT", "1m", exchange="okx", market_type="spot")
        assert [call["source"] for call in storage.upsert_calls] == [
            "data_manager_closed",
            "data_manager_amended",
        ]
        assert storage.upsert_calls[1]["rows"][0]["close"] == 3
        assert storage.upsert_calls[1]["rows"][0]["quote_volume"] is None
        assert storage.upsert_calls[1]["rows"][0]["trades"] is None
        assert storage.upsert_calls[1]["exchange"] == "okx"
        assert storage.upsert_calls[1]["market_type"] == "spot"
        assert cache.get_latest(key, 1)[0].close == 3
        assert marked == [key, key]
        await _wait_until(lambda: len(events) == 2)
        assert [event.event_type for event in events] == [
            DataEventType.BAR_CLOSED,
            DataEventType.BAR_AMENDED,
        ]
        assert events[1].previous_bar is not None
        assert events[1].previous_bar.close == 2
        await bus.close()

    asyncio.run(_run())
