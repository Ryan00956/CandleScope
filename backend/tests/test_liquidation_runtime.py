from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.data_engine import runtime as runtime_module
from app.data_engine.market_data.liquidation_service import LiquidationService
from app.data_engine.storage import SQLiteLiquidationRollupStore


class _Factory:
    pass


def _valid_builder_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(runtime_module, "LIQUIDATION_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(
        runtime_module,
        "LIQUIDATION_DB_PATH",
        tmp_path / "liquidations.db",
    )
    monkeypatch.setattr(runtime_module, "LIQUIDATION_RAW_RING_SIZE", 17)
    monkeypatch.setattr(runtime_module, "LIQUIDATION_MAX_STREAMS", 3)
    monkeypatch.setattr(runtime_module, "LIQUIDATION_EVENT_QUEUE_SIZE", 19)
    monkeypatch.setattr(runtime_module, "LIQUIDATION_MAX_BATCH_SIZE", 5)
    monkeypatch.setattr(
        runtime_module,
        "LIQUIDATION_BATCH_INTERVAL_SECONDS",
        0.02,
    )
    monkeypatch.setattr(
        runtime_module,
        "LIQUIDATION_FINALIZE_INTERVAL_SECONDS",
        0.2,
    )


def test_rollup_store_selects_configured_sqlite_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    database = tmp_path / "liquidations.db"
    monkeypatch.setattr(runtime_module, "LIQUIDATION_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(runtime_module, "LIQUIDATION_DB_PATH", database)

    store = runtime_module._build_liquidation_rollup_store()

    assert isinstance(store, SQLiteLiquidationRollupStore)
    assert store.db_path == database


@pytest.mark.parametrize("backend", ["duckdb", "", "memory"])
def test_unknown_rollup_backend_fails_fast(
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
) -> None:
    monkeypatch.setattr(runtime_module, "LIQUIDATION_ROLLUP_BACKEND", backend)

    with pytest.raises(
        runtime_module.LiquidationConfigurationError,
        match="supported backends: sqlite",
    ):
        runtime_module._build_liquidation_rollup_store()


def test_invalid_sqlite_path_fails_with_liquidation_configuration_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "LIQUIDATION_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(runtime_module, "LIQUIDATION_DB_PATH", object())

    with pytest.raises(
        runtime_module.LiquidationConfigurationError,
        match="invalid liquidation SQLite path",
    ):
        runtime_module._build_liquidation_rollup_store()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("LIQUIDATION_RAW_RING_SIZE", 0),
        ("LIQUIDATION_MAX_STREAMS", False),
        ("LIQUIDATION_EVENT_QUEUE_SIZE", -1),
        ("LIQUIDATION_MAX_BATCH_SIZE", 0),
        ("LIQUIDATION_BATCH_INTERVAL_SECONDS", float("nan")),
        ("LIQUIDATION_FINALIZE_INTERVAL_SECONDS", float("inf")),
    ],
)
def test_service_builder_rejects_invalid_numeric_configuration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    name: str,
    value: int | float,
) -> None:
    _valid_builder_config(monkeypatch, tmp_path)
    monkeypatch.setattr(runtime_module, name, value)

    with pytest.raises(
        runtime_module.LiquidationConfigurationError,
        match="must be greater than zero",
    ):
        runtime_module._build_liquidation_service(_Factory())  # type: ignore[arg-type]


@pytest.mark.anyio
async def test_service_builder_wires_limits_and_independent_store(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _valid_builder_config(monkeypatch, tmp_path)

    service = runtime_module._build_liquidation_service(  # type: ignore[arg-type]
        _Factory()
    )

    assert isinstance(service, LiquidationService)
    assert isinstance(service.rollup_store, SQLiteLiquidationRollupStore)
    assert service.rollup_store.db_path == tmp_path / "liquidations.db"
    assert service.engine.diagnostics()["limits"] == {
        "raw_ring_per_stream": 17,
        "rollup_rows_per_stream": 2880,
        "streams": 3,
    }
    diagnostics = service.diagnostics()
    assert diagnostics["max_streams"] == 3
    assert diagnostics["command_queue"]["limit"] == 19
    assert service.hub.diagnostics()["max_batch_size"] == 5
    assert diagnostics["source_quality"] == "sampled_best_effort"
    assert diagnostics["backfillable"] is False

    await service.shutdown()


def test_capture_stream_identities_default_to_no_always_on_leases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "LIQUIDATION_CAPTURE_STREAMS", ())

    assert runtime_module._liquidation_capture_identities() == ()


def test_capture_stream_identities_normalize_and_deduplicate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runtime_module,
        "LIQUIDATION_CAPTURE_STREAMS",
        (
            " BINANCE : FUTURES : btcusdt ",
            "binance:futures:BTCUSDT",
            "binance:futures:ethusdt",
        ),
    )

    assert runtime_module._liquidation_capture_identities() == (
        ("binance", "futures", "BTCUSDT"),
        ("binance", "futures", "ETHUSDT"),
    )


@pytest.mark.parametrize(
    "streams",
    [
        ("binance:BTCUSDT",),
        ("binance::BTCUSDT",),
        ("binance:futures:BTCUSDT:extra",),
        (123,),
    ],
)
def test_capture_stream_identities_reject_malformed_values(
    monkeypatch: pytest.MonkeyPatch,
    streams: tuple[object, ...],
) -> None:
    monkeypatch.setattr(runtime_module, "LIQUIDATION_CAPTURE_STREAMS", streams)

    with pytest.raises(runtime_module.LiquidationConfigurationError):
        runtime_module._liquidation_capture_identities()


@pytest.mark.anyio
async def test_start_capture_streams_holds_dedicated_runtime_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str, str, str], str]] = []

    class _Service:
        async def ensure_stream(self, identity, *, consumer_id):
            calls.append((identity, consumer_id))
            return True

    monkeypatch.setattr(
        runtime_module,
        "LIQUIDATION_CAPTURE_STREAMS",
        (
            "binance:futures:BTCUSDT",
            "BINANCE:FUTURES:btcusdt",
        ),
    )

    await runtime_module._start_liquidation_capture_streams(  # type: ignore[arg-type]
        _Service()
    )

    assert calls == [
        (
            ("binance", "futures", "BTCUSDT"),
            "runtime:liquidation-capture",
        )
    ]


@pytest.mark.anyio
async def test_start_capture_streams_wraps_lease_failure_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Service:
        async def ensure_stream(self, _identity, *, consumer_id):
            assert consumer_id == "runtime:liquidation-capture"
            raise RuntimeError("transport unavailable")

    monkeypatch.setattr(
        runtime_module,
        "LIQUIDATION_CAPTURE_STREAMS",
        ("binance:futures:BTCUSDT",),
    )

    with pytest.raises(
        runtime_module.LiquidationConfigurationError,
        match="failed to start configured liquidation capture stream",
    ) as raised:
        await runtime_module._start_liquidation_capture_streams(  # type: ignore[arg-type]
            _Service()
        )
    assert isinstance(raised.value.__cause__, RuntimeError)


class _ShutdownComponent:
    def __init__(
        self,
        name: str,
        calls: list[str],
        *,
        fail: bool = False,
    ) -> None:
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


def _runtime(
    calls: list[str],
    *,
    liquidation_service: Any = None,
) -> runtime_module.DataEngineRuntime:
    return runtime_module.DataEngineRuntime(
        data_manager=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent(  # type: ignore[arg-type]
            "ingestion-factory",
            calls,
        ),
        backfill_transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        backfill_engine=object(),  # type: ignore[arg-type]
        backfill_coordinator=_ShutdownComponent("backfill", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent("market-data", calls),  # type: ignore[arg-type]
        trade_flow_service=_ShutdownComponent("trade-flow", calls),  # type: ignore[arg-type]
        liquidation_service=liquidation_service,
        price_stream_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
    )


@pytest.mark.anyio
async def test_runtime_optional_default_preserves_pre_liquidation_shutdown_order() -> None:
    calls: list[str] = []

    await _runtime(calls).shutdown(step_timeout=1)

    assert calls == [
        "backfill",
        "trade-flow",
        "market-data",
        "price-source",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]


@pytest.mark.anyio
async def test_runtime_shutdown_drains_liquidations_before_trade_flow() -> None:
    calls: list[str] = []

    await _runtime(
        calls,
        liquidation_service=_ShutdownComponent("liquidations", calls),
    ).shutdown(step_timeout=1)

    assert calls == [
        "backfill",
        "liquidations",
        "trade-flow",
        "market-data",
        "price-source",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]


@pytest.mark.anyio
async def test_partial_start_cleanup_closes_liquidations_and_continues_on_error() -> None:
    calls: list[str] = []

    await runtime_module._cleanup_partial_start(
        dm=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent(  # type: ignore[arg-type]
            "ingestion-factory",
            calls,
        ),
        transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        price_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent("market-data", calls),  # type: ignore[arg-type]
        trade_flow_service=_ShutdownComponent("trade-flow", calls),  # type: ignore[arg-type]
        liquidation_service=_ShutdownComponent(
            "liquidations",
            calls,
            fail=True,
        ),  # type: ignore[arg-type]
    )

    assert calls == [
        "price-source",
        "liquidations",
        "trade-flow",
        "market-data",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]
