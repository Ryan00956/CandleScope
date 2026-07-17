from __future__ import annotations

from typing import Any

import pytest

from app.data_engine import runtime as runtime_module
from app.data_engine.market_data.order_book_service import OrderBookService


class _Factory:
    pass


def _valid_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_module, "ORDER_BOOK_MAX_STREAMS", 3)
    monkeypatch.setattr(runtime_module, "ORDER_BOOK_EVENT_QUEUE_SIZE", 7)
    monkeypatch.setattr(runtime_module, "ORDER_BOOK_DEFAULT_MAX_PENDING", 2)
    monkeypatch.setattr(runtime_module, "ORDER_BOOK_MAX_SNAPSHOT_AGE_MS", 4000)
    monkeypatch.setattr(
        runtime_module,
        "ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS",
        0.25,
    )


@pytest.mark.anyio
async def test_order_book_builder_wires_bounded_latest_state(monkeypatch) -> None:
    _valid_config(monkeypatch)

    service = runtime_module._build_order_book_service(  # type: ignore[arg-type]
        _Factory(),
    )

    assert isinstance(service, OrderBookService)
    diagnostics = service.diagnostics()
    assert diagnostics["max_streams"] == 3
    assert diagnostics["max_snapshot_age_ms"] == 4000
    assert diagnostics["event_queue"]["limit"] == 7
    assert diagnostics["hub"]["max_states"] == 3
    assert diagnostics["mode"] == "partial_top_n"
    assert diagnostics["delivery"] == "latest_wins"
    assert diagnostics["persistence"] is False
    assert diagnostics["full_depth_reconstruction"] is False

    await service.shutdown()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("ORDER_BOOK_MAX_STREAMS", 0),
        ("ORDER_BOOK_EVENT_QUEUE_SIZE", False),
        ("ORDER_BOOK_DEFAULT_MAX_PENDING", -1),
        ("ORDER_BOOK_MAX_SNAPSHOT_AGE_MS", 0),
        ("ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS", float("nan")),
    ],
)
def test_order_book_builder_rejects_invalid_numeric_config(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: int | float,
) -> None:
    _valid_config(monkeypatch)
    monkeypatch.setattr(runtime_module, name, value)

    with pytest.raises(
        runtime_module.OrderBookConfigurationError,
        match="must be greater than zero",
    ):
        runtime_module._build_order_book_service(_Factory())  # type: ignore[arg-type]


def test_order_book_builder_requires_latest_slot_per_active_stream(monkeypatch) -> None:
    _valid_config(monkeypatch)
    monkeypatch.setattr(runtime_module, "ORDER_BOOK_MAX_STREAMS", 8)
    monkeypatch.setattr(runtime_module, "ORDER_BOOK_EVENT_QUEUE_SIZE", 7)

    with pytest.raises(
        runtime_module.OrderBookConfigurationError,
        match="at least ORDER_BOOK_MAX_STREAMS",
    ):
        runtime_module._build_order_book_service(_Factory())  # type: ignore[arg-type]


class _ShutdownComponent:
    def __init__(self, name: str, calls: list[str], *, fail: bool = False) -> None:
        self.name = name
        self.calls = calls
        self.fail = fail

    async def shutdown(self) -> None:
        self.calls.append(self.name)
        if self.fail:
            raise RuntimeError(self.name)

    async def stop(self) -> None:
        self.calls.append(self.name)
        if self.fail:
            raise RuntimeError(self.name)


def _runtime(calls: list[str], *, order_book_service: Any = None):
    return runtime_module.DataEngineRuntime(
        data_manager=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent("ingestion-factory", calls),  # type: ignore[arg-type]
        backfill_transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        backfill_engine=object(),  # type: ignore[arg-type]
        backfill_coordinator=_ShutdownComponent("backfill", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent("market-data", calls),  # type: ignore[arg-type]
        trade_flow_service=_ShutdownComponent("trade-flow", calls),  # type: ignore[arg-type]
        order_book_service=order_book_service,
        price_stream_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
    )


@pytest.mark.anyio
async def test_runtime_shutdown_closes_order_book_before_shared_ingestion() -> None:
    calls: list[str] = []

    await _runtime(
        calls,
        order_book_service=_ShutdownComponent("order-book", calls),
    ).shutdown(step_timeout=1)

    assert calls == [
        "backfill",
        "order-book",
        "trade-flow",
        "market-data",
        "price-source",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]


@pytest.mark.anyio
async def test_partial_start_cleanup_closes_order_book_and_continues() -> None:
    calls: list[str] = []

    await runtime_module._cleanup_partial_start(
        dm=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent("ingestion-factory", calls),  # type: ignore[arg-type]
        transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        price_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent("market-data", calls),  # type: ignore[arg-type]
        trade_flow_service=_ShutdownComponent("trade-flow", calls),  # type: ignore[arg-type]
        order_book_service=_ShutdownComponent("order-book", calls, fail=True),  # type: ignore[arg-type]
    )

    assert calls == [
        "price-source",
        "order-book",
        "trade-flow",
        "market-data",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]
