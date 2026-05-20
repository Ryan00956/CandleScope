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

import logging
from typing import Any, Callable, Awaitable

from app.exchanges import bootstrap_default_adapters, get_exchange_registry

from .config import IngestionConfig
from .models import StreamType, StreamDescriptor, MarketEvent

logger = logging.getLogger("ingestion.factory")


class _IngestionHandle:
    """Handle returned by ``ExchangeIngestionFactory.start()``.

    Provides a ``stop()`` coroutine that the coordinator calls
    when tearing down a stream.
    """
    __slots__ = ("_ingress", "_stream_key")

    def __init__(self, ingress: Any, stream_key: str) -> None:
        self._ingress = ingress
        self._stream_key = stream_key

    async def stop(self) -> None:
        """Stop and remove the underlying ingestion pipeline."""
        try:
            await self._ingress.remove_stream(self._stream_key)
            logger.info("Ingestion pipeline stopped: %s", self._stream_key)
        except Exception as exc:
            logger.error(
                "Error stopping ingestion pipeline %s: %s",
                self._stream_key, exc,
            )


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

    def __init__(self, config: IngestionConfig | None = None) -> None:
        self._cfg = config or IngestionConfig()
        self._ingress: Any = None  # lazily created MarketDataIngress

    @property
    def config(self) -> IngestionConfig:
        return self._cfg

    def get_transports(self) -> list[Any]:
        """Return active transport layers managed by this factory."""
        if self._ingress is None:
            return []
        return [self._ingress.transport]

    async def _ensure_ingress(self) -> Any:
        """Lazily create and start the shared MarketDataIngress instance."""
        if self._ingress is None:
            # Import here to avoid circular imports at module level
            from . import MarketDataIngress

            self._ingress = MarketDataIngress(self._cfg)
            await self._ingress.start()
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
        ingress = await self._ensure_ingress()

        descriptor = StreamDescriptor(
            symbol=symbol.upper(),
            stream_type=StreamType.KLINE,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
        )

        # Check if pipeline already exists (idempotent)
        existing = ingress.get_pipeline(descriptor.key)
        if existing is not None:
            logger.info(
                "Pipeline already exists for %s, reusing",
                descriptor.key,
            )
            existing.delivery.on_market_event(on_market_event)
            if on_gap is not None:
                existing.delivery.on_gap(on_gap)
            return _IngestionHandle(ingress, descriptor.key)

        # Create a new L1–L6 pipeline
        pipeline = await ingress.add_stream(descriptor)

        pipeline.delivery.on_market_event(on_market_event)
        if on_gap is not None:
            pipeline.delivery.on_gap(on_gap)

        logger.info("Ingestion pipeline started: %s", descriptor.key)
        return _IngestionHandle(ingress, descriptor.key)

    async def start_price(
        self,
        symbol: str,
        on_price: Callable[[dict], Awaitable[None]],
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> _IngestionHandle:
        """Start an ingestion ticker stream for a watched price symbol."""
        ingress = await self._ensure_ingress()
        stream_type = self._price_stream_type(exchange, market_type)
        descriptor = StreamDescriptor(
            symbol=symbol.upper(),
            stream_type=stream_type,
            exchange=exchange,
            market_type=market_type,
        )

        existing = ingress.get_pipeline(descriptor.key)
        if existing is not None:
            self._register_price_callback(existing, on_price, exchange, market_type)
            return _IngestionHandle(ingress, descriptor.key)

        pipeline = await ingress.add_stream(descriptor)
        self._register_price_callback(pipeline, on_price, exchange, market_type)
        logger.info("Price ingestion pipeline started: %s", descriptor.key)
        return _IngestionHandle(ingress, descriptor.key)

    @staticmethod
    def _price_stream_type(exchange: str, market_type: str) -> StreamType:
        bootstrap_default_adapters()
        try:
            stream_type = get_exchange_registry().get_plugin(exchange).price_stream_type(market_type)
        except KeyError:
            return StreamType.TICKER
        return stream_type if isinstance(stream_type, StreamType) else StreamType(str(stream_type))

    def _register_price_callback(
        self,
        pipeline: Any,
        on_price: Callable[[dict], Awaitable[None]],
        exchange: str,
        market_type: str,
    ) -> None:
        async def _bridge(market_event: MarketEvent) -> None:
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

        pipeline.delivery.on_market_event(_bridge)

    async def shutdown(self) -> None:
        """Stop the shared MarketDataIngress (called during app shutdown)."""
        if self._ingress is not None:
            await self._ingress.stop()
            self._ingress = None
            logger.info("ExchangeIngestionFactory shut down")
