from __future__ import annotations

import asyncio

from app.data_engine.runtime import DataEngineRuntime


class _Stop:
    def __init__(self) -> None:
        self.called = False

    async def stop(self) -> None:
        self.called = True


class _Coordinator:
    def __init__(self) -> None:
        self.shutdown_after_service = False
        self.service: _Stop | None = None

    async def shutdown(self) -> None:
        self.shutdown_after_service = bool(self.service and self.service.called)


class _Idle:
    async def shutdown(self) -> None:
        return None

    async def stop(self) -> None:
        return None


def test_runtime_shutdown_stops_manual_history_before_coordinator(monkeypatch) -> None:
    service = _Stop()
    coordinator = _Coordinator()
    coordinator.service = service
    idle = _Idle()

    runtime = DataEngineRuntime.__new__(DataEngineRuntime)
    runtime.gap_audit_task = None
    runtime.gap_scan_task = None
    runtime.manual_history_service = service
    runtime.backfill_coordinator = coordinator
    runtime.liquidation_service = None
    runtime.order_book_service = None
    runtime.full_order_book_service = None
    runtime.trade_flow_service = idle
    runtime.market_data_service = idle
    runtime.price_stream_source = None
    runtime.data_manager = idle
    runtime.ingestion_factory = idle
    runtime.backfill_transport = idle

    asyncio.run(runtime.shutdown())
    assert service.called is True
    assert coordinator.shutdown_after_service is True
