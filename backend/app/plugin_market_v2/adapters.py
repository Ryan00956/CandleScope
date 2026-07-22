"""Capability Broker methods for the Phase 6 read-only market plane."""

from __future__ import annotations

import asyncio
import copy
import time
from collections import Counter, OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    BarsReadRequest,
    BarsSubscribeRequest,
    HostCallRequest,
    OrderBookReadRequest,
    PlatformContractError,
    SymbolsReadRequest,
    TradesReadRequest,
)

from app.data_engine.interval_policy import parse_interval_spec
from app.plugin_security_v2.capabilities import (
    CapabilityBroker,
    CapabilityLease,
    CapabilityMethodPolicy,
)

from .chart_layers import ChartLayerRegistry
from .errors import market_error
from .ports import MarketDataConsumerPort
from .projections import project_bars_page, project_symbols_page
from .subscriptions import BarSubscriptionManager


class _ReadCoordinator:
    """Share concurrent cold reads and briefly absorb identical retries."""

    def __init__(self, *, ttl_seconds: float = 0.25, capacity: int = 128) -> None:
        self.ttl_seconds = ttl_seconds
        self.capacity = capacity
        self._in_flight: dict[tuple[Any, ...], asyncio.Task[dict[str, Any]]] = {}
        self._cache: OrderedDict[tuple[Any, ...], tuple[float, dict[str, Any]]] = (
            OrderedDict()
        )
        self.shared = 0
        self.cache_hits = 0

    async def run(
        self,
        key: tuple[Any, ...],
        factory: Callable[[], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached is not None and cached[0] > now:
            self.cache_hits += 1
            self._cache.move_to_end(key)
            return copy.deepcopy(cached[1])
        self._cache.pop(key, None)
        task = self._in_flight.get(key)
        if task is not None:
            self.shared += 1
            return copy.deepcopy(await asyncio.shield(task))
        task = asyncio.create_task(factory(), name="plugin-market-shared-read")
        self._in_flight[key] = task
        try:
            result = await asyncio.shield(task)
        finally:
            self._in_flight.pop(key, None)
        self._cache[key] = (time.monotonic() + self.ttl_seconds, result)
        self._cache.move_to_end(key)
        while len(self._cache) > self.capacity:
            self._cache.popitem(last=False)
        return copy.deepcopy(result)

    def snapshot(self) -> dict[str, int]:
        return {
            "inFlight": len(self._in_flight),
            "cached": len(self._cache),
            "shared": self.shared,
            "cacheHits": self.cache_hits,
        }


class MarketCapabilityAdapters:
    def __init__(
        self,
        *,
        subscriptions: BarSubscriptionManager,
        chart_layers: ChartLayerRegistry,
    ) -> None:
        self.subscriptions = subscriptions
        self.chart_layers = chart_layers
        self._port: MarketDataConsumerPort | None = None
        self._active_reads: Counter[tuple[str, str, int]] = Counter()
        self._reads = _ReadCoordinator()
        self._accepting = True

    def start(self) -> None:
        self._accepting = True

    def stop(self) -> None:
        self._accepting = False

    def bind(self, port: MarketDataConsumerPort) -> None:
        if self._port is not None and self._port is not port:
            raise RuntimeError("market data port is already bound")
        self._port = port
        self.subscriptions.bind(port)

    @staticmethod
    def _parse(parser: Any, params: dict[str, Any]) -> Any:
        try:
            return parser.from_wire(params)
        except PlatformContractError as exc:
            raise market_error(
                "CAPABILITY_PARAMS_INVALID",
                exc.message,
                details={"path": exc.path},
            ) from exc

    @staticmethod
    def _context_scope(context: Any) -> dict[str, Any]:
        return {
            "contexts": [context.mode],
            "exchanges": [context.exchange],
            "marketTypes": [context.market_type],
        }

    @classmethod
    def _symbols_scope(cls, params: dict[str, Any]) -> dict[str, Any]:
        request = cls._parse(SymbolsReadRequest, params)
        return {
            **cls._context_scope(request.context),
            "quoteAssets": [request.quote_asset],
            "maxSymbolsPerCall": request.limit,
        }

    @classmethod
    def _bars_scope(cls, params: dict[str, Any]) -> dict[str, Any]:
        request = cls._parse(BarsReadRequest, params)
        return {
            **cls._context_scope(request.context),
            "symbols": [request.series.symbol],
            "intervals": [request.series.interval],
            "maxHistoryBars": request.limit,
        }

    @classmethod
    def _bars_subscription_scope(cls, params: dict[str, Any]) -> dict[str, Any]:
        request = cls._parse(BarsSubscribeRequest, params)
        return {
            **cls._context_scope(request.context),
            "symbols": [request.series.symbol],
            "intervals": [request.series.interval],
            "maxConcurrent": 1,
        }

    @classmethod
    def _trades_scope(cls, params: dict[str, Any]) -> dict[str, Any]:
        request = cls._parse(TradesReadRequest, params)
        return {
            **cls._context_scope(request.context),
            "symbols": [request.symbol],
            "dataKinds": [request.kind],
            "maxTrades": request.limit,
        }

    @classmethod
    def _order_book_scope(cls, params: dict[str, Any]) -> dict[str, Any]:
        request = cls._parse(OrderBookReadRequest, params)
        return {
            **cls._context_scope(request.context),
            "symbols": [request.symbol],
            "maxDepthLevels": request.depth_levels,
        }

    @classmethod
    def _chart_scope(cls, params: dict[str, Any]) -> dict[str, Any]:
        context = params.get("context")
        try:
            from candlescope_plugin_sdk.platform_v2 import MarketContext

            parsed = MarketContext.from_wire(context)
        except PlatformContractError as exc:
            raise market_error(
                "CAPABILITY_PARAMS_INVALID",
                exc.message,
                details={"path": exc.path},
            ) from exc
        layer_id = params.get("layerId")
        render = params.get("render")
        if not isinstance(layer_id, str) or not isinstance(render, dict):
            raise market_error(
                "CAPABILITY_PARAMS_INVALID",
                "chart layer scope parameters are invalid",
            )
        items = render.get("items")
        if not isinstance(items, list):
            raise market_error(
                "CAPABILITY_PARAMS_INVALID", "render.items must be an array"
            )
        return {
            **cls._context_scope(parsed),
            "layers": [layer_id],
            "maxItems": len(items),
        }

    def register(self, broker: CapabilityBroker) -> None:
        policies = (
            CapabilityMethodPolicy(
                "market.symbols.read",
                "market.symbols.read",
                handler_with_lease=self._symbols_read,
                scope_extractor=self._symbols_scope,
                max_calls_per_minute=120,
                max_calls_per_activation=10_000,
            ),
            CapabilityMethodPolicy(
                "market.bars.read",
                "market.bars.read",
                handler_with_lease=self._bars_read,
                scope_extractor=self._bars_scope,
                max_calls_per_minute=600,
                max_calls_per_activation=50_000,
            ),
            CapabilityMethodPolicy(
                "market.bars.subscribe",
                "market.bars.subscribe",
                handler_with_lease=self._bars_subscribe,
                scope_extractor=self._bars_subscription_scope,
                max_calls_per_minute=60,
                max_calls_per_activation=1_000,
            ),
            CapabilityMethodPolicy(
                "market.bars.cancel",
                "market.bars.subscribe",
                handler_with_lease=self._bars_cancel,
                max_calls_per_minute=120,
                max_calls_per_activation=2_000,
            ),
            CapabilityMethodPolicy(
                "market.bars.resume",
                "market.bars.subscribe",
                handler_with_lease=self._bars_resume,
                max_calls_per_minute=120,
                max_calls_per_activation=2_000,
            ),
            CapabilityMethodPolicy(
                "market.trades.read",
                "market.trades.read",
                handler_with_lease=self._trades_read,
                scope_extractor=self._trades_scope,
                max_calls_per_minute=300,
                max_calls_per_activation=20_000,
            ),
            CapabilityMethodPolicy(
                "market.order-book.read",
                "market.order-book.read",
                handler_with_lease=self._order_book_read,
                scope_extractor=self._order_book_scope,
                max_calls_per_minute=120,
                max_calls_per_activation=5_000,
            ),
            CapabilityMethodPolicy(
                "chart.layer.publish",
                "chart.layer.publish",
                handler_with_lease=self._chart_publish,
                scope_extractor=self._chart_scope,
                max_calls_per_minute=600,
                max_calls_per_activation=20_000,
            ),
        )
        for policy in policies:
            broker.register(policy)

    @staticmethod
    def _require_live(context: Any, lease: CapabilityLease) -> None:
        if context.mode != "live":
            raise market_error(
                "MARKET_CONTEXT_ISOLATION_DENIED",
                "live market capabilities cannot access replay context",
                plugin_id=lease.plugin_id,
            )

    def _require_port(self, lease: CapabilityLease) -> MarketDataConsumerPort:
        if not self._accepting:
            raise market_error(
                "MARKET_DATA_GENERATION_REVOKED",
                "market data capability is stopping",
                plugin_id=lease.plugin_id,
            )
        if self._port is None:
            raise market_error(
                "MARKET_DATA_UNAVAILABLE",
                "DataManager market data is not initialized",
                plugin_id=lease.plugin_id,
            )
        return self._port

    async def _symbols_read(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        request = self._parse(SymbolsReadRequest, dict(call.params))
        self._require_live(request.context, lease)
        symbols, cached_at = await self._require_port(lease).list_symbols(request)
        allowed_symbols = lease.scope.get("symbols")
        if allowed_symbols is not None:
            if (
                not isinstance(allowed_symbols, list)
                or not allowed_symbols
                or not all(isinstance(item, str) for item in allowed_symbols)
            ):
                raise market_error(
                    "MARKET_SYMBOL_SCOPE_INVALID",
                    "granted symbol discovery scope is invalid",
                    plugin_id=lease.plugin_id,
                )
            allowed = {item.upper() for item in allowed_symbols}
            symbols = [
                item
                for item in symbols
                if str(item.get("symbol", "")).upper() in allowed
            ]
        return project_symbols_page(
            context=request.context,
            quote_asset=request.quote_asset,
            search=request.search,
            after=request.after,
            limit=request.limit,
            cached_at=cached_at,
            symbols=symbols,
        )

    @staticmethod
    def _validate_history_span(
        request: BarsReadRequest, lease: CapabilityLease
    ) -> None:
        spec = parse_interval_spec(request.series.interval)
        if spec is None or spec.nominal_ms <= 0:
            raise market_error(
                "MARKET_INTERVAL_INVALID",
                "bar interval is unsupported",
                plugin_id=lease.plugin_id,
            )
        if request.start_ms is None or request.end_ms is None:
            return
        requested = (request.end_ms - request.start_ms) // spec.nominal_ms + 1
        if requested > request.limit:
            raise market_error(
                "MARKET_HISTORY_RANGE_TOO_DEEP",
                "requested time range exceeds the bounded history limit",
                plugin_id=lease.plugin_id,
                details={"requestedBars": requested, "limit": request.limit},
            )

    async def _bars_read(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        request = self._parse(BarsReadRequest, dict(call.params))
        self._require_live(request.context, lease)
        self._validate_history_span(request, lease)
        maximum = lease.scope.get("maxConcurrent", 1)
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
            raise market_error(
                "MARKET_READ_SCOPE_INVALID",
                "granted maxConcurrent is invalid",
                plugin_id=lease.plugin_id,
            )
        owner = (lease.plugin_id, lease.instance_id, lease.generation)
        if self._active_reads[owner] >= maximum:
            raise market_error(
                "MARKET_READ_CONCURRENCY_EXCEEDED",
                "bar read concurrency quota is exhausted",
                plugin_id=lease.plugin_id,
                details={"maxConcurrent": maximum},
            )
        self._active_reads[owner] += 1
        key = (
            request.context.mode,
            request.context.exchange,
            request.context.market_type,
            request.series.symbol,
            request.series.interval,
            request.start_ms,
            request.end_ms,
            request.limit,
        )

        async def load() -> dict[str, Any]:
            result = await self._require_port(lease).read_bars(request)
            return project_bars_page(request, result)

        try:
            return await self._reads.run(key, load)
        finally:
            self._active_reads[owner] -= 1
            if self._active_reads[owner] <= 0:
                self._active_reads.pop(owner, None)

    async def _bars_subscribe(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        request = self._parse(BarsSubscribeRequest, dict(call.params))
        self._require_live(request.context, lease)
        self._require_port(lease)
        return await self.subscriptions.create(request, lease)

    @staticmethod
    def _subscription_control(
        call: HostCallRequest, *, resume: bool
    ) -> tuple[str, int | None]:
        value = dict(call.params)
        expected = {"subscriptionId", "lastSequence"} if resume else {"subscriptionId"}
        if set(value) != expected or not isinstance(value.get("subscriptionId"), str):
            raise market_error(
                "CAPABILITY_PARAMS_INVALID",
                "subscription control parameters have an invalid shape",
            )
        last = value.get("lastSequence")
        if resume and (isinstance(last, bool) or not isinstance(last, int) or last < 0):
            raise market_error(
                "CAPABILITY_PARAMS_INVALID",
                "lastSequence must be a non-negative integer",
            )
        return value["subscriptionId"], last

    async def _bars_cancel(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        subscription_id, _ = self._subscription_control(call, resume=False)
        return await self.subscriptions.cancel(subscription_id, lease)

    async def _bars_resume(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        subscription_id, last = self._subscription_control(call, resume=True)
        assert last is not None
        return await self.subscriptions.resume(subscription_id, last, lease)

    async def _trades_read(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        request = self._parse(TradesReadRequest, dict(call.params))
        self._require_live(request.context, lease)
        return await self._require_port(lease).read_trades(request)

    async def _order_book_read(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        request = self._parse(OrderBookReadRequest, dict(call.params))
        self._require_live(request.context, lease)
        consumer_id = (
            f"plugin:{lease.plugin_id}:{lease.entrypoint_id}:"
            f"{lease.instance_id}:{lease.generation}:order-book:{call.request_context.trace_id}"
        )
        return await self._require_port(lease).read_order_book(
            request, consumer_id=consumer_id
        )

    async def _chart_publish(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        return self.chart_layers.publish(dict(call.params), lease)

    def snapshot(self) -> dict[str, Any]:
        return {
            "bound": self._port is not None,
            "activeReads": sum(self._active_reads.values()),
            "readCoordinator": self._reads.snapshot(),
        }


__all__ = ["MarketCapabilityAdapters"]
