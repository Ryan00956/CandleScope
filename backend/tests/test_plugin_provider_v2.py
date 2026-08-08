from __future__ import annotations

import asyncio
import copy
from functools import wraps
from pathlib import Path
from typing import Any

import pytest

from candlescope_plugin_sdk.platform_v2 import (
    ActivationRequest,
    InvokeRequest,
    PluginManifest,
    RequestContext,
)
from candlescope_plugin_sdk.platform_v2.examples.mock_exchange_provider import (
    MockExchangeProviderPlugin,
    mock_exchange_provider_manifest,
)

from app.data_engine.backfill import BackfillConfig, BackfillEngine
from app.data_engine.bar_aggregator import BarAggregator, BarEventType
from app.data_engine.ingestion import IngestionConfig, MarketDataIngress
from app.data_engine.ingestion.continuity import ContinuityLayer
from app.data_engine.ingestion.models import (
    DataSource,
    FeedMode,
    MarketEvent,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.ingestion.normalize import NormalizeLayer
from app.data_engine.ingestion.transport import TransportLayer
from app.data_engine.storage import AsyncKlinesRepoAdapter, KlinesRepoAdapter
from app.data_engine.storage import klines_repo
from app.exchanges import (
    RateLimitAdmission,
    bootstrap_default_adapters,
    get_exchange_registry,
)
from app.plugin_core_v2 import CorePluginError
from app.plugin_core_v2.contracts import core_contributions
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_provider_v2 import PluginProviderRuntime
from tests.plugin_platform_bundle_testkit import build_mock_exchange_provider_bundle


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


class _MockSidecar:
    def __init__(self) -> None:
        self.plugin = MockExchangeProviderPlugin()
        self.plugin.activate(ActivationRequest("provider-test", 1, ()))
        self.open_requests: list[dict[str, Any]] = []
        self.history_requests: list[dict[str, Any]] = []
        self.symbol_requests: list[dict[str, Any]] = []
        self.corrupt_next_book_delta = False
        self.oversize_next_book_snapshot = False
        self.fail_next_poll = False

    async def invoke(
        self, contribution: Any, payload: dict[str, Any]
    ) -> dict[str, Any]:
        if payload["operation"] == "stream.open":
            self.open_requests.append(copy.deepcopy(payload))
        elif payload["operation"] == "history.read":
            self.history_requests.append(copy.deepcopy(payload))
        elif payload["operation"] == "symbols.list":
            self.symbol_requests.append(copy.deepcopy(payload))
        elif payload["operation"] == "stream.poll" and self.fail_next_poll:
            self.fail_next_poll = False
            raise RuntimeError("synthetic provider crash")
        request = InvokeRequest(
            contribution_id=contribution.id,
            input=payload,
            request_context=RequestContext(
                contribution_id=contribution.id,
                user_action=False,
                generation=1,
                trace_id="provider-test",
            ),
        )
        result = self.plugin.invoke(request)
        assert isinstance(result, dict)
        if (
            self.corrupt_next_book_delta
            and payload["operation"] == "stream.poll"
            and result["events"][0]["eventType"] == "orderbook.delta"
        ):
            self.corrupt_next_book_delta = False
            result = copy.deepcopy(result)
            result["events"][0]["payload"]["previousFinalUpdateId"] -= 1
        if (
            self.oversize_next_book_snapshot
            and payload["operation"] == "stream.poll"
            and result["events"][0]["eventType"] == "orderbook.snapshot"
        ):
            self.oversize_next_book_snapshot = False
            result = copy.deepcopy(result)
            result["events"][0]["payload"]["bids"] = [
                [100.0 + index, 1.0] for index in range(101)
            ]
        return result


class _ProviderResponseAccounting:
    def __init__(self) -> None:
        self.responses: list[dict[str, object]] = []

    async def inspect(
        self,
        rule: object,
        request: object,
    ) -> RateLimitAdmission:
        return RateLimitAdmission(
            allowed=True,
            bucket_key=str(getattr(rule, "bucket_key", "provider:test")),
            cost=1,
            reason=None,
            retry_after_seconds=0,
            retry_at_monotonic=None,
            retry_at_ms=None,
            rule_name=str(getattr(rule, "name", "provider_test")),
        )

    async def acquire_nowait(self, rule: object, request: object) -> None:
        return None

    def record_response(self, rule: object, **kwargs: object) -> bool:
        self.responses.append(dict(kwargs))
        return False


def _contributions():
    return core_contributions(mock_exchange_provider_manifest())


def test_provider_contributions_fail_closed_on_unpaired_or_colliding_exchanges() -> (
    None
):
    unpaired = mock_exchange_provider_manifest().to_wire()
    unpaired["contributions"] = [unpaired["contributions"][0]]
    with pytest.raises(CorePluginError, match="exactly one symbol and one market-data"):
        core_contributions(PluginManifest.from_wire(unpaired))

    malformed = mock_exchange_provider_manifest().to_wire()
    malformed["contributions"][1]["configuration"]["channels"][0]["marketTypes"] = [
        {"not": "a-string"}
    ]
    with pytest.raises(CorePluginError, match="canonical string"):
        core_contributions(PluginManifest.from_wire(malformed))

    colliding = mock_exchange_provider_manifest().to_wire()
    for contribution in colliding["contributions"]:
        contribution["configuration"]["exchange"] = "binance"
    runtime = PluginProviderRuntime(invoke=_MockSidecar().invoke)
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    existing = registry.get_plugin("binance")
    with pytest.raises(ValueError, match="collide"):
        runtime.register_plugin(core_contributions(PluginManifest.from_wire(colliding)))
    assert registry.get_plugin("binance") is existing


@_async_test
async def test_provider_registry_symbols_and_history_use_existing_normalizer_path() -> (
    None
):
    sidecar = _MockSidecar()
    runtime = PluginProviderRuntime(invoke=sidecar.invoke)
    registry = get_exchange_registry()
    registry.unregister("mock")
    try:
        runtime.register_plugin(_contributions())
        provider = registry.get_plugin("mock")
        assert provider.capabilities().ws_connection_model == "plugin_sidecar"
        assert [
            item.symbol for item in await provider.adapter().list_symbols("spot")
        ] == [
            "BTCUSDT",
            "ETHUSDT",
        ]
        assert [
            item.symbol for item in await provider.adapter().list_symbols("spot")
        ] == ["BTCUSDT", "ETHUSDT"]
        assert len(sidecar.symbol_requests) == 1
        kline_capability = next(
            item
            for item in provider.capabilities().channels
            if item.channel.value == "kline"
        )
        assert set(kline_capability.unavailable_fields) == {
            "quote_volume",
            "trades",
            "taker_buy_base",
            "taker_buy_quote",
        }

        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.KLINE,
            interval="1m",
            exchange="mock",
            market_type="spot",
        )
        transport = TransportLayer(IngestionConfig(proxy_mode="none"))
        messages = await transport.http_fetch(
            TransportRequest(
                descriptor=descriptor,
                limit=3,
                start_ms=1_700_000_000_000,
                end_ms=1_700_000_300_000,
            )
        )
        assert len(messages) == 3
        assert all(message.source == DataSource.PLUGIN for message in messages)
        normalizer = NormalizeLayer(IngestionConfig(proxy_mode="none"), descriptor)
        events = [normalizer.parse_raw(message) for message in messages]
        assert [event.data["finality"] for event in events if event is not None] == [
            "final",
            "final",
            "final",
        ]
        assert all(
            event is not None and event.data["source_quality"]["quality"] == "synthetic"
            for event in events
        )
    finally:
        await runtime.stop()
        registry.unregister("mock")


@_async_test
async def test_provider_kline_stream_is_observable_as_plugin_stream_and_emits_amendment() -> (
    None
):
    sidecar = _MockSidecar()
    runtime = PluginProviderRuntime(invoke=sidecar.invoke)
    registry = get_exchange_registry()
    registry.unregister("mock")
    ingress = MarketDataIngress(
        IngestionConfig(
            proxy_mode="none",
            ws_reconnect_delay_initial=0.01,
            ws_reconnect_delay_max=0.05,
        )
    )
    aggregator = BarAggregator()
    try:
        runtime.register_plugin(_contributions())
        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.KLINE,
            interval="1m",
            exchange="mock",
        )
        aggregator.add_target("BTCUSDT", "1m", exchange="mock", market_type="spot")
        aggregate_events = []
        amended_ready = asyncio.Event()

        async def capture_aggregate(event) -> None:
            aggregate_events.append(event)
            if event.event_type == BarEventType.AMENDED:
                amended_ready.set()

        aggregator.publisher.on_bar_event(capture_aggregate)
        await aggregator.start()
        pipeline = await ingress.add_stream(descriptor)
        events: list[MarketEvent] = []
        ready = asyncio.Event()

        async def capture(event: MarketEvent) -> None:
            events.append(event)
            await aggregator.on_market_event(event)
            if len(events) >= 3:
                ready.set()

        pipeline.delivery.on_market_event(capture)
        await asyncio.wait_for(ready.wait(), timeout=3.0)
        await asyncio.wait_for(amended_ready.wait(), timeout=3.0)
        assert pipeline.feed_control.mode == FeedMode.PLUGIN_STREAM
        assert [event.data["finality"] for event in events[:3]] == [
            "final",
            "forming",
            "corrected",
        ]
        assert events[2].data["is_correction"] is True
        assert pipeline.continuity.metrics.get_counter("events_deduplicated") == 0
        amended = [
            event
            for event in aggregate_events
            if event.event_type == BarEventType.AMENDED
        ]
        assert len(amended) == 1
        assert amended[0].bar.close == events[2].data["close"]
    finally:
        await ingress.stop()
        await aggregator.stop()
        await runtime.stop()
        registry.unregister("mock")


@_async_test
async def test_provider_stream_crash_reconnects_without_polluting_builtin_exchange() -> (
    None
):
    sidecar = _MockSidecar()
    sidecar.fail_next_poll = True
    runtime = PluginProviderRuntime(invoke=sidecar.invoke)
    registry = get_exchange_registry()
    registry.unregister("mock")
    binance = registry.get_plugin("binance")
    ingress = MarketDataIngress(
        IngestionConfig(
            proxy_mode="none",
            ws_reconnect_delay_initial=0.01,
            ws_reconnect_delay_max=0.05,
        )
    )
    try:
        runtime.register_plugin(_contributions())
        pipeline = await ingress.add_stream(
            StreamDescriptor(
                "BTCUSDT",
                StreamType.KLINE,
                interval="1m",
                exchange="mock",
            )
        )
        recovered = asyncio.Event()

        async def capture(_event: MarketEvent) -> None:
            if len(sidecar.open_requests) >= 2:
                recovered.set()

        pipeline.delivery.on_market_event(capture)
        await asyncio.wait_for(recovered.wait(), timeout=3.0)
        assert [item["resync"] for item in sidecar.open_requests[:2]] == [False, True]
        assert registry.get_plugin("binance") is binance
        assert registry.get_plugin("mock").id == "mock"
    finally:
        await ingress.stop()
        await runtime.stop()
        registry.unregister("mock")


@_async_test
async def test_provider_order_book_gap_forces_snapshot_resync_without_forwarding_delta() -> (
    None
):
    sidecar = _MockSidecar()
    sidecar.corrupt_next_book_delta = True
    runtime = PluginProviderRuntime(invoke=sidecar.invoke)
    registry = get_exchange_registry()
    registry.unregister("mock")
    ingress = MarketDataIngress(
        IngestionConfig(
            proxy_mode="none",
            ws_reconnect_delay_initial=0.01,
            ws_reconnect_delay_max=0.05,
        )
    )
    try:
        runtime.register_plugin(_contributions())
        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.FULL_DEPTH,
            exchange="mock",
        )
        pipeline = await ingress.add_stream(descriptor)
        events: list[MarketEvent] = []
        resynced = asyncio.Event()

        async def capture(event: MarketEvent) -> None:
            events.append(event)
            if len(sidecar.open_requests) >= 2 and len(events) >= 2:
                resynced.set()

        pipeline.delivery.on_market_event(capture)
        await asyncio.wait_for(resynced.wait(), timeout=3.0)
        assert sidecar.open_requests[0]["resync"] is False
        assert sidecar.open_requests[1]["resync"] is True
        assert [event.data["kind"] for event in events[:2]] == ["snapshot", "snapshot"]
    finally:
        await ingress.stop()
        await runtime.stop()
        registry.unregister("mock")


@_async_test
async def test_provider_order_book_rejects_depth_above_manifest_limit() -> None:
    sidecar = _MockSidecar()
    sidecar.oversize_next_book_snapshot = True
    runtime = PluginProviderRuntime(invoke=sidecar.invoke)
    registry = get_exchange_registry()
    registry.unregister("mock")
    ingress = MarketDataIngress(
        IngestionConfig(
            proxy_mode="none",
            ws_reconnect_delay_initial=0.01,
            ws_reconnect_delay_max=0.05,
        )
    )
    try:
        runtime.register_plugin(_contributions())
        pipeline = await ingress.add_stream(
            StreamDescriptor(
                "BTCUSDT",
                StreamType.FULL_DEPTH,
                exchange="mock",
            )
        )
        events: list[MarketEvent] = []
        recovered = asyncio.Event()

        async def capture(event: MarketEvent) -> None:
            events.append(event)
            if len(sidecar.open_requests) >= 2:
                recovered.set()

        pipeline.delivery.on_market_event(capture)
        await asyncio.wait_for(recovered.wait(), timeout=3.0)
        assert [item["resync"] for item in sidecar.open_requests[:2]] == [False, True]
        assert events[0].data["kind"] == "snapshot"
        assert all(len(event.data["bids"]) <= 100 for event in events)
    finally:
        await ingress.stop()
        await runtime.stop()
        registry.unregister("mock")


@_async_test
async def test_continuity_delivers_closed_bar_corrections_without_reopening_cursor() -> (
    None
):
    descriptor = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
    continuity = ContinuityLayer(
        IngestionConfig(proxy_mode="none"),
        TransportLayer(IngestionConfig(proxy_mode="none")),
        descriptor,
    )
    delivered: list[MarketEvent] = []
    base = MarketEvent(
        event_type=StreamType.KLINE,
        symbol="BTCUSDT",
        exchange="binance",
        event_time_ms=60_000,
        received_at_ms=60_000,
        source=DataSource.PLUGIN,
        data={"open_time": 0, "is_closed": True},
        stream_key=descriptor.key,
    )

    async def collect(event: MarketEvent) -> None:
        delivered.append(event)

    continuity.on_event(collect)
    await continuity.ingest(base)
    corrected = copy.deepcopy(base)
    corrected.data["is_correction"] = True
    await continuity.ingest(corrected)
    spoofed = copy.deepcopy(corrected)
    spoofed.source = DataSource.WEBSOCKET
    await continuity.ingest(spoofed)
    assert delivered == [base, corrected]
    assert continuity.snapshot()["last_continuity_key"] == 0


@_async_test
async def test_provider_continuity_dedup_gap_and_out_of_order_are_deterministic() -> (
    None
):
    descriptor = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
    continuity = ContinuityLayer(
        IngestionConfig(proxy_mode="none"),
        TransportLayer(IngestionConfig(proxy_mode="none")),
        descriptor,
    )
    delivered: list[MarketEvent] = []
    gaps = []

    async def collect(event: MarketEvent) -> None:
        delivered.append(event)

    async def collect_gap(gap) -> None:
        gaps.append(gap)

    continuity.on_event(collect)
    continuity.on_gap(collect_gap)

    def event(open_time: int) -> MarketEvent:
        return MarketEvent(
            event_type=StreamType.KLINE,
            symbol="BTCUSDT",
            exchange="mock",
            event_time_ms=open_time + 59_999,
            received_at_ms=open_time + 59_999,
            source=DataSource.PLUGIN,
            data={"open_time": open_time, "is_closed": True},
            stream_key=descriptor.key,
        )

    await continuity.ingest(event(0))
    await continuity.ingest(event(0))
    await continuity.ingest(event(120_000))
    await continuity.ingest(event(60_000))

    assert [item.data["open_time"] for item in delivered] == [0, 120_000, 60_000]
    assert len(gaps) == 1
    assert gaps[0].expected_count == 1
    assert continuity.metrics.get_counter("events_deduplicated") == 1
    assert continuity.metrics.get_counter("events_out_of_order") == 1
    assert continuity.snapshot()["last_continuity_key"] == 120_000


@_async_test
async def test_installed_mock_provider_runs_in_real_supervised_sidecar(
    tmp_path: Path,
) -> None:
    fixture = build_mock_exchange_provider_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "active"
    registry = get_exchange_registry()
    registry.unregister("mock")
    refreshes: list[str] = []
    evictions: list[str] = []

    async def refresh(exchange: str) -> dict[str, int]:
        refreshes.append(exchange)
        symbols = await registry.get(exchange).list_symbols("spot")
        return {f"{exchange}:spot": len(symbols)}

    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
    )
    platform.bind_symbol_refresher(refresh, evictor=evictions.append)
    await platform.start()
    try:
        assert refreshes == ["mock"]
        assert platform.providers.registered_exchanges() == ("mock",)
        assert (
            platform.manager.supervisor(installed.plugin_id, "main").state == "active"
        )
        catalog = platform.catalog()["plugins"][0]
        assert catalog["available"] is True
        assert {item["kind"] for item in catalog["contributions"]} == {
            "symbol-provider/1",
            "market-data-provider/1",
        }

        descriptor = StreamDescriptor(
            "BTCUSDT",
            StreamType.KLINE,
            interval="1m",
            exchange="mock",
        )
        messages = await TransportLayer(IngestionConfig(proxy_mode="none")).http_fetch(
            TransportRequest(
                descriptor=descriptor,
                limit=2,
                start_ms=1_700_000_000_000,
                end_ms=1_700_000_300_000,
            )
        )
        assert len(messages) == 2

        cold_db = tmp_path / "cold" / "candlescope.db"
        previous_db = klines_repo.KLINES_DB_PATH
        klines_repo.KLINES_DB_PATH = cold_db
        try:
            klines_repo.init_klines_storage()
            sync_storage = KlinesRepoAdapter(exchange="mock", market_type="spot")
            assert sync_storage.query_bars("BTCUSDT", "1m") == []
            transport = TransportLayer(IngestionConfig(proxy_mode="none"))
            backfill = BackfillEngine(
                config=BackfillConfig(
                    fetch_batch_size=2,
                    fetch_rate_limit_delay=0,
                    fetch_max_retries=0,
                ),
                storage=AsyncKlinesRepoAdapter(exchange="mock", market_type="spot"),
                transport=transport,
                ingestion_config=IngestionConfig(proxy_mode="none"),
            )
            response_accounting = _ProviderResponseAccounting()
            transport._rate_limits = response_accounting  # type: ignore[assignment]
            backfill.fetcher._rate_limit_manager = response_accounting  # type: ignore[assignment]
            start_ms = 1_700_000_040_000
            requests_before = platform.manager.supervisor(
                installed.plugin_id, "main"
            ).snapshot()["requests"]
            report = await backfill.run(
                "BTCUSDT",
                intervals=["1m"],
                range_start_ms=start_ms,
                range_end_ms=start_ms + 4 * 60_000,
                exchange="mock",
                market_type="spot",
            )
            assert report.status.value == "completed"
            stored = sync_storage.query_bars(
                "BTCUSDT",
                "1m",
                exchange="mock",
                market_type="spot",
            )
            assert [row["open_time"] for row in stored] == [
                start_ms + index * 60_000 for index in range(5)
            ]
            requests_after = platform.manager.supervisor(
                installed.plugin_id, "main"
            ).snapshot()["requests"]
            assert requests_after - requests_before == 3
            assert response_accounting.responses == [
                {"status_code": 200},
                {"status_code": 200},
                {"status_code": 200},
            ]
        finally:
            klines_repo.KLINES_DB_PATH = previous_db

        installer.disable(installed.plugin_id)
        await platform.reconcile_plugin(installed.plugin_id)
        assert not registry.has("mock")
        assert platform.providers.registered_exchanges() == ()
        assert evictions == ["mock"]

        assert installer.enable(installed.plugin_id).state == "active"
        await platform.reconcile_plugin(installed.plugin_id)
        assert registry.has("mock")
        assert platform.providers.registered_exchanges() == ("mock",)
        assert refreshes == ["mock", "mock"]
        reenabled_catalog = platform.catalog()["plugins"][0]
        assert reenabled_catalog["available"] is True
        assert reenabled_catalog.get("unavailableReason") is None
        assert [
            item.symbol for item in await registry.get("mock").list_symbols("spot")
        ] == ["BTCUSDT", "ETHUSDT"]
    finally:
        await platform.stop()
        registry.unregister("mock")
