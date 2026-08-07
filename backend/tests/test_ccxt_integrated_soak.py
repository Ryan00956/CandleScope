from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import aiohttp
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.continuity import ContinuityLayer
from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.ingestion.transport import TransportLayer
from app.exchanges.ccxt_ext.soak import (
    FullBookAudit,
    SequenceAudit,
    integrated_soak_failure_reasons,
)


def test_sequence_audit_counts_recovery_without_accepting_output_gaps() -> None:
    audit = SequenceAudit(step=1)

    audit.observe(10, DataSource.WEBSOCKET)
    audit.observe(11, DataSource.HTTP_BACKFILL)
    audit.observe(12, DataSource.HTTP_BACKFILL)
    audit.observe(13, DataSource.WEBSOCKET)

    assert audit.events == 4
    assert audit.recovered_events == 2
    assert audit.gaps == 0
    assert audit.missing == 0
    assert audit.duplicates == 0
    assert audit.out_of_order == 0


def test_sequence_audit_exposes_duplicates_order_and_missing() -> None:
    audit = SequenceAudit(step=1)

    for value in (10, 10, 9, 13):
        audit.observe(value, DataSource.WEBSOCKET)

    assert audit.duplicates == 1
    assert audit.out_of_order == 1
    assert audit.gaps == 1
    assert audit.missing == 2


def test_live_kline_revisions_are_not_counted_as_out_of_order() -> None:
    async def run() -> None:
        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.KLINE,
            interval="1m",
        )
        layer = ContinuityLayer(IngestionConfig(), object(), descriptor)

        async def ingest(open_time: int) -> None:
            await layer.ingest(
                MarketEvent(
                    event_type=StreamType.KLINE,
                    symbol="BTCUSDT",
                    exchange="binance",
                    event_time_ms=open_time,
                    received_at_ms=open_time,
                    source=DataSource.WEBSOCKET,
                    data={"open_time": open_time, "is_closed": False},
                    stream_key=descriptor.key,
                )
            )

        await ingest(0)
        await ingest(0)
        await ingest(60_000)
        await ingest(60_000)

        counters = layer.snapshot()["metrics"]["counters"]
        assert counters["events_received"] == 4
        assert counters.get("events_out_of_order", 0) == 0
        assert layer.snapshot()["last_continuity_key"] == 60_000

    asyncio.run(run())


def test_full_book_audit_rejects_crossed_and_regressing_books() -> None:
    audit = FullBookAudit()

    audit.observe(_book(100, bid=101, ask=100))
    audit.observe(_book(99, bid=99, ask=100))

    assert audit.crossed_samples == 1
    assert audit.update_id_regressions == 1

    object_levels = SimpleNamespace(
        event=SimpleNamespace(
            data={
                "live": True,
                "last_update_id": 101,
                "bids": [SimpleNamespace(price=99.0, quantity=1.0)],
                "asks": [SimpleNamespace(price=100.0, quantity=1.0)],
            }
        )
    )
    audit.observe(object_levels)
    assert audit.crossed_samples == 1


def test_verdict_gate_accepts_clean_recovered_stream() -> None:
    report = _clean_report()
    report["agg_trade"]["recovered_events"] = 50
    report["gap_recovery"]["agg_trade"]["filled"] = 2

    assert integrated_soak_failure_reasons(report) == []


def test_verdict_gate_fails_unfilled_gap_and_queue_overflow() -> None:
    report = _clean_report()
    report["gap_recovery"]["agg_trade"]["unfilled"] = 1
    session = report["pipelines"]["futures:BTCUSDT@aggTrade"]["feed_control"]["session"]
    session["metrics"]["counters"]["raw_queue_overflows"] = 1

    assert integrated_soak_failure_reasons(report) == [
        "agg_trade_unfilled_gaps",
        "raw_queue_overflow:futures:BTCUSDT@aggTrade",
    ]


def test_verdict_gate_fails_pending_or_terminal_recovery_state() -> None:
    report = _clean_report()
    recovery = report["pipelines"]["futures:BTCUSDT@aggTrade"]["recovery"]
    recovery["state"] = "recovering"

    assert integrated_soak_failure_reasons(report) == [
        "recovery_not_healthy:futures:BTCUSDT@aggTrade",
    ]

    recovery["state"] = "failed"
    assert integrated_soak_failure_reasons(report) == [
        "recovery_not_healthy:futures:BTCUSDT@aggTrade",
    ]

    recovery["state"] = "healthy"
    recovery["terminal_failures"] = 1
    assert integrated_soak_failure_reasons(report) == [
        "recovery_not_healthy:futures:BTCUSDT@aggTrade",
    ]


def test_verdict_gate_rejects_capacity_churn_and_incomplete_shutdown() -> None:
    report = _clean_report()
    report["full_order_book"]["service"]["engine"] = {"capacity_failures": 1}
    report["shutdown"] = {"completed": False}

    assert integrated_soak_failure_reasons(report) == [
        "full_book_capacity_failures",
        "shutdown_incomplete",
    ]


def test_verdict_gate_requires_every_injected_disconnect_to_be_observed() -> None:
    report = _clean_report()
    report["completed_duration"] = True
    report["fault_injection"] = {"requested": 1, "completed": 1, "failed": 0}

    assert integrated_soak_failure_reasons(report) == [
        "fault_not_observed:futures:BTCUSDT@aggTrade",
    ]

    session = report["pipelines"]["futures:BTCUSDT@aggTrade"]["feed_control"][
        "session"
    ]
    session["metrics"]["counters"]["lifecycle_disconnected"] = 1
    assert integrated_soak_failure_reasons(report) == []


def test_native_transport_uses_threaded_dns_on_windows(monkeypatch) -> None:
    async def run() -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        transport = TransportLayer(IngestionConfig())
        await transport.start()
        try:
            assert transport._http_session is not None
            connector = transport._http_session.connector
            assert isinstance(connector._resolver, aiohttp.ThreadedResolver)
        finally:
            await transport.stop()

    asyncio.run(run())


def _book(update_id: int, *, bid: float, ask: float):
    return SimpleNamespace(
        event=SimpleNamespace(
            data={
                "live": True,
                "last_update_id": update_id,
                "bids": [[bid, 1.0]],
                "asks": [[ask, 1.0]],
            }
        )
    )


def _clean_report():
    sequence = {
        "duplicates": 0,
        "out_of_order": 0,
        "gaps": 0,
        "missing": 0,
    }
    return {
        "ready": True,
        "fatal_errors": [],
        "kline": dict(sequence),
        "agg_trade": dict(sequence),
        "gap_recovery": {
            "kline": {"unfilled": 0, "filled": 0},
            "agg_trade": {"unfilled": 0, "filled": 0},
        },
        "full_order_book": {
            "audit": {
                "missing_samples": 0,
                "empty_side_samples": 0,
                "crossed_samples": 0,
                "update_id_regressions": 0,
            },
            "service": {
                "deltas_invalid": 0,
                "upstream_queue_overflows": 0,
                "hub_publish_rejected": 0,
                "engine": {"capacity_failures": 0},
                "actors": [{"state": "live"}],
            },
        },
        "pipelines": {
            "futures:BTCUSDT@aggTrade": {
                "recovery": {"enabled": True, "state": "healthy"},
                "feed_control": {
                    "session": {
                        "health": "connected",
                        "metrics": {"counters": {}},
                    },
                }
            }
        },
    }
