from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import wraps
from pathlib import Path

import pytest

import app.data_engine.market_data.liquidation_service as liquidation_service_module
from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.append_hub import AppendBatchHub
from app.data_engine.market_data.liquidation import LiquidationEngine
from app.data_engine.market_data.liquidation_service import LiquidationService
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.storage.liquidation_store import SQLiteLiquidationRollupStore
from app.data_engine.storage.liquidation_writer import LiquidationRollupWriter


MINUTE = 60_000
START_MS = 1_700_000_040_000
IDENTITY = ("binance", "futures", "BTCUSDT")


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


@dataclass
class _Handle:
    factory: "_Factory"
    identity: tuple[str, str, str]
    stopped: bool = False

    async def stop(self) -> bool | None:
        self.factory.stop_invocations += 1
        if self.factory.stop_gate is not None:
            self.factory.stop_started.set()
            while True:
                try:
                    await self.factory.stop_gate.wait()
                except asyncio.CancelledError:
                    if not self.factory.stop_ignores_cancellation:
                        raise
                else:
                    break
        if self.factory.stop_error is not None:
            raise self.factory.stop_error
        if self.factory.stop_returns_false:
            return False
        if not self.stopped:
            self.stopped = True
            self.factory.stop_calls.append(self.identity)
        return None


class _Factory:
    def __init__(self) -> None:
        self.start_calls = []
        self.stop_calls: list[tuple[str, str, str]] = []
        self.callbacks = {}
        self.stop_gate: asyncio.Event | None = None
        self.stop_started = asyncio.Event()
        self.stop_error: Exception | None = None
        self.stop_returns_false = False
        self.stop_ignores_cancellation = False
        self.stop_invocations = 0

    async def start_market(self, descriptor, callback, *, on_gap=None):
        assert on_gap is None
        identity = (
            descriptor.exchange,
            descriptor.market_type,
            descriptor.symbol,
        )
        self.start_calls.append(descriptor)
        self.callbacks[identity] = callback
        return _Handle(self, identity)

    async def emit(self, event: MarketEvent) -> None:
        identity = (event.exchange, event.market_type, event.symbol)
        await self.callbacks[identity](event)


def _event(
    nonce: int,
    *,
    symbol: str = "BTCUSDT",
    order_side: str = "SELL",
    trade_time_ms: int | None = None,
    event_time_ms: int | None = None,
    received_at_ms: int | None = None,
    average_price: float | None = None,
    filled_quantity: float = 1.0,
) -> MarketEvent:
    trade_time = START_MS + nonce if trade_time_ms is None else trade_time_ms
    event_time = trade_time + 1 if event_time_ms is None else event_time_ms
    received_at = event_time + 1 if received_at_ms is None else received_at_ms
    price = 100.0 + nonce if average_price is None else average_price
    position_side = "long" if order_side == "SELL" else "short"
    return MarketEvent(
        event_type=StreamType.LIQUIDATION,
        symbol=symbol,
        exchange="binance",
        market_type="futures",
        event_time_ms=event_time,
        received_at_ms=received_at,
        source=DataSource.WEBSOCKET,
        data={
            "order_side": order_side,
            "position_side": position_side,
            "order_type": "LIMIT",
            "time_in_force": "IOC",
            "original_quantity": filled_quantity,
            "order_price": price,
            "average_price": price,
            "order_status": "FILLED",
            "last_filled_quantity": filled_quantity,
            "filled_quantity": filled_quantity,
            "trade_time_ms": trade_time,
            "symbol_type": "UM",
        },
    )


def _key(
    symbol: str = "BTCUSDT",
    *,
    market_type: str = "futures",
    channel: MarketChannel = MarketChannel.LIQUIDATION,
) -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        market_type,
        symbol,
        channel,
    )


def _service(
    factory: _Factory,
    db_path: Path,
    **kwargs,
) -> LiquidationService:
    store = kwargs.pop("rollup_store", SQLiteLiquidationRollupStore(db_path))
    writer = kwargs.pop(
        "rollup_writer",
        LiquidationRollupWriter(store, flush_interval_seconds=0.01),
    )
    return LiquidationService(
        factory,
        engine=kwargs.pop("engine", LiquidationEngine()),
        rollup_store=store,
        rollup_writer=writer,
        flush_interval_seconds=kwargs.pop("flush_interval_seconds", 1.0),
        finalize_interval_seconds=kwargs.pop("finalize_interval_seconds", 60.0),
        **kwargs,
    )


async def _wait_until(predicate, *, timeout: float = 2.0) -> None:
    async def _wait() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(_wait(), timeout=timeout)


def _stored_row(
    *,
    bucket_open_ms: int,
    position_side: str,
    filled_quantity: float,
    filled_notional: float,
    event_count: int = 1,
    is_final: bool = True,
    revision: int = 1,
) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "bucket_open_ms": bucket_open_ms,
        "bucket_close_ms": bucket_open_ms + MINUTE,
        "position_side": position_side,
        "filled_quantity": filled_quantity,
        "filled_notional": filled_notional,
        "event_count": event_count,
        "max_event_notional": filled_notional,
        "first_event_time_ms": bucket_open_ms + 1,
        "last_event_time_ms": bucket_open_ms + 1,
        "is_final": is_final,
        "revision": revision,
        "source": "seed",
        "received_at_ms": bucket_open_ms + 10,
    }


@_async_test
async def test_consumer_leases_share_one_physical_feed_until_last_release(
    tmp_path,
) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path / "liquidation.sqlite")

    assert await service.ensure_stream(_key(), consumer_id="first") is True
    assert await service.ensure_stream(_key(), consumer_id="first") is False
    assert await service.ensure_stream(_key(), consumer_id="second") is True
    assert len(factory.start_calls) == 1
    assert factory.start_calls[0].stream_type is StreamType.LIQUIDATION
    assert service.engine.diagnostics()["active_streams"] == 1

    assert await service.release_stream(_key(), consumer_id="first") is True
    assert factory.stop_calls == []
    assert await service.release_stream(_key(), consumer_id="second") is True
    assert factory.stop_calls == [IDENTITY]
    assert service.diagnostics()["physical_streams"] == 0
    assert service.engine.diagnostics()["active_streams"] == 0
    await service.shutdown()


@_async_test
async def test_binance_spot_and_wrong_channel_are_rejected_before_start(
    tmp_path,
) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path / "liquidation.sqlite")

    with pytest.raises(ValueError, match="market_type='futures'"):
        await service.ensure_stream(_key(market_type="spot"), consumer_id="spot")
    with pytest.raises(ValueError, match="only accepts liquidation keys"):
        await service.ensure_stream(
            _key(channel=MarketChannel.AGG_TRADE),
            consumer_id="wrong-channel",
        )
    assert factory.start_calls == []
    await service.shutdown()


@_async_test
async def test_event_ingest_deduplicates_exact_payload_and_exposes_recent(
    tmp_path,
) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path / "liquidation.sqlite")
    await service.ensure_stream(_key(), consumer_id="recent")
    original = _event(1, received_at_ms=START_MS + 100)
    duplicate = _event(1, received_at_ms=START_MS + 500)

    await factory.emit(original)
    await factory.emit(duplicate)
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 2)

    recent = service.recent(_key())
    assert len(recent) == 1
    assert recent[0].fingerprint == recent[0].to_dict()["fingerprint"]
    assert recent[0].executed_notional == 101.0
    assert service.engine.diagnostics()["duplicates_rejected"] == 1
    assert service.diagnostics()["physical"][0]["last_event_time_ms"] == START_MS + 1
    await service.shutdown()


@_async_test
async def test_history_merges_live_and_persisted_rows_and_filters_side(
    tmp_path,
) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path / "liquidation.sqlite")
    await service.rollup_store.upsert_rollups([
        _stored_row(
            bucket_open_ms=START_MS,
            position_side="long",
            filled_quantity=5,
            filled_notional=500,
        ),
    ])
    # Same-key live provisional data must not replace an already final row.
    service.engine.ingest(
        _event(
            1,
            trade_time_ms=START_MS + 1,
            average_price=10,
            filled_quantity=1,
        ),
    )
    service.engine.ingest(
        _event(
            2,
            order_side="BUY",
            trade_time_ms=START_MS + 2,
            average_price=10,
            filled_quantity=3,
        ),
    )

    all_rows = await service.history(_key(), limit=10)
    short_rows = await service.history(_key(), position_side="short", limit=10)

    assert [
        (row["bucket_start_ms"], row["position_side"])
        for row in all_rows
    ] == [
        (START_MS, "long"),
        (START_MS, "short"),
    ]
    assert all_rows[0]["filled_notional"] == 500
    assert all_rows[0]["is_final"] is True
    assert all_rows[0]["updated_at_ms"] == START_MS + 10
    assert "received_at_ms" not in all_rows[0]
    assert "bucket_open_ms" not in all_rows[0]
    assert "bucket_close_ms" not in all_rows[0]
    assert "source" not in all_rows[0]
    assert [row["position_side"] for row in short_rows] == ["short"]
    assert short_rows[-1]["filled_notional"] == 30
    await service.shutdown()


@_async_test
async def test_wall_clock_finalization_persists_without_a_later_event(
    tmp_path,
    monkeypatch,
) -> None:
    clock_ms = [START_MS + 1_000]
    monkeypatch.setattr(
        liquidation_service_module.time,
        "time",
        lambda: clock_ms[0] / 1000,
    )
    factory = _Factory()
    service = _service(
        factory,
        tmp_path / "liquidation.sqlite",
        finalize_interval_seconds=0.1,
    )
    await service.ensure_stream(_key(), consumer_id="wall-clock")
    await factory.emit(_event(1, trade_time_ms=START_MS + 1))
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 1)

    clock_ms[0] = START_MS + MINUTE
    await _wait_until(lambda: service.diagnostics()["wall_clock_finalizations"] == 1)

    async def _wait_for_final_row() -> list[dict]:
        while True:
            rows = await service.rollup_store.query_rollups(
                exchange="binance",
                market_type="futures",
                symbol="BTCUSDT",
            )
            if rows and rows[0]["is_final"] == 1:
                return rows
            await asyncio.sleep(0.005)

    rows = await asyncio.wait_for(_wait_for_final_row(), timeout=2)
    assert len(rows) == 1
    assert rows[0]["is_final"] == 1
    assert rows[0]["bucket_open_ms"] == START_MS
    await service.shutdown()


@_async_test
async def test_persisted_baseline_is_seeded_across_service_restart(
    tmp_path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "liquidation.sqlite"
    monkeypatch.setattr(
        liquidation_service_module.time,
        "time",
        lambda: (START_MS + 10_000) / 1000,
    )
    first_factory = _Factory()
    first = _service(first_factory, db_path)
    await first.ensure_stream(_key(), consumer_id="first-process")
    await first_factory.emit(
        _event(
            1,
            trade_time_ms=START_MS + 1,
            average_price=100,
            filled_quantity=1,
        ),
    )
    await _wait_until(lambda: first.diagnostics()["commands_processed"] == 1)
    await first.shutdown()

    second_factory = _Factory()
    second = _service(second_factory, db_path)
    await second.ensure_stream(_key(), consumer_id="second-process")
    assert second.engine.diagnostics()["seeded_rollups"] == 1
    await second_factory.emit(
        _event(
            2,
            trade_time_ms=START_MS + 2,
            average_price=100,
            filled_quantity=2,
        ),
    )
    await _wait_until(lambda: second.diagnostics()["commands_processed"] == 1)

    rows = await second.history(_key(), position_side="long")
    assert len(rows) == 1
    assert rows[0]["event_count"] == 2
    assert rows[0]["filled_quantity"] == 3
    assert rows[0]["filled_notional"] == 300
    await second.shutdown()


@_async_test
async def test_attach_handoff_has_recent_without_live_overlap(
    tmp_path,
) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path / "liquidation.sqlite")
    await service.ensure_stream(_key(), consumer_id="attach")
    first = _event(1)
    second = _event(2)
    await factory.emit(first)
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 1)

    attachment = service.attach(_key(), recent_limit=10)
    assert [item.fingerprint for item in attachment.recent[IDENTITY]] == [
        service.recent(_key())[0].fingerprint,
    ]
    await factory.emit(second)
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 2)
    service.hub.flush_all()
    batch = await asyncio.wait_for(attachment.subscription.receive(), timeout=1)

    assert batch is not None
    assert [item.trade_time_ms for item in batch.records] == [START_MS + 2]
    assert batch.continuity is True
    await attachment.subscription.close()
    await service.shutdown()


@_async_test
async def test_bounded_hub_marks_process_local_discontinuity(
    tmp_path,
) -> None:
    factory = _Factory()
    hub = AppendBatchHub(max_pending_records=1, max_batch_size=10)
    service = _service(
        factory,
        tmp_path / "liquidation.sqlite",
        hub=hub,
    )
    await service.ensure_stream(_key(), consumer_id="bounded")
    attachment = service.attach(_key(), recent_limit=0, max_pending_records=10)

    await factory.emit(_event(1))
    await factory.emit(_event(2))
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 2)
    service.hub.flush_all()
    batch = await asyncio.wait_for(attachment.subscription.receive(), timeout=1)

    assert batch is not None
    assert [item.trade_time_ms for item in batch.records] == [START_MS + 2]
    assert batch.continuity is False
    assert batch.resync_required is True
    assert batch.dropped_before == 1
    await attachment.subscription.close()
    await service.shutdown()


@_async_test
async def test_shutdown_drains_enqueued_event_and_rollup_writer(
    tmp_path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "liquidation.sqlite"
    monkeypatch.setattr(
        liquidation_service_module.time,
        "time",
        lambda: (START_MS + 10_000) / 1000,
    )
    factory = _Factory()
    service = _service(factory, db_path)
    await service.ensure_stream(_key(), consumer_id="shutdown")
    await factory.emit(_event(1, trade_time_ms=START_MS + 1))

    await service.shutdown()

    assert factory.stop_calls == [IDENTITY]
    assert service.engine.diagnostics()["accepted"] == 1
    reopened = SQLiteLiquidationRollupStore(db_path)
    rows = await reopened.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert len(rows) == 1
    assert rows[0]["event_count"] == 1
    assert rows[0]["is_final"] == 0
    await reopened.close()


@_async_test
async def test_shutdown_drain_is_not_blocked_by_a_late_physical_stop(
    tmp_path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "liquidation.sqlite"
    monkeypatch.setattr(
        liquidation_service_module.time,
        "time",
        lambda: (START_MS + 10_000) / 1000,
    )
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    factory.stop_ignores_cancellation = True
    service = _service(
        factory,
        db_path,
        physical_stop_timeout_seconds=0.02,
    )
    await service.ensure_stream(_key(), consumer_id="late-stop-shutdown")
    await factory.emit(_event(1, trade_time_ms=START_MS + 1))

    await asyncio.wait_for(asyncio.shield(service.shutdown()), timeout=0.5)

    diagnostics = service.diagnostics()
    assert diagnostics["state"] == "closed"
    assert diagnostics["physical_streams"] == 0
    assert diagnostics["shutdown"]["degraded"] is True
    assert service.engine.diagnostics()["accepted"] == 1
    reopened = SQLiteLiquidationRollupStore(db_path)
    rows = await reopened.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert len(rows) == 1
    await reopened.close()

    # Let the detached, cancellation-resistant stop complete so the test event
    # loop exits without leaving a task behind. Its late result must be safe
    # after the service already cleared the physical lease map.
    factory.stop_gate.set()
    await _wait_until(
        lambda: service.diagnostics()["physical_stops_late_succeeded"] == 1,
    )


@_async_test
async def test_failed_stop_keeps_truthful_lease_and_can_retry(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.stop_error = RuntimeError("stop failed")
    service = _service(factory, tmp_path / "liquidation.sqlite")
    await service.ensure_stream(_key(), consumer_id="failed-stop")

    assert await service.release_stream(_key(), consumer_id="failed-stop") is False
    diagnostics = service.diagnostics()
    assert diagnostics["physical_streams"] == 1
    assert diagnostics["physical"][0]["stop_state"] == "stop_failed"
    assert diagnostics["physical_stop_failures"] == 1
    assert service.engine.diagnostics()["active_streams"] == 1
    assert len(factory.start_calls) == 1

    factory.stop_error = None
    assert await service.release_stream(_key(), consumer_id="failed-stop") is True
    assert service.diagnostics()["physical_streams"] == 0
    assert factory.stop_invocations == 2
    assert len(factory.start_calls) == 1
    await service.shutdown()


@_async_test
async def test_timed_out_cancellation_resistant_stop_never_spawns_duplicate_feed(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    factory.stop_ignores_cancellation = True
    service = _service(
        factory,
        tmp_path / "liquidation.sqlite",
        physical_stop_timeout_seconds=0.02,
    )
    await service.ensure_stream(_key(), consumer_id="timed-out")

    assert await service.release_stream(_key(), consumer_id="timed-out") is False
    diagnostics = service.diagnostics()
    assert diagnostics["physical_streams"] == 1
    assert diagnostics["physical"][0]["stop_state"] == "stopping"
    assert diagnostics["physical_stop_timeouts"] == 1
    assert service.engine.diagnostics()["active_streams"] == 1
    with pytest.raises(RuntimeError, match="stop is still in progress"):
        await service.ensure_stream(_key(), consumer_id="replacement")
    assert len(factory.start_calls) == 1

    factory.stop_gate.set()
    await _wait_until(lambda: service.diagnostics()["physical_streams"] == 0)
    assert service.engine.diagnostics()["active_streams"] == 0
    assert await service.ensure_stream(_key(), consumer_id="replacement") is True
    assert len(factory.start_calls) == 2
    await service.shutdown()
