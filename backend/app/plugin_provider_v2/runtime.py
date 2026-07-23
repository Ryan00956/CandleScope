"""Bridge public Platform v2 providers into the existing exchange/Data Engine truth path."""

from __future__ import annotations

import asyncio
import time
import weakref
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    ProviderHistoryRequest,
    ProviderStreamDescriptor,
    ProviderSymbolsRequest,
    validate_provider_history_page,
    validate_provider_symbols_page,
)

from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.exchanges import (
    ExchangeCapabilities,
    ExchangeMarket,
    HistoryAvailabilityPolicy,
    HistoryCadence,
    HistoryEmptyPageSemantics,
    MarketChannelCapability,
    RateLimitOverride,
    RateLimitPolicy,
    RealtimePolicy,
    ReverseTimePaginationPolicy,
    SymbolInfo,
    bootstrap_default_adapters,
    get_exchange_registry,
)
from app.exchanges.plugin import DefaultSymbolNormalizer

from .normalizer import ProviderNormalizer
from .session import ProviderStreamSession


InvokeContribution = Callable[[Any, dict[str, Any]], Awaitable[dict[str, Any]]]
SymbolRefresher = Callable[[str], Awaitable[dict[str, int]]]
SymbolEvictor = Callable[[str], None]


class _InvocationGate:
    def __init__(self, *, rate_per_minute: int, max_concurrent: int) -> None:
        self._interval = 60.0 / max(1, rate_per_minute)
        self._semaphore = asyncio.Semaphore(max(1, max_concurrent))
        self._reservation_lock = asyncio.Lock()
        self._next_allowed = 0.0

    async def run(
        self, callback: Callable[[], Awaitable[dict[str, Any]]]
    ) -> dict[str, Any]:
        async with self._semaphore:
            async with self._reservation_lock:
                now = time.monotonic()
                allowed_at = max(now, self._next_allowed)
                self._next_allowed = allowed_at + self._interval
            delay = allowed_at - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            return await callback()


class _ProviderProtocol:
    """Explicit no-network protocol; Host transport dispatches provider calls directly."""

    def rest_request(self, req: Any, config: Any | None = None) -> None:
        return None

    def ws_connection(self, descriptor: Any, config: Any | None = None) -> Any:
        raise RuntimeError("provider streams do not expose a WebSocket endpoint")

    def rest_base_urls(
        self, market_type: str = "spot", config: Any | None = None
    ) -> list[str]:
        return []

    def ws_base_urls(self, descriptor: Any, config: Any | None = None) -> list[str]:
        return []

    def rest_path(self, stream_type: Any, market_type: str = "spot") -> None:
        return None

    def build_http_params(self, req: Any) -> dict[str, Any]:
        return {}

    def build_ws_subscription(self, descriptor: Any) -> Any:
        raise RuntimeError("provider streams do not expose a WebSocket subscription")

    def extract_http_rows(self, payload: Any, stream_type: Any) -> list[Any]:
        return list(payload) if isinstance(payload, list) else [payload]

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        return {}

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        return False

    def sanitize_http_urls(self, urls: list[str]) -> list[str]:
        return []

    def sanitize_ws_urls(self, urls: list[str]) -> list[str]:
        return []


class ProviderExchangePlugin:
    """Exchange-plugin facade backed by two paired public contributions."""

    def __init__(
        self,
        *,
        symbol_contribution: Any,
        market_contribution: Any,
        invoke: InvokeContribution,
    ) -> None:
        self._symbol_contribution = symbol_contribution
        self._market_contribution = market_contribution
        self._symbol_config = symbol_contribution.configuration
        self._market_config = market_contribution.configuration
        self._invoke = invoke
        self.id = self._symbol_config["exchange"]
        self.name = self._symbol_config["displayName"]
        self.plugin_id = symbol_contribution.plugin_id
        self._protocol = _ProviderProtocol()
        self._symbol_normalizer = DefaultSymbolNormalizer()
        self._sessions: weakref.WeakSet[ProviderStreamSession] = weakref.WeakSet()
        self._symbol_pages: dict[str, tuple[float, tuple[dict[str, Any], ...]]] = {}
        self._symbol_locks = {
            item["id"]: asyncio.Lock() for item in self._symbol_config["marketTypes"]
        }
        self._symbol_gate = _InvocationGate(rate_per_minute=600, max_concurrent=2)
        self._channel_gates = {
            (channel["kind"], market_type): _InvocationGate(
                rate_per_minute=channel["ratePerMinute"],
                max_concurrent=channel["maxConcurrent"],
            )
            for channel in self._market_config["channels"]
            for market_type in channel["marketTypes"]
        }
        self._capabilities = self._build_capabilities()

    def adapter(self) -> ProviderExchangePlugin:
        return self

    def capabilities(self) -> ExchangeCapabilities:
        return self._capabilities

    def protocol(self) -> _ProviderProtocol:
        return self._protocol

    def normalizer(
        self, config: Any, descriptor: StreamDescriptor
    ) -> ProviderNormalizer:
        return ProviderNormalizer(descriptor)

    def symbol_normalizer(self) -> DefaultSymbolNormalizer:
        return self._symbol_normalizer

    def rate_limit_policy(self, config: Any | None = None) -> RateLimitPolicy:
        channels = self._market_config["channels"]
        max_concurrent = min(channel["maxConcurrent"] for channel in channels)
        slowest_rate = min(channel["ratePerMinute"] for channel in channels)
        overrides: dict[str, RateLimitOverride] = {}
        for market in self._symbol_config["marketTypes"]:
            overrides[market["id"]] = RateLimitOverride(
                concurrency=max_concurrent,
                delay_seconds=60.0 / slowest_rate,
            )
        return RateLimitPolicy(
            default_concurrency=max_concurrent,
            default_delay_seconds=60.0 / slowest_rate,
            market_overrides=overrides,
        )

    def pagination_policy(
        self, config: Any | None = None
    ) -> ReverseTimePaginationPolicy:
        return ReverseTimePaginationPolicy()

    def realtime_policy(self) -> RealtimePolicy:
        return RealtimePolicy()

    def price_stream_type(self, market_type: str = "spot") -> StreamType:
        return StreamType.KLINE

    async def list_symbols(self, market_type: str = "") -> list[SymbolInfo]:
        market_types = (
            [market_type]
            if market_type
            else [item["id"] for item in self._symbol_config["marketTypes"]]
        )
        result: list[SymbolInfo] = []
        for current_market in market_types:
            result.extend(await self._list_market_symbols(current_market))
        return result

    async def _list_market_symbols(self, market_type: str) -> list[SymbolInfo]:
        declared = {item["id"] for item in self._symbol_config["marketTypes"]}
        if market_type not in declared:
            return []
        cached = self._cached_symbol_page(market_type)
        if cached is not None:
            return [self._symbol_info(item) for item in cached]
        async with self._symbol_locks[market_type]:
            cached = self._cached_symbol_page(market_type)
            if cached is not None:
                return [self._symbol_info(item) for item in cached]
            rows = await self._fetch_market_symbols(market_type)
            expires_at = time.monotonic() + float(
                self._symbol_config["cacheTtlSeconds"]
            )
            frozen_rows = tuple(dict(item) for item in rows)
            self._symbol_pages[market_type] = (expires_at, frozen_rows)
            return [self._symbol_info(item) for item in frozen_rows]

    def _cached_symbol_page(
        self, market_type: str
    ) -> tuple[dict[str, Any], ...] | None:
        cached = self._symbol_pages.get(market_type)
        if cached is None:
            return None
        expires_at, rows = cached
        if time.monotonic() >= expires_at:
            self._symbol_pages.pop(market_type, None)
            return None
        return rows

    async def _fetch_market_symbols(self, market_type: str) -> list[dict[str, Any]]:
        cursor: str | None = None
        seen_cursors: set[str] = set()
        rows: list[dict[str, Any]] = []
        page_size = self._symbol_config["maxPageSize"]
        for _ in range(256):
            request = ProviderSymbolsRequest(market_type=market_type, limit=page_size)
            payload = {
                "operation": "symbols.list",
                "marketType": request.market_type,
                "limit": request.limit,
                **({"cursor": cursor} if cursor is not None else {}),
            }
            raw = await self._symbol_gate.run(
                lambda payload=payload: self._invoke_checked(
                    self._symbol_contribution, payload, timeout=30.0
                )
            )
            page = validate_provider_symbols_page(
                raw,
                expected_exchange=self.id,
                expected_market_type=market_type,
                max_rows=page_size,
            )
            page_rows = page["symbols"]
            if rows and page_rows and page_rows[0]["symbol"] <= rows[-1]["symbol"]:
                raise ValueError("provider symbol pages are not globally ordered")
            rows.extend(page_rows)
            if page["exhausted"]:
                break
            next_cursor = page["nextCursor"]
            if (
                not page_rows
                or next_cursor is None
                or next_cursor == cursor
                or next_cursor in seen_cursors
            ):
                raise ValueError("provider symbol pagination did not advance")
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        else:
            raise ValueError("provider symbol pagination exceeded the Host page budget")
        return rows

    async def fetch_history(self, req: TransportRequest) -> list[RawMessage]:
        provider_descriptor = self._provider_descriptor(req.descriptor)
        channel = self._channel_for(req.descriptor, require_history=True)
        limit = min(int(req.limit), int(channel["maxPageSize"]))
        request = ProviderHistoryRequest(
            descriptor=provider_descriptor,
            start_ms=req.start_ms,
            end_ms=req.end_ms,
            limit=limit,
        )
        payload = {
            "operation": "history.read",
            "descriptor": provider_descriptor.to_wire(),
            "startMs": request.start_ms,
            "endMs": request.end_ms,
            "limit": request.limit,
        }
        raw = await self._invoke_market(channel, payload, timeout=30.0)
        page = validate_provider_history_page(raw, request=request, max_rows=limit)
        now_ms = int(time.time() * 1_000)
        return [
            RawMessage(
                payload={
                    "eventType": "history.bar",
                    "payload": row,
                    "sourceQuality": page["sourceQuality"],
                },
                source=DataSource.PLUGIN,
                stream_type=req.descriptor.stream_type,
                received_at_ms=now_ms,
                endpoint=f"plugin://{self.plugin_id}/{self._market_contribution.id}",
                request_limit=limit,
            )
            for row in page["rows"]
        ]

    def supports_provider_stream(self, descriptor: StreamDescriptor) -> bool:
        try:
            self._channel_for(descriptor, require_realtime=True)
        except (KeyError, ValueError):
            return False
        return True

    def create_stream_session(
        self, config: Any, descriptor: StreamDescriptor
    ) -> ProviderStreamSession:
        channel = self._channel_for(descriptor, require_realtime=True)
        provider_descriptor = self._provider_descriptor(descriptor)
        session = ProviderStreamSession(
            config=config,
            descriptor=descriptor,
            provider_descriptor=provider_descriptor,
            channel_configuration=channel,
            invoke=lambda payload: self._invoke_market(
                channel, payload, market_type=descriptor.market_type
            ),
        )
        self._sessions.add(session)
        return session

    async def shutdown(self, reason: str) -> None:
        await asyncio.gather(
            *(session.invalidate(reason) for session in tuple(self._sessions)),
            return_exceptions=True,
        )
        self._sessions.clear()
        self._symbol_pages.clear()

    async def _invoke_market(
        self,
        channel: dict[str, Any],
        payload: dict[str, Any],
        *,
        timeout: float | None = None,
        market_type: str | None = None,
    ) -> dict[str, Any]:
        selected_market = market_type or payload.get("descriptor", {}).get(
            "marketType", channel["marketTypes"][0]
        )
        gate = self._channel_gates[(channel["kind"], selected_market)]
        wait_ms = payload.get("waitMs", 0)
        effective_timeout = timeout or max(10.0, float(wait_ms) / 1_000 + 5.0)
        return await gate.run(
            lambda: self._invoke_checked(
                self._market_contribution,
                payload,
                timeout=effective_timeout,
            )
        )

    async def _invoke_checked(
        self, contribution: Any, payload: dict[str, Any], *, timeout: float
    ) -> dict[str, Any]:
        value = await asyncio.wait_for(
            self._invoke(contribution, payload), timeout=timeout
        )
        if not isinstance(value, dict):
            raise ValueError("provider invocation must return an object")
        return value

    def _channel_for(
        self,
        descriptor: StreamDescriptor,
        *,
        require_history: bool = False,
        require_realtime: bool = False,
    ) -> dict[str, Any]:
        kind = self._provider_channel(descriptor.stream_type)
        for channel in self._market_config["channels"]:
            if (
                kind != channel["kind"]
                or descriptor.market_type not in channel["marketTypes"]
            ):
                continue
            if require_history and not channel["history"]:
                break
            if require_realtime and not channel["realtime"]:
                break
            if kind == "kline" and descriptor.interval not in channel["intervals"]:
                break
            return channel
        raise KeyError(f"provider does not support {descriptor.key}")

    def _provider_descriptor(
        self, descriptor: StreamDescriptor
    ) -> ProviderStreamDescriptor:
        return ProviderStreamDescriptor(
            exchange=self.id,
            market_type=descriptor.market_type,
            channel=self._provider_channel(descriptor.stream_type),
            symbol=self._symbol_normalizer.normalize(
                descriptor.symbol, descriptor.market_type
            ),
            interval=descriptor.interval,
        )

    @staticmethod
    def _provider_channel(stream_type: StreamType) -> str:
        if stream_type == StreamType.KLINE:
            return "kline"
        if stream_type == StreamType.FULL_DEPTH:
            return "full_depth"
        raise ValueError("Phase 10 providers support kline and full_depth only")

    def _build_capabilities(self) -> ExchangeCapabilities:
        markets = [
            ExchangeMarket(
                market_type=item["id"],
                product_type=item["productType"],
                label=item["label"],
                calendar_id=item["calendarId"],
                timezone=item["timezone"],
            )
            for item in self._symbol_config["marketTypes"]
        ]
        channels: list[MarketChannelCapability] = []
        intervals: set[str] = set()
        for item in self._market_config["channels"]:
            if item["kind"] == "kline":
                intervals.update(item["intervals"])
                available_fields = (
                    "open_time",
                    "close_time",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    "is_closed",
                    "is_correction",
                    "finality",
                    "source_quality",
                )
                history_policy = (
                    HistoryAvailabilityPolicy(
                        cadence=HistoryCadence.REGULAR,
                        empty_page_semantics=HistoryEmptyPageSemantics.TERMINAL_EXHAUSTION,
                        max_page_size=item["maxPageSize"],
                    )
                    if item["history"]
                    else None
                )
                channels.append(
                    MarketChannelCapability(
                        channel=MarketChannel.KLINE,
                        market_types=tuple(item["marketTypes"]),
                        realtime=item["realtime"],
                        history=item["history"],
                        realtime_transports=(TransportMode.PLUGIN_STREAM,)
                        if item["realtime"]
                        else (),
                        history_transports=(TransportMode.PLUGIN_STREAM,)
                        if item["history"]
                        else (),
                        delivery=DeliveryClass.APPEND,
                        sequence="timestamp",
                        params={"interval": list(item["intervals"])},
                        available_fields=available_fields,
                        unavailable_fields=(
                            "quote_volume",
                            "trades",
                            "taker_buy_base",
                            "taker_buy_quote",
                        ),
                        connection_model="plugin_sidecar",
                        limits={"history.max_limit": item["maxPageSize"]},
                        known_limitations=(
                            f"source quality: {self._market_config['sourceQuality']['quality']}",
                        ),
                        history_policy=history_policy,
                    )
                )
            else:
                channels.append(
                    MarketChannelCapability(
                        channel=MarketChannel.FULL_DEPTH,
                        market_types=tuple(item["marketTypes"]),
                        realtime=True,
                        realtime_transports=(TransportMode.PLUGIN_STREAM,),
                        delivery=DeliveryClass.ORDERED_DELTA,
                        snapshot=True,
                        delta=True,
                        sequence="range",
                        resync="snapshot_replay",
                        params={"max_depth_levels": item["maxDepthLevels"]},
                        available_fields=(
                            "kind",
                            "last_update_id",
                            "first_update_id",
                            "final_update_id",
                            "previous_final_update_id",
                            "bids",
                            "asks",
                            "source_quality",
                        ),
                        connection_model="plugin_sidecar",
                    )
                )
        return ExchangeCapabilities(
            exchange=self.id,
            name=self.name,
            plugin_api_version="1.0",
            capability_schema_version=3,
            markets=markets,
            native_intervals=sorted(intervals),
            supports_symbol_search=True,
            ws_connection_model="plugin_sidecar",
            protocol_features=["platform-v2-provider", "candlescope.stream/1"],
            known_limitations=["public market data only; no account or trading APIs"],
            channels=channels,
        )

    @staticmethod
    def _symbol_info(item: dict[str, Any]) -> SymbolInfo:
        return SymbolInfo(
            symbol=item["symbol"],
            base_asset=item["baseAsset"],
            quote_asset=item["quoteAsset"],
            status=item["status"],
            exchange=item["exchange"],
            market_type=item["marketType"],
            product_type=item["productType"],
            contract_type=item.get("contractType", ""),
            raw=dict(item),
            listed_at_ms=item.get("listedAtMs"),
            continuous_trading_at_ms=item.get("continuousTradingAtMs"),
            delisted_at_ms=item.get("delistedAtMs"),
            expiry_at_ms=item.get("expiryAtMs"),
            price_tick_size=item.get("priceTickSize", ""),
        )

    # Legacy adapter facade. Provider transport dispatch never calls these URLs.
    def get_http_base_urls(
        self, market_type: str = "spot", config: Any | None = None
    ) -> list[str]:
        return []

    def get_ws_base_urls(
        self, market_type: str = "spot", config: Any | None = None
    ) -> list[str]:
        return []

    def get_rest_path(self, stream_type: StreamType, market_type: str = "spot") -> None:
        return None

    def build_http_params(self, req: TransportRequest) -> dict[str, Any]:
        return {}

    def build_ws_stream_name(self, descriptor: StreamDescriptor) -> str:
        return ""

    def build_ws_subscription(self, descriptor: StreamDescriptor) -> Any:
        raise RuntimeError("provider streams do not use WebSocket subscriptions")

    def get_multi_symbol_ticker_stream_name(self, market_type: str = "spot") -> None:
        return None

    def supports_ws_streaming(self, market_type: str = "spot") -> bool:
        return False

    def extract_http_rows(self, payload: Any, stream_type: StreamType) -> list[Any]:
        return list(payload) if isinstance(payload, list) else [payload]


class PluginProviderRuntime:
    """Own dynamic registry entries and tear them down before sidecars disappear."""

    def __init__(self, *, invoke: InvokeContribution) -> None:
        self._invoke = invoke
        self._plugins: dict[str, tuple[ProviderExchangePlugin, ...]] = {}
        self._symbol_refresher: SymbolRefresher | None = None
        self._symbol_evictor: SymbolEvictor | None = None

    def bind_symbol_refresher(
        self,
        refresher: SymbolRefresher,
        *,
        evictor: SymbolEvictor | None = None,
    ) -> None:
        self._symbol_refresher = refresher
        self._symbol_evictor = evictor

    def register_plugin(self, contributions: Iterable[Any]) -> None:
        values = tuple(contributions)
        if not values:
            return
        plugin_id = values[0].plugin_id
        symbols = {
            item.configuration["exchange"]: item
            for item in values
            if item.kind == "symbol-provider/1"
        }
        markets = {
            item.configuration["exchange"]: item
            for item in values
            if item.kind == "market-data-provider/1"
        }
        if not symbols and not markets:
            return
        if plugin_id in self._plugins:
            raise ValueError(f"provider plugin is already registered: {plugin_id}")
        bootstrap_default_adapters()
        registry = get_exchange_registry()
        collisions = sorted(exchange for exchange in symbols if registry.has(exchange))
        if collisions:
            raise ValueError(
                "provider exchange IDs collide with registered exchanges: "
                + ", ".join(collisions)
            )
        providers = tuple(
            ProviderExchangePlugin(
                symbol_contribution=symbols[exchange],
                market_contribution=markets[exchange],
                invoke=self._invoke,
            )
            for exchange in sorted(symbols)
        )
        registered: list[ProviderExchangePlugin] = []
        try:
            for provider in providers:
                registry.register(provider, source=f"platform-v2:{plugin_id}")
                registered.append(provider)
        except Exception:
            for provider in reversed(registered):
                registry.unregister(provider.id, expected_plugin=provider)
            raise
        self._plugins[plugin_id] = providers

    async def refresh_plugin_symbols(self, plugin_id: str) -> dict[str, int]:
        if self._symbol_refresher is None:
            return {}
        counts: dict[str, int] = {}
        for provider in self._plugins.get(plugin_id, ()):
            counts.update(await self._symbol_refresher(provider.id))
        return counts

    async def clear_plugin(self, plugin_id: str, *, reason: str) -> None:
        providers = self._plugins.pop(plugin_id, ())
        await asyncio.gather(
            *(provider.shutdown(reason) for provider in providers),
            return_exceptions=True,
        )
        registry = get_exchange_registry()
        for provider in providers:
            removed = registry.unregister(provider.id, expected_plugin=provider)
            if removed and self._symbol_evictor is not None:
                self._symbol_evictor(provider.id)

    async def stop(self) -> None:
        for plugin_id in tuple(self._plugins):
            await self.clear_plugin(plugin_id, reason="platform-stop")

    def registered_exchanges(self) -> tuple[str, ...]:
        return tuple(
            sorted(
                provider.id
                for providers in self._plugins.values()
                for provider in providers
            )
        )

    def diagnostics(self) -> dict[str, Any]:
        return {
            "schemaVersion": "candlescope.plugin-provider-runtime/1",
            "registeredExchanges": list(self.registered_exchanges()),
            "plugins": {
                plugin_id: [provider.id for provider in providers]
                for plugin_id, providers in sorted(self._plugins.items())
            },
        }
