from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import wraps

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.append_hub import AppendBatchHub
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.trade_flow import TradeFlowEngine
from app.data_engine.market_data.trade_flow_service import TradeFlowService
from app.data_engine.storage.raw_trade_archive import DisabledRawAggTradeArchive
from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    RawAggTradeArchiveWriter,
)
from app.data_engine.storage.trade_flow_store import SQLiteTradeFlowRollupStore
from app.data_engine.storage.trade_flow_writer import TradeFlowRollupWriter


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

    async def stop(self) -> None:
        self.factory.stop_invocations += 1
        if not self.stopped:
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
            self.stopped = True
            self.factory.stop_calls.append(self.identity)


class _Factory:
    def __init__(self) -> None:
        self.start_calls = []
        self.start_gates: dict[str, asyncio.Event] = {}
        self.start_entered: dict[str, asyncio.Event] = {}
        self.stop_calls: list[tuple[str, str, str]] = []
        self.callbacks = {}
        self.gap_callbacks = {}
        self.fetch_calls = []
        self.repair_rows: dict[int, MarketEvent] = {}
        self.partial_repair = False
        self.fetch_failures_remaining = 0
        self.stop_gate: asyncio.Event | None = None
        self.stop_started = asyncio.Event()
        self.stop_error: Exception | None = None
        self.stop_ignores_cancellation = False
        self.stop_invocations = 0

    async def start_market(self, descriptor, callback, *, on_gap=None):
        identity = (
            descriptor.exchange,
            descriptor.market_type,
            descriptor.symbol,
        )
        self.start_calls.append(descriptor)
        gate = self.start_gates.get(descriptor.symbol)
        if gate is not None:
            self.start_entered.setdefault(descriptor.symbol, asyncio.Event()).set()
            await gate.wait()
        self.callbacks[identity] = callback
        self.gap_callbacks[identity] = on_gap
        return _Handle(self, identity)

    async def fetch_market(self, descriptor, **kwargs):
        self.fetch_calls.append((descriptor, kwargs))
        if self.fetch_failures_remaining:
            self.fetch_failures_remaining -= 1
            raise RuntimeError("temporary REST failure")
        start = int(kwargs["from_id"])
        limit = int(kwargs["limit"])
        ids = range(start, start + limit)
        rows = [self.repair_rows[item] for item in ids if item in self.repair_rows]
        if self.partial_repair:
            return rows[:1]
        return rows

    async def emit(self, event: MarketEvent) -> None:
        identity = (event.exchange, event.market_type, event.symbol)
        await self.callbacks[identity](event)


def _event(
    trade_id: int,
    *,
    symbol: str = "BTCUSDT",
    trade_time_ms: int | None = None,
    buyer_maker: bool = False,
    source: DataSource = DataSource.WEBSOCKET,
) -> MarketEvent:
    timestamp = START_MS + trade_id if trade_time_ms is None else trade_time_ms
    return MarketEvent(
        event_type=StreamType.AGG_TRADE,
        symbol=symbol,
        exchange="binance",
        market_type="futures",
        event_time_ms=timestamp,
        received_at_ms=timestamp + 1,
        source=source,
        sequence=trade_id,
        data={
            "agg_trade_id": trade_id,
            "price": 100.0 + trade_id,
            "quantity": 1.0,
            "trade_time_ms": timestamp,
            "is_buyer_maker": buyer_maker,
            "first_trade_id": trade_id * 2,
            "last_trade_id": trade_id * 2 + 1,
        },
    )


def _key(symbol: str = "BTCUSDT") -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        "futures",
        symbol,
        MarketChannel.AGG_TRADE,
    )


def _service(factory: _Factory, tmp_path, **kwargs) -> TradeFlowService:
    store = SQLiteTradeFlowRollupStore(tmp_path / "trade-flow.sqlite")
    writer = TradeFlowRollupWriter(store, flush_interval_seconds=0.01)
    use_default_idle_grace = kwargs.pop("use_default_idle_grace", False)
    if not use_default_idle_grace:
        kwargs.setdefault("physical_idle_grace_seconds", 0)
    return TradeFlowService(
        factory,
        engine=kwargs.pop(
            "engine",
            TradeFlowEngine(initial_bucket_complete=True),
        ),
        rollup_writer=writer,
        raw_archive=DisabledRawAggTradeArchive(),
        **kwargs,
    )


async def _wait_until(predicate, *, timeout: float = 2.0) -> None:
    async def _wait() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(_wait(), timeout=timeout)


@_async_test
async def test_consumer_leases_share_one_physical_feed(tmp_path) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path)

    assert await service.ensure_stream(_key(), consumer_id="first") is True
    assert await service.ensure_stream(_key(), consumer_id="first") is False
    assert await service.ensure_stream(_key(), consumer_id="second") is True
    assert len(factory.start_calls) == 1
    assert factory.start_calls[0].stream_type is StreamType.AGG_TRADE
    assert service.engine.diagnostics()["active_streams"] == 1

    assert await service.release_stream(_key(), consumer_id="first") is True
    assert factory.stop_calls == []
    assert await service.release_stream(_key(), consumer_id="second") is True
    assert factory.stop_calls == [IDENTITY]
    assert service.engine.diagnostics()["active_streams"] == 0
    await service.shutdown()


@_async_test
async def test_last_consumer_release_enters_idle_grace_with_active_handle(
    tmp_path,
) -> None:
    factory = _Factory()
    service = _service(
        factory,
        tmp_path,
        use_default_idle_grace=True,
    )
    await service.ensure_stream(_key(), consumer_id="owner")

    assert await service.release_stream(_key(), consumer_id="owner") is True
    diagnostics = service.diagnostics()
    assert diagnostics["physical_streams"] == 1
    assert diagnostics["logical_leases"] == 0
    assert diagnostics["pending_idle_stops"] == 1
    assert diagnostics["physical_idle_grace_seconds"] == 30.0
    assert diagnostics["shutdown"]["physical_stop_timeout_seconds"] == 3.0
    assert diagnostics["physical"][0]["idle_stop_pending"] is True
    assert diagnostics["physical"][0]["stop_state"] == "active"
    assert factory.stop_invocations == 0
    with pytest.raises(RuntimeError, match="active leased physical streams"):
        service.attach(_key())
    await service.shutdown()


@_async_test
async def test_replacement_cancels_idle_stop_and_reuses_active_handle(tmp_path) -> None:
    factory = _Factory()
    service = _service(
        factory,
        tmp_path,
        physical_idle_grace_seconds=0.05,
    )
    await service.ensure_stream(_key(), consumer_id="owner")
    await service.release_stream(_key(), consumer_id="owner")

    assert await service.ensure_stream(_key(), consumer_id="replacement") is True
    diagnostics = service.diagnostics()
    assert diagnostics["pending_idle_stops"] == 0
    assert diagnostics["physical"][0]["idle_stop_pending"] is False
    assert diagnostics["physical"][0]["consumers"] == 1
    assert diagnostics["physical_idle_stops_cancelled"] == 1
    assert len(factory.start_calls) == 1
    assert factory.stop_invocations == 0
    await asyncio.sleep(0.07)
    assert factory.stop_invocations == 0
    await service.shutdown()


@_async_test
async def test_idle_grace_deadline_stops_physical_stream_once(tmp_path) -> None:
    factory = _Factory()
    service = _service(
        factory,
        tmp_path,
        physical_idle_grace_seconds=0.02,
    )
    await service.ensure_stream(_key(), consumer_id="owner")
    await service.release_stream(_key(), consumer_id="owner")

    await _wait_until(lambda: service.diagnostics()["physical_streams"] == 0)
    assert factory.stop_invocations == 1
    assert factory.stop_calls == [IDENTITY]
    assert service.diagnostics()["physical_idle_stops_expired"] == 1
    await asyncio.sleep(0.03)
    assert factory.stop_invocations == 1
    await service.shutdown()


@_async_test
async def test_shutdown_bypasses_idle_grace_and_stops_immediately(tmp_path) -> None:
    factory = _Factory()
    service = _service(
        factory,
        tmp_path,
        physical_idle_grace_seconds=30,
    )
    await service.ensure_stream(_key(), consumer_id="owner")
    await service.release_stream(_key(), consumer_id="owner")
    assert service.diagnostics()["pending_idle_stops"] == 1

    await asyncio.wait_for(service.shutdown(), timeout=0.2)
    assert factory.stop_invocations == 1
    assert factory.stop_calls == [IDENTITY]
    diagnostics = service.diagnostics()
    assert diagnostics["pending_idle_stops"] == 0
    assert diagnostics["physical_idle_stops_cancelled"] == 1
    assert diagnostics["physical_idle_stops_expired"] == 0
    assert diagnostics["physical_stops_attempted"] == 1


@_async_test
async def test_concurrent_replacements_cancel_one_idle_stop_without_restart(
    tmp_path,
) -> None:
    factory = _Factory()
    service = _service(
        factory,
        tmp_path,
        physical_idle_grace_seconds=0.1,
    )
    await service.ensure_stream(_key(), consumer_id="owner")
    await service.release_stream(_key(), consumer_id="owner")

    replacements = [
        asyncio.create_task(
            service.ensure_stream(_key(), consumer_id=f"replacement-{index}"),
        )
        for index in range(10)
    ]
    assert await asyncio.gather(*replacements) == [True] * 10
    diagnostics = service.diagnostics()
    assert diagnostics["logical_leases"] == 10
    assert diagnostics["pending_idle_stops"] == 0
    assert diagnostics["physical_idle_stops_cancelled"] == 1
    assert len(factory.start_calls) == 1
    assert factory.stop_invocations == 0

    await asyncio.sleep(0.12)
    assert factory.stop_invocations == 0
    for index in range(10):
        assert await service.release_stream(
            _key(),
            consumer_id=f"replacement-{index}",
        ) is True
    assert service.diagnostics()["pending_idle_stops"] == 1
    await service.shutdown()
    assert factory.stop_invocations == 1


@_async_test
async def test_concurrent_replacements_after_idle_deadline_share_cleanup_owner(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    service = _service(
        factory,
        tmp_path,
        physical_idle_grace_seconds=0.01,
        physical_stop_timeout_seconds=0.2,
    )
    await service.ensure_stream(_key(), consumer_id="owner")
    await service.release_stream(_key(), consumer_id="owner")
    await factory.stop_started.wait()

    replacements = [
        asyncio.create_task(
            service.ensure_stream(_key(), consumer_id=f"replacement-{index}"),
        )
        for index in range(10)
    ]
    await asyncio.sleep(0.01)
    assert all(task.done() is False for task in replacements)
    assert factory.stop_invocations == 1
    factory.stop_gate.set()

    assert await asyncio.gather(*replacements) == [True] * 10
    assert factory.stop_invocations == 1
    assert len(factory.start_calls) == 2
    assert service.diagnostics()["logical_leases"] == 10
    await service.shutdown()


@_async_test
async def test_keyed_lifecycle_parallelizes_symbols_and_singleflights_identity(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.start_gates["BTCUSDT"] = asyncio.Event()
    factory.start_entered["BTCUSDT"] = asyncio.Event()
    service = _service(factory, tmp_path)

    first = asyncio.create_task(
        service.ensure_stream(_key(), consumer_id="btc-one"),
    )
    await factory.start_entered["BTCUSDT"].wait()
    same_identity = asyncio.create_task(
        service.ensure_stream(_key(), consumer_id="btc-two"),
    )

    assert await asyncio.wait_for(
        service.ensure_stream(_key("ETHUSDT"), consumer_id="eth"),
        timeout=0.25,
    ) is True
    assert len(factory.start_calls) == 2
    assert not same_identity.done()

    factory.start_gates["BTCUSDT"].set()
    assert await first is True
    assert await same_identity is True
    assert len(factory.start_calls) == 2

    await service.shutdown()
    assert len(factory.stop_calls) == 2
    assert service.diagnostics()["physical_streams"] == 0
    assert service._identity_locks.active_keys == 0  # noqa: SLF001


@_async_test
async def test_last_consumer_release_drops_lease_and_reconciles_late_stop(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    service = _service(
        factory,
        tmp_path,
        physical_stop_timeout_seconds=0.05,
    )
    await service.ensure_stream(_key(), consumer_id="bounded-release")

    released = await asyncio.wait_for(
        service.release_stream(_key(), consumer_id="bounded-release"),
        timeout=0.5,
    )

    assert released is False
    assert service.diagnostics()["physical_streams"] == 1
    assert service.diagnostics()["logical_leases"] == 0
    assert service.diagnostics()["physical"][0]["consumers"] == 0
    assert service.diagnostics()["physical"][0]["stop_state"] == "stopping"
    assert service.engine.diagnostics()["active_streams"] == 1
    assert service.diagnostics()["physical_stop_timeouts"] == 1
    assert service.diagnostics()["physical_stop_tasks_cancelled"] == 0
    with pytest.raises(RuntimeError, match="cleanup did not finish"):
        await service.ensure_stream(_key(), consumer_id="replacement")
    assert factory.stop_invocations == 1
    assert service.diagnostics()["logical_leases"] == 0
    assert service.diagnostics()["physical"][0]["stop_state"] == "stopping"

    factory.stop_gate.set()
    await _wait_until(
        lambda: service.diagnostics()["physical_streams"] == 0,
    )
    assert service.engine.diagnostics()["active_streams"] == 0
    assert await service.ensure_stream(_key(), consumer_id="replacement") is True
    assert len(factory.start_calls) == 2
    await service.shutdown()


@_async_test
async def test_replacement_waits_for_cancelled_releaser_cleanup_without_dead_lease(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    factory.stop_ignores_cancellation = True
    service = _service(
        factory,
        tmp_path,
        physical_stop_timeout_seconds=0.05,
    )
    await service.ensure_stream(_key(), consumer_id="cancelled-release")

    release = asyncio.create_task(
        service.release_stream(_key(), consumer_id="cancelled-release"),
    )
    await factory.stop_started.wait()
    release.cancel()
    with pytest.raises(asyncio.CancelledError):
        await release

    diagnostics = service.diagnostics()
    assert diagnostics["physical_streams"] == 1
    assert diagnostics["physical"][0]["stop_state"] == "stopping"
    assert diagnostics["physical"][0]["consumers"] == 0
    assert diagnostics["physical_stop_wait_cancellations"] == 1
    assert service.engine.diagnostics()["active_streams"] == 1

    replacement = asyncio.create_task(
        service.ensure_stream(_key(), consumer_id="replacement"),
    )
    await asyncio.sleep(0.01)
    assert replacement.done() is False
    assert factory.stop_invocations == 1
    factory.stop_gate.set()

    assert await replacement is True
    assert service.engine.diagnostics()["active_streams"] == 1
    assert service.diagnostics()["physical"][0]["stop_state"] == "active"
    assert service.diagnostics()["physical"][0]["consumers"] == 1
    assert len(factory.start_calls) == 2
    assert factory.stop_invocations == 1
    await service.shutdown()


@_async_test
async def test_pending_stop_does_not_block_a_different_identity(tmp_path) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    service = _service(
        factory,
        tmp_path,
        physical_stop_timeout_seconds=0.05,
    )
    await service.ensure_stream(_key(), consumer_id="btc")

    release = asyncio.create_task(
        service.release_stream(_key(), consumer_id="btc"),
    )
    await factory.stop_started.wait()
    assert await asyncio.wait_for(
        service.ensure_stream(_key("ETHUSDT"), consumer_id="eth"),
        timeout=0.02,
    ) is True

    factory.stop_gate.set()
    assert await release is True
    assert await service.release_stream(
        _key("ETHUSDT"),
        consumer_id="eth",
    ) is True
    await service.shutdown()


@_async_test
async def test_cancel_after_start_returns_cleans_unpublished_reservation(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.start_gates["BTCUSDT"] = asyncio.Event()
    service = _service(factory, tmp_path)
    starting = asyncio.create_task(
        service.ensure_stream(_key(), consumer_id="cancelled-start"),
    )
    await factory.start_entered.setdefault("BTCUSDT", asyncio.Event()).wait()

    async with service._lifecycle_lock:
        factory.start_gates["BTCUSDT"].set()
        await asyncio.sleep(0)
        assert len(factory.start_calls) == 1
        assert starting.done() is False
        starting.cancel()
        await asyncio.sleep(0)

    with pytest.raises(asyncio.CancelledError):
        await starting

    assert factory.stop_invocations == 1
    assert service.diagnostics()["physical_streams"] == 0
    assert service.engine.diagnostics()["active_streams"] == 0
    assert await service.ensure_stream(_key(), consumer_id="replacement") is True
    assert len(factory.start_calls) == 2
    await service.shutdown()


@_async_test
async def test_failed_stop_is_cleaned_before_replacement_can_start(tmp_path) -> None:
    factory = _Factory()
    factory.stop_error = RuntimeError("transport stop failed")
    service = _service(factory, tmp_path)
    await service.ensure_stream(_key(), consumer_id="owner")

    assert await service.release_stream(_key(), consumer_id="owner") is False
    diagnostics = service.diagnostics()
    assert diagnostics["logical_leases"] == 0
    assert diagnostics["physical"][0]["stop_state"] == "stop_failed"
    with pytest.raises(RuntimeError, match="unavailable after a failed stop"):
        await service.ensure_stream(_key(), consumer_id="replacement")
    assert len(factory.start_calls) == 1
    assert factory.stop_invocations == 2

    factory.stop_error = None
    assert await service.ensure_stream(_key(), consumer_id="replacement") is True
    assert len(factory.start_calls) == 2
    assert service.diagnostics()["physical"][0]["stop_state"] == "active"
    await service.shutdown()


@_async_test
async def test_failed_stop_has_one_cleanup_owner_for_concurrent_replacements(
    tmp_path,
) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    factory.stop_error = RuntimeError("transport stop failed")
    service = _service(factory, tmp_path)
    await service.ensure_stream(_key(), consumer_id="owner")

    release = asyncio.create_task(
        service.release_stream(_key(), consumer_id="owner"),
    )
    await factory.stop_started.wait()
    replacements = [
        asyncio.create_task(
            service.ensure_stream(_key(), consumer_id=f"replacement-{index}"),
        )
        for index in range(10)
    ]
    await asyncio.sleep(0.01)
    assert all(task.done() is False for task in replacements)

    factory.stop_gate.set()
    assert await release is False
    results = await asyncio.gather(*replacements, return_exceptions=True)
    assert all(
        isinstance(result, RuntimeError)
        and "unavailable after a failed stop" in str(result)
        for result in results
    )
    assert factory.stop_invocations == 1
    assert len(factory.start_calls) == 1
    assert service.diagnostics()["physical_stops_attempted"] == 1

    factory.stop_error = None
    assert await service.ensure_stream(_key(), consumer_id="recovered") is True
    assert factory.stop_invocations == 2
    assert len(factory.start_calls) == 2
    await service.shutdown()


@_async_test
async def test_physical_stream_limit_fails_before_engine_lru_eviction(tmp_path) -> None:
    factory = _Factory()
    service = _service(
        factory,
        tmp_path,
        engine=TradeFlowEngine(max_streams=1, initial_bucket_complete=True),
    )

    await service.ensure_stream(_key("BTCUSDT"), consumer_id="btc")
    with pytest.raises(RuntimeError, match=r"physical stream limit reached \(1\)"):
        await service.ensure_stream(_key("ETHUSDT"), consumer_id="eth")
    assert len(factory.start_calls) == 1

    await service.release_stream(_key("BTCUSDT"), consumer_id="btc")
    assert await service.ensure_stream(_key("ETHUSDT"), consumer_id="eth") is True
    assert len(factory.start_calls) == 2
    await service.shutdown()


@_async_test
async def test_finalized_rollup_is_persisted_with_store_vocabulary(tmp_path) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path)
    await service.ensure_stream(_key(), consumer_id="rollup")

    await factory.emit(_event(1, trade_time_ms=START_MS + 1))
    await factory.emit(_event(2, trade_time_ms=START_MS + MINUTE + 1))
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 2)
    await _wait_until(
        lambda: service.diagnostics()["rollup_writer"]["rows_written"] >= 1,
    )

    rows = await service.rollup_store.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert rows[0]["bucket_open_ms"] == START_MS
    assert rows[0]["buy_base_volume"] == 1.0
    assert rows[0]["buy_quote_volume"] == 101.0
    assert rows[0]["trade_count"] == 2
    assert rows[0]["is_final"] == 1
    assert rows[0]["is_complete"] == 1

    await service.shutdown()


@_async_test
async def test_engine_gap_repairs_exact_rest_id_range_and_restores_complete(tmp_path) -> None:
    factory = _Factory()
    factory.repair_rows = {
        2: _event(2, source=DataSource.HTTP_BACKFILL),
        3: _event(3, source=DataSource.HTTP_BACKFILL),
    }
    service = _service(factory, tmp_path, repair_page_size=1000)
    await service.ensure_stream(_key(), consumer_id="repair")

    await factory.emit(_event(1))
    await factory.emit(_event(4))
    await _wait_until(lambda: service.diagnostics()["repairs_succeeded"] == 1)

    assert [
        trade.agg_trade_id for trade in service.engine.raw_snapshot(IDENTITY)
    ] == [1, 2, 3, 4]
    assert service.engine.gap_snapshot(IDENTITY) == ()
    recent = service.recent(_key())
    assert [trade.agg_trade_id for trade in recent] == [1, 2, 3, 4]
    rollups = await service.recent_rollups(_key())
    assert rollups[-1]["agg_trade_count"] == 4
    assert rollups[-1]["volume_delta_base"] == 4.0
    assert rollups[-1]["bucket_start_ms"] == START_MS
    assert rollups[-1]["is_complete"] is True
    assert factory.fetch_calls[0][1] == {
        "from_id": 2,
        "limit": 2,
        "history": True,
    }
    await service.shutdown()


@_async_test
async def test_gap_fill_is_not_broadcast_and_live_gap_requires_resync(tmp_path) -> None:
    factory = _Factory()
    factory.repair_rows = {
        2: _event(2, source=DataSource.HTTP_BACKFILL),
        3: _event(3, source=DataSource.HTTP_BACKFILL),
    }
    hub = AppendBatchHub(max_pending_records=64, max_batch_size=64)
    service = _service(
        factory,
        tmp_path,
        hub=hub,
        flush_interval_seconds=0.1,
    )
    await service.ensure_stream(_key(), consumer_id="ordered-live")
    attachment = service.attach(_key(), recent_limit=0)

    await factory.emit(_event(1))
    await factory.emit(_event(4))
    await _wait_until(lambda: service.diagnostics()["repairs_succeeded"] == 1)
    service.hub.flush_all()
    await _wait_until(lambda: attachment.subscription.pending_batch_count > 0)
    batches = []
    while attachment.subscription.pending_batch_count:
        batch = await attachment.subscription.receive()
        assert batch is not None
        batches.append(batch)

    assert [
        trade.agg_trade_id
        for batch in batches
        for trade in batch.records
    ] == [1, 4]
    assert any(batch.resync_required for batch in batches)
    assert all(
        trade.source is DataSource.WEBSOCKET
        for batch in batches
        for trade in batch.records
    )
    await attachment.subscription.close()
    await service.shutdown()


@_async_test
async def test_attach_rejects_identity_while_gap_is_open(tmp_path) -> None:
    factory = _Factory()
    factory.partial_repair = True
    factory.repair_rows = {2: _event(2, source=DataSource.HTTP_BACKFILL)}
    service = _service(
        factory,
        tmp_path,
        repair_retry_backoff_seconds=0.2,
    )
    await service.ensure_stream(_key(), consumer_id="open-gap")
    await factory.emit(_event(1))
    await factory.emit(_event(4))
    await _wait_until(lambda: bool(service.engine.gap_snapshot(IDENTITY)))

    with pytest.raises(RuntimeError, match="unresolved or collapsed gap"):
        service.attach(_key())

    await service.shutdown()


@_async_test
async def test_transient_repair_failure_retries_and_recovers(tmp_path) -> None:
    factory = _Factory()
    factory.fetch_failures_remaining = 1
    factory.repair_rows = {
        2: _event(2, source=DataSource.HTTP_BACKFILL),
        3: _event(3, source=DataSource.HTTP_BACKFILL),
    }
    service = _service(
        factory,
        tmp_path,
        repair_retry_backoff_seconds=0.001,
    )
    await service.ensure_stream(_key(), consumer_id="transient-repair")

    await factory.emit(_event(1))
    await factory.emit(_event(4))
    await _wait_until(lambda: service.diagnostics()["repairs_succeeded"] == 1)

    diagnostics = service.diagnostics()
    assert diagnostics["repair_retries"] == 1
    assert diagnostics["repairs_exhausted"] == 0
    assert diagnostics["degraded"] is False
    assert service.engine.gap_snapshot(IDENTITY) == ()
    assert [
        trade.agg_trade_id for trade in service.engine.raw_snapshot(IDENTITY)
    ] == [1, 2, 3, 4]
    await service.shutdown()


@_async_test
async def test_cancelled_shutdown_can_be_awaited_again_to_completion(tmp_path) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    service = _service(factory, tmp_path)
    await service.ensure_stream(_key(), consumer_id="shutdown")

    first_waiter = asyncio.create_task(service.shutdown())
    await factory.stop_started.wait()
    first_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first_waiter
    assert service.diagnostics()["state"] == "closing"

    factory.stop_gate.set()
    await service.shutdown()

    assert service.diagnostics()["state"] == "closed"
    assert service.engine.diagnostics()["active_streams"] == 0


@_async_test
async def test_hung_physical_stop_times_out_but_durability_drains(tmp_path) -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    service = _service(
        factory,
        tmp_path,
        physical_stop_timeout_seconds=0.01,
    )
    await service.ensure_stream(_key(), consumer_id="hung-stop")
    await factory.emit(_event(1, trade_time_ms=START_MS + 1))
    await factory.emit(_event(2, trade_time_ms=START_MS + MINUTE + 1))

    await asyncio.wait_for(service.shutdown(), timeout=1)

    rows = await service.rollup_store.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    diagnostics = service.diagnostics()
    assert rows and rows[0]["bucket_open_ms"] == START_MS
    assert diagnostics["state"] == "closed"
    assert diagnostics["degraded"] is True
    assert diagnostics["shutdown"]["degraded"] is True
    assert diagnostics["physical_stops_attempted"] == 1
    assert diagnostics["physical_stop_timeouts"] == 1
    assert diagnostics["physical_stop_tasks_cancelled"] == 0
    assert diagnostics["rollup_writer"]["durable_batches_pending"] == 0
    assert diagnostics["last_physical_stop_error"]
    assert diagnostics["shutdown"]["pending_physical_stop_tasks"] == 1

    factory.stop_gate.set()
    await _wait_until(
        lambda: service.diagnostics()["shutdown"][
            "pending_physical_stop_tasks"
        ] == 0,
    )
    await _wait_until(
        lambda: service.diagnostics()["physical_stops_late_succeeded"] == 1,
    )


@_async_test
async def test_physical_stop_failure_is_degraded_but_shutdown_closes(tmp_path) -> None:
    factory = _Factory()
    factory.stop_error = RuntimeError("transport stop failed")
    service = _service(factory, tmp_path)
    await service.ensure_stream(_key(), consumer_id="failed-stop")

    await service.shutdown()

    diagnostics = service.diagnostics()
    assert diagnostics["state"] == "closed"
    assert diagnostics["shutdown"]["degraded"] is True
    assert diagnostics["physical_stops_attempted"] == 1
    assert diagnostics["physical_stop_failures"] == 1
    assert diagnostics["physical_stops_succeeded"] == 0
    assert "transport stop failed" in diagnostics["last_physical_stop_error"]


@_async_test
async def test_invalid_rest_repair_keeps_bucket_incomplete(tmp_path) -> None:
    factory = _Factory()
    factory.repair_rows = {
        2: _event(2, source=DataSource.HTTP_BACKFILL),
        3: _event(3, source=DataSource.HTTP_BACKFILL),
    }
    factory.partial_repair = True
    service = _service(factory, tmp_path)
    await service.ensure_stream(_key(), consumer_id="repair-failure")

    await factory.emit(_event(1))
    await factory.emit(_event(4))
    await _wait_until(lambda: service.diagnostics()["repairs_failed"] == 1)

    assert service.engine.gap_snapshot(IDENTITY)[0].start_id == 2
    assert service.engine.gap_snapshot(IDENTITY)[0].end_id == 3
    rollups = await service.recent_rollups(_key())
    assert rollups[-1]["is_complete"] is False
    assert service.diagnostics()["last_repair_error"]
    await service.shutdown()


@_async_test
async def test_disabled_archive_is_explicit_and_coverage_fails_closed(tmp_path) -> None:
    factory = _Factory()
    service = _service(factory, tmp_path)
    await service.ensure_stream(_key(), consumer_id="no-archive")
    await factory.emit(_event(1))
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 1)

    diagnostics = service.diagnostics()
    assert diagnostics["archive_writer"]["state"] == "disabled"
    assert diagnostics["archive_forwarded"] == 0
    coverage = await service.archive_coverage(
        _key(),
        expected_start_agg_trade_id=1,
        expected_end_agg_trade_id=1,
    )
    assert coverage.enabled is False
    assert coverage.backend == "disabled"
    assert coverage.row_count == 0
    assert coverage.complete is False
    await service.shutdown()


@_async_test
async def test_archive_forwarding_enqueues_without_waiting_for_debounce(
    tmp_path,
) -> None:
    pytest.importorskip("pyarrow")
    factory = _Factory()
    store = SQLiteTradeFlowRollupStore(tmp_path / "trade-flow.sqlite")
    archive = ParquetRawAggTradeArchive(tmp_path / "raw-trades")
    archive_writer = RawAggTradeArchiveWriter(
        archive,
        flush_interval_seconds=0.2,
        max_pending_batches=4,
    )
    service = TradeFlowService(
        factory,
        engine=TradeFlowEngine(initial_bucket_complete=True),
        rollup_writer=TradeFlowRollupWriter(store, flush_interval_seconds=0.01),
        archive_writer=archive_writer,
        archive_forward_batch_size=1,
    )
    await service.ensure_stream(_key(), consumer_id="archive-enqueue")

    await factory.emit(_event(1))
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 1)
    await asyncio.sleep(0.03)
    await factory.emit(_event(2))
    await _wait_until(lambda: service.diagnostics()["commands_processed"] == 2)
    await _wait_until(
        lambda: service.diagnostics()["archive_forward_queue"]["pending"] == 0,
    )

    # The first batch is still inside the debounce window while the second has
    # already transferred to the bounded writer queue.
    assert service.diagnostics()["archive_writer"]["batches_written"] == 0
    assert service.diagnostics()["archive_writer"]["pending_batches"] == 1
    await service.shutdown()
    assert service.diagnostics()["archive_forwarded"] == 2


@_async_test
async def test_slow_multiplexed_consumer_gets_resync_continuity_marker(tmp_path) -> None:
    factory = _Factory()
    hub = AppendBatchHub(max_pending_records=64, max_batch_size=1)
    service = _service(
        factory,
        tmp_path,
        hub=hub,
        flush_interval_seconds=0.02,
    )
    await service.ensure_stream(_key(), consumer_id="slow")
    attachment = service.attach_many(
        [_key()],
        recent_limit=20_000,
        max_pending_records=2,
    )
    assert attachment.recent[IDENTITY] == ()

    for trade_id in range(1, 6):
        await factory.emit(_event(trade_id))
        await _wait_until(
            lambda expected=trade_id: service.diagnostics()["hub"][
                "published_records"
            ]
            >= expected,
        )

    batches = [await attachment.subscription.receive() for _ in range(2)]
    assert any(batch is not None and batch.resync_required for batch in batches)
    assert attachment.subscription.dropped_records == 3
    await attachment.subscription.close()
    await service.shutdown()


def test_capability_validation_fails_closed(tmp_path) -> None:
    async def _run() -> None:
        service = _service(_Factory(), tmp_path)
        with pytest.raises(ValueError, match="Unknown exchange"):
            await service.ensure_stream(
                ("missing", "futures", "BTCUSDT"),
                consumer_id="unknown",
            )
        await service.shutdown()

    asyncio.run(_run())
