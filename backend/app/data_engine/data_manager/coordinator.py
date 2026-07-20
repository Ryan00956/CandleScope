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

    Ingestion → on_market_event() → BarAggregator.on_market_event()
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
from app.data_engine.interval_policy import parse_interval_spec
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolver,
    IntervalRouteKind,
)

from ..ingestion.models import GapMarker, MarketEvent
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
        on_market_event: Callable[[MarketEvent], Awaitable[None]],
        exchange: str = "binance",
        market_type: str = "spot",
        on_gap: Callable[[GapMarker], Awaitable[None]] | None = None,
    ) -> Any:
        """Start an ingestion stream.

        Args:
            symbol:      Trading pair.
            interval:    Base interval (e.g. "1m").
            on_market_event: Callback for each normalized MarketEvent.
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
        # Shared startup task.  Concurrent ensure_stream() callers for the
        # same key await this task instead of observing a transient STARTING
        # status as if startup had completed.
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
        interval_resolver: IntervalResolver | None = None,
    ) -> None:
        self._cfg = config or CoordinatorConfig()
        self._cache = cache
        self._bus = event_bus
        self._interval_resolver = interval_resolver or IntervalResolver()

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
        route = self._interval_resolver.resolve(
            exchange=exchange,
            market_type=self._normalize_market_type(market_type),
            interval=interval,
            purpose=IntervalPurpose.REALTIME,
        )
        key = SeriesKey(
            symbol,
            route.canonical_interval,
            exchange=route.exchange,
            market_type=route.market_type,
        )

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
                if entry.info.status is StreamStatus.STARTING:
                    return await self._wait_for_stream_start(entry)
                return entry.info

        # Auto-start if configured
        if not self._cfg.auto_start_ingestion:
            return StreamInfo(key=key, status=StreamStatus.STOPPED)

        # ── Derived interval: reuse its exchange-resolved native base ────
        if route.kind is IntervalRouteKind.DERIVED:
            base_spec = parse_interval_spec(route.base_interval or "")
            if base_spec is None:  # guarded by resolver
                raise ValueError(f"invalid resolved realtime base: {route.base_interval!r}")
            entry = _StreamEntry(key)
            entry.info.status = StreamStatus.STARTING
            entry.info.started_at_ms = int(time.time() * 1000)
            self._streams[key] = entry
            entry.task = asyncio.create_task(
                self._start_derived_stream(
                    entry,
                    base_interval=base_spec.canonical,
                )
            )
            return await self._wait_for_stream_start(entry)

        return await self._start_stream(
            key,
            protocol_interval=route.native_interval or key.interval,
        )

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

        # Quiesce startup before inspecting the handle.  Otherwise a startup
        # can publish its handle after the first ``None`` check, leaving a
        # physically running ingestion stream behind an already-popped entry.
        current_task = asyncio.current_task()
        if (
            entry.task is not None
            and entry.task is not current_task
            and not entry.task.done()
        ):
            entry.task.cancel()
            try:
                await entry.task
            except asyncio.CancelledError:
                pass

        # Stop any handle that startup published before it completed or while
        # it was responding to cancellation.
        if entry.handle is not None:
            try:
                await entry.handle.stop()
            except Exception as exc:
                logger.error("Error stopping ingestion for %s: %s", key, exc)

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
                sub_count = self._bus.get_direct_subscriber_count(key)

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
        bar = bar.with_closed_state(
            event_type in (DataEventType.BAR_CLOSED, DataEventType.BAR_AMENDED),
        )

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

    def health_snapshot(self) -> dict[str, Any]:
        """Return constant-size liveness state without serializing streams."""
        return {
            "active_streams": len(self._streams),
            "reaper_running": self._reaper_task is not None and not self._reaper_task.done(),
        }

    # ── Internal: Stream Start ───────────────────────────────

    @staticmethod
    async def _wait_for_stream_start(entry: _StreamEntry) -> StreamInfo:
        """Wait for a shared startup attempt to reach its terminal status."""
        task = entry.task
        if task is None:
            entry.info.status = StreamStatus.ERROR
            entry.info.error = "stream startup task is missing"
            return entry.info
        # A caller cancelling its own ensure must not cancel the shared start
        # that other concurrent callers are also awaiting.
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            current_task = asyncio.current_task()
            if current_task is not None and current_task.cancelling():
                raise
            # stop_stream() canceled the shared startup task.  It has already
            # moved the entry out of STARTING, so return that fail-closed
            # lifecycle state to the waiter.
        return entry.info

    async def _start_derived_stream(
        self,
        entry: _StreamEntry,
        *,
        base_interval: str,
    ) -> None:
        """Start one passive derived stream after its native base is live."""
        key = entry.key
        try:
            base_info = await self.ensure_stream(
                key.symbol,
                base_interval,
                exchange=key.exchange,
                market_type=key.market_type,
            )
            base_key = base_info.key

            # A derived stream has no ingestion handle of its own.  Its
            # liveness is therefore exactly bounded by the resolved base
            # stream.  Do not publish a synthetic ACTIVE entry when the base
            # failed (or ingestion is disabled), otherwise callers can ACK a
            # stream that can never produce bars.
            if base_info.status is not StreamStatus.ACTIVE:
                entry.info.status = StreamStatus.ERROR
                entry.info.error = (
                    f"base stream {base_key} is {base_info.status.value}"
                    + (f": {base_info.error}" if base_info.error else "")
                )
                return

            entry.info.status = StreamStatus.ACTIVE
            logger.info(
                "Derived interval %s: aggregating from base stream %s",
                key, base_key,
            )

            if self._bus:
                await self._bus.emit(DataEvent(
                    event_type=DataEventType.STREAM_STARTED,
                    key=key,
                ))
        except asyncio.CancelledError:
            if entry.info.status is StreamStatus.STOPPING:
                raise
            entry.info.status = StreamStatus.ERROR
            entry.info.error = "derived stream startup was cancelled"
        except Exception as exc:
            entry.info.status = StreamStatus.ERROR
            entry.info.error = str(exc)
            logger.error(
                "Failed to start derived stream %s: %s",
                key,
                exc,
                exc_info=True,
            )
        finally:
            # A failed passive entry has no physical handle and must not remain
            # discoverable as a stream.  Waiters already hold ``entry`` and
            # still receive this exact ERROR info after the shared task ends.
            # The identity guard avoids deleting a newer retry entry.
            if (
                entry.info.status is StreamStatus.ERROR
                and self._streams.get(key) is entry
            ):
                self._streams.pop(key, None)

    async def _start_stream(
        self,
        key: SeriesKey,
        *,
        protocol_interval: str | None = None,
    ) -> StreamInfo:
        """Start a new ingestion pipeline for a series.

        Data flow:
            Ingestion → on_market_event()
                      → BarAggregator.on_market_event()
                      → L1-L5 pipeline → Publisher
                      → AggregatorBridge.on_bar_event()
                      → Cache + EventBus
        """
        entry = _StreamEntry(key)
        entry.info.status = StreamStatus.STARTING
        entry.info.started_at_ms = int(time.time() * 1000)
        self._streams[key] = entry
        entry.task = asyncio.create_task(
            self._run_stream_start(entry, protocol_interval=protocol_interval)
        )
        return await self._wait_for_stream_start(entry)

    async def _run_stream_start(
        self,
        entry: _StreamEntry,
        *,
        protocol_interval: str | None = None,
    ) -> None:
        """Run one physical startup attempt shared by all same-key callers."""
        key = entry.key

        logger.info("Starting stream: %s", key)

        if self._ingestion_factory is not None:
            try:
                if self._bar_aggregator is None:
                    raise RuntimeError(
                        "StreamCoordinator requires a BarAggregator for realtime kline streams"
                    )

                async def on_market_event(market_event: MarketEvent) -> None:
                    """Callback from ingestion: route L6 events into K-line semantics.

                    Realtime MarketEvents do not mutate DataManager cache directly.
                    BarAggregator emits BarEvents, then AggregatorBridge converts
                    those into cache/storage/EventBus updates.
                    """
                    await self._bar_aggregator.on_market_event(market_event)

                async def on_gap(gap: GapMarker) -> None:
                    if self._gap_handler is not None:
                        await self._gap_handler(key, gap)

                start_kwargs = {
                    "symbol": key.symbol,
                    "interval": protocol_interval or key.interval,
                    "on_market_event": on_market_event,
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
                if entry.info.status is StreamStatus.STOPPING:
                    # A cancellation-resistant factory may still return a
                    # handle after stop_stream() removed this entry. Publish
                    # the handle for stop_stream() to close, but never revive
                    # the detached stream or emit STREAM_STARTED.
                    return
                entry.info.status = StreamStatus.ACTIVE

                # Emit event
                if self._bus:
                    await self._bus.emit(DataEvent(
                        event_type=DataEventType.STREAM_STARTED,
                        key=key,
                    ))

            except asyncio.CancelledError:
                if entry.info.status is StreamStatus.STOPPING:
                    raise
                entry.info.status = StreamStatus.ERROR
                entry.info.error = "stream startup was cancelled"
                logger.error("Stream startup was cancelled: %s", key)
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

        bars = [
            BarData.from_storage_row(
                row,
                exchange=key.exchange,
                market_type=key.market_type,
            )
            for row in rows
        ]
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
