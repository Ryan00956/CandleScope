from __future__ import annotations

import asyncio
import importlib.util
import re
import sys
import time
from pathlib import Path

from app.core import market as core_market
from app.data_engine import interval_policy
from app.data_engine.bar_aggregator import (
    BarAggregator,
    BarAggregatorConfig,
    BarEvent,
    BarEventType,
    BarInput,
    BarInputSource,
    BarState,
)
from app.data_engine.bar_aggregator import models as aggregator_models
from app.data_engine.data_manager.aggregator_bridge import AggregatorBridge
from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.backfill_coordinator import (
    BackfillCoordinator,
    RepairRequest,
)
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.custom_query import CustomIntervalQueryService
from app.data_engine.data_manager.event_bus import DataEventBus
from app.data_engine.data_manager.ingestion_price_source import IngestionPriceSource
from app.data_engine.data_manager.models import (
    BarData,
    DataEvent,
    DataEventType,
    QueryResult,
    QuerySource,
    SeriesKey,
)
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.data_manager.retention import RetentionService
from app.data_engine.data_manager.coordinator import StreamCoordinator
from app.data_engine.data_manager.stream_policy import StreamEnsurePlanner
from app.data_engine.data_manager.subscriptions import SubscriptionService, SubscriptionTier
from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _load_module_from_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


async def _wait_until(predicate, *, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    assert predicate()


backfill_models = _load_module_from_path(
    "boundary_backfill_models",
    BACKEND_ROOT / "app/data_engine/backfill/models.py",
)


def _python_files(*roots: str) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        files.extend((BACKEND_ROOT / root).rglob("*.py"))
    return sorted(files)


def test_no_new_legacy_data_engine_service_imports() -> None:
    """Only known migration shims may import legacy services/collectors."""
    pattern = re.compile(
        r"app\.data_engine\.services|data_engine\.services|"
        r"app\.data_engine\.collectors|data_engine\.collectors"
    )
    allowed: set[Path] = set()

    offenders: list[str] = []
    for path in _python_files("app", "tests"):
        rel = path.relative_to(BACKEND_ROOT)
        if rel in allowed:
            continue
        if pattern.search(path.read_text(encoding="utf-8", errors="ignore")):
            offenders.append(str(rel))

    assert offenders == []


def test_price_ticker_service_has_no_runtime_imports() -> None:
    """Price streams should be backed by ingestion, not the old side-channel service."""
    offenders: list[str] = []
    for path in _python_files("app"):
        rel = path.relative_to(BACKEND_ROOT)
        if "PriceTickerService" in path.read_text(encoding="utf-8", errors="ignore"):
            offenders.append(str(rel))

    assert offenders == []


def test_interval_policy_is_shared_by_legacy_entrypoints() -> None:
    """Historical helpers should delegate to the canonical interval policy."""
    samples = {
        "1m": 60_000,
        "45m": 2_700_000,
        "2h": 7_200_000,
        "2w": 1_209_600_000,
        "1M": 2_592_000_000,
    }

    for interval, expected_ms in samples.items():
        assert interval_policy.parse_interval_ms(interval) == expected_ms
        assert aggregator_models.parse_interval_ms(interval) == expected_ms
        assert backfill_models.parse_interval_ms(interval) == expected_ms
        assert core_market.parse_custom_interval(interval) == expected_ms // 1000

    assert aggregator_models.STANDARD_INTERVALS is interval_policy.STANDARD_INTERVALS
    assert backfill_models.STANDARD_INTERVAL_MS is interval_policy.STANDARD_INTERVAL_MS
    assert core_market.INTERVAL_SECONDS is interval_policy.INTERVAL_SECONDS
    assert core_market.compute_bucket_start_ms(3_750_000, 2_700_000, interval="45m") == 2_700_000
    assert core_market.compute_month_bucket(1_714_521_600, 2) == interval_policy.compute_month_bucket(
        1_714_521_600,
        2,
    )
    assert core_market.compute_month_bucket_ms(1_714_521_600_000, 2) == (
        interval_policy.compute_month_bucket_ms(1_714_521_600_000, 2)
    )
    assert core_market.next_month_bucket(1_714_521_600, 2) == (
        interval_policy.next_month_bucket(1_714_521_600, 2)
    )


def test_data_engine_does_not_import_core_market_interval_helpers() -> None:
    """data_engine should use interval_policy directly; core.market is compatibility."""
    offenders: list[str] = []
    for path in _python_files("app/data_engine"):
        if "app.core.market" in path.read_text(encoding="utf-8", errors="ignore"):
            offenders.append(str(path.relative_to(BACKEND_ROOT)))

    assert offenders == []


def test_settings_and_main_do_not_run_backfill_engine_directly() -> None:
    """Backfill orchestration should go through BackfillCoordinator."""
    forbidden = (
        "backfill_engine.run",
        "detect_only",
        "backfill_futures",
        "_load_backfilled",
        "def _backfill_trigger",
        "def _startup_gap_scan",
    )
    offenders: list[str] = []
    for rel in (Path("app/main.py"), Path("app/api/v1/settings.py")):
        text = (BACKEND_ROOT / rel).read_text(encoding="utf-8", errors="ignore")
        for token in forbidden:
            if token in text:
                offenders.append(f"{rel}:{token}")

    assert offenders == []


def test_main_delegates_data_engine_runtime_wiring() -> None:
    """FastAPI entrypoint should not construct DataEngine internals directly."""
    text = (BACKEND_ROOT / "app/main.py").read_text(encoding="utf-8", errors="ignore")
    forbidden = (
        "BackfillEngine(",
        "TransportLayer(",
        "BinanceIngestionFactory(",
        "BackfillCoordinator(",
        "IngestionPriceSource",
        "SubscriptionService",
        "dm.subscribe",
        "DataEventType",
        "create_engine",
        "backfill_coordinator.startup_scan",
        "app.state.backfill_transport",
        "app.state.backfill_engine",
        "app.state.backfill_coordinator",
        "app.state.ingestion_factory",
        "app.state.price_stream_source",
        "app.state.gap_scan_task",
    )

    offenders = [token for token in forbidden if token in text]

    assert offenders == []
    assert "start_data_engine" in text
    assert "bridge_indicator_engine" in text


def test_runtime_attaches_only_stable_app_state_handles() -> None:
    """Runtime should not publish internal wiring objects onto app.state."""
    text = (BACKEND_ROOT / "app/data_engine/runtime.py").read_text(
        encoding="utf-8",
        errors="ignore",
    )
    forbidden = (
        "state.ingestion_factory",
        "state.backfill_transport",
        "state.backfill_engine",
        "state.backfill_coordinator",
        "state.price_stream_source",
        "state.gap_scan_task",
    )

    offenders = [token for token in forbidden if token in text]

    assert offenders == []
    assert "state.data_engine_runtime" in text
    assert "state.data_manager" in text


def test_settings_uses_runtime_facade_for_data_engine_internals() -> None:
    """Settings API should not read DataEngine internals from app.state."""
    text = (BACKEND_ROOT / "app/api/v1/settings.py").read_text(
        encoding="utf-8",
        errors="ignore",
    )
    forbidden_state_fields = (
        "ingestion_factory",
        "backfill_transport",
        "backfill_engine",
        "backfill_coordinator",
        "price_stream_source",
        "gap_scan_task",
    )

    offenders: list[str] = []
    for field in forbidden_state_fields:
        patterns = (
            rf"request\.app\.state\.{field}\b",
            rf"getattr\(\s*request\.app\.state\s*,\s*[\"']{field}[\"']",
        )
        if any(re.search(pattern, text) for pattern in patterns):
            offenders.append(field)

    assert offenders == []
    assert '"data_engine_runtime"' in text


def test_data_engine_does_not_call_exchange_adapters_directly() -> None:
    """Data Engine core should consume exchange plugins/protocols, not adapters."""
    offenders: list[str] = []
    for path in (BACKEND_ROOT / "app/data_engine").rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for token in ("plugin.adapter()", "get_exchange_registry().get("):
            if token in text:
                offenders.append(f"{path.relative_to(BACKEND_ROOT)}:{token}")

    assert offenders == []


def test_data_engine_layer_import_boundaries_are_directional() -> None:
    """Cross-module imports should follow the planned DataEngine layering."""
    checks = [
        (
            "api/v1 imports bar_aggregator",
            _python_files("app/api/v1"),
            re.compile(
                r"^\s*(?:from\s+app\.data_engine\.bar_aggregator\b|"
                r"import\s+app\.data_engine\.bar_aggregator\b)",
                re.MULTILINE,
            ),
        ),
        (
            "ingestion imports backfill",
            _python_files("app/data_engine/ingestion"),
            re.compile(
                r"^\s*(?:from\s+(?:app\.data_engine\.backfill|\.\.backfill)\b|"
                r"import\s+app\.data_engine\.backfill\b)",
                re.MULTILINE,
            ),
        ),
        (
            "bar_aggregator imports storage",
            _python_files("app/data_engine/bar_aggregator"),
            re.compile(
                r"^\s*(?:from\s+(?:app\.data_engine\.storage|\.\.storage)\b|"
                r"import\s+app\.data_engine\.storage\b)",
                re.MULTILINE,
            ),
        ),
        (
            "backfill imports data_manager",
            _python_files("app/data_engine/backfill"),
            re.compile(
                r"^\s*(?:from\s+(?:app\.data_engine\.data_manager|\.\.data_manager)\b|"
                r"import\s+app\.data_engine\.data_manager\b)",
                re.MULTILINE,
            ),
        ),
    ]

    offenders: list[str] = []
    for label, files, pattern in checks:
        for path in files:
            text = path.read_text(encoding="utf-8", errors="ignore")
            if pattern.search(text):
                offenders.append(f"{label}: {path.relative_to(BACKEND_ROOT)}")

    assert offenders == []


def test_business_paths_do_not_use_bar_aggregator_private_pipeline() -> None:
    """DataManager/backfill/settings must use BarAggregator public APIs."""
    pattern = re.compile(r"_handle_bar_input|pipeline\.bar_state|get_pipeline\(")
    roots = [
        Path("app/data_engine/data_manager"),
        Path("app/data_engine/backfill"),
        Path("app/api/v1/settings.py"),
    ]
    offenders: list[str] = []
    for root in roots:
        path = BACKEND_ROOT / root
        files = [path] if path.is_file() else sorted(path.rglob("*.py"))
        for file_path in files:
            if pattern.search(file_path.read_text(encoding="utf-8", errors="ignore")):
                offenders.append(str(file_path.relative_to(BACKEND_ROOT)))

    assert offenders == []


def test_settings_storage_maintenance_stays_behind_data_manager() -> None:
    """Settings API should delegate storage repair to DataManager maintenance."""
    text = (BACKEND_ROOT / "app/api/v1/settings.py").read_text(
        encoding="utf-8",
        errors="ignore",
    )
    forbidden = (
        "BarAggregator",
        "RepairRequest",
        "backfill_engine.run",
        "detect_only",
        "query_engine._storage",
        "_normalize_storage_row",
    )

    offenders = [token for token in forbidden if token in text]

    assert offenders == []


def test_maintenance_service_uses_explicit_dependencies() -> None:
    """MaintenanceService should not hold the whole DataManager facade."""
    text = (BACKEND_ROOT / "app/data_engine/data_manager/maintenance.py").read_text(
        encoding="utf-8",
        errors="ignore",
    )
    forbidden = (
        "def __init__(self, data_manager",
        "self._dm",
        "_dm.",
    )

    offenders = [token for token in forbidden if token in text]

    assert offenders == []
    assert "storage_provider" in text
    assert "cache_invalidator" in text
    assert "bars_backfilled" in text


def test_backfill_coordinator_uses_explicit_sinks() -> None:
    """BackfillCoordinator should not hold the whole DataManager facade."""
    text = (BACKEND_ROOT / "app/data_engine/data_manager/backfill_coordinator.py").read_text(
        encoding="utf-8",
        errors="ignore",
    )
    forbidden = (
        "data_manager:",
        "self._dm",
        "_dm.",
    )

    offenders = [token for token in forbidden if token in text]

    assert offenders == []
    assert "bars_backfilled" in text
    assert "emit_event" in text


def test_business_code_uses_data_manager_public_facade_for_internals() -> None:
    """Business modules should not reach into DataManager internals."""
    files = [
        *_python_files("app/api", "app/indicator"),
        BACKEND_ROOT / "app/main.py",
        BACKEND_ROOT / "app/data_engine/runtime.py",
    ]
    direct_pattern = re.compile(
        r"\bdm\.(?:cache|event_bus|coordinator|query_engine|bar_aggregator|subscriptions)\b|"
        r"\bruntime\.data_manager\.(?:cache|event_bus|coordinator|query_engine|bar_aggregator|subscriptions)\b|"
        r"getattr\(\s*dm\s*,\s*[\"'](?:cache|event_bus|coordinator|query_engine|bar_aggregator|subscriptions)[\"']",
    )

    offenders: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        if direct_pattern.search(text):
            offenders.append(str(path.relative_to(BACKEND_ROOT)))

    assert offenders == []


def test_data_manager_package_root_does_not_export_internal_services() -> None:
    """Package root should expose facade contracts, not internal services."""
    from app.data_engine import data_manager

    forbidden = {
        "BarCache",
        "BarSeries",
        "DataEventBus",
        "MiddlewareHook",
        "DailyOpenService",
        "QueryEngine",
        "StreamCoordinator",
        "IngestionFactory",
        "IngestionPriceSource",
        "MaintenanceService",
        "PriceSnapshot",
        "PriceSnapshotCache",
        "SubscriptionService",
    }

    exported = set(data_manager.__all__)

    assert forbidden.isdisjoint(exported)
    assert {
        "DataManager",
        "DataManagerConfig",
        "BarData",
        "SeriesKey",
        "DataEventType",
        "MaintenanceBusyError",
        "MaintenanceUnavailableError",
        "SubscriptionTier",
    }.issubset(exported)


def test_cross_module_dependency_slots_use_named_contracts() -> None:
    """High-risk cross-module hooks should use named contracts, not bare Any."""
    checked = [
        BACKEND_ROOT / "app/data_engine/data_manager/manager.py",
        BACKEND_ROOT / "app/data_engine/data_manager/maintenance.py",
        BACKEND_ROOT / "app/data_engine/data_manager/backfill_coordinator.py",
        BACKEND_ROOT / "app/data_engine/data_manager/subscriptions.py",
    ]
    forbidden = (
        "def wire_backfill_reconciler(self, reconciler: Any)",
        "def set_price_stream_controller(self, controller: Any)",
        "def set_backfill_trigger(self, trigger: Any)",
        "backfill_coordinator: Any",
        "data_manager: Any",
        "_data_manager: Any",
    )

    offenders: list[str] = []
    for path in checked:
        text = path.read_text(encoding="utf-8", errors="ignore")
        for token in forbidden:
            if token in text:
                offenders.append(f"{path.relative_to(BACKEND_ROOT)}:{token}")

    assert offenders == []


def test_query_engine_interior_gap_fill_uses_series_exchange() -> None:
    class _Storage:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def query_bars(self, **kwargs):
            self.calls.append(kwargs)
            return [{
                "open_time": 120_000,
                "open": 1,
                "high": 1,
                "low": 1,
                "close": 1,
                "volume": 1,
            }]

    storage = _Storage()
    engine = QueryEngine(BarCache(), storage=storage)  # type: ignore[arg-type]
    key = SeriesKey("BTC-USDT", "1m", exchange="okx", market_type="spot")
    bars = [
        BarData(time=60, open=1, high=1, low=1, close=1, volume=1),
        BarData(time=180, open=1, high=1, low=1, close=1, volume=1),
    ]

    filled = engine._fill_interior_gaps(key, bars, "1m")

    assert storage.calls[0]["exchange"] == "okx"
    assert storage.calls[0]["market_type"] == "spot"
    assert [bar.time for bar in filled] == [60, 120, 180]


def test_data_manager_submits_query_missing_ranges_explicitly() -> None:
    class _Storage:
        def query_bars(self, **kwargs):
            return []

    calls: list[tuple] = []
    dm = DataManager()
    dm.set_storage(_Storage())  # type: ignore[arg-type]
    dm.set_backfill_trigger(lambda *args: calls.append(args))

    result = dm.query(
        "BTC-USDT",
        "1m",
        start_ms=60_000,
        end_ms=120_000,
        limit=2,
        exchange="okx",
        market_type="spot",
    )

    assert dm.query_engine.backfill_trigger is None
    assert result.backfill_triggered is True
    assert [r.reason for r in result.missing_ranges] == ["query_empty"]
    assert calls == [("BTC-USDT", "1m", 60_000, 120_000, "okx", "spot")]


def test_stream_policy_plans_okx_base_stream_without_facade_logic() -> None:
    planner = StreamEnsurePlanner(base_interval="1m")

    plan = planner.plan("BTC-USDT", "1h", exchange="okx", market_type="spot")

    assert [key.interval for key in plan.aggregation_targets] == ["1h", "1m"]
    assert [key.interval for key in plan.prerequisite_streams] == ["1m"]


def test_data_manager_on_bar_event_preserves_exchange() -> None:
    async def _run() -> None:
        dm = DataManager()
        events = []

        async def _capture(event):
            events.append(event)

        dm.subscribe(
            _capture,
            symbol="BTC-USDT",
            interval="1m",
            exchange="okx",
            market_type="spot",
            event_types={DataEventType.BAR_UPDATED},
        )
        await dm.on_bar_event(
            "BTC-USDT",
            "1m",
            BarData(time=60, open=1, high=1, low=1, close=1, volume=1),
            exchange="okx",
            market_type="spot",
        )

        await _wait_until(lambda: len(events) == 1)
        assert len(events) == 1
        assert events[0].key.exchange == "okx"
        assert events[0].key.market_type == "spot"
        await dm.event_bus.close()

    asyncio.run(_run())


def test_ingestion_gap_marker_routes_to_backfill_trigger() -> None:
    async def _run() -> None:
        class _Handle:
            async def stop(self) -> None:
                pass

        class _Factory:
            def __init__(self) -> None:
                self.on_gap = None

            async def start(
                self,
                symbol,
                interval,
                on_market_event,
                exchange="binance",
                market_type="spot",
                on_gap=None,
            ):
                self.on_gap = on_gap
                return _Handle()

        dm = DataManager()
        factory = _Factory()
        triggered = []
        dm.set_ingestion_factory(factory)
        dm.set_backfill_trigger(lambda *args: triggered.append(args))

        await dm.ensure_stream("BTC-USDT", "1m", exchange="okx", market_type="spot")
        assert factory.on_gap is not None

        class _StreamType:
            value = "kline"

        class _Gap:
            stream_type = _StreamType()
            filled = False
            gap_start = 60_000
            gap_end = 180_000

        await factory.on_gap(_Gap())

        assert triggered == [("BTC-USDT", "1m", 120_000, 120_000, "okx", "spot")]

    asyncio.run(_run())


def test_stream_coordinator_forwards_real_market_event_to_bar_aggregator() -> None:
    async def _run() -> None:
        class _Handle:
            async def stop(self) -> None:
                pass

        class _Factory:
            def __init__(self) -> None:
                self.on_market_event = None

            async def start(
                self,
                symbol,
                interval,
                on_market_event,
                exchange="binance",
                market_type="spot",
                on_gap=None,
            ):
                self.on_market_event = on_market_event
                return _Handle()

        class _Aggregator:
            def __init__(self) -> None:
                self.events = []

            async def on_market_event(self, event):
                self.events.append(event)

        factory = _Factory()
        aggregator = _Aggregator()
        coord = StreamCoordinator()
        coord.set_ingestion_factory(factory)
        coord.set_bar_aggregator(aggregator)

        await coord.ensure_stream("BTC-USDT", "1m", exchange="okx", market_type="swap")
        assert factory.on_market_event is not None

        event = MarketEvent(
            event_type=StreamType.KLINE,
            symbol="BTC-USDT",
            exchange="okx",
            event_time_ms=60_000,
            received_at_ms=60_010,
            source=DataSource.WEBSOCKET,
            data={
                "interval": "1m",
                "open_time": 60_000,
                "close_time": 119_999,
                "open": 1,
                "high": 2,
                "low": 1,
                "close": 2,
                "volume": 10,
                "is_closed": False,
            },
            stream_key="okx:swap:BTC-USDT@kline_1m",
            market_type="swap",
        )
        await factory.on_market_event(event)

        assert aggregator.events == [event]

    asyncio.run(_run())


def test_realtime_kline_path_has_no_bar_dict_market_event_adapter() -> None:
    checked = [
        BACKEND_ROOT / "app/data_engine/ingestion/factory.py",
        BACKEND_ROOT / "app/data_engine/data_manager/coordinator.py",
    ]
    forbidden = (
        "_BarDictMarketEvent",
        "_EnumLike",
        "on_raw_bar",
        "on_bar: Callable[[dict]",
        "bar_dict -> MarketEvent",
        "MarketEvent -> bar_dict",
    )

    offenders: list[str] = []
    for path in checked:
        text = path.read_text(encoding="utf-8", errors="ignore")
        for token in forbidden:
            if token in text:
                offenders.append(f"{path.relative_to(BACKEND_ROOT)}:{token}")

    assert offenders == []


def test_data_manager_price_updates_emit_events_and_snapshot() -> None:
    async def _run() -> None:
        dm = DataManager()
        events = []

        async def _capture(event):
            events.append(event)

        dm.subscribe(_capture, event_types={DataEventType.PRICE_UPDATED})
        await dm.ensure_price_stream("BTC-USDT", exchange="okx", market_type="spot")
        await dm.on_price_ticks([{
            "symbol": "okx:spot:BTC-USDT",
            "exchange": "okx",
            "market_type": "spot",
            "price": 100,
            "open": 90,
            "high": 110,
            "low": 80,
            "change_pct": 11.1111,
            "volume": 12,
            "quote_volume": 1200,
            "daily_open": 95,
            "updated_at_ms": 123456,
        }])

        snapshot = dm.get_prices_snapshot()
        assert len(snapshot) == 1
        assert snapshot[0]["symbol"] == "okx:spot:BTC-USDT"
        assert snapshot[0]["daily_change"] == 5
        await _wait_until(lambda: len(events) == 1)
        assert len(events) == 1
        assert events[0].event_type == DataEventType.PRICE_UPDATED
        assert events[0].key == SeriesKey("BTC-USDT", "price", exchange="okx", market_type="spot")
        await dm.event_bus.close()

    asyncio.run(_run())


def test_event_bus_callback_subscribers_do_not_block_each_other() -> None:
    async def _run() -> None:
        bus = DataEventBus()
        gate = asyncio.Event()
        fast_received = asyncio.Event()
        delivered: list[str] = []

        async def _slow(_event):
            await gate.wait()
            delivered.append("slow")

        async def _fast(_event):
            delivered.append("fast")
            fast_received.set()

        bus.subscribe(_slow)
        bus.subscribe(_fast)

        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_UPDATED,
            key=SeriesKey("BTC-USDT", "1m"),
        ))

        await asyncio.wait_for(fast_received.wait(), timeout=1.0)
        assert delivered == ["fast"]

        gate.set()
        await _wait_until(lambda: delivered == ["fast", "slow"])
        await bus.close()

    asyncio.run(_run())


def test_event_bus_reports_callback_subscriber_lag() -> None:
    async def _run() -> None:
        bus = DataEventBus()
        delivered = asyncio.Event()

        async def _callback(_event):
            delivered.set()

        bus.subscribe(_callback, event_types={DataEventType.BAR_CLOSED})
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=SeriesKey("BTC-USDT", "1m"),
        ))
        await asyncio.wait_for(delivered.wait(), timeout=1.0)

        snapshot = bus.snapshot()
        assert snapshot["callback_lag"]
        stats = next(iter(snapshot["callback_lag"].values()))
        assert stats["delivered"] == 1
        assert stats["max_lag_ms"] >= 0

        await bus.close()

    asyncio.run(_run())


def test_event_bus_reports_iterator_subscriber_lag() -> None:
    async def _run() -> None:
        bus = DataEventBus()
        delivered = asyncio.Event()
        release = asyncio.Event()

        async def _consume() -> None:
            async for _event in bus.subscribe_iter(
                event_types={DataEventType.BAR_CLOSED},
            ):
                delivered.set()
                await release.wait()
                break

        task = asyncio.create_task(_consume())
        await asyncio.sleep(0)
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=SeriesKey("BTC-USDT", "1m"),
        ))
        await asyncio.wait_for(delivered.wait(), timeout=1.0)

        snapshot = bus.snapshot()
        assert snapshot["queue_lag"]
        stats = next(iter(snapshot["queue_lag"].values()))
        assert stats["delivered"] == 1
        assert stats["max_lag_ms"] >= 0

        release.set()
        await task
        await bus.close()

    asyncio.run(_run())


def test_data_manager_price_stream_uses_async_controller() -> None:
    async def _run() -> None:
        class _Controller:
            def __init__(self) -> None:
                self.started = []
                self.stopped = []

            async def ensure_symbol(self, key):
                self.started.append(key)

            async def remove_symbol(self, key):
                self.stopped.append(key)

        dm = DataManager()
        controller = _Controller()
        dm.set_price_stream_controller(controller)

        await dm.ensure_price_stream("BTC-USDT", exchange="okx", market_type="spot")
        await dm.stop_price_stream("BTC-USDT", exchange="okx", market_type="spot")

        assert controller.started == ["okx:spot:BTC-USDT"]
        assert controller.stopped == ["okx:spot:BTC-USDT"]

    asyncio.run(_run())


def test_ingestion_price_source_starts_and_stops_factory_streams() -> None:
    async def _run() -> None:
        class _Handle:
            def __init__(self) -> None:
                self.stopped = False

            async def stop(self):
                self.stopped = True

        class _Factory:
            def __init__(self) -> None:
                self.calls = []
                self.handle = _Handle()
                self.on_price = None

            async def start_price(self, symbol, on_price, exchange="binance", market_type="spot"):
                self.calls.append((exchange, market_type, symbol))
                self.on_price = on_price
                return self.handle

        factory = _Factory()
        source = IngestionPriceSource(factory)
        updates = []

        async def _capture(items):
            updates.extend(items)

        source.on_price_update(_capture)
        await source.ensure_symbol("okx:spot:BTC-USDT")
        await factory.on_price({"symbol": "BTC-USDT", "price": 100})
        await source.remove_symbol("okx:spot:BTC-USDT")

        assert factory.calls == [("okx", "spot", "BTC-USDT")]
        assert updates == [{"symbol": "BTC-USDT", "price": 100}]
        assert factory.handle.stopped is True

    asyncio.run(_run())


def test_ingestion_price_source_fans_out_multi_symbol_ticker_streams() -> None:
    async def _run() -> None:
        class _Handle:
            def __init__(self, symbols) -> None:
                self.symbols_history = [list(symbols)]
                self.stopped = False

            def set_symbols(self, symbols):
                self.symbols_history.append(list(symbols))

            async def stop(self):
                self.stopped = True

        class _Factory:
            def __init__(self) -> None:
                self.calls = []
                self.handle: _Handle | None = None
                self.on_price = None

            async def start_price_many(
                self,
                *,
                symbols,
                on_price,
                exchange="binance",
                market_type="spot",
            ):
                self.calls.append((exchange, market_type, list(symbols)))
                self.on_price = on_price
                self.handle = _Handle(symbols)
                return self.handle

        factory = _Factory()
        source = IngestionPriceSource(factory)
        updates = []

        async def _capture(items):
            updates.extend(items)

        source.on_price_update(_capture)
        await source.ensure_symbol("spot:BTCUSDT")
        await source.ensure_symbol("spot:ETHUSDT")
        await factory.on_price({"symbol": "ETHUSDT", "price": 200})
        await source.remove_symbol("spot:BTCUSDT")
        await source.remove_symbol("spot:ETHUSDT")

        assert factory.calls == [("binance", "spot", ["BTCUSDT"])]
        assert factory.handle is not None
        assert factory.handle.symbols_history == [
            ["BTCUSDT"],
            ["BTCUSDT", "ETHUSDT"],
            ["ETHUSDT"],
        ]
        assert factory.handle.stopped is True
        assert updates == [{"symbol": "ETHUSDT", "price": 200}]

    asyncio.run(_run())


def test_subscription_service_price_tier_uses_data_manager(tmp_path) -> None:
    async def _run() -> None:
        class _DataManager:
            def __init__(self) -> None:
                self.price_started = []
                self.price_stopped = []

            async def ensure_price_stream(self, symbol, exchange="binance", market_type="spot"):
                self.price_started.append((exchange, market_type, symbol))

            async def stop_price_stream(self, symbol, exchange="binance", market_type="spot"):
                self.price_stopped.append((exchange, market_type, symbol))

        dm = _DataManager()
        service = SubscriptionService(tmp_path / "subs.db")
        service.set_data_manager(dm)

        result = await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.PRICE_ONLY)
        assert result["changed"] is True
        assert dm.price_started == [("okx", "spot", "BTC-USDT")]

        result = await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.NONE)
        assert result["changed"] is True
        assert dm.price_stopped == [("okx", "spot", "BTC-USDT")]

    asyncio.run(_run())


def test_aggregator_bridge_persists_closed_bar_and_preserves_exchange() -> None:
    async def _run() -> None:
        class _Storage:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            def upsert_bars(
                self,
                symbol,
                interval,
                rows,
                source,
                exchange,
                market_type,
            ) -> None:
                self.calls.append({
                    "symbol": symbol,
                    "interval": interval,
                    "rows": rows,
                    "source": source,
                    "exchange": exchange,
                    "market_type": market_type,
                })

        cache = BarCache()
        bus = DataEventBus()
        storage = _Storage()
        marked: list[SeriesKey] = []
        events = []

        async def _capture(event):
            events.append(event)

        bus.subscribe(_capture)
        bridge = AggregatorBridge(
            cache=cache,
            event_bus=bus,
            storage_provider=lambda: storage,  # type: ignore[return-value]
            mark_bar_received=marked.append,
            is_started=lambda: True,
        )
        state = BarState(
            symbol="BTC-USDT",
            interval="1m",
            bucket_start_ms=60_000,
            bucket_end_ms=120_000,
            open=1,
            high=3,
            low=0.5,
            close=2,
            volume=10,
            exchange="okx",
            market_type="spot",
        )

        await bridge.on_bar_event(BarEvent(BarEventType.CLOSED, state))

        key = SeriesKey("BTC-USDT", "1m", exchange="okx", market_type="spot")
        assert storage.calls[0]["exchange"] == "okx"
        assert storage.calls[0]["market_type"] == "spot"
        assert cache.get_latest(key, 1)[0].close == 2
        assert marked == [key]
        await _wait_until(lambda: len(events) == 1)
        assert events[0].key == key
        assert events[0].event_type == DataEventType.BAR_CLOSED
        await bus.close()

    asyncio.run(_run())


def test_retention_service_updates_limits_without_private_cache_access() -> None:
    cache = BarCache()
    service = RetentionService(
        cache=cache,
        event_bus=DataEventBus(),
        storage_provider=lambda: None,
    )

    service.update_limits(
        db_limits={"minutes": 123},
        ephemeral_bars=456,
    )

    assert service.snapshot()["db_limits"]["minutes"] == 123
    assert service.snapshot()["ephemeral_bars"] == 456


def test_custom_interval_query_service_aggregates_45m_from_base() -> None:
    base_bars = [
        BarData(time=0, open=1, high=2, low=1, close=2, volume=1),
        BarData(time=900, open=2, high=4, low=1.5, close=3, volume=2),
        BarData(time=1800, open=3, high=3.5, low=0.5, close=2.5, volume=3),
    ]

    def _base_query(*args, **kwargs) -> QueryResult:
        return QueryResult(
            bars=base_bars,
            symbol="BTC-USDT",
            interval="15m",
            source=QuerySource.CACHE,
            total=len(base_bars),
            has_more=False,
            cache_hit=True,
            backfill_triggered=False,
            has_tail_gap=False,
        )

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(default_limit=10, max_limit=100),
        base_query=_base_query,
    )

    result = service.query_from_base(
        symbol="BTC-USDT",
        interval="45m",
        start_ms=None,
        end_ms=None,
        limit=10,
        started_at=0.0,
        exchange="binance",
        market_type="spot",
    )

    assert len(result.bars) == 1
    assert result.bars[0].open == 1
    assert result.bars[0].high == 4
    assert result.bars[0].low == 0.5
    assert result.bars[0].close == 2.5
    assert result.bars[0].volume == 6
    assert result.metadata["derived_from"] == "15m"


def test_custom_interval_query_service_uses_bar_aggregator_batch() -> None:
    class _Aggregator:
        def __init__(self) -> None:
            self.calls = []

        async def aggregate_batch(
            self,
            symbol,
            target_interval,
            source_interval,
            bars,
            exchange="binance",
            market_type="spot",
        ):
            self.calls.append({
                "symbol": symbol,
                "target_interval": target_interval,
                "source_interval": source_interval,
                "bars": bars,
                "exchange": exchange,
                "market_type": market_type,
            })
            return [BarState(
                symbol=symbol,
                interval=target_interval,
                bucket_start_ms=0,
                bucket_end_ms=2_700_000,
                open=10,
                high=12,
                low=8,
                close=11,
                volume=7,
                exchange=exchange,
                market_type=market_type,
            )]

    base_bars = [
        BarData(time=0, open=1, high=2, low=1, close=2, volume=1),
        BarData(time=900, open=2, high=4, low=1.5, close=3, volume=2),
        BarData(time=1800, open=3, high=3.5, low=0.5, close=2.5, volume=3),
    ]

    def _base_query(*args, **kwargs) -> QueryResult:
        return QueryResult(
            bars=base_bars,
            symbol="BTC-USDT",
            interval="15m",
            source=QuerySource.CACHE,
            total=len(base_bars),
            has_more=False,
            cache_hit=True,
            backfill_triggered=False,
            has_tail_gap=False,
        )

    aggregator = _Aggregator()
    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(default_limit=10, max_limit=100),
        base_query=_base_query,
        bar_aggregator=aggregator,
    )

    result = service.query_from_base(
        symbol="BTC-USDT",
        interval="45m",
        start_ms=None,
        end_ms=None,
        limit=10,
        started_at=0.0,
        exchange="okx",
        market_type="spot",
    )

    assert aggregator.calls[0]["symbol"] == "BTC-USDT"
    assert aggregator.calls[0]["target_interval"] == "45m"
    assert aggregator.calls[0]["source_interval"] == "15m"
    assert aggregator.calls[0]["bars"][0]["close_time"] == 899_999
    assert aggregator.calls[0]["exchange"] == "okx"
    assert result.bars[0].open == 10
    assert result.bars[0].close == 11


def test_bar_aggregator_seed_active_bar_does_not_emit_events() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig())
        agg.add_target("BTC-USDT", "1m", exchange="okx", market_type="spot")
        events = []

        async def _capture(event):
            events.append(event)

        now_ms = int(time.time() * 1000)
        bucket_start_ms = agg.compute_bucket("1m", now_ms)
        assert bucket_start_ms is not None
        agg.publisher.on_bar_event(_capture)
        state = await agg.seed_active_bar(
            "BTC-USDT",
            "1m",
            BarInput(
                symbol="BTC-USDT",
                source_interval="1m",
                exchange="okx",
                market_type="spot",
                open_time_ms=bucket_start_ms,
                close_time_ms=bucket_start_ms + 59_999,
                open=1,
                high=2,
                low=0.5,
                close=1.5,
                volume=10,
                source=BarInputSource.MANUAL,
                is_closed=False,
            ),
            exchange="okx",
            market_type="spot",
            emit_events=False,
        )

        assert state is not None
        assert state.exchange == "okx"
        assert state.close == 1.5
        assert events == []

    asyncio.run(_run())


def test_bar_aggregator_aggregate_batch_is_isolated() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig())
        rows = [
            {
                "open_time": 0,
                "close_time": 899_999,
                "open": 1,
                "high": 2,
                "low": 1,
                "close": 2,
                "volume": 1,
            },
            {
                "open_time": 900_000,
                "close_time": 1_799_999,
                "open": 2,
                "high": 4,
                "low": 1.5,
                "close": 3,
                "volume": 2,
            },
            {
                "open_time": 1_800_000,
                "close_time": 2_699_999,
                "open": 3,
                "high": 3.5,
                "low": 0.5,
                "close": 2.5,
                "volume": 3,
            },
        ]

        states = await agg.aggregate_batch(
            "BTC-USDT",
            "45m",
            "15m",
            rows,
            exchange="binance",
            market_type="spot",
        )

        assert agg.get_targets() == []
        assert agg.get_active_bars("BTC-USDT", "45m") == []
        assert len(states) == 1
        assert states[0].open == 1
        assert states[0].high == 4
        assert states[0].low == 0.5
        assert states[0].close == 2.5
        assert states[0].volume == 6

    asyncio.run(_run())


def test_backfill_coordinator_dedupes_inflight_request_and_loads_cache() -> None:
    async def _run() -> None:
        class _Status:
            value = "completed"

        class _ReconcileResult:
            bars_written = 1

        class _RepairReport:
            status = _Status()
            reconcile_result = _ReconcileResult()
            errors: list[str] = []

        class _Engine:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def run(self, **kwargs):
                self.calls.append(kwargs)
                await asyncio.sleep(0.01)
                return _RepairReport()

        class _Storage:
            def query_bars(self, **kwargs):
                return [{
                    "open_time": 60_000,
                    "open": 1,
                    "high": 2,
                    "low": 1,
                    "close": 2,
                    "volume": 3,
                }]

        class _DataManager:
            def __init__(self) -> None:
                self.event_bus = DataEventBus()
                self.loaded = []

            async def on_bars_backfilled(self, symbol, interval, bars, **kwargs):
                self.loaded.append((symbol, interval, bars, kwargs))

        engine = _Engine()
        dm = _DataManager()
        coord = BackfillCoordinator(
            storage=_Storage(),
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.event_bus.emit,
            engine=engine,
            loop=asyncio.get_running_loop(),
            base_delay_seconds=0,
        )

        req = RepairRequest(
            symbol="BTC-USDT",
            interval="1m",
            start_ms=0,
            end_ms=120_000,
            exchange="okx",
            market_type="spot",
        )
        first = asyncio.create_task(coord.request_and_wait(req))
        await asyncio.sleep(0)
        second = asyncio.create_task(coord.request_and_wait(RepairRequest(
            symbol="BTC-USDT",
            interval="1m",
            start_ms=0,
            end_ms=120_000,
            exchange="okx",
            market_type="spot",
        )))

        outcomes = await asyncio.gather(first, second)

        assert len(engine.calls) == 1
        assert outcomes[0].status.value == "completed"
        assert outcomes[1].status.value == "completed"
        assert len(dm.loaded) == 1
        assert dm.loaded[0][3]["exchange"] == "okx"
        assert dm.loaded[0][2][0].close == 2

    asyncio.run(_run())
