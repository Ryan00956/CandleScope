from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from candlescope_plugin_sdk.platform_v2 import (
    MARKET_BARS_PAGE_V1,
    MARKET_STREAM_V1,
    RENDER_IR_V1,
    BarsReadRequest,
    BarsSubscribeRequest,
    CapabilityGrant,
    HostCallRequest,
    RequestContext,
)

from app.api.v1.klines import _bars_to_dicts
from app.data_engine.data_manager.manager import DataManager
from app.data_engine.data_manager.models import (
    BarData,
    DataEvent,
    DataEventType,
    QueryResult,
    QuerySource,
    SeriesKey,
)
from app.plugin_market_v2.adapters import MarketCapabilityAdapters
from app.plugin_market_v2.chart_layers import ChartLayerRegistry
from app.plugin_market_v2.data_manager_port import DataManagerConsumerPort
from app.plugin_market_v2.ports import PortBarSubscription
from app.plugin_market_v2.projections import project_bars_page
from app.plugin_market_v2.subscriptions import BarSubscriptionManager
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_core_v2.private_storage import StorageNamespace
from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.capabilities import (
    CapabilityBroker,
    CapabilityHandleAuthority,
    CapabilityLease,
)
from app.plugin_security_v2.errors import PlatformSecurityError
from tests.plugin_platform_bundle_testkit import build_market_scanner_bundle


def _bar(
    second: int, close: float, *, closed: bool = True, source: str = "backfill"
) -> BarData:
    return BarData(
        time=second,
        open=close - 1,
        high=close + 1,
        low=close - 2,
        close=close,
        volume=10,
        quote_volume=close * 10,
        trades=2,
        taker_buy_base=6,
        taker_buy_quote=close * 6,
        is_closed=closed,
        source=source,
    )


def _result() -> QueryResult:
    bars = [_bar(60, 100), _bar(120, 103)]
    return QueryResult(
        bars=bars,
        symbol="BTCUSDT",
        interval="1m",
        source=QuerySource.CACHE,
        total=2,
        metadata={"all_rows_final": True, "verified_contiguous": True},
        complete=True,
    )


def _lease(
    permission_id: str,
    scope: dict[str, Any],
    *,
    generation: int = 1,
    instance_id: str = "instance-one",
) -> CapabilityLease:
    return CapabilityLease(
        handle_fingerprint="f" * 64,
        plugin_id="candlescope.market-scanner",
        entrypoint_id="main",
        instance_id=instance_id,
        generation=generation,
        permission_id=permission_id,
        scope=scope,
        contribution_ids=("scan", "signals"),
        store_revision=1,
        bundle_sha256="sha256:" + "1" * 64,
        publisher_identity="manifest:candlescope",
        confirmation_version=1,
        issued_monotonic=0,
        expires_monotonic=10_000,
    )


def _call(
    method: str, params: dict[str, Any], *, generation: int = 1
) -> HostCallRequest:
    return HostCallRequest(
        "capability-handle",
        method,
        params,
        RequestContext(
            "scan", True, generation, f"trace-{method.replace('.', '-')}-{generation}"
        ),
    )


def _bars_params(
    *,
    mode: str = "live",
    symbol: str = "BTCUSDT",
    start_ms: int | None = 60_000,
    end_ms: int | None = 120_000,
    limit: int = 2,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "context": {
            "mode": mode,
            "exchange": "binance",
            "marketType": "spot",
        },
        "series": {"symbol": symbol, "interval": "1m"},
        "limit": limit,
    }
    if start_ms is not None:
        value["startMs"] = start_ms
    if end_ms is not None:
        value["endMs"] = end_ms
    return value


class _FakePort:
    def __init__(self) -> None:
        self.read_calls = 0
        self.read_started = asyncio.Event()
        self.read_release: asyncio.Event | None = None
        self.callbacks: dict[str, Any] = {}
        self.unsubscribe_calls = 0

    async def list_symbols(self, request):
        return (
            [
                {"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT"},
                {"symbol": "ETHUSDT", "baseAsset": "ETH", "quoteAsset": "USDT"},
                {"symbol": "ETHBTC", "baseAsset": "ETH", "quoteAsset": "BTC"},
            ],
            123.0,
        )

    async def read_bars(self, request):
        self.read_calls += 1
        self.read_started.set()
        if self.read_release is not None:
            await self.read_release.wait()
        result = _result()
        result.symbol = request.series.symbol
        return result

    async def subscribe_bars(self, request, *, consumer_id, callback):
        handle = object()
        self.callbacks[consumer_id] = callback
        return PortBarSubscription(handle, consumer_id, request)

    async def unsubscribe_bars(self, subscription):
        self.unsubscribe_calls += 1
        self.callbacks.pop(subscription.consumer_id, None)

    async def read_trades(self, request):
        return {"schemaVersion": "candlescope.market-trades-page/1", "payload": {}}

    async def read_order_book(self, request, *, consumer_id):
        return {"schemaVersion": "candlescope.market-order-book/1", "payload": {}}


def _adapters(tmp_path: Path, port: Any, *, deliver=None):
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    broker = CapabilityBroker(authority, audit)

    def resolve(_plugin_id: str, kind: str, contribution_id: str):
        assert kind == "chart-layer/1"
        return SimpleNamespace(
            id=contribution_id,
            full_id=f"candlescope.market-scanner.{contribution_id}",
            configuration={
                "maxItems": 10,
                "maxBytes": 16_384,
                "maxTextChars": 64,
            },
        )

    async def default_deliver(*_args):
        return None

    subscriptions = BarSubscriptionManager(deliver=deliver or default_deliver)
    layers = ChartLayerRegistry(resolve)
    adapters = MarketCapabilityAdapters(
        subscriptions=subscriptions, chart_layers=layers
    )
    adapters.register(broker)
    adapters.bind(port)
    return broker, adapters, subscriptions, layers


@pytest.mark.anyio
async def test_data_manager_to_broker_bar_projection_matches_direct_public_rows(
    tmp_path: Path,
) -> None:
    dm = DataManager()
    bars = [_bar(60, 100), _bar(120, 103)]
    dm.cache.bulk_load(SeriesKey("BTCUSDT", "1m"), bars)
    port = DataManagerConsumerPort(dm)
    broker, _adapters_value, subscriptions, _layers = _adapters(tmp_path, port)
    scope = {
        "contexts": ["live"],
        "exchanges": ["binance"],
        "marketTypes": ["spot"],
        "symbols": ["BTCUSDT"],
        "intervals": ["1m"],
        "maxHistoryBars": 2,
        "maxConcurrent": 1,
    }
    lease = _lease("market.bars.read", scope)
    response = await broker.handle(
        _call("market.bars.read", _bars_params()),
        CapabilityGrant("capability-handle", "market.bars.read", scope),
        lease,
    )
    direct = dm.query(
        "BTCUSDT",
        "1m",
        start_ms=60_000,
        end_ms=120_000,
        limit=2,
        auto_backfill=False,
    )

    assert response["schemaVersion"] == MARKET_BARS_PAGE_V1
    assert response["data"] == _bars_to_dicts(direct.bars)
    assert response["coverage"]["allRowsFinal"] is True
    assert response["coverage"]["verifiedContiguous"] is None
    assert response["sourceQuality"]["trustedFinal"] is False
    await subscriptions.stop()


def test_trusted_final_requires_explicit_continuity_evidence() -> None:
    request = BarsReadRequest.from_wire(_bars_params())
    verified = project_bars_page(request, _result())
    assert verified["sourceQuality"]["trustedFinal"] is True

    result = _result()
    result.metadata = {"all_rows_final": True}
    page = project_bars_page(request, result)

    assert page["coverage"]["verifiedContiguous"] is None
    assert page["coverage"]["allRowsFinal"] is True
    assert page["sourceQuality"]["trustedFinal"] is False


@pytest.mark.anyio
async def test_market_scope_context_depth_and_concurrency_fail_closed(
    tmp_path: Path,
) -> None:
    port = _FakePort()
    broker, _adapter, subscriptions, _layers = _adapters(tmp_path, port)
    scope = {
        "contexts": ["live"],
        "exchanges": ["binance"],
        "marketTypes": ["spot"],
        "symbols": ["BTCUSDT"],
        "intervals": ["1m"],
        "maxHistoryBars": 10,
        "maxConcurrent": 1,
    }
    lease = _lease("market.bars.read", scope)
    grant = CapabilityGrant("capability-handle", "market.bars.read", scope)

    with pytest.raises(PlatformSecurityError) as wrong_symbol:
        await broker.handle(
            _call("market.bars.read", _bars_params(symbol="ETHUSDT")),
            grant,
            lease,
        )
    assert wrong_symbol.value.code == "CAPABILITY_SCOPE_DENIED"

    replay_scope = {**scope, "contexts": ["live", "replay"]}
    with pytest.raises(PlatformSecurityError) as replay:
        await broker.handle(
            _call("market.bars.read", _bars_params(mode="replay")),
            CapabilityGrant("capability-handle", "market.bars.read", replay_scope),
            _lease("market.bars.read", replay_scope),
        )
    assert replay.value.code == "MARKET_CONTEXT_ISOLATION_DENIED"

    with pytest.raises(PlatformSecurityError) as too_deep:
        await broker.handle(
            _call(
                "market.bars.read",
                _bars_params(start_ms=0, end_ms=9 * 60_000, limit=2),
            ),
            grant,
            lease,
        )
    assert too_deep.value.code == "MARKET_HISTORY_RANGE_TOO_DEEP"

    port.read_release = asyncio.Event()
    first = asyncio.create_task(
        broker.handle(_call("market.bars.read", _bars_params()), grant, lease)
    )
    await port.read_started.wait()
    with pytest.raises(PlatformSecurityError) as concurrent:
        await broker.handle(
            _call("market.bars.read", _bars_params(start_ms=None, end_ms=None)),
            grant,
            lease,
        )
    assert concurrent.value.code == "MARKET_READ_CONCURRENCY_EXCEEDED"
    port.read_release.set()
    await first
    await subscriptions.stop()


@pytest.mark.anyio
async def test_identical_cold_bar_reads_share_one_data_manager_request(
    tmp_path: Path,
) -> None:
    port = _FakePort()
    port.read_release = asyncio.Event()
    broker, adapter, subscriptions, _layers = _adapters(tmp_path, port)
    scope = {
        "contexts": ["live"],
        "exchanges": ["binance"],
        "marketTypes": ["spot"],
        "symbols": ["BTCUSDT"],
        "intervals": ["1m"],
        "maxHistoryBars": 2,
        "maxConcurrent": 2,
    }
    lease = _lease("market.bars.read", scope)
    grant = CapabilityGrant("capability-handle", "market.bars.read", scope)
    call = _call("market.bars.read", _bars_params())
    first = asyncio.create_task(broker.handle(call, grant, lease))
    await port.read_started.wait()
    second = asyncio.create_task(broker.handle(call, grant, lease))
    await asyncio.sleep(0)
    port.read_release.set()
    left, right = await asyncio.gather(first, second)

    assert left == right
    assert port.read_calls == 1
    assert adapter.snapshot()["readCoordinator"]["shared"] == 1
    await subscriptions.stop()


@pytest.mark.anyio
async def test_bar_subscription_coalesces_forming_preserves_final_events_and_releases(
    tmp_path: Path,
) -> None:
    delivered: list[tuple[tuple[dict[str, Any], ...], dict[str, Any]]] = []

    async def deliver(_plugin, _entrypoint, _generation, events, metadata):
        delivered.append((events, metadata))

    port = _FakePort()
    _broker, _adapter, subscriptions, _layers = _adapters(
        tmp_path, port, deliver=deliver
    )
    request = BarsSubscribeRequest.from_wire(
        {
            "context": {
                "mode": "live",
                "exchange": "binance",
                "marketType": "spot",
            },
            "series": {"symbol": "BTCUSDT", "interval": "1m"},
            "queueCapacity": 8,
            "maxBatch": 8,
            "maxLatencyMs": 1,
        }
    )
    scope = {
        "contexts": ["live"],
        "exchanges": ["binance"],
        "marketTypes": ["spot"],
        "symbols": ["BTCUSDT"],
        "intervals": ["1m"],
        "maxConcurrent": 1,
    }
    lease = _lease("market.bars.subscribe", scope)
    created = await subscriptions.create(request, lease)
    callback = next(iter(port.callbacks.values()))
    key = SeriesKey("BTCUSDT", "1m")
    for close in range(100, 120):
        await callback(
            DataEvent(
                DataEventType.BAR_UPDATED,
                key,
                bar=_bar(180, close, closed=False, source=""),
            )
        )
    await callback(DataEvent(DataEventType.BAR_CLOSED, key, bar=_bar(180, 120)))
    await callback(
        DataEvent(
            DataEventType.BAR_AMENDED,
            key,
            bar=_bar(120, 104, source="data_manager_amended"),
        )
    )
    await asyncio.sleep(0.05)

    events = [event for batch, _metadata in delivered for event in batch]
    assert [item["sequence"] for item in events] == list(range(1, len(events) + 1))
    assert [item["eventType"] for item in events].count("bar.closed") == 1
    assert [item["eventType"] for item in events].count("bar.amended") == 1
    assert [item["eventType"] for item in events].count("bar.updated") <= 1
    assert any(metadata["coalesced"] >= 19 for _batch, metadata in delivered)
    assert all(item["schemaVersion"] == MARKET_STREAM_V1 for item in events)

    resumed = await subscriptions.resume(created["subscriptionId"], 0, lease)
    assert resumed["resyncRequired"] is False
    assert resumed["events"] == events
    await subscriptions.cancel(created["subscriptionId"], lease)
    assert port.unsubscribe_calls == 1
    assert subscriptions.snapshot()["active"] == 0


@pytest.mark.anyio
async def test_reliable_subscription_overflow_requires_resync_and_disconnects(
    tmp_path: Path,
) -> None:
    deliveries: list[dict[str, Any]] = []

    async def deliver(_plugin, _entrypoint, _generation, _events, metadata):
        deliveries.append(metadata)

    port = _FakePort()
    _broker, _adapter, subscriptions, _layers = _adapters(
        tmp_path, port, deliver=deliver
    )
    request = BarsSubscribeRequest.from_wire(
        {
            "context": {
                "mode": "live",
                "exchange": "binance",
                "marketType": "spot",
            },
            "series": {"symbol": "BTCUSDT", "interval": "1m"},
            "queueCapacity": 8,
            "maxBatch": 1,
            "maxLatencyMs": 1,
        }
    )
    scope = {
        "contexts": ["live"],
        "exchanges": ["binance"],
        "marketTypes": ["spot"],
        "symbols": ["BTCUSDT"],
        "intervals": ["1m"],
        "maxConcurrent": 1,
    }
    lease = _lease("market.bars.subscribe", scope)
    await subscriptions.create(request, lease)
    callback = next(iter(port.callbacks.values()))
    key = SeriesKey("BTCUSDT", "1m")
    for index in range(9):
        await callback(
            DataEvent(
                DataEventType.BAR_CLOSED,
                key,
                bar=_bar(60 + index * 60, 100 + index),
            )
        )
    await asyncio.sleep(0.1)

    assert any(item["resyncRequired"] is True for item in deliveries)
    assert subscriptions.snapshot()["active"] == 0
    assert port.unsubscribe_calls == 1


@pytest.mark.anyio
async def test_slow_plugin_delivery_does_not_block_producer_and_cleanup_releases_lease(
    tmp_path: Path,
) -> None:
    delivery_started = asyncio.Event()
    release_delivery = asyncio.Event()

    async def deliver(_plugin, _entrypoint, _generation, _events, _metadata):
        delivery_started.set()
        await release_delivery.wait()

    port = _FakePort()
    _broker, _adapter, subscriptions, _layers = _adapters(
        tmp_path, port, deliver=deliver
    )
    request = BarsSubscribeRequest.from_wire(
        {
            "context": {
                "mode": "live",
                "exchange": "binance",
                "marketType": "spot",
            },
            "series": {"symbol": "BTCUSDT", "interval": "1m"},
            "queueCapacity": 64,
            "maxBatch": 8,
            "maxLatencyMs": 1,
        }
    )
    scope = {
        "contexts": ["live"],
        "exchanges": ["binance"],
        "marketTypes": ["spot"],
        "symbols": ["BTCUSDT"],
        "intervals": ["1m"],
        "maxConcurrent": 1,
    }
    lease = _lease("market.bars.subscribe", scope)
    await subscriptions.create(request, lease)
    callback = next(iter(port.callbacks.values()))
    key = SeriesKey("BTCUSDT", "1m")
    await callback(DataEvent(DataEventType.BAR_CLOSED, key, bar=_bar(60, 100)))
    await asyncio.wait_for(delivery_started.wait(), timeout=0.5)

    started = time.perf_counter()
    for value in range(500):
        await callback(
            DataEvent(
                DataEventType.BAR_UPDATED,
                key,
                bar=_bar(120, 100 + value, closed=False, source=""),
            )
        )
    producer_elapsed = time.perf_counter() - started
    assert producer_elapsed < 0.25

    cleanup = asyncio.create_task(
        subscriptions.cancel_leases((lease,), reason="capability-revoked")
    )
    release_delivery.set()
    await asyncio.wait_for(cleanup, timeout=1.0)
    assert subscriptions.snapshot()["active"] == 0
    assert port.unsubscribe_calls == 1


def test_chart_layer_budget_revision_context_and_generation_are_host_owned() -> None:
    contribution = SimpleNamespace(
        id="signals",
        full_id="candlescope.market-scanner.signals",
        configuration={"maxItems": 1, "maxBytes": 4_096, "maxTextChars": 32},
    )
    registry = ChartLayerRegistry(lambda plugin_id, kind, contribution_id: contribution)
    scope = {
        "contexts": ["live"],
        "exchanges": ["binance"],
        "marketTypes": ["spot"],
        "layers": ["signals"],
        "maxItems": 1,
    }
    lease = _lease("chart.layer.publish", scope)
    params = {
        "layerId": "signals",
        "context": {
            "mode": "live",
            "exchange": "binance",
            "marketType": "spot",
        },
        "series": {"symbol": "BTCUSDT", "interval": "1m"},
        "revision": 1,
        "render": {
            "schemaVersion": RENDER_IR_V1,
            "items": [
                {
                    "id": "scan-1",
                    "type": "marker",
                    "time": 120,
                    "position": "aboveBar",
                    "shape": "arrowUp",
                    "color": "#22C55E",
                    "text": "scanner",
                    "price": 103,
                }
            ],
        },
    }
    assert registry.publish(params, lease)["published"] is True
    with pytest.raises(PlatformSecurityError) as stale_revision:
        registry.publish(params, lease)
    assert stale_revision.value.code == "CHART_LAYER_STALE_REVISION"

    newer = _lease(
        "chart.layer.publish", scope, generation=2, instance_id="instance-two"
    )
    assert registry.publish({**params, "revision": 1}, newer)["generation"] == 2
    with pytest.raises(PlatformSecurityError) as stale_generation:
        registry.publish({**params, "revision": 2}, lease)
    assert stale_generation.value.code == "CHART_LAYER_STALE_GENERATION"

    with pytest.raises(PlatformSecurityError) as replay:
        registry.publish(
            {
                **params,
                "context": {**params["context"], "mode": "replay"},
                "revision": 2,
            },
            newer,
        )
    assert replay.value.code == "MARKET_CONTEXT_ISOLATION_DENIED"

    with pytest.raises(PlatformSecurityError) as budget:
        registry.publish(
            {
                **params,
                "revision": 2,
                "render": {
                    **params["render"],
                    "items": params["render"]["items"] * 2,
                },
            },
            newer,
        )
    assert budget.value.code == "CHART_LAYER_RENDER_INVALID"


def test_capability_revocation_listener_receives_exact_activation_lease(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    observed: list[tuple[tuple[CapabilityLease, ...], str]] = []
    authority.add_revocation_listener(
        lambda leases, reason: observed.append((leases, reason))
    )
    lease = _lease("market.bars.subscribe", {"maxConcurrent": 1})
    authority._leases[lease.handle_fingerprint] = lease

    assert authority.revoke_plugin(lease.plugin_id) == 1
    assert observed == [((lease,), "plugin")]


@pytest.mark.anyio
async def test_market_scanner_bundle_runs_real_sidecar_broker_storage_and_layer(
    tmp_path: Path,
) -> None:
    fixture = build_market_scanner_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "staged"
    for permission in fixture.bundle.manifest.permissions.required:
        installer.grant_permission(
            installed.plugin_id, permission.id, scope=permission.scope
        )
    assert installer.enable(installed.plugin_id).state == "active"

    port = _FakePort()
    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
    )
    platform.bind_market_data(port)
    await platform.start()
    try:
        catalog = platform.catalog()["plugins"][0]
        assert {item["kind"] for item in catalog["contributions"]} == {
            "command/1",
            "settings/1",
            "chart-layer/1",
        }
        outcome = await platform.invoke_command(
            "candlescope.market-scanner.scan",
            {},
            user_action=True,
            trace_id="phase6-market-scanner",
        )
        assert outcome["completed"] is True
        assert outcome["stored"] is True
        assert outcome["layerPublished"] is True
        assert outcome["scannedSymbols"] == 2
        stored = platform.private_storage.document_get(
            StorageNamespace("candlescope.market-scanner", "manifest:candlescope"),
            "latest-scan",
        )
        assert stored["found"] is True
        assert stored["value"]["schemaVersion"] == (
            "candlescope.market-scanner-result/1"
        )
        layers = platform.market.chart_layers.projections()
        assert len(layers) == 1
        assert layers[0]["render"]["items"][0]["type"] == "marker"

        installer.disable(installed.plugin_id)
        await platform.reconcile_plugin(installed.plugin_id)
        assert platform.market.chart_layers.projections() == ()
        assert platform.market.subscriptions.snapshot()["active"] == 0
    finally:
        await platform.stop()
