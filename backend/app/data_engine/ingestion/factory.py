"""
    Exchange Ingestion Factory — bridges the six-layer Ingestion pipeline
into the DataManager's ``IngestionFactory`` protocol.

This is the "last mile" wiring that was missing:

    DataManager.set_ingestion_factory(ExchangeIngestionFactory())

When ``StreamCoordinator.ensure_stream()`` starts a new pipeline,
it calls ``factory.start(symbol, interval, on_market_event)`` which:

  1. Creates a ``StreamDescriptor`` for the requested (symbol, interval).
  2. Uses ``MarketDataIngress`` to spin up a full L1–L6 pipeline
     (Transport → Session → FeedControl → Normalize → Continuity → Delivery).
  3. Registers a callback on L6 ``DeliveryLayer`` that forwards each
     ``MarketEvent`` directly to ``on_market_event()``.
     Gap markers can be forwarded through optional ``on_gap``.
  4. Returns a handle with a ``stop()`` coroutine.

The ``on_market_event()`` callback is wired by the coordinator into the
BarAggregator L1-L5 pipeline, which then feeds Cache + EventBus.

Data flow::

    Exchange WS/HTTP
      → L1 Transport → L2 Session → L3 FeedControl
      → L4 Normalize → L5 Continuity → L6 Delivery
      → ExchangeIngestionFactory
      → on_market_event(market_event)
      → BarAggregator.on_market_event()
      → L1 Router → L2 TimeBucket → L3 BarState → L4 Finalizer → L5 Publisher
      → AggregatorBridge.on_bar_event()
      → Cache + EventBus
      → WebSocket subscribers (frontend)
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable, Awaitable

from app.exchanges import bootstrap_default_adapters, get_exchange_registry

from .config import IngestionConfig
from .session_types import HealthCallback
from .models import (
    DataSource,
    MarketEvent,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)

logger = logging.getLogger("ingestion.factory")


class _IngestionHandle:
    """Handle returned by ``ExchangeIngestionFactory.start()``.

    Provides a ``stop()`` coroutine that the coordinator calls
    when tearing down a stream.
    """
    __slots__ = ("_factory", "_ingress", "_stream_key")

    def __init__(
        self,
        factory: "ExchangeIngestionFactory",
        ingress: Any,
        stream_key: str,
    ) -> None:
        self._factory = factory
        self._ingress = ingress
        self._stream_key = stream_key

    async def stop(self) -> bool:
        """Stop and remove the underlying ingestion pipeline."""
        try:
            await self._factory._stop_descriptor(self._ingress, self._stream_key)
            logger.info("Ingestion pipeline stopped: %s", self._stream_key)
            return True
        except Exception as exc:
            logger.error(
                "Error stopping ingestion pipeline %s: %s",
                self._stream_key, exc,
            )
            return False


class ExchangeIngestionFactory:
    """Bridges the six-layer Ingestion architecture into the DataManager.

    Implements the ``IngestionFactory`` protocol expected by
    ``StreamCoordinator``:

        async def start(self, symbol, interval, on_market_event) -> handle
        handle.stop()  — to tear down

    Usage in ``main.py``::

        from app.data_engine.ingestion.factory import ExchangeIngestionFactory

        dm = DataManager()
        dm.set_ingestion_factory(ExchangeIngestionFactory())
        await dm.start()
    """

    def __init__(
        self,
        config: IngestionConfig | None = None,
        *,
        calendar_resolver: Callable[[str, str, str], Any] | None = None,
    ) -> None:
        self._cfg = config or IngestionConfig()
        self._ingress: Any = None  # lazily created MarketDataIngress
        self._ingress_lock = asyncio.Lock()
        self._stream_locks: dict[str, tuple[asyncio.Lock, int]] = {}
        self._failed_stream_stops: set[str] = set()
        self._calendar_resolver = calendar_resolver

    @property
    def config(self) -> IngestionConfig:
        return self._cfg

    def set_calendar_resolver(
        self,
        resolver: Callable[[str, str, str], Any] | None,
    ) -> None:
        """Set calendar lookup before the shared ingress is created."""
        if self._ingress is not None:
            raise RuntimeError("calendar resolver must be set before ingestion starts")
        self._calendar_resolver = resolver

    def get_transports(self) -> list[Any]:
        """Return active transport layers managed by this factory."""
        if self._ingress is None:
            return []
        return [self._ingress.transport]

    def snapshot(self) -> dict[str, Any]:
        """Return the lazily owned ingress state for read-only diagnostics."""

        return {
            "initialized": self._ingress is not None,
            "failed_stream_stops": sorted(self._failed_stream_stops),
            "ingress": self._ingress.snapshot() if self._ingress is not None else None,
        }

    async def _ensure_ingress(self) -> Any:
        """Lazily create and start the shared MarketDataIngress instance."""
        if self._ingress is not None:
            return self._ingress
        async with self._ingress_lock:
            if self._ingress is not None:
                return self._ingress
            # Import here to avoid circular imports at module level
            from . import MarketDataIngress

            ingress = MarketDataIngress(
                self._cfg,
                calendar_resolver=self._calendar_resolver,
            )
            await ingress.start()
            self._ingress = ingress
            logger.info("MarketDataIngress initialized and started")
        return self._ingress

    async def start(
        self,
        symbol: str,
        interval: str,
        on_market_event: Callable[[MarketEvent], Awaitable[None]],
        exchange: str = "binance",
        market_type: str = "spot",
        on_gap: Callable[[Any], Awaitable[None]] | None = None,
    ) -> _IngestionHandle:
        """Start an ingestion stream for (symbol, interval).

        Creates a full L1–L6 pipeline via ``MarketDataIngress.add_stream()``,
        then registers a callback on L6 Delivery that forwards each
        ``MarketEvent`` directly to ``on_market_event()``.

        Args:
            symbol:      Trading pair, e.g. "BTCUSDT".
            interval:    K-line interval, e.g. "1m".
            on_market_event: Async callback ``(MarketEvent) -> None``.
            market_type: "spot" or "futures".

        Returns:
            An ``_IngestionHandle`` with a ``stop()`` coroutine.
        """
        descriptor = StreamDescriptor(
            symbol=symbol.upper(),
            stream_type=StreamType.KLINE,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
        )

        return await self._start_descriptor(
            descriptor,
            on_market_event,
            on_gap=on_gap,
        )

    async def start_market(
        self,
        descriptor: StreamDescriptor,
        on_market_event: Callable[[MarketEvent], Awaitable[None]],
        *,
        on_gap: Callable[[Any], Awaitable[None]] | None = None,
        on_health: HealthCallback | None = None,
    ) -> _IngestionHandle:
        """Start one non-K-line physical market-data pipeline.

        Consumer refcounting belongs to ``MarketDataService``.  Callers must
        not hand the returned handle to multiple independent owners.
        """

        if descriptor.stream_type == StreamType.KLINE:
            raise ValueError("start_market does not accept KLINE descriptors")
        return await self._start_descriptor(
            descriptor,
            on_market_event,
            on_gap=on_gap,
            on_health=on_health,
        )

    async def _start_descriptor(
        self,
        descriptor: StreamDescriptor,
        on_market_event: Callable[[MarketEvent], Awaitable[None]],
        *,
        on_gap: Callable[[Any], Awaitable[None]] | None = None,
        on_health: HealthCallback | None = None,
    ) -> _IngestionHandle:
        ingress = await self._ensure_ingress()
        descriptor.validate()
        async with self._hold_stream_lock(descriptor.key):
            if descriptor.key in self._failed_stream_stops:
                await self._remove_stream_locked(ingress, descriptor.key)

            # The reuse check must share the same lifecycle lock as handle.stop().
            # Otherwise a fast resubscribe can reuse a pipeline that is already
            # stopping and will be removed immediately afterwards.
            existing = ingress.get_pipeline(descriptor.key)
            if existing is not None:
                logger.info(
                    "Pipeline already exists for %s, reusing",
                    descriptor.key,
                )
                existing.delivery.on_market_event(on_market_event)
                if on_gap is not None:
                    existing.delivery.on_gap(on_gap)
                if on_health is not None:
                    existing.on_health_change(on_health)
                return _IngestionHandle(self, ingress, descriptor.key)

            # Create a new L1–L6 pipeline
            try:
                if on_health is None:
                    pipeline = await ingress.add_stream(descriptor)
                else:
                    pipeline = await ingress.add_stream(
                        descriptor,
                        on_health=on_health,
                    )
            except BaseException:
                if ingress.get_pipeline(descriptor.key) is not None:
                    try:
                        await asyncio.shield(
                            self._remove_stream_locked(ingress, descriptor.key),
                        )
                    except BaseException:
                        logger.exception(
                            "Failed to roll back ingestion pipeline: %s",
                            descriptor.key,
                        )
                raise

            pipeline.delivery.on_market_event(on_market_event)
            if on_gap is not None:
                pipeline.delivery.on_gap(on_gap)

            logger.info("Ingestion pipeline started: %s", descriptor.key)
            return _IngestionHandle(self, ingress, descriptor.key)

    async def _stop_descriptor(self, ingress: Any, stream_key: str) -> None:
        async with self._hold_stream_lock(stream_key):
            await self._remove_stream_locked(ingress, stream_key)

    async def _remove_stream_locked(self, ingress: Any, stream_key: str) -> None:
        try:
            await ingress.remove_stream(stream_key)
        except BaseException:
            self._failed_stream_stops.add(stream_key)
            raise
        else:
            self._failed_stream_stops.discard(stream_key)

    @asynccontextmanager
    async def _hold_stream_lock(self, key: str) -> AsyncIterator[None]:
        state = self._stream_locks.get(key)
        if state is None:
            lock = asyncio.Lock()
            users = 0
        else:
            lock, users = state
        self._stream_locks[key] = (lock, users + 1)

        acquired = False
        try:
            await lock.acquire()
            acquired = True
            yield
        finally:
            if acquired:
                lock.release()
            current = self._stream_locks.get(key)
            if current is not None and current[0] is lock:
                remaining = current[1] - 1
                if remaining <= 0:
                    self._stream_locks.pop(key, None)
                else:
                    self._stream_locks[key] = (lock, remaining)

    async def fetch_market(
        self,
        descriptor: StreamDescriptor,
        *,
        limit: int = 1,
        start_ms: int | None = None,
        end_ms: int | None = None,
        from_id: int | None = None,
        history: bool = False,
        defer_on_rate_limit: bool = False,
    ) -> list[MarketEvent]:
        """Fetch and normalize one REST snapshot or history page."""

        from .normalizers import create_normalizer

        descriptor.validate()
        ingress = await self._ensure_ingress()
        messages = await ingress.transport.http_fetch(TransportRequest(
            descriptor=descriptor,
            limit=limit,
            start_ms=start_ms,
            end_ms=end_ms,
            from_id=from_id,
            history=history,
            defer_on_rate_limit=defer_on_rate_limit,
        ))
        normalizer = create_normalizer(self._cfg, descriptor)
        events: list[MarketEvent] = []
        for message in messages:
            if history:
                message.source = DataSource.HTTP_BACKFILL
            event = normalizer.parse(message)
            if event is not None:
                events.append(event)
        return events

    async def market_rate_limit_admission(
        self,
        descriptor: StreamDescriptor,
        *,
        limit: int = 1,
        start_ms: int | None = None,
        end_ms: int | None = None,
        from_id: int | None = None,
        history: bool = False,
    ) -> Any:
        """Inspect the exact plugin-owned REST budget without consuming it."""

        descriptor.validate()
        ingress = await self._ensure_ingress()
        return await ingress.transport.http_admission(TransportRequest(
            descriptor=descriptor,
            limit=limit,
            start_ms=start_ms,
            end_ms=end_ms,
            from_id=from_id,
            history=history,
            defer_on_rate_limit=True,
        ))

    async def start_price(
        self,
        symbol: str,
        on_price: Callable[[dict], Awaitable[None]],
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> _IngestionHandle:
        """Start an ingestion ticker stream for a watched price symbol."""
        stream_type = self._price_stream_type(exchange, market_type)
        descriptor = StreamDescriptor(
            symbol=symbol.upper(),
            stream_type=stream_type,
            exchange=exchange,
            market_type=market_type,
        )

        async def _bridge(market_event: MarketEvent) -> None:
            await self._forward_price_event(market_event, on_price, exchange, market_type)

        return await self._start_descriptor(descriptor, _bridge)

    @staticmethod
    def _price_stream_type(exchange: str, market_type: str) -> StreamType:
        bootstrap_default_adapters()
        try:
            stream_type = get_exchange_registry().get_plugin(exchange).price_stream_type(market_type)
        except KeyError:
            return StreamType.TICKER
        return stream_type if isinstance(stream_type, StreamType) else StreamType(str(stream_type))

    async def _forward_price_event(
        self,
        market_event: MarketEvent,
        on_price: Callable[[dict], Awaitable[None]],
        exchange: str,
        market_type: str,
    ) -> None:
        if market_event.event_type not in (StreamType.TICKER, StreamType.MINI_TICKER):
            return

        data = market_event.data
        price = float(data.get("last_price", data.get("close_price", 0)) or 0)
        open_price = float(data.get("open_price", 0) or 0)
        if "price_change_pct" in data:
            change_pct = float(data.get("price_change_pct", 0) or 0)
        elif open_price > 0:
            change_pct = ((price - open_price) / open_price) * 100
        else:
            change_pct = 0.0

        try:
            await on_price({
                "symbol": market_event.symbol,
                "exchange": exchange,
                "market_type": market_type,
                "price": price,
                "open": open_price,
                "high": float(data.get("high_price", 0) or 0),
                "low": float(data.get("low_price", 0) or 0),
                "change_pct": change_pct,
                "volume": float(data.get("volume", 0) or 0),
                "quote_volume": float(data.get("quote_volume", 0) or 0),
                "daily_open": open_price,
                "updated_at_ms": market_event.event_time_ms or market_event.received_at_ms,
            })
        except Exception as exc:
            logger.error("on_price callback error: %s", exc, exc_info=True)

    def _register_price_callback(
        self,
        pipeline: Any,
        on_price: Callable[[dict], Awaitable[None]],
        exchange: str,
        market_type: str,
    ) -> None:
        """Backward-compatible helper used by focused bridge tests."""

        async def _bridge(market_event: MarketEvent) -> None:
            await self._forward_price_event(market_event, on_price, exchange, market_type)

        pipeline.delivery.on_market_event(_bridge)

    async def shutdown(self) -> None:
        """Stop the shared MarketDataIngress (called during app shutdown)."""
        if self._ingress is not None:
            await self._ingress.stop()
            self._ingress = None
            self._failed_stream_stops.clear()
            logger.info("ExchangeIngestionFactory shut down")
