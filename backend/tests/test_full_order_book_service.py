from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from functools import wraps
from typing import Any

import pytest

from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    SessionHealth,
    StreamType,
)
from app.data_engine.market_data.full_order_book import FullOrderBookEngine
from app.data_engine.market_data.full_order_book_service import FullOrderBookService
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _key(
    *,
    symbol: str = "BTCUSDT",
    market_type: str = "futures",
    update_interval_ms: int = 250,
) -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        market_type,
        symbol,
        MarketChannel.FULL_DEPTH,
        params={
            "mode": "full",
            "snapshot_limit": 1000,
            "update_interval_ms": update_interval_ms,
        },
    )


_FUTURE_TIME_MS = int(time.time() * 1000) + 60_000


def _delta(
    first_update_id: int,
    final_update_id: int,
    previous_final_update_id: int,
    *,
    bids: list[list[float]] | None = None,
    asks: list[list[float]] | None = None,
    symbol: str = "BTCUSDT",
    update_interval_ms: int = 250,
) -> MarketEvent:
    received_at_ms = _FUTURE_TIME_MS + final_update_id
    return MarketEvent(
        event_type=StreamType.FULL_DEPTH,
        symbol=symbol,
        exchange="binance",
        market_type="futures",
        event_time_ms=received_at_ms - 1,
        received_at_ms=received_at_ms,
        source=DataSource.WEBSOCKET,
        sequence=final_update_id,
        data={
            "kind": "delta",
            "first_update_id": first_update_id,
            "final_update_id": final_update_id,
            "previous_final_update_id": previous_final_update_id,
            "last_update_id": final_update_id,
            "event_time_ms": received_at_ms - 1,
            "transaction_time_ms": received_at_ms - 2,
            "update_interval_ms": update_interval_ms,
            "snapshot_limit": None,
            "bids": bids or [],
            "asks": asks or [],
        },
    )


def _rest_snapshot(
    last_update_id: int,
    *,
    bids: list[list[float]] | None = None,
    asks: list[list[float]] | None = None,
    symbol: str = "BTCUSDT",
    update_interval_ms: int = 250,
) -> MarketEvent:
    received_at_ms = _FUTURE_TIME_MS + last_update_id
    return MarketEvent(
        event_type=StreamType.FULL_DEPTH,
        symbol=symbol,
        exchange="binance",
        market_type="futures",
        event_time_ms=received_at_ms,
        received_at_ms=received_at_ms,
        source=DataSource.HTTP,
        sequence=last_update_id,
        data={
            "kind": "snapshot",
            "first_update_id": None,
            "final_update_id": None,
            "previous_final_update_id": None,
            "last_update_id": last_update_id,
            "event_time_ms": received_at_ms,
            "transaction_time_ms": None,
            "update_interval_ms": update_interval_ms,
            "snapshot_limit": 1000,
            "bids": bids or [[100.0, 2.0], [99.0, 1.0]],
            "asks": asks or [[101.0, 2.0], [102.0, 1.0]],
        },
    )


@dataclass(frozen=True, slots=True)
class _EngineSnapshot:
    identity: tuple[str, str, str, int]
    epoch: int
    last_update_id: int
    bids: tuple[tuple[float, float], ...]
    asks: tuple[tuple[float, float], ...]
    event_time_ms: int
    received_at_ms: int
    source: DataSource

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.identity[0],
            "market_type": self.identity[1],
            "symbol": self.identity[2],
            "update_interval_ms": self.identity[3],
            "epoch": self.epoch,
            "last_update_id": self.last_update_id,
            "snapshot_limit": 1000,
            "bids": [list(level) for level in self.bids],
            "asks": [list(level) for level in self.asks],
        }


@dataclass(frozen=True, slots=True)
class _EngineResult:
    action: str
    state: str
    epoch: int
    reason: str | None = None
    snapshot: _EngineSnapshot | None = None


@dataclass(slots=True)
class _EngineState:
    epoch: int = 0
    state: str = "inactive"
    buffered: list[MarketEvent] | None = None
    bids: dict[float, float] | None = None
    asks: dict[float, float] | None = None
    last_update_id: int | None = None
    last_event: MarketEvent | None = None


class _Engine:
    """Small deterministic engine double for service lifecycle tests."""

    def __init__(self, *, max_buffered: int = 64) -> None:
        self.states: dict[tuple[str, str, str, int], _EngineState] = {}
        self.max_buffered = max_buffered
        self.begin_calls = 0
        self.deactivate_calls = 0

    def activate_stream(self, identity):
        if identity in self.states:
            return False
        self.states[identity] = _EngineState()
        return True

    def deactivate_stream(self, identity):
        if identity not in self.states:
            return False
        self.states.pop(identity)
        self.deactivate_calls += 1
        return True

    def begin_sync(self, identity):
        state = self.states[identity]
        state.epoch += 1
        state.state = "buffering"
        state.buffered = []
        state.bids = {}
        state.asks = {}
        state.last_update_id = None
        state.last_event = None
        self.begin_calls += 1
        return state.epoch

    def apply_delta(self, identity, event, *, epoch):
        state = self.states[identity]
        if epoch != state.epoch:
            return _EngineResult("stale_epoch", state.state, state.epoch)
        if state.state == "buffering":
            assert state.buffered is not None
            if len(state.buffered) >= self.max_buffered:
                state.state = "resync_required"
                state.buffered.clear()
                return _EngineResult(
                    "resync_required",
                    state.state,
                    state.epoch,
                    "engine_buffer_overflow",
                )
            state.buffered.append(event)
            return _EngineResult("buffered", state.state, state.epoch)
        if state.state == "awaiting_bridge":
            return self._apply_bridge(identity, state, event)
        if state.state != "live":
            return _EngineResult(
                "resync_required",
                "resync_required",
                state.epoch,
                "engine_not_live",
            )
        previous = int(event.data["previous_final_update_id"])
        if previous != state.last_update_id:
            state.state = "resync_required"
            return _EngineResult(
                "resync_required",
                state.state,
                state.epoch,
                "previous_final_update_id_mismatch",
            )
        return self._apply_live(identity, state, event)

    def install_snapshot(self, identity, event, *, epoch):
        state = self.states[identity]
        if epoch != state.epoch:
            return _EngineResult("stale_epoch", state.state, state.epoch)
        state.bids = {float(price): float(qty) for price, qty in event.data["bids"]}
        state.asks = {float(price): float(qty) for price, qty in event.data["asks"]}
        state.last_update_id = int(event.data["last_update_id"])
        state.last_event = event
        buffered = list(state.buffered or [])
        state.buffered = []
        state.state = "awaiting_bridge"
        for delta in buffered:
            result = self._apply_bridge(identity, state, delta)
            if result.action == "resync_required":
                return result
            if state.state == "live":
                continue
        if state.state == "live":
            return _EngineResult(
                "snapshot_installed",
                "live",
                state.epoch,
                snapshot=self._snapshot(identity, state),
            )
        return _EngineResult("snapshot_installed", "awaiting_bridge", state.epoch)

    def diagnostics(self):
        return {
            "streams": len(self.states),
            "begin_calls": self.begin_calls,
            "deactivate_calls": self.deactivate_calls,
        }

    def _apply_bridge(self, identity, state, event):
        assert state.last_update_id is not None
        first = int(event.data["first_update_id"])
        final = int(event.data["final_update_id"])
        if final < state.last_update_id:
            return _EngineResult("stale", state.state, state.epoch)
        if first > state.last_update_id:
            state.state = "resync_required"
            return _EngineResult(
                "resync_required",
                state.state,
                state.epoch,
                "bridge_gap",
            )
        return self._apply_live(identity, state, event)

    def _apply_live(self, identity, state, event):
        assert state.bids is not None
        assert state.asks is not None
        for side_name, target in (("bids", state.bids), ("asks", state.asks)):
            for raw_price, raw_quantity in event.data[side_name]:
                price = float(raw_price)
                quantity = float(raw_quantity)
                if quantity == 0:
                    target.pop(price, None)
                else:
                    target[price] = quantity
        state.last_update_id = int(event.data["final_update_id"])
        state.last_event = event
        if not state.bids or not state.asks or max(state.bids) >= min(state.asks):
            state.state = "resync_required"
            return _EngineResult(
                "resync_required",
                state.state,
                state.epoch,
                "crossed_book",
            )
        state.state = "live"
        return _EngineResult(
            "applied",
            "live",
            state.epoch,
            snapshot=self._snapshot(identity, state),
        )

    @staticmethod
    def _snapshot(identity, state):
        assert state.bids is not None
        assert state.asks is not None
        assert state.last_event is not None
        assert state.last_update_id is not None
        return _EngineSnapshot(
            identity=identity,
            epoch=state.epoch,
            last_update_id=state.last_update_id,
            bids=tuple(sorted(state.bids.items(), reverse=True)),
            asks=tuple(sorted(state.asks.items())),
            event_time_ms=state.last_event.event_time_ms,
            received_at_ms=state.last_event.received_at_ms,
            source=state.last_event.source,
        )


@dataclass(slots=True)
class _FetchPlan:
    events: list[MarketEvent]
    gate: asyncio.Event | None = None
    ignore_cancellation: bool = False
    cancel_self: bool = False


@dataclass(slots=True)
class _Handle:
    factory: "_Factory"
    stopped: bool = False

    async def stop(self):
        self.factory.stop_calls += 1
        self.stopped = True
        return None


class _Factory:
    def __init__(self) -> None:
        self.order: list[str] = []
        self.prestart_events: list[MarketEvent] = []
        self.plans: deque[_FetchPlan] = deque()
        self.callbacks: list[Any] = []
        self.gap_callbacks: list[Any] = []
        self.health_callbacks: list[Any] = []
        self.start_calls = 0
        self.fetch_calls = 0
        self.fetch_cancellations = 0
        self.stop_calls = 0

    async def start_market(
        self,
        descriptor,
        callback,
        *,
        on_gap=None,
        on_health=None,
    ):
        assert descriptor.stream_type is StreamType.FULL_DEPTH
        assert descriptor.depth_levels is None
        self.order.append("start")
        self.start_calls += 1
        self.callbacks.append(callback)
        self.gap_callbacks.append(on_gap)
        self.health_callbacks.append(on_health)
        for event in self.prestart_events:
            await callback(event)
        return _Handle(self)

    async def fetch_market(self, descriptor, **kwargs):
        assert descriptor.stream_type is StreamType.FULL_DEPTH
        assert kwargs == {"limit": 1000, "history": False}
        self.order.append("fetch")
        self.fetch_calls += 1
        plan = self.plans.popleft()
        if plan.cancel_self:
            raise asyncio.CancelledError
        if plan.gate is not None:
            while not plan.gate.is_set():
                try:
                    await asyncio.shield(plan.gate.wait())
                except asyncio.CancelledError:
                    self.fetch_cancellations += 1
                    if not plan.ignore_cancellation:
                        raise
        return plan.events

    async def emit(self, event: MarketEvent, *, generation: int = -1) -> None:
        await self.callbacks[generation](event)

    async def gap(self, *, generation: int = -1) -> None:
        callback = self.gap_callbacks[generation]
        assert callback is not None
        await callback(object())

    async def health(
        self,
        health: SessionHealth,
        *,
        generation: int = -1,
    ) -> None:
        callback = self.health_callbacks[generation]
        assert callback is not None
        await callback(health, "test")


def _service(factory: _Factory, **kwargs) -> FullOrderBookService:
    return FullOrderBookService(
        factory,
        engine=kwargs.pop("engine", _Engine()),
        max_streams=kwargs.pop("max_streams", 8),
        upstream_queue_size=kwargs.pop("upstream_queue_size", 16),
        snapshot_timeout_seconds=kwargs.pop("snapshot_timeout_seconds", 1),
        resync_backoff_seconds=kwargs.pop("resync_backoff_seconds", 0),
        max_resync_backoff_seconds=kwargs.pop("max_resync_backoff_seconds", 0.01),
        **kwargs,
    )


async def _wait_until(predicate, *, timeout: float = 2.0) -> None:
    async def _wait() -> None:
        while not predicate():
            await asyncio.sleep(0.002)

    await asyncio.wait_for(_wait(), timeout=timeout)


@_async_test
async def test_websocket_starts_and_buffers_before_rest_snapshot_alignment() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99, bids=[[100.0, 3.0]])]
    factory.plans.append(_FetchPlan([_rest_snapshot(100)]))
    service = _service(factory)
    key = _key()

    assert await service.ensure_stream(key, consumer_id="first") is True
    record = await service.wait_for_live(key, timeout_seconds=1)

    assert factory.order == ["start", "fetch"]
    assert record.event.data["last_update_id"] == 101
    assert record.event.data["live"] is True
    assert service.diagnostics()["engine_buffered"] == 1
    await service.shutdown()


@_async_test
async def test_service_contract_integrates_with_real_reconstruction_engine() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99, bids=[[100.0, 3.0]])]
    factory.plans.append(_FetchPlan([_rest_snapshot(100)]))
    service = _service(factory, engine=FullOrderBookEngine(max_streams=4))
    key = _key()

    await service.ensure_stream(key, consumer_id="real-engine")
    initial = await service.wait_for_live(key, timeout_seconds=1)
    assert initial.event.data["last_update_id"] == 101
    assert initial.event.data["mode"] == "full_depth_reconstructed"
    assert initial.event.data["full_projection"] is True

    await factory.emit(
        _delta(
            102,
            102,
            101,
            asks=[[101.0, 0.0], [103.0, 4.0]],
        ),
    )
    await _wait_until(
        lambda: (
            (record := service.current(key)) is not None
            and record.event.data["last_update_id"] == 102
        ),
    )
    current = service.current(key)
    assert current is not None
    assert current.event.data["top_ask"] == 102.0
    assert [101.0, 0.0] not in current.event.data["asks"]
    engine_diagnostics = service.diagnostics()["engine"]
    assert engine_diagnostics["deltas_replayed"] == 1
    assert engine_diagnostics["deltas_applied"] == 1
    await service.shutdown()


@_async_test
async def test_exchange_clock_behind_initial_stale_timestamp_still_becomes_live() -> None:
    factory = _Factory()
    delta = _delta(100, 101, 99)
    delta.event_time_ms = 1
    delta.received_at_ms = 2
    delta.data["event_time_ms"] = 1
    snapshot = _rest_snapshot(100)
    snapshot.event_time_ms = 1
    snapshot.received_at_ms = 2
    snapshot.data["event_time_ms"] = 1
    factory.prestart_events = [delta]
    factory.plans.append(_FetchPlan([snapshot]))
    service = _service(factory, engine=FullOrderBookEngine(max_streams=4))
    key = _key()

    await service.ensure_stream(key, consumer_id="clock-skew")
    live = await service.wait_for_live(key, timeout_seconds=1)
    assert live.event.data["last_update_id"] == 101
    assert live.event.data["event_time_ms"] == 1
    assert live.event.event_time_ms > live.event.data["event_time_ms"]
    assert service.diagnostics()["hub_publish_rejected"] == 0
    await service.shutdown()


@_async_test
async def test_multiple_leases_share_one_physical_stream_until_last_release() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99)]
    factory.plans.append(_FetchPlan([_rest_snapshot(100)]))
    service = _service(factory)
    key = _key()

    assert await service.ensure_stream(key, consumer_id="one") is True
    assert await service.ensure_stream(key, consumer_id="one") is False
    assert await service.ensure_stream(key, consumer_id="two") is True
    await service.wait_for_live(key, timeout_seconds=1)
    assert factory.start_calls == 1
    assert await service.release_stream(key, consumer_id="one") is True
    assert factory.stop_calls == 0
    assert await service.release_stream(key, consumer_id="two") is True
    assert factory.stop_calls == 1
    assert service.current(key) is None
    await service.shutdown()


@_async_test
async def test_gap_publishes_empty_stale_state_and_only_recovers_after_new_bridge() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99)]
    factory.plans.extend([
        _FetchPlan([_rest_snapshot(100)]),
        _FetchPlan([_rest_snapshot(200)]),
    ])
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="one")
    await service.wait_for_live(key, timeout_seconds=1)
    attachment = service.attach(key)
    await attachment.subscription.receive()  # replayed live state

    await factory.gap()
    assert service.current(key) is None
    stale = await asyncio.wait_for(attachment.subscription.receive(), timeout=1)
    assert stale is not None
    assert stale.event.data["live"] is False
    assert stale.event.data["stale_reason"] == "ingestion_gap"
    assert stale.event.data["bids"] == []
    assert stale.event.data["asks"] == []
    assert stale.event.data["last_live_update_id"] == 101
    assert stale.event.data["local_sequence_continuity"] is False
    assert stale.event.data["event_time_ms"] is None

    await _wait_until(lambda: factory.fetch_calls == 2)
    assert service.current(key) is None
    await factory.emit(_delta(200, 201, 199, bids=[[100.0, 4.0]]))
    recovered = await service.wait_for_live(key, timeout_seconds=1)
    assert recovered.event.data["last_update_id"] == 201
    diagnostics = service.diagnostics()
    assert diagnostics["resyncs_succeeded"] == 2
    assert diagnostics["ingestion_gaps"] == 1
    await attachment.subscription.close()
    await service.shutdown()


@_async_test
async def test_reconnect_health_break_immediately_fails_closed_and_resyncs_once() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99)]
    factory.plans.extend([
        _FetchPlan([_rest_snapshot(100)]),
        _FetchPlan([_rest_snapshot(200)]),
    ])
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="one")
    await service.wait_for_live(key, timeout_seconds=1)

    await factory.health(SessionHealth.RECONNECTING)
    assert service.current(key) is None
    stale = service.current(key, require_live=False)
    assert stale is not None
    assert stale.event.data["stale_reason"] == "ingestion_reconnecting"
    version = stale.event.data["resync_version"]
    await factory.health(SessionHealth.UNHEALTHY)
    assert service.current(key, require_live=False).event.data["resync_version"] == version

    await _wait_until(lambda: factory.fetch_calls == 2)
    await factory.health(SessionHealth.CONNECTED)
    await factory.emit(_delta(200, 201, 199))
    recovered = await service.wait_for_live(key, timeout_seconds=1)
    assert recovered.event.data["last_update_id"] == 201
    diagnostics = service.diagnostics()
    assert diagnostics["upstream_health_breaks"] == 1
    assert diagnostics["upstream_health_connected"] == 1
    assert diagnostics["actors"][0]["upstream_health"] == "connected"
    await service.shutdown()


@_async_test
async def test_upstream_queue_overflow_is_explicit_and_realigns_from_new_epoch() -> None:
    factory = _Factory()
    factory.prestart_events = [
        _delta(100, 101, 99),
        _delta(101, 102, 100, bids=[[100.0, 5.0]]),
    ]
    snapshot_gate = asyncio.Event()
    factory.plans.append(_FetchPlan([_rest_snapshot(101)], gate=snapshot_gate))
    service = _service(factory, upstream_queue_size=1)
    key = _key()

    await service.ensure_stream(key, consumer_id="one")
    await _wait_until(lambda: factory.fetch_calls == 1)
    assert service.current(key) is None
    stale = service.current(key, require_live=False)
    assert stale is not None
    assert stale.event.data["stale_reason"] == "upstream_queue_overflow"
    assert stale.event.data["resync_version"] == 2
    diagnostics = service.diagnostics()
    assert diagnostics["upstream_queue_overflows"] == 1
    assert diagnostics["deltas_enqueued"] == 2
    assert diagnostics["deltas_old_epoch_discarded"] == 1

    snapshot_gate.set()
    recovered = await service.wait_for_live(key, timeout_seconds=1)
    assert recovered.event.data["last_update_id"] == 102
    assert recovered.event.data["resync_version"] == 2
    await service.shutdown()


@_async_test
async def test_crossed_live_book_fails_closed_and_starts_resync() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99)]
    factory.plans.extend([
        _FetchPlan([_rest_snapshot(100)]),
        _FetchPlan([_rest_snapshot(200)]),
    ])
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="one")
    await service.wait_for_live(key, timeout_seconds=1)

    await factory.emit(_delta(102, 102, 101, bids=[[102.0, 1.0]]))
    await _wait_until(lambda: service.current(key) is None)
    stale = service.current(key, require_live=False)
    assert stale is not None
    assert stale.event.data["stale_reason"] == "crossed_book"
    await _wait_until(lambda: factory.fetch_calls == 2)

    await factory.emit(_delta(200, 201, 199))
    recovered = await service.wait_for_live(key, timeout_seconds=1)
    assert recovered.event.data["last_update_id"] == 201
    assert service.diagnostics()["engine_resync_required"] == 1
    await service.shutdown()


@_async_test
async def test_late_cancel_resistant_rest_result_cannot_overwrite_new_epoch() -> None:
    factory = _Factory()
    old_gate = asyncio.Event()
    factory.plans.extend([
        _FetchPlan(
            [_rest_snapshot(100)],
            gate=old_gate,
            ignore_cancellation=True,
        ),
        _FetchPlan([_rest_snapshot(200)]),
    ])
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="one")
    await _wait_until(lambda: factory.fetch_calls == 1)

    await factory.gap()
    await _wait_until(lambda: factory.fetch_calls == 2)
    await factory.emit(_delta(200, 201, 199))
    live = await service.wait_for_live(key, timeout_seconds=1)
    assert live.event.data["last_update_id"] == 201
    live_version = live.event.data["resync_version"]

    old_gate.set()
    await _wait_until(lambda: not service._snapshot_tasks)
    current = service.current(key)
    assert current is not None
    assert current.event.data["last_update_id"] == 201
    assert current.event.data["resync_version"] == live_version
    assert service.diagnostics()["snapshot_results_discarded"] >= 1
    assert factory.fetch_cancellations >= 1
    await service.shutdown()


@_async_test
async def test_old_physical_callback_cannot_mutate_restarted_generation() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99)]
    factory.plans.append(_FetchPlan([_rest_snapshot(100)]))
    service = _service(factory)
    key = _key()

    await service.ensure_stream(key, consumer_id="first")
    first = await service.wait_for_live(key, timeout_seconds=1)
    old_callback = factory.callbacks[0]
    assert await service.release_stream(key, consumer_id="first") is True

    factory.prestart_events = [_delta(300, 301, 299)]
    factory.plans.append(_FetchPlan([_rest_snapshot(300)]))
    await service.ensure_stream(key, consumer_id="second")
    second = await service.wait_for_live(key, timeout_seconds=1)
    assert second.event.data["generation"] > first.event.data["generation"]
    assert second.event.data["last_update_id"] == 301

    await old_callback(_delta(999, 1000, 998, bids=[[100.0, 99.0]]))
    await asyncio.sleep(0)
    current = service.current(key)
    assert current is not None
    assert current.event.data["last_update_id"] == 301
    assert service.diagnostics()["events_after_stop"] == 1
    await service.shutdown()


@_async_test
async def test_shutdown_is_bounded_when_rest_fetch_ignores_cancellation() -> None:
    factory = _Factory()
    fetch_gate = asyncio.Event()
    factory.plans.append(_FetchPlan(
        [_rest_snapshot(100)],
        gate=fetch_gate,
        ignore_cancellation=True,
    ))
    service = _service(factory, physical_stop_timeout_seconds=0.02)
    key = _key()
    await service.ensure_stream(key, consumer_id="one")
    await _wait_until(lambda: factory.fetch_calls == 1)

    await asyncio.wait_for(service.shutdown(), timeout=0.2)
    diagnostics = service.diagnostics()
    assert diagnostics["state"] == "closed"
    assert diagnostics["shutdown"]["degraded"] is True
    assert diagnostics["snapshot_shutdown_timeouts"] == 1

    fetch_gate.set()
    await _wait_until(lambda: not service._snapshot_tasks)


@_async_test
async def test_independently_cancelled_snapshot_fetch_retries_instead_of_killing_actor() -> None:
    factory = _Factory()
    factory.plans.extend([
        _FetchPlan([], cancel_self=True),
        _FetchPlan([_rest_snapshot(200)]),
    ])
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="one")
    await _wait_until(lambda: factory.fetch_calls == 2)

    assert service.current(key) is None
    await factory.emit(_delta(200, 201, 199))
    live = await service.wait_for_live(key, timeout_seconds=1)
    assert live.event.data["last_update_id"] == 201
    diagnostics = service.diagnostics()
    assert diagnostics["snapshot_fetch_errors"] == 1
    assert diagnostics["resyncs_failed"] == 1
    await service.shutdown()


@_async_test
async def test_downstream_subscription_coalesces_replaceable_live_snapshots() -> None:
    factory = _Factory()
    factory.prestart_events = [_delta(100, 101, 99)]
    factory.plans.append(_FetchPlan([_rest_snapshot(100)]))
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="one")
    await service.wait_for_live(key, timeout_seconds=1)
    attachment = service.attach(key, max_pending=1)
    await attachment.subscription.receive()

    await factory.emit(_delta(102, 102, 101, bids=[[100.0, 3.0]]))
    await factory.emit(_delta(103, 103, 102, bids=[[100.0, 4.0]]))
    await factory.emit(_delta(104, 104, 103, bids=[[100.0, 5.0]]))
    await _wait_until(
        lambda: (
            (record := service.current(key)) is not None
            and record.event.data["last_update_id"] == 104
        ),
    )

    assert attachment.subscription.pending_count == 1
    latest = await attachment.subscription.receive()
    assert latest is not None
    assert latest.event.data["last_update_id"] == 104
    assert service.diagnostics()["hub"]["subscriber_coalesced"] >= 2
    await attachment.subscription.close()
    await service.shutdown()


@_async_test
async def test_engine_buffer_capacity_break_is_visible_and_resynced() -> None:
    factory = _Factory()
    factory.prestart_events = [
        _delta(100, 101, 99),
        _delta(101, 102, 100),
    ]
    old_gate = asyncio.Event()
    factory.plans.extend([
        _FetchPlan([_rest_snapshot(100)], gate=old_gate),
        _FetchPlan([_rest_snapshot(200)]),
    ])
    service = _service(factory, engine=_Engine(max_buffered=1))
    key = _key()
    await service.ensure_stream(key, consumer_id="one")

    await _wait_until(lambda: factory.fetch_calls == 2)
    stale = service.current(key, require_live=False)
    assert stale is not None
    assert stale.event.data["stale_reason"] == "engine_buffer_overflow"
    assert service.diagnostics()["engine_resync_required"] == 1
    await factory.emit(_delta(200, 201, 199))
    recovered = await service.wait_for_live(key, timeout_seconds=1)
    assert recovered.event.data["last_update_id"] == 201
    await service.shutdown()


@_async_test
async def test_invalid_key_is_rejected_before_physical_start() -> None:
    factory = _Factory()
    service = _service(factory)
    invalid = MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.FULL_DEPTH,
        params={"mode": "full", "snapshot_limit": 1000},
    )

    with pytest.raises(ValueError, match="requires exactly"):
        await service.ensure_stream(invalid, consumer_id="one")
    with pytest.raises(ValueError, match="'spot' or 'futures'"):
        await service.ensure_stream(
            _key(market_type="margin"),
            consumer_id="margin",
        )
    with pytest.raises(ValueError, match="100, 1000"):
        await service.ensure_stream(
            _key(market_type="spot", update_interval_ms=250),
            consumer_id="spot-wrong-speed",
        )
    spot = _key(market_type="spot", update_interval_ms=1000)
    assert service._validate_key(spot) == spot
    assert factory.start_calls == 0
    await service.shutdown()
