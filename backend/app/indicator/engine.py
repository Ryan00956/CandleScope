"""
Indicator Engine -- scheduling and lifecycle core.

The engine is the central coordinator that:
  1. Creates / caches / destroys indicator instances
  2. Feeds bar events to the correct instances
  3. Collects results and dispatches them to subscribers

It does NOT own data -- it receives standardized bar events from
the DataManager and delegates computation to Indicator instances.

Usage::

    from app.indicator.engine import IndicatorEngine
    engine = IndicatorEngine()

    # Compute an indicator over historical bars
    result = engine.compute("BTCUSDT", "1m", "MA", {"period": 20, "source": "close"}, bars)

    # Incremental updates
    engine.on_bar_closed("BTCUSDT", "1m", bar)
    engine.on_bar_updated("BTCUSDT", "1m", bar)
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable

from app.data_engine.data_manager.models import BarData

from .base import Indicator
from .events import IndicatorEvent, IndicatorEventType
from .registry import registry
from .types import IndicatorKey, IndicatorResult

logger = logging.getLogger("candlescope.indicator.engine")

# Type alias for event listeners
EventListener = Callable[[IndicatorEvent], None]


class IndicatorEngine:
    """Indicator computation engine with instance caching.

    Key design decisions:
      * **Instance caching**: same (symbol, interval, indicator, params) ->
        same instance.  Multiple subscribers share one computation.
      * **Two-phase updates**: ``on_bar_updated`` (partial/preview) and
        ``on_bar_closed`` (committed) are separate paths.
      * **Event dispatching**: listeners receive ``IndicatorEvent`` objects
        for real-time push to frontends.
    """

    def __init__(self) -> None:
        # Instance cache: IndicatorKey -> Indicator
        self._instances: dict[IndicatorKey, Indicator] = {}
        # Reference counting: IndicatorKey -> subscriber count
        self._refcounts: dict[IndicatorKey, int] = {}
        # Event listeners
        self._listeners: list[EventListener] = []
        # Track which (symbol, interval) streams have active instances
        self._stream_keys: dict[str, set[IndicatorKey]] = {}
        self._started = False

    # =============================================================
    #  Lifecycle
    # =============================================================

    def start(self) -> None:
        """Start the indicator engine."""
        self._started = True
        logger.info("IndicatorEngine started")

    def stop(self) -> None:
        """Stop the engine and destroy all instances."""
        self._instances.clear()
        self._refcounts.clear()
        self._stream_keys.clear()
        self._started = False
        logger.info("IndicatorEngine stopped -- all instances destroyed")

    # =============================================================
    #  Core: compute (one-shot, stateless-friendly)
    # =============================================================

    def compute(
        self,
        symbol: str,
        interval: str,
        indicator_name: str,
        params: dict[str, Any],
        bars: list[BarData],
    ) -> IndicatorResult | None:
        """Compute an indicator over a set of bars.

        This is the primary entry point for HTTP API requests.
        It creates or reuses a cached instance, feeds it the bars,
        and returns the complete result.

        Args:
            symbol:         Trading pair, e.g. "BTCUSDT"
            interval:       Timeframe, e.g. "1m", "5m"
            indicator_name: Registered indicator name, e.g. "MA"
            params:         Indicator parameters, e.g. {"period": 20}
            bars:           Historical bars sorted ascending by time.

        Returns:
            IndicatorResult on success, None if indicator not found.
        """
        key = IndicatorKey(symbol, interval, indicator_name, params)

        # Get or create instance
        instance = self._get_or_create(key)
        if instance is None:
            logger.warning("Unknown indicator: %s", indicator_name)
            return None

        # Initialize (or recompute if already initialized with different data)
        try:
            instance.recompute(bars)
        except Exception as exc:
            logger.error("Indicator %s computation failed: %s", key.uid, exc, exc_info=True)
            from .types import IndicatorMeta
            return IndicatorResult(
                key=key,
                meta=instance.get_meta(),
                error=str(exc),
            )

        return instance.build_result(key)

    # =============================================================
    #  Instance Management
    # =============================================================

    def subscribe(
        self,
        symbol: str,
        interval: str,
        indicator_name: str,
        params: dict[str, Any],
        bars: list[BarData] | None = None,
    ) -> tuple[IndicatorKey, IndicatorResult | None]:
        """Subscribe to an indicator -- create/reuse instance + optional init.

        Returns:
            (key, result) -- result is None if bars not provided.
        """
        key = IndicatorKey(symbol, interval, indicator_name, params)
        instance = self._get_or_create(key)
        if instance is None:
            return key, None

        # Bump refcount
        self._refcounts[key] = self._refcounts.get(key, 0) + 1

        # Track stream
        topic = key.series_topic
        if topic not in self._stream_keys:
            self._stream_keys[topic] = set()
        self._stream_keys[topic].add(key)

        # Initialize if bars provided and not yet initialized
        result = None
        if bars and not instance.is_initialized:
            try:
                instance.init(bars)
                result = instance.build_result(key)
                self._emit(IndicatorEventType.INSTANCE_INITIALIZED, key, full_result=result)
            except Exception as exc:
                logger.error("Init failed for %s: %s", key.uid, exc, exc_info=True)

        elif bars and instance.is_initialized:
            result = instance.build_result(key)

        return key, result

    def unsubscribe(self, key: IndicatorKey) -> None:
        """Unsubscribe from an indicator.  Destroys instance when refcount hits 0."""
        if key not in self._refcounts:
            return

        self._refcounts[key] -= 1
        if self._refcounts[key] <= 0:
            self._destroy_instance(key)

    def _get_or_create(self, key: IndicatorKey) -> Indicator | None:
        """Get existing instance or create a new one."""
        if key in self._instances:
            return self._instances[key]

        cls = registry.get(key.indicator_name)
        if cls is None:
            return None

        instance = cls(params=dict(key.params))
        self._instances[key] = instance
        self._refcounts.setdefault(key, 0)

        self._emit(IndicatorEventType.INSTANCE_CREATED, key)
        logger.debug("Created instance: %s", key.uid)

        return instance

    def _destroy_instance(self, key: IndicatorKey) -> None:
        """Destroy an indicator instance and clean up."""
        self._instances.pop(key, None)
        self._refcounts.pop(key, None)

        topic = key.series_topic
        if topic in self._stream_keys:
            self._stream_keys[topic].discard(key)
            if not self._stream_keys[topic]:
                del self._stream_keys[topic]

        self._emit(IndicatorEventType.INSTANCE_DESTROYED, key)
        logger.debug("Destroyed instance: %s", key.uid)

    # =============================================================
    #  Bar Event Handlers (called by DataManager bridge)
    # =============================================================

    def on_bar_closed(self, symbol: str, interval: str, bar: BarData) -> None:
        """Handle a confirmed bar close event.

        Updates all indicator instances subscribed to this (symbol, interval).
        """
        topic = f"{symbol.upper()}@{interval}"
        keys = self._stream_keys.get(topic, set())

        for key in keys:
            instance = self._instances.get(key)
            if instance is None or not instance.is_initialized:
                continue

            try:
                instance.update_closed(bar)
                values = instance.get_latest()
                self._emit(
                    IndicatorEventType.INDICATOR_UPDATED, key,
                    values=values, bar_timestamp=bar.time,
                )
            except Exception as exc:
                logger.error("update_closed failed for %s: %s", key.uid, exc, exc_info=True)
                self._emit(
                    IndicatorEventType.INDICATOR_ERROR, key,
                    detail={"error": str(exc)}, bar_timestamp=bar.time,
                )

    def on_bar_updated(self, symbol: str, interval: str, bar: BarData) -> None:
        """Handle a partial bar update (tick, forming bar).

        Computes preview values without advancing indicator state.
        """
        topic = f"{symbol.upper()}@{interval}"
        keys = self._stream_keys.get(topic, set())

        for key in keys:
            instance = self._instances.get(key)
            if instance is None or not instance.is_initialized:
                continue

            try:
                instance.update_partial(bar)
                values = instance.get_preview()
                self._emit(
                    IndicatorEventType.INDICATOR_PREVIEW, key,
                    values=values, bar_timestamp=bar.time,
                )
            except Exception as exc:
                logger.error("update_partial failed for %s: %s", key.uid, exc, exc_info=True)

    def on_bars_backfilled(self, symbol: str, interval: str, bars: list[BarData]) -> None:
        """Handle historical bars being inserted (backfill/correction).

        Triggers a full recomputation for affected instances.
        """
        topic = f"{symbol.upper()}@{interval}"
        keys = self._stream_keys.get(topic, set())

        for key in keys:
            instance = self._instances.get(key)
            if instance is None:
                continue

            try:
                instance.recompute(bars)
                result = instance.build_result(key)
                self._emit(
                    IndicatorEventType.INDICATOR_RECOMPUTED, key,
                    full_result=result,
                )
                logger.info("Recomputed %s after backfill (%d bars)", key.uid, len(bars))
            except Exception as exc:
                logger.error("Recompute failed for %s: %s", key.uid, exc, exc_info=True)

    # =============================================================
    #  Event Dispatching
    # =============================================================

    def add_listener(self, listener: EventListener) -> None:
        """Register an event listener."""
        self._listeners.append(listener)

    def remove_listener(self, listener: EventListener) -> None:
        """Remove an event listener."""
        try:
            self._listeners.remove(listener)
        except ValueError:
            pass

    def _emit(
        self,
        event_type: IndicatorEventType,
        key: IndicatorKey,
        values: dict[str, float | None] | None = None,
        full_result: IndicatorResult | None = None,
        detail: dict | None = None,
        bar_timestamp: int = 0,
    ) -> None:
        """Create and dispatch an indicator event."""
        event = IndicatorEvent(
            event_type=event_type,
            key=key,
            values=values or {},
            full_result=full_result,
            detail=detail or {},
            bar_timestamp=bar_timestamp,
        )
        for listener in self._listeners:
            try:
                listener(event)
            except Exception as exc:
                logger.error("Event listener error: %s", exc, exc_info=True)

    # =============================================================
    #  Query
    # =============================================================

    def get_instance(self, key: IndicatorKey) -> Indicator | None:
        """Get an indicator instance by key."""
        return self._instances.get(key)

    def get_result(self, key: IndicatorKey) -> IndicatorResult | None:
        """Get the current result for an indicator instance."""
        instance = self._instances.get(key)
        if instance is None:
            return None
        return instance.build_result(key)

    def list_instances(self, symbol: str | None = None, interval: str | None = None) -> list[IndicatorKey]:
        """List active indicator instance keys, optionally filtered."""
        keys = list(self._instances.keys())
        if symbol:
            keys = [k for k in keys if k.symbol == symbol.upper()]
        if interval:
            keys = [k for k in keys if k.interval == interval]
        return keys

    def destroy_all(self, symbol: str | None = None, interval: str | None = None) -> int:
        """Destroy instances, optionally filtered.  Returns count destroyed."""
        keys = self.list_instances(symbol, interval)
        for key in keys:
            self._destroy_instance(key)
        return len(keys)

    # =============================================================
    #  Diagnostics
    # =============================================================

    def snapshot(self) -> dict:
        """Return a diagnostic snapshot of the engine state."""
        return {
            "started": self._started,
            "instance_count": len(self._instances),
            "stream_count": len(self._stream_keys),
            "listener_count": len(self._listeners),
            "instances": [
                {
                    "key": key.uid,
                    "indicator": key.indicator_name,
                    "symbol": key.symbol,
                    "interval": key.interval,
                    "params": dict(key.params),
                    "initialized": inst.is_initialized,
                    "bar_count": inst.bar_count,
                    "refcount": self._refcounts.get(key, 0),
                }
                for key, inst in self._instances.items()
            ],
        }
