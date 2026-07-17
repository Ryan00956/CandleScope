from __future__ import annotations

from typing import Any

import pytest

from app.data_engine import runtime as runtime_module
from app.data_engine.market_data.full_order_book_service import FullOrderBookService


class _Factory:
    pass


def _valid_config(monkeypatch: pytest.MonkeyPatch) -> None:
    values = {
        "FULL_ORDER_BOOK_MAX_STREAMS": 3,
        "FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE": 17,
        "FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE": 2000,
        "FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA": 101,
        "FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES": 1001,
        "FULL_ORDER_BOOK_DEFAULT_MAX_PENDING": 2,
        "FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS": 1.5,
        "FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS": 0.05,
        "FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS": 2.0,
        "FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS": 0.25,
    }
    for name, value in values.items():
        monkeypatch.setattr(runtime_module, name, value)


@pytest.mark.anyio
async def test_full_order_book_builder_wires_all_strict_memory_bounds(monkeypatch) -> None:
    _valid_config(monkeypatch)

    service = runtime_module._build_full_order_book_service(  # type: ignore[arg-type]
        _Factory(),
    )

    assert isinstance(service, FullOrderBookService)
    diagnostics = service.diagnostics()
    assert diagnostics["limits"] == {
        "streams": 3,
        "upstream_queue_per_stream": 17,
        "snapshot_limit": 1000,
        "snapshot_timeout_seconds": 1.5,
        "initial_resync_backoff_seconds": 0.05,
        "max_resync_backoff_seconds": 2.0,
    }
    assert diagnostics["hub"]["max_states"] == 3
    assert diagnostics["engine"]["limits"] == {
        "streams": 3,
        "levels_per_side": 2000,
        "buffered_deltas_per_stream": 17,
        "updates_per_delta": 101,
        "buffered_level_updates_per_stream": 1001,
    }
    assert diagnostics["source_delivery"] == "ordered_delta"
    assert diagnostics["fail_closed_on_gap"] is True
    assert diagnostics["persistence"] is False
    await service.shutdown()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("FULL_ORDER_BOOK_MAX_STREAMS", 0),
        ("FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE", False),
        ("FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE", -1),
        ("FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA", 0),
        ("FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES", 0),
        ("FULL_ORDER_BOOK_DEFAULT_MAX_PENDING", 0),
        ("FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS", float("nan")),
        ("FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS", -0.1),
        ("FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS", 0),
        ("FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS", 0),
    ],
)
def test_full_order_book_builder_rejects_invalid_numeric_config(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: int | float,
) -> None:
    _valid_config(monkeypatch)
    monkeypatch.setattr(runtime_module, name, value)

    with pytest.raises(runtime_module.FullOrderBookConfigurationError):
        runtime_module._build_full_order_book_service(_Factory())  # type: ignore[arg-type]


def test_full_order_book_builder_rejects_incoherent_bounds(monkeypatch) -> None:
    _valid_config(monkeypatch)
    monkeypatch.setattr(runtime_module, "FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE", 999)
    with pytest.raises(
        runtime_module.FullOrderBookConfigurationError,
        match="at least 1000",
    ):
        runtime_module._build_full_order_book_service(_Factory())  # type: ignore[arg-type]

    _valid_config(monkeypatch)
    monkeypatch.setattr(
        runtime_module,
        "FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES",
        100,
    )
    with pytest.raises(
        runtime_module.FullOrderBookConfigurationError,
        match="must be at least",
    ):
        runtime_module._build_full_order_book_service(_Factory())  # type: ignore[arg-type]

    _valid_config(monkeypatch)
    monkeypatch.setattr(
        runtime_module,
        "FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS",
        0.01,
    )
    with pytest.raises(
        runtime_module.FullOrderBookConfigurationError,
        match="cannot be less",
    ):
        runtime_module._build_full_order_book_service(_Factory())  # type: ignore[arg-type]


class _ShutdownComponent:
    def __init__(self, name: str, calls: list[str]) -> None:
        self.name = name
        self.calls = calls

    async def shutdown(self) -> None:
        self.calls.append(self.name)

    async def stop(self) -> None:
        self.calls.append(self.name)


def _runtime(calls: list[str], *, full_order_book_service: Any = None):
    return runtime_module.DataEngineRuntime(
        data_manager=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent("ingestion-factory", calls),  # type: ignore[arg-type]
        backfill_transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        backfill_engine=object(),  # type: ignore[arg-type]
        backfill_coordinator=_ShutdownComponent("backfill", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent("market-data", calls),  # type: ignore[arg-type]
        trade_flow_service=_ShutdownComponent("trade-flow", calls),  # type: ignore[arg-type]
        full_order_book_service=full_order_book_service,
        price_stream_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
    )


@pytest.mark.anyio
async def test_runtime_shutdown_closes_full_book_before_shared_ingestion() -> None:
    calls: list[str] = []

    await _runtime(
        calls,
        full_order_book_service=_ShutdownComponent("full-order-book", calls),
    ).shutdown(step_timeout=1)

    assert calls == [
        "backfill",
        "full-order-book",
        "trade-flow",
        "market-data",
        "price-source",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]


@pytest.mark.anyio
async def test_partial_start_cleanup_closes_full_book_before_factory() -> None:
    calls: list[str] = []

    await runtime_module._cleanup_partial_start(
        dm=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent("ingestion-factory", calls),  # type: ignore[arg-type]
        transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        price_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent("market-data", calls),  # type: ignore[arg-type]
        trade_flow_service=_ShutdownComponent("trade-flow", calls),  # type: ignore[arg-type]
        full_order_book_service=_ShutdownComponent("full-order-book", calls),  # type: ignore[arg-type]
    )

    assert calls == [
        "price-source",
        "full-order-book",
        "trade-flow",
        "market-data",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]
