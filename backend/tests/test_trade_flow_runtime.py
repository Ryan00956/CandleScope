from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.data_engine import runtime as runtime_module
from app.data_engine.market_data.trade_flow_service import TradeFlowService
from app.data_engine.storage import (
    DisabledRawAggTradeArchive,
    SQLiteTradeFlowRollupStore,
)


class _Factory:
    pass


def test_rollup_store_selects_configured_sqlite_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    database = tmp_path / "trade-flow.db"
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_DB_PATH", database)

    store = runtime_module._build_trade_flow_rollup_store()

    assert isinstance(store, SQLiteTradeFlowRollupStore)
    assert store.db_path == database


def test_unknown_rollup_backend_fails_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_ROLLUP_BACKEND", "duckdb")

    with pytest.raises(
        runtime_module.TradeFlowConfigurationError,
        match="supported backends: sqlite",
    ):
        runtime_module._build_trade_flow_rollup_store()


def test_disabled_archive_does_not_validate_or_create_backend(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_root = tmp_path / "must-not-exist"
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", False)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_BACKEND",
        "not-configured",
    )
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_DIR", archive_root)

    archive = runtime_module._build_raw_agg_trade_archive()

    assert isinstance(archive, DisabledRawAggTradeArchive)
    assert not archive_root.exists()


def test_raw_archive_stream_identities_are_inert_when_archive_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", False)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_STREAMS",
        ("not:a:valid:identity",),
    )

    assert runtime_module._raw_archive_stream_identities() == ()


def test_raw_archive_stream_identities_normalize_and_deduplicate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_STREAMS",
        (
            "BINANCE:FUTURES:btcusdt",
            "binance:futures:BTCUSDT",
            "binance:futures:ethusdt",
        ),
    )

    assert runtime_module._raw_archive_stream_identities() == (
        ("binance", "futures", "BTCUSDT"),
        ("binance", "futures", "ETHUSDT"),
    )


def test_raw_archive_stream_identities_reject_malformed_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_STREAMS",
        ("binance:BTCUSDT",),
    )

    with pytest.raises(
        runtime_module.TradeFlowConfigurationError,
        match="exchange:market_type:symbol",
    ):
        runtime_module._raw_archive_stream_identities()


@pytest.mark.anyio
async def test_start_raw_archive_streams_holds_runtime_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str, str, str], str]] = []

    class _Service:
        async def ensure_stream(self, identity, *, consumer_id):
            calls.append((identity, consumer_id))
            return True

    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_STREAMS",
        ("binance:futures:BTCUSDT",),
    )

    await runtime_module._start_raw_archive_streams(_Service())  # type: ignore[arg-type]

    assert calls == [
        (
            ("binance", "futures", "BTCUSDT"),
            "runtime:raw-agg-trade-archive",
        )
    ]


def test_enabled_archive_constructs_parquet_backend_and_directory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[Path, int]] = []

    class _ParquetArchive:
        enabled = True

        def __init__(self, root: Path, *, max_rows_per_file: int) -> None:
            calls.append((root, max_rows_per_file))

    archive_root = tmp_path / "raw"
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_BACKEND", "parquet")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_DIR", archive_root)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH",
        321,
    )
    monkeypatch.setattr(runtime_module, "ParquetRawAggTradeArchive", _ParquetArchive)

    archive = runtime_module._build_raw_agg_trade_archive()

    assert isinstance(archive, _ParquetArchive)
    assert archive_root.is_dir()
    assert calls == [(archive_root, 321)]


@pytest.mark.parametrize(
    ("backend", "message"),
    [
        ("duckdb", "supported backends: parquet"),
        ("", "supported backends: parquet"),
    ],
)
def test_enabled_archive_rejects_unknown_backend(
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
    message: str,
) -> None:
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_BACKEND", backend)

    with pytest.raises(runtime_module.TradeFlowConfigurationError, match=message):
        runtime_module._build_raw_agg_trade_archive()


def test_enabled_archive_propagates_missing_pyarrow_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class _MissingPyArrowArchive:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("pyarrow is not installed")

    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_BACKEND", "parquet")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_DIR", tmp_path / "raw")
    monkeypatch.setattr(
        runtime_module,
        "ParquetRawAggTradeArchive",
        _MissingPyArrowArchive,
    )

    with pytest.raises(
        runtime_module.TradeFlowConfigurationError,
        match="pyarrow is not installed",
    ) as raised:
        runtime_module._build_raw_agg_trade_archive()
    assert isinstance(raised.value.__cause__, RuntimeError)


def test_enabled_archive_rejects_file_as_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    archive_root = tmp_path / "not-a-directory"
    archive_root.write_text("occupied", encoding="utf-8")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_BACKEND", "parquet")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_DIR", archive_root)

    with pytest.raises(
        runtime_module.TradeFlowConfigurationError,
        match="directory is unusable",
    ):
        runtime_module._build_raw_agg_trade_archive()


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("TRADE_FLOW_EVENT_QUEUE_SIZE", 0, "must be greater than zero"),
        ("TRADE_FLOW_BATCH_INTERVAL_SECONDS", float("nan"), "must be greater"),
    ],
)
def test_service_builder_rejects_invalid_numeric_configuration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    name: str,
    value: int | float,
    message: str,
) -> None:
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_DB_PATH", tmp_path / "flow.db")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", False)
    monkeypatch.setattr(runtime_module, name, value)

    with pytest.raises(runtime_module.TradeFlowConfigurationError, match=message):
        runtime_module._build_trade_flow_service(_Factory())


@pytest.mark.anyio
async def test_disabled_archive_ignores_archive_only_numeric_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_DB_PATH", tmp_path / "flow.db")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", False)
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS", -1.0)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_MAX_PENDING_BATCHES",
        0,
    )
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH",
        0,
    )

    service = runtime_module._build_trade_flow_service(_Factory())

    assert isinstance(service.raw_archive, DisabledRawAggTradeArchive)
    await service.shutdown()


def test_enabled_archive_validates_archive_numeric_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class _ParquetArchive:
        enabled = True

        def __init__(self, _root: Path, *, max_rows_per_file: int) -> None:
            assert max_rows_per_file > 0

    monkeypatch.setattr(runtime_module, "TRADE_FLOW_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_DB_PATH", tmp_path / "flow.db")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", True)
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_BACKEND", "parquet")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_DIR", tmp_path / "raw")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS", -1.0)
    monkeypatch.setattr(runtime_module, "ParquetRawAggTradeArchive", _ParquetArchive)

    with pytest.raises(
        runtime_module.TradeFlowConfigurationError,
        match="zero or greater",
    ):
        runtime_module._build_trade_flow_service(_Factory())


@pytest.mark.anyio
async def test_service_builder_wires_limits_and_disabled_archive(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_ROLLUP_BACKEND", "sqlite")
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_DB_PATH", tmp_path / "flow.db")
    monkeypatch.setattr(runtime_module, "RAW_AGG_TRADE_ARCHIVE_ENABLED", False)
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_RAW_RING_SIZE", 17)
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_MAX_STREAMS", 3)
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_EVENT_QUEUE_SIZE", 19)
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_MAX_BATCH_SIZE", 5)
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_GAP_REPAIR_MAX_TRADES", 23)
    monkeypatch.setattr(runtime_module, "TRADE_FLOW_BATCH_INTERVAL_SECONDS", 0.02)
    monkeypatch.setattr(
        runtime_module,
        "RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH",
        29,
    )

    service = runtime_module._build_trade_flow_service(_Factory())

    assert isinstance(service, TradeFlowService)
    assert isinstance(service.rollup_store, SQLiteTradeFlowRollupStore)
    assert isinstance(service.raw_archive, DisabledRawAggTradeArchive)
    assert service.engine.diagnostics()["raw_ring_size_per_stream"] == 17
    assert service.engine.diagnostics()["max_streams"] == 3
    assert service.diagnostics()["max_streams"] == 3
    assert service.diagnostics()["command_queue"]["limit"] == 19
    assert service.hub.diagnostics()["max_batch_size"] == 5

    await service.shutdown()


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


@pytest.mark.anyio
async def test_runtime_shutdown_stops_trade_flow_before_ingestion() -> None:
    calls: list[str] = []
    runtime = runtime_module.DataEngineRuntime(
        data_manager=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent("ingestion-factory", calls),  # type: ignore[arg-type]
        backfill_transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        backfill_engine=object(),  # type: ignore[arg-type]
        backfill_coordinator=_ShutdownComponent("backfill", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent("market-data", calls),  # type: ignore[arg-type]
        trade_flow_service=_ShutdownComponent("trade-flow", calls),  # type: ignore[arg-type]
        price_stream_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
    )

    await runtime.shutdown(step_timeout=1)

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
async def test_partial_start_cleanup_closes_trade_flow_and_continues_on_error() -> None:
    calls: list[str] = []

    await runtime_module._cleanup_partial_start(
        dm=_ShutdownComponent("data-manager", calls),  # type: ignore[arg-type]
        ingestion_factory=_ShutdownComponent(  # type: ignore[arg-type]
            "ingestion-factory",
            calls,
        ),
        transport=_ShutdownComponent("transport", calls),  # type: ignore[arg-type]
        price_source=_ShutdownComponent("price-source", calls),  # type: ignore[arg-type]
        market_data_service=_ShutdownComponent(  # type: ignore[arg-type]
            "market-data",
            calls,
            fail=True,
        ),
        trade_flow_service=_ShutdownComponent(  # type: ignore[arg-type]
            "trade-flow",
            calls,
        ),
    )

    assert calls == [
        "price-source",
        "trade-flow",
        "market-data",
        "data-manager",
        "ingestion-factory",
        "transport",
    ]


@pytest.mark.anyio
async def test_startup_configuration_failure_cleans_already_created_components(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class _DataManager(_ShutdownComponent):
        def set_storage(self, _storage: Any) -> None:
            pass

        def set_ingestion_factory(self, _factory: Any) -> None:
            pass

        def set_market_data_service(self, _service: Any) -> None:
            pass

    class _Writer:
        def __init__(self, _repository: Any) -> None:
            pass

        def start(self) -> None:
            pass

    data_manager = _DataManager("data-manager", calls)
    ingestion_factory = _ShutdownComponent("ingestion-factory", calls)
    market_data_service = _ShutdownComponent("market-data", calls)

    monkeypatch.setattr(runtime_module, "DataManager", lambda: data_manager)
    monkeypatch.setattr(runtime_module, "KlinesRepoAdapter", object)
    monkeypatch.setattr(runtime_module, "AsyncKlinesRepoAdapter", object)
    monkeypatch.setattr(runtime_module, "GapLedger", object)
    monkeypatch.setattr(
        runtime_module,
        "ExchangeIngestionFactory",
        lambda: ingestion_factory,
    )
    monkeypatch.setattr(runtime_module, "MarketMetricsRepository", object)
    monkeypatch.setattr(runtime_module, "MarketMetricStorageWriter", _Writer)
    monkeypatch.setattr(
        runtime_module,
        "MarketDataService",
        lambda *_args, **_kwargs: market_data_service,
    )

    def _fail_trade_flow(_factory: Any) -> TradeFlowService:
        raise runtime_module.TradeFlowConfigurationError("invalid TradeFlow config")

    monkeypatch.setattr(
        runtime_module,
        "_build_trade_flow_service",
        _fail_trade_flow,
    )

    with pytest.raises(
        runtime_module.TradeFlowConfigurationError,
        match="invalid TradeFlow config",
    ):
        await runtime_module.start_data_engine()

    assert calls == ["market-data", "data-manager", "ingestion-factory"]


@pytest.mark.anyio
async def test_main_does_not_swallow_trade_flow_configuration_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import main as main_module

    async def _fail_startup():
        raise runtime_module.TradeFlowConfigurationError("unsafe archive config")

    monkeypatch.setattr(runtime_module, "start_data_engine", _fail_startup)

    with pytest.raises(
        runtime_module.TradeFlowConfigurationError,
        match="unsafe archive config",
    ):
        await main_module._init_data_manager()
