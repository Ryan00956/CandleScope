from __future__ import annotations

import asyncio
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.continuity import ContinuityLayer
from app.data_engine.ingestion.models import (
    DataSource,
    GapMarker,
    MarketEvent,
    RawMessage,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.ingestion.recovery import RecoveryLayer


class _FakeTransport:
    def __init__(self, rows: list[dict[str, Any]] | list[list[Any]]) -> None:
        self.rows = rows
        self.requests = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def http_fetch(self, request: Any) -> list[RawMessage]:
        self.requests.append(request)
        self.started.set()
        await self.release.wait()
        return [
            RawMessage(
                payload=row,
                source=DataSource.HTTP,
                stream_type=request.descriptor.stream_type,
                received_at_ms=1_700_000_000_100,
            )
            for row in self.rows
        ]


def _agg_descriptor() -> StreamDescriptor:
    return StreamDescriptor(
        "BTCUSDT",
        StreamType.AGG_TRADE,
        market_type="futures",
    )


def _agg_payload(sequence: int) -> dict[str, Any]:
    return {
        "a": sequence,
        "p": "64000",
        "q": "0.1",
        "f": sequence,
        "l": sequence,
        "T": 1_700_000_000_000 + sequence,
        "m": False,
    }


def _agg_event(sequence: int) -> MarketEvent:
    return MarketEvent(
        event_type=StreamType.AGG_TRADE,
        symbol="BTCUSDT",
        exchange="binance",
        event_time_ms=1_700_000_000_000 + sequence,
        received_at_ms=1_700_000_000_100 + sequence,
        source=DataSource.WEBSOCKET,
        data={
            "agg_trade_id": sequence,
            "price": 64000.0,
            "quantity": 0.1,
            "first_trade_id": sequence,
            "last_trade_id": sequence,
            "trade_time_ms": 1_700_000_000_000 + sequence,
            "is_buyer_maker": False,
        },
        stream_key="futures:BTCUSDT@aggTrade",
        sequence=sequence,
        market_type="futures",
    )


def _gap(
    stream_type: StreamType,
    start: int,
    end: int,
    expected: int,
    *,
    key: str,
) -> GapMarker:
    return GapMarker(
        stream_key=key,
        symbol="BTCUSDT",
        stream_type=stream_type,
        gap_start=start,
        gap_end=end,
        expected_count=expected,
    )


def _enabled_config(**overrides: Any) -> IngestionConfig:
    values: dict[str, Any] = {
        "ccxt_stream_enabled": True,
        "ccxt_recovery_timeout_seconds": 0.1,
        "ccxt_recovery_retry_initial_seconds": 0.01,
        "ccxt_recovery_retry_max_seconds": 0.02,
        "ccxt_recovery_retry_deadline_seconds": 0.2,
        "ccxt_recovery_buffer_max_events": 100,
    }
    values.update(overrides)
    return IngestionConfig(
        **values,
    )


def test_aggregate_trade_gap_is_filled_before_buffered_live_event() -> None:
    async def run() -> None:
        transport = _FakeTransport([_agg_payload(value) for value in (11, 12, 13)])
        layer = RecoveryLayer(
            _enabled_config(ccxt_recovery_retry_deadline_seconds=0),
            transport,
            _agg_descriptor(),
        )
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await transport.started.wait()
        await layer.ingest_event(_agg_event(14))
        transport.release.set()
        await layer.wait_idle()

        assert [event.continuity_key for event in emitted] == [11, 12, 13, 14]
        assert [event.source for event in emitted[:3]] == [
            DataSource.HTTP_BACKFILL,
            DataSource.HTTP_BACKFILL,
            DataSource.HTTP_BACKFILL,
        ]
        assert len(gaps) == 1 and gaps[0].filled is True
        assert transport.requests[0].from_id == 11
        assert transport.requests[0].history is True
        assert layer.snapshot()["metrics"]["counters"]["repairs_succeeded"] == 1

        await layer.ingest_event(_agg_event(12))
        assert [event.continuity_key for event in emitted] == [11, 12, 13, 14]

    asyncio.run(run())


def test_transient_rest_failure_stays_pending_and_retries_until_filled() -> None:
    async def run() -> None:
        transport = _RecoveringTransport(
            [_agg_payload(value) for value in (11, 12, 13)]
        )
        layer = RecoveryLayer(_enabled_config(), transport, _agg_descriptor())
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await transport.attempted.wait()
        await layer.ingest_event(_agg_event(14))

        pending = layer.snapshot()
        assert pending["state"] == "recovering"
        assert pending["repairing"] is True
        assert pending["buffered_events"] == 1
        assert emitted == []
        assert gaps == []

        transport.available.set()
        await layer.wait_idle()

        assert [event.continuity_key for event in emitted] == [11, 12, 13, 14]
        assert len(gaps) == 1 and gaps[0].filled is True
        snapshot = layer.snapshot()
        assert snapshot["state"] == "healthy"
        assert snapshot["repairing"] is False
        assert snapshot["terminal_failures"] == 0
        counters = snapshot["metrics"]["counters"]
        assert counters["repair_attempts_failed"] >= 1
        assert counters["retries_scheduled"] >= 1
        assert counters["repairs_succeeded"] == 1
        assert counters.get("repairs_failed", 0) == 0

    asyncio.run(run())


def test_real_failure_shape_repairs_166_ids_before_accumulated_live_tail() -> None:
    async def run() -> None:
        config = _enabled_config(
            continuity_buffer_size=1_000,
            ccxt_recovery_buffer_max_events=1_000,
        )
        transport = _RecoveringTransport(
            [_agg_payload(value) for value in range(7_519, 7_685)]
        )
        descriptor = _agg_descriptor()
        continuity = ContinuityLayer(config, transport, descriptor)
        recovery = RecoveryLayer(config, transport, descriptor)
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        continuity.on_event(recovery.ingest_event)
        continuity.on_gap(recovery.ingest_gap)
        recovery.on_event(_append_async(emitted))
        recovery.on_gap(_append_async(gaps))

        await continuity.ingest(_agg_event(7_518))
        await continuity.ingest(_agg_event(7_685))
        await transport.attempted.wait()
        for sequence in range(7_686, 7_801):
            await continuity.ingest(_agg_event(sequence))

        pending = recovery.snapshot()
        assert pending["state"] == "recovering"
        assert pending["expected_missing"] == 166
        assert pending["buffered_events"] == 116
        assert [event.continuity_key for event in emitted] == [7_518]

        transport.available.set()
        await recovery.wait_idle()

        assert [event.continuity_key for event in emitted] == list(range(7_518, 7_801))
        assert len(gaps) == 1
        assert gaps[0].filled is True
        assert gaps[0].expected_count == 166
        assert recovery.snapshot()["state"] == "healthy"

    asyncio.run(run())


def test_reconnect_replay_larger_than_continuity_cache_cannot_escape() -> None:
    async def run() -> None:
        config = _enabled_config(
            continuity_buffer_size=3,
            ccxt_recovery_buffer_max_events=100,
        )
        transport = _FakeTransport(
            [_agg_payload(value) for value in range(11, 20)]
        )
        descriptor = _agg_descriptor()
        continuity = ContinuityLayer(config, transport, descriptor)
        recovery = RecoveryLayer(config, transport, descriptor)
        emitted: list[MarketEvent] = []
        continuity.on_event(recovery.ingest_event)
        continuity.on_gap(recovery.ingest_gap)
        recovery.on_event(_append_async(emitted))

        await continuity.ingest(_agg_event(10))
        await continuity.ingest(_agg_event(20))
        await transport.started.wait()
        transport.release.set()
        await recovery.wait_idle()

        assert [event.continuity_key for event in emitted] == list(range(10, 21))

        # A reconnect may replay more IDs than Continuity's bounded LRU keeps.
        # The final CCXT ordered boundary must still prevent stale or duplicate
        # IDs from reaching delivery.
        for sequence in range(11, 21):
            await continuity.ingest(_agg_event(sequence))

        assert [event.continuity_key for event in emitted] == list(range(10, 21))
        snapshot = recovery.snapshot()
        counters = snapshot["metrics"]["counters"]
        assert counters["events_out_of_order_dropped"] >= 1
        assert counters["events_duplicate_dropped"] == 1
        assert snapshot["last_emitted_key"] == 20

    asyncio.run(run())


def test_kline_current_revision_passes_but_older_reconnect_replay_drops() -> None:
    async def run() -> None:
        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.KLINE,
            interval="1m",
            market_type="futures",
        )
        layer = RecoveryLayer(_enabled_config(), _FakeTransport([]), descriptor)
        emitted: list[MarketEvent] = []
        layer.on_event(_append_async(emitted))

        await layer.ingest_event(_kline_event(120_000))
        await layer.ingest_event(_kline_event(120_000))
        await layer.ingest_event(_kline_event(60_000))

        assert [event.continuity_key for event in emitted] == [120_000, 120_000]
        snapshot = layer.snapshot()
        assert snapshot["last_emitted_key"] == 120_000
        assert (
            snapshot["metrics"]["counters"]["events_out_of_order_dropped"]
            == 1
        )

    asyncio.run(run())


def test_live_event_cannot_interleave_with_recovery_batch_publication() -> None:
    async def run() -> None:
        transport = _FakeTransport([_agg_payload(value) for value in (11, 12, 13)])
        layer = RecoveryLayer(_enabled_config(), transport, _agg_descriptor())
        emitted: list[int] = []
        first_recovered_started = asyncio.Event()
        release_delivery = asyncio.Event()

        async def collect(event: MarketEvent) -> None:
            if event.continuity_key == 11:
                first_recovered_started.set()
                await release_delivery.wait()
            assert event.continuity_key is not None
            emitted.append(event.continuity_key)

        layer.on_event(collect)
        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await transport.started.wait()
        await layer.ingest_event(_agg_event(14))
        transport.release.set()
        await first_recovered_started.wait()

        later = asyncio.create_task(layer.ingest_event(_agg_event(15)))
        await asyncio.sleep(0)
        assert emitted == []
        assert later.done() is False

        release_delivery.set()
        await layer.wait_idle()
        await later

        assert emitted == [11, 12, 13, 14, 15]

    asyncio.run(run())


def test_retry_deadline_emits_one_terminal_unfilled_gap() -> None:
    async def run() -> None:
        transport = _RecoveringTransport([_agg_payload(11)])
        layer = RecoveryLayer(
            _enabled_config(ccxt_recovery_retry_deadline_seconds=0.03),
            transport,
            _agg_descriptor(),
        )
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await layer.ingest_event(_agg_event(14))
        await layer.wait_idle()

        assert [event.continuity_key for event in emitted] == [14]
        assert len(gaps) == 1 and gaps[0].filled is False
        snapshot = layer.snapshot()
        assert snapshot["state"] == "failed"
        assert snapshot["terminal_failures"] == 1
        counters = snapshot["metrics"]["counters"]
        assert counters["retry_deadlines_exhausted"] == 1
        assert counters["repairs_failed"] == 1

    asyncio.run(run())


def test_recovery_buffer_overflow_fails_explicitly_without_dropping_boundary() -> (
    None
):
    async def run() -> None:
        transport = _FakeTransport([_agg_payload(value) for value in (11, 12, 13)])
        layer = RecoveryLayer(
            _enabled_config(
                ccxt_recovery_buffer_max_events=2,
                ccxt_recovery_retry_deadline_seconds=1,
            ),
            transport,
            _agg_descriptor(),
        )
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await transport.started.wait()
        await layer.ingest_event(_agg_event(14))
        await layer.ingest_event(_agg_event(15))
        await layer.ingest_event(_agg_event(16))

        assert [event.continuity_key for event in emitted] == [14, 15, 16]
        assert len(gaps) == 1 and gaps[0].filled is False
        snapshot = layer.snapshot()
        assert snapshot["state"] == "failed"
        assert snapshot["metrics"]["counters"]["buffer_overflows"] == 1

    asyncio.run(run())


def test_coalesced_gap_refetches_extended_target_and_merges_in_sequence() -> None:
    async def run() -> None:
        transport = _CoalescingTransport()
        layer = RecoveryLayer(_enabled_config(), transport, _agg_descriptor())
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await transport.first_started.wait()
        await layer.ingest_event(_agg_event(14))
        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                14,
                17,
                2,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await layer.ingest_event(_agg_event(17))
        transport.release_first.set()
        await layer.wait_idle()

        assert [event.continuity_key for event in emitted] == list(range(11, 18))
        assert [event.source for event in emitted if event.continuity_key in {14, 17}] == [
            DataSource.WEBSOCKET,
            DataSource.WEBSOCKET,
        ]
        assert len(transport.requests) == 2
        assert transport.requests[1].from_id == 11
        assert transport.requests[1].limit == 6
        assert len(gaps) == 1
        assert gaps[0].filled is True
        assert gaps[0].expected_count == 5
        assert layer.snapshot()["metrics"]["counters"]["repair_targets_extended"] == 1

    asyncio.run(run())


def test_stop_marks_pending_gap_unfilled_and_releases_buffer() -> None:
    async def run() -> None:
        transport = _FakeTransport([_agg_payload(value) for value in (11, 12, 13)])
        layer = RecoveryLayer(_enabled_config(), transport, _agg_descriptor())
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await transport.started.wait()
        await layer.ingest_event(_agg_event(14))
        await layer.stop()

        assert [event.continuity_key for event in emitted] == [14]
        assert len(gaps) == 1 and gaps[0].filled is False
        snapshot = layer.snapshot()
        assert snapshot["state"] == "failed"
        assert snapshot["repairing"] is False

    asyncio.run(run())


def test_incomplete_aggregate_trade_repair_fails_closed_then_releases_boundary() -> (
    None
):
    async def run() -> None:
        transport = _FakeTransport([_agg_payload(11), _agg_payload(13)])
        layer = RecoveryLayer(
            _enabled_config(ccxt_recovery_retry_deadline_seconds=0),
            transport,
            _agg_descriptor(),
        )
        timeline: list[tuple[str, int | bool | None]] = []

        async def on_event(event: MarketEvent) -> None:
            timeline.append(("event", event.continuity_key))

        async def on_gap(gap: GapMarker) -> None:
            timeline.append(("gap", gap.filled))

        layer.on_event(on_event)
        layer.on_gap(on_gap)
        await layer.ingest_gap(
            _gap(
                StreamType.AGG_TRADE,
                10,
                14,
                3,
                key="futures:BTCUSDT@aggTrade",
            )
        )
        await transport.started.wait()
        await layer.ingest_event(_agg_event(14))
        transport.release.set()
        await layer.wait_idle()

        assert timeline == [("gap", False), ("event", 14)]
        snapshot = layer.snapshot()
        assert snapshot["repairing"] is False
        assert snapshot["metrics"]["counters"]["repairs_failed"] == 1

    asyncio.run(run())


def test_kline_gap_uses_fixed_interval_and_strict_open_time_sequence() -> None:
    async def run() -> None:
        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.KLINE,
            interval="1m",
            market_type="futures",
        )
        rows = [_kline_row(60_000), _kline_row(120_000)]
        transport = _FakeTransport(rows)
        layer = RecoveryLayer(_enabled_config(), transport, descriptor)
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        await layer.ingest_gap(
            _gap(
                StreamType.KLINE,
                0,
                180_000,
                2,
                key="futures:BTCUSDT@kline_1m",
            )
        )
        await transport.started.wait()
        await layer.ingest_event(_kline_event(180_000))
        transport.release.set()
        await layer.wait_idle()

        assert [event.continuity_key for event in emitted] == [
            60_000,
            120_000,
            180_000,
        ]
        request = transport.requests[0]
        assert (request.start_ms, request.end_ms, request.limit) == (
            60_000,
            120_000,
            2,
        )
        assert gaps[0].filled is True

    asyncio.run(run())


def test_recovery_is_noop_when_ccxt_transport_is_disabled() -> None:
    async def run() -> None:
        transport = _FakeTransport([_agg_payload(11)])
        layer = RecoveryLayer(IngestionConfig(), transport, _agg_descriptor())
        emitted: list[MarketEvent] = []
        gaps: list[GapMarker] = []
        layer.on_event(_append_async(emitted))
        layer.on_gap(_append_async(gaps))

        marker = _gap(
            StreamType.AGG_TRADE,
            10,
            12,
            1,
            key="futures:BTCUSDT@aggTrade",
        )
        await layer.ingest_gap(marker)
        await layer.ingest_event(_agg_event(12))

        assert gaps == [marker]
        assert [event.continuity_key for event in emitted] == [12]
        assert transport.requests == []
        assert layer.enabled is False

    asyncio.run(run())


def _append_async(target: list[Any]):
    async def append(value: Any) -> None:
        target.append(value)

    return append


class _RecoveringTransport:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.requests: list[Any] = []
        self.attempted = asyncio.Event()
        self.available = asyncio.Event()

    async def http_fetch(self, request: Any) -> list[RawMessage]:
        self.requests.append(request)
        self.attempted.set()
        if not self.available.is_set():
            raise TimeoutError("simulated REST outage")
        return [
            RawMessage(
                payload=row,
                source=DataSource.HTTP,
                stream_type=request.descriptor.stream_type,
                received_at_ms=1_700_000_000_100,
            )
            for row in self.rows
        ]


class _CoalescingTransport:
    def __init__(self) -> None:
        self.requests: list[Any] = []
        self.first_started = asyncio.Event()
        self.release_first = asyncio.Event()

    async def http_fetch(self, request: Any) -> list[RawMessage]:
        self.requests.append(request)
        if len(self.requests) == 1:
            self.first_started.set()
            await self.release_first.wait()
        assert request.from_id is not None
        rows = [
            _agg_payload(sequence)
            for sequence in range(request.from_id, request.from_id + request.limit)
        ]
        return [
            RawMessage(
                payload=row,
                source=DataSource.HTTP,
                stream_type=request.descriptor.stream_type,
                received_at_ms=1_700_000_000_100,
            )
            for row in rows
        ]


def _kline_row(open_time: int) -> list[Any]:
    return [
        open_time,
        "1",
        "3",
        "0.5",
        "2",
        "10",
        open_time + 59_999,
        "20",
        4,
        "6",
        "12",
        "0",
    ]


def _kline_event(open_time: int) -> MarketEvent:
    return MarketEvent(
        event_type=StreamType.KLINE,
        symbol="BTCUSDT",
        exchange="binance",
        event_time_ms=open_time,
        received_at_ms=open_time + 1,
        source=DataSource.WEBSOCKET,
        data={
            "interval": "1m",
            "open_time": open_time,
            "close_time": open_time + 59_999,
            "open": 1.0,
            "high": 3.0,
            "low": 0.5,
            "close": 2.0,
            "volume": 10.0,
            "quote_volume": 20.0,
            "trades": 4,
            "taker_buy_base": 6.0,
            "taker_buy_quote": 12.0,
            "is_closed": False,
        },
        stream_key="futures:BTCUSDT@kline_1m",
        sequence=open_time,
        market_type="futures",
    )
