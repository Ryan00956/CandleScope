"""
Stream Coordinator — lifecycle management for data pipelines.

The coordinator is responsible for:
  * **Auto-starting** ingestion pipelines when a (symbol, interval) is
    first requested.
  * **Tracking** active streams and their health.
  * **Idle reaping** — stopping streams with zero subscribers after
    a configurable timeout.
  * **Prewarm** — loading historical data into cache on startup.
  * **Routing** ingestion output through BarAggregator (not directly
    to cache).

The coordinator does NOT own the ingestion or bar_aggregator modules
directly — it holds *references* and manages their lifecycle.  This
keeps dependencies loose and allows users to swap in custom
ingestion/aggregation implementations.

Data flow::

    Ingestion → on_raw_bar() → BarAggregator.on_market_event()
                              → L1–L5 pipeline
                              → Publisher callbacks
                              → AggregatorBridge.on_bar_event()
                              → Cache + EventBus

Usage::

    coord = StreamCoordinator(config, cache, event_bus)
    coord.set_ingestion_factory(my_factory)
    coord.set_bar_aggregator(my_aggregator)
    coord.set_storage(my_storage)

    await coord.ensure_stream("BTCUSDT", "1m")  # auto-start
    await coord.stop_stream("BTCUSDT", "1m")
    await coord.prewarm()
    await coord.shutdown()
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from typing import Any, Callable, Awaitable, Protocol, runtime_checkable

from app.core.executors import run_storage
from app.data_engine.interval_policy import is_standard_interval

from .cache import BarCache
from .config import CoordinatorConfig
from .event_bus import DataEventBus
from .models import (
    BarData,
    DataEvent,
    DataEventType,
    SeriesKey,
    StorageBackend,
    StreamInfo,
    StreamStatus,
)

logger = logging.getLogger("data_manager.coordinator")


# ═══════════════════════════════════════════════════════════════
#  Factory Protocols — for dependency injection
# ═══════════════════════════════════════════════════════════════


@runtime_checkable
class IngestionFactory(Protocol):
    """Protocol for creating ingestion sessions.

    Users can provide their own implementation to support different
    exchanges (Binance, OKX, Bybit, etc.) or data sources.

    The factory returns a handle that can be ``stop()``-ed.
    """

    async def start(
        self,
        symbol: str,
        interval: str,
        on_bar: Callable[[dict], Awaitable[None]],
        exchange: str = "binance",
        market_type: str = "spot",
        on_gap: Callable[[Any], Awaitable[None]] | None = None,
    ) -> Any:
        """Start an ingestion stream.

        Args:
            symbol:      Trading pair.
            interval:    Base interval (e.g. "1m").
            on_bar:      Callback for each incoming bar dict.
            market_type: "spot" or "futures".
            on_gap:      Optional callback for ingestion gap markers.

        Returns:
            A handle with a ``stop()`` coroutine.
        """
        ...


class _StreamEntry:
    """Internal tracking for one active stream."""
    __slots__ = (
        "key", "info", "handle", "task",
        "_last_subscriber_at_ms",
    )

    def __init__(self, key: SeriesKey) -> None:
        self.key = key
        self.info = StreamInfo(key=key)
        self.handle: Any = None       # ingestion handle
        self.task: asyncio.Task | None = None
        self._last_subscriber_at_ms = int(time.time() * 1000)

    def touch(self) -> None:
        self._last_subscriber_at_ms = int(time.time() * 1000)

    @property
    def idle_ms(self) -> int:
        return int(time.time() * 1000) - self._last_subscriber_at_ms


# ═══════════════════════════════════════════════════════════════
#  Stream Coordinator
# ═══════════════════════════════════════════════════════════════


class StreamCoordinator:
    """Lifecycle manager for ingestion → aggregation → cache pipelines.

    Responsibilities:
      * ``ensure_stream()`` — start a pipeline if not running.
      * ``stop_stream()`` — gracefully shut down a pipeline.
      * ``prewarm()`` — bulk-load historical data into cache.
      * ``reap_idle()`` — stop streams with no subscribers.
      * Route ingestion data through BarAggregator (not direct to cache).

    The coordinator is **exchange-agnostic** — it uses pluggable
    factory functions for ingestion.  Set them with:
      * ``set_ingestion_factory()``
      * ``set_bar_aggregator()``
      * ``set_storage()``
    """

    def __init__(
        self,
        config: CoordinatorConfig | None = None,
        cache: BarCache | None = None,
        event_bus: DataEventBus | None = None,
    ) -> None:
        self._cfg = config or CoordinatorConfig()
        self._cache = cache
        self._bus = event_bus

        # Active streams: SeriesKey → _StreamEntry
        self._streams: dict[SeriesKey, _StreamEntry] = {}

        # Pluggable factories
        self._ingestion_factory: IngestionFactory | None = None
        self._bar_aggregator: Any = None  # BarAggregator instance
        self._storage: StorageBackend | None = None
        self._gap_handler: Callable[[SeriesKey, Any], Awaitable[None]] | None = None

        # Background tasks
        self._reaper_task: asyncio.Task | None = None

    # ── Public: Configuration ────────────────────────────────

    def set_ingestion_factory(self, factory: IngestionFactory) -> None:
        """Set the ingestion factory for creating data streams.

        Must be called before ``ensure_stream()`` can auto-start
        ingestion pipelines.
        """
        self._ingestion_factory = factory

    def set_bar_aggregator(self, aggregator: Any) -> None:
        """Set the BarAggregator instance for routing ingestion data.

        When set, raw ingestion data flows through the BarAggregator
        L1–L5 pipeline instead of being directly pushed to cache.

        Args:
            aggregator: A ``BarAggregator`` instance.
        """
        self._bar_aggregator = aggregator

    def set_storage(self, storage: StorageBackend) -> None:
        """Set the storage backend for prewarm and persistence."""
        self._storage = storage

    def set_cache(self, cache: BarCache) -> None:
        """Set the cache instance."""
        self._cache = cache

    def set_event_bus(self, bus: DataEventBus) -> None:
        """Set the event bus instance."""
        self._bus = bus

    def set_gap_handler(
        self,
        handler: Callable[[SeriesKey, Any], Awaitable[None]] | None,
    ) -> None:
        """Set the callback used for ingestion gap markers."""
        self._gap_handler = handler

    # ── Public: Stream Lifecycle ─────────────────────────────

    async def ensure_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> StreamInfo:
        """Ensure a data stream is active for (market_type, symbol, interval).

        If the stream is already running, returns its info immediately.
        If not, and ``auto_start_ingestion`` is True, starts a new
        pipeline.

        For **non-standard intervals** (e.g. 7m, 11m, 45m) that are not
        natively supported by the exchange WebSocket, the coordinator
        does NOT create a separate WS connection.  Instead it ensures
        the base interval (typically 1m) stream is running and creates
        a passive StreamEntry.  The BarAggregator's L1 Router already
        knows how to fan out 1m data to custom-interval targets.

        Args:
            symbol:      Trading pair, e.g. "BTCUSDT".
            interval:    K-line interval, e.g. "1m", "5m", "1h", "7m".
            market_type: "spot" or "futures".

        Returns:
            ``StreamInfo`` with the current stream status.
        """
        market_type = self._normalize_market_type(market_type)
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)

        # Already running?
        if key in self._streams:
            entry = self._streams[key]
            # If the stream previously failed (e.g. network/proxy error),
            # remove the stale entry so we can retry starting it.
            if entry.info.status in (StreamStatus.ERROR, StreamStatus.STOPPED):
                logger.info(
                    "Removing stale %s stream %s for retry",
                    entry.info.status.value, key,
                )
                self._streams.pop(key, None)
            else:
                entry.touch()
                return entry.info

        # Auto-start if configured
        if not self._cfg.auto_start_ingestion:
            return StreamInfo(key=key, status=StreamStatus.STOPPED)

        # ── Non-standard interval: reuse base-interval stream ────
        if not is_standard_interval(interval):
            base_interval = self._cfg.base_interval  # typically "1m"
            base_key = SeriesKey(symbol, base_interval, exchange=exchange, market_type=market_type)

            # Ensure the base-interval ingestion stream is running
            if base_key not in self._streams:
                await self._start_stream(base_key)
            else:
                base_entry = self._streams[base_key]
                if base_entry.info.status in (StreamStatus.ERROR, StreamStatus.STOPPED):
                    logger.info(
                        "Removing stale %s base stream %s for retry",
                        base_entry.info.status.value, base_key,
                    )
                    self._streams.pop(base_key, None)
                    await self._start_stream(base_key)
                else:
                    base_entry.touch()

            # Create a passive StreamEntry (no WS connection of its own)
            entry = _StreamEntry(key)
            entry.info.status = StreamStatus.ACTIVE
            entry.info.started_at_ms = int(time.time() * 1000)
            self._streams[key] = entry

            logger.info(
                "Custom interval %s: aggregating from base stream %s",
                key, base_key,
            )

            # Emit stream-started event
            if self._bus:
                await self._bus.emit(DataEvent(
                    event_type=DataEventType.STREAM_STARTED,
                    key=key,
                ))

            return entry.info

        return await self._start_stream(key)

    async def stop_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Stop a running data stream."""
        market_type = self._normalize_market_type(market_type)
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        entry = self._streams.pop(key, None)
        if entry is None:
            return

        entry.info.status = StreamStatus.STOPPING
        logger.info("Stopping stream: %s", key)

        # Stop ingestion handle
        if entry.handle is not None:
            try:
                await entry.handle.stop()
            except Exception as exc:
                logger.error("Error stopping ingestion for %s: %s", key, exc)

        # Cancel task
        if entry.task is not None and not entry.task.done():
            entry.task.cancel()
            try:
                await entry.task
            except asyncio.CancelledError:
                pass

        entry.info.status = StreamStatus.STOPPED

        # Emit event
        if self._bus:
            await self._bus.emit(DataEvent(
                event_type=DataEventType.STREAM_STOPPED,
                key=key,
            ))

    async def stop_all(self) -> None:
        """Stop all running streams."""
        keys = list(self._streams.keys())
        for key in keys:
            await self.stop_stream(
                key.symbol,
                key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
            )

    # ── Public: Prewarm ──────────────────────────────────────

    async def prewarm(self) -> dict:
        """Load historical data into cache for configured symbols/intervals.

        Uses ``CoordinatorConfig.prewarm_symbols`` and
        ``CoordinatorConfig.prewarm_intervals``.

        Returns a summary dict.
        """
        if self._cache is None or self._storage is None:
            logger.warning("Prewarm skipped: cache or storage not set")
            return {"status": "skipped", "reason": "missing dependencies"}

        results: dict[str, int] = {}

        for exchange, market_type, symbol in self._iter_prewarm_targets():
            for interval, days in self._cfg.prewarm_intervals.items():
                key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
                try:
                    bars_loaded = await run_storage(
                        self._prewarm_series, key, days,
                    )
                    results[str(key)] = bars_loaded
                except Exception as exc:
                    logger.error("Prewarm failed for %s: %s", key, exc)
                    results[str(key)] = 0

                # Emit event
                if self._bus and results.get(str(key), 0) > 0:
                    await self._bus.emit(DataEvent(
                        event_type=DataEventType.CACHE_PREWARM,
                        key=key,
                        detail={"bars_loaded": results[str(key)]},
                    ))

        total = sum(results.values())
        logger.info("Prewarm complete: %d bars across %d series", total, len(results))
        return {"status": "ok", "series": results, "total_bars": total}

    def _iter_prewarm_targets(self) -> list[tuple[str, str, str]]:
        if getattr(self._cfg, "prewarm_targets", None):
            return [
                (
                    target.exchange.strip().lower(),
                    self._normalize_market_type(target.market_type),
                    target.symbol.upper().strip(),
                )
                for target in self._cfg.prewarm_targets
            ]
        return [
            ("binance", "spot", symbol.upper().strip())
            for symbol in self._cfg.prewarm_symbols
        ]

    def prewarm_targets(self) -> list[tuple[str, str, str]]:
        """Return configured prewarm targets as (exchange, market_type, symbol)."""
        return self._iter_prewarm_targets()

    def prewarm_intervals(self) -> tuple[str, ...]:
        """Return configured prewarm interval names."""
        return tuple(self._cfg.prewarm_intervals)

    # ── Public: Idle Reaping ─────────────────────────────────

    async def start_reaper(self) -> None:
        """Start the background idle-stream reaper."""
        if self._cfg.idle_stream_timeout_seconds <= 0:
            return
        if self._reaper_task is not None:
            return
        self._reaper_task = asyncio.create_task(self._reaper_loop())
        logger.debug("Idle stream reaper started")

    async def stop_reaper(self) -> None:
        """Stop the background reaper."""
        if self._reaper_task is not None:
            self._reaper_task.cancel()
            try:
                await self._reaper_task
            except asyncio.CancelledError:
                pass
            self._reaper_task = None

    async def reap_idle(self) -> list[str]:
        """Manually reap idle streams.  Returns list of stopped topics."""
        timeout_ms = self._cfg.idle_stream_timeout_seconds * 1000
        reaped: list[str] = []

        for key, entry in list(self._streams.items()):
            # Check if stream has subscribers
            sub_count = 0
            if self._bus:
                sub_count = self._bus.get_subscriber_count(key)

            if sub_count > 0:
                entry.touch()
                continue

            if entry.idle_ms > timeout_ms:
                logger.info("Reaping idle stream: %s (idle %ds)", key, entry.idle_ms // 1000)
                await self.stop_stream(
                    key.symbol,
                    key.interval,
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                reaped.append(str(key))

        return reaped

    # ── Public: Introspection ────────────────────────────────

    def get_stream_info(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> StreamInfo | None:
        """Get info about a specific stream."""
        market_type = self._normalize_market_type(market_type)
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        entry = self._streams.get(key)
        return entry.info if entry else None

    def get_all_streams(self) -> list[StreamInfo]:
        """Get info about all active streams."""
        return [e.info for e in self._streams.values()]

    def has_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> bool:
        """Return True if a stream entry exists, regardless of status."""
        market_type = self._normalize_market_type(market_type)
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        return key in self._streams

    def mark_bar_received(self, key: SeriesKey) -> None:
        """Record that a bar was received for an active stream."""
        entry = self._streams.get(key)
        if entry is None:
            return
        entry.info.bars_received += 1
        entry.info.last_bar_at_ms = int(time.time() * 1000)

    def is_active(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> bool:
        """Check if a stream is currently active."""
        market_type = self._normalize_market_type(market_type)
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        entry = self._streams.get(key)
        return entry is not None and entry.info.status == StreamStatus.ACTIVE

    @staticmethod
    def _normalize_market_type(market_type: str) -> str:
        return (market_type or "spot").strip().lower()

    # ── Public: Bar Ingestion (manual push — bypasses aggregator) ─

    async def on_bar_event(
        self,
        symbol: str,
        interval: str,
        bar: BarData,
        event_type: DataEventType = DataEventType.BAR_UPDATED,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Manually push a bar event into the coordinator.

        This pushes directly to cache + event_bus, **bypassing**
        the BarAggregator. The aggregator output path now enters
        DataManager through AggregatorBridge.on_bar_event().

        For normal data flow, ingestion data goes through the
        BarAggregator first (see ``_start_stream``).

        Args:
            symbol:     Trading pair.
            interval:   K-line interval.
            bar:        The bar data.
            event_type: BAR_CREATED, BAR_UPDATED, or BAR_CLOSED.
        """
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)

        # Update cache
        if self._cache is not None:
            if event_type == DataEventType.BAR_CLOSED:
                self._cache.append(key, bar)
            else:
                self._cache.upsert(key, bar)

        # Update stream info
        entry = self._streams.get(key)
        if entry is not None:
            entry.info.bars_received += 1
            entry.info.last_bar_at_ms = int(time.time() * 1000)

        # Forward to event bus
        if self._bus is not None:
            await self._bus.emit(DataEvent(
                event_type=event_type,
                key=key,
                bar=bar,
            ))

    # ── Public: Shutdown ─────────────────────────────────────

    async def shutdown(self) -> None:
        """Gracefully shut down all streams and the reaper."""
        await self.stop_reaper()
        await self.stop_all()
        logger.info("StreamCoordinator shutdown complete")

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "active_streams": len(self._streams),
            "reaper_running": self._reaper_task is not None and not self._reaper_task.done(),
            "has_bar_aggregator": self._bar_aggregator is not None,
            "config": {
                "auto_start": self._cfg.auto_start_ingestion,
                "idle_timeout_s": self._cfg.idle_stream_timeout_seconds,
                "base_interval": self._cfg.base_interval,
            },
            "streams": [e.info.to_dict() for e in self._streams.values()],
        }

    # ── Internal: Stream Start ───────────────────────────────

    async def _start_stream(self, key: SeriesKey) -> StreamInfo:
        """Start a new ingestion pipeline for a series.

        Data flow when BarAggregator is set:
            Ingestion → on_raw_bar() → _build_market_event()
                      → BarAggregator.on_market_event()
                      → L1–L5 pipeline → Publisher
                      → AggregatorBridge.on_bar_event()
                      → Cache + EventBus

        Data flow without BarAggregator (fallback):
            Ingestion → on_raw_bar() → on_bar_event()
                      → Cache + EventBus (directly)
        """
        entry = _StreamEntry(key)
        entry.info.status = StreamStatus.STARTING
        entry.info.started_at_ms = int(time.time() * 1000)
        self._streams[key] = entry

        logger.info("Starting stream: %s", key)

        if self._ingestion_factory is not None:
            try:
                async def on_raw_bar(bar_dict: dict) -> None:
                    """Callback from ingestion: route through BarAggregator."""
                    if self._bar_aggregator is not None:
                        # Build a MarketEvent-like object and feed it to
                        # the BarAggregator's L1 Router.
                        market_event = _BarDictMarketEvent(
                            bar_dict, key.symbol, key.interval, key.exchange, key.market_type,
                        )
                        await self._bar_aggregator.on_market_event(market_event)
                    else:
                        # Fallback: direct to cache (legacy behavior)
                        bar = BarData.from_dict(bar_dict)
                        raw_type = bar_dict.get("event_type")
                        if raw_type == "bar.closed" or raw_type == "closed":
                            event_type = DataEventType.BAR_CLOSED
                        elif raw_type == "bar.created" or raw_type == "created":
                            event_type = DataEventType.BAR_CREATED
                        elif bar_dict.get("is_closed") or bar_dict.get("closed"):
                            event_type = DataEventType.BAR_CLOSED
                        elif bar_dict.get("is_new"):
                            event_type = DataEventType.BAR_CREATED
                        else:
                            event_type = DataEventType.BAR_UPDATED
                        await self.on_bar_event(
                            key.symbol,
                            key.interval,
                            bar,
                            event_type,
                            exchange=key.exchange,
                            market_type=key.market_type,
                        )

                async def on_gap(gap: Any) -> None:
                    if self._gap_handler is not None:
                        await self._gap_handler(key, gap)

                start_kwargs = {
                    "symbol": key.symbol,
                    "interval": key.interval,
                    "on_bar": on_raw_bar,
                    "exchange": key.exchange,
                    "market_type": key.market_type,
                }
                try:
                    start_signature = inspect.signature(self._ingestion_factory.start)
                    if "on_gap" in start_signature.parameters:
                        start_kwargs["on_gap"] = on_gap
                except (TypeError, ValueError):
                    logger.debug("Could not inspect ingestion factory start signature")

                handle = await self._ingestion_factory.start(**start_kwargs)
                entry.handle = handle
                entry.info.status = StreamStatus.ACTIVE

                # Emit event
                if self._bus:
                    await self._bus.emit(DataEvent(
                        event_type=DataEventType.STREAM_STARTED,
                        key=key,
                    ))

            except Exception as exc:
                entry.info.status = StreamStatus.ERROR
                entry.info.error = str(exc)
                logger.error("Failed to start stream %s: %s", key, exc, exc_info=True)

                if self._bus:
                    await self._bus.emit(DataEvent(
                        event_type=DataEventType.STREAM_ERROR,
                        key=key,
                        detail={"error": str(exc)},
                    ))
        else:
            # No ingestion factory — stream is "passive" (manual push only)
            entry.info.status = StreamStatus.ACTIVE
            logger.info("Stream %s started in passive mode (no ingestion factory)", key)

        return entry.info

    # ── Internal: Prewarm ────────────────────────────────────

    def _prewarm_series(self, key: SeriesKey, days: int) -> int:
        """Load historical bars for one series (runs in thread)."""
        if self._storage is None or self._cache is None:
            return 0

        now_ms = int(time.time() * 1000)
        start_ms = now_ms - days * 86400 * 1000

        rows = self._storage.query_bars(
            symbol=key.symbol,
            interval=key.interval,
            start_ms=start_ms,
            end_ms=now_ms,
            order="ASC",
            exchange=key.exchange,
            market_type=key.market_type,
        )
        if not rows:
            return 0

        bars = [BarData.from_storage_row(r) for r in rows]
        self._cache.bulk_load(key, bars)
        logger.debug("Prewarmed %s: %d bars (%d days)", key, len(bars), days)
        return len(bars)

    # ── Internal: Reaper Loop ────────────────────────────────

    async def _reaper_loop(self) -> None:
        """Background loop that periodically reaps idle streams."""
        interval = max(30, self._cfg.idle_stream_timeout_seconds // 2)
        try:
            while True:
                await asyncio.sleep(interval)
                reaped = await self.reap_idle()
                if reaped:
                    logger.info("Reaper cycle: stopped %d streams", len(reaped))
        except asyncio.CancelledError:
            pass


# ═══════════════════════════════════════════════════════════════
#  Helper: Lightweight MarketEvent-like wrapper for bar dicts
# ═══════════════════════════════════════════════════════════════


class _BarDictMarketEvent:
    """Lightweight wrapper that makes a raw bar dict look like a
    ``MarketEvent`` for the BarAggregator's L1 Router.

    The Router uses duck-typing (``getattr``) to extract fields,
    so we only need to provide the attributes it expects:
      - event_type  (with .value)
      - symbol
      - source      (with .value)
      - data        (dict with kline fields)
    """
    __slots__ = ("event_type", "symbol", "source", "data", "market_type", "stream_key", "exchange")

    def __init__(
        self,
        bar_dict: dict,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        self.event_type = _EnumLike("kline")
        self.symbol = symbol.upper()
        self.source = _EnumLike("websocket")
        self.exchange = exchange
        self.market_type = market_type
        base_stream = f"{self.symbol}@kline_{interval}"
        prefixes: list[str] = []
        if exchange != "binance":
            prefixes.append(exchange)
        if market_type != "spot":
            prefixes.append(market_type)
        self.stream_key = base_stream if not prefixes else f"{':'.join(prefixes)}:{base_stream}"
        self.data = {
            "interval": interval,
            "open_time": bar_dict.get("open_time", int(bar_dict.get("time", 0)) * 1000),
            "close_time": bar_dict.get("close_time", 0),
            "open": bar_dict.get("open", 0),
            "high": bar_dict.get("high", 0),
            "low": bar_dict.get("low", 0),
            "close": bar_dict.get("close", 0),
            "volume": bar_dict.get("volume", 0),
            "quote_volume": bar_dict.get("quote_volume", 0),
            "trades": bar_dict.get("trades", 0),
            "taker_buy_base": bar_dict.get("taker_buy_base", 0),
            "taker_buy_quote": bar_dict.get("taker_buy_quote", 0),
            "is_closed": bar_dict.get("is_closed", bar_dict.get("closed", False)),
        }


class _EnumLike:
    """Minimal enum-like object with a .value attribute."""
    __slots__ = ("value",)

    def __init__(self, value: str) -> None:
        self.value = value
