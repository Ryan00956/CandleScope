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

from app.data_engine.series_identity import (
    KlineSeriesIdentity,
    resolve_kline_series_identity,
)

import logging
import time
from typing import Any, Callable

from app.core import config
from app.data_engine.data_manager.models import BarData

from .base import Indicator
from .events import IndicatorEvent, IndicatorEventType
from .registry import registry
from .script_identity import object_source_hash
from .types import IndicatorKey, IndicatorResult

logger = logging.getLogger("candlescope.indicator.engine")

# Type alias for event listeners
EventListener = Callable[[IndicatorEvent], None]


class IndicatorCapacityError(RuntimeError):
    """Raised when a new target would exceed the process-wide hard limit."""

    def __init__(self, *, active: int, maximum: int) -> None:
        self.active = active
        self.maximum = maximum
        super().__init__(
            f"indicator target capacity reached: active={active}, maximum={maximum}"
        )


def indicator_code_hash(indicator_name: str) -> str:
    """Hash the implementation file for a registered builtin indicator."""
    cls = registry.get(indicator_name.upper().strip())
    if cls is None:
        return ""
    return object_source_hash(cls)


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

    def __init__(
        self,
        *,
        warm_ttl_seconds: float | None = None,
        warm_max_instances: int | None = None,
        max_active_targets: int | None = None,
    ) -> None:
        # Instance cache: IndicatorKey -> Indicator
        self._instances: dict[IndicatorKey, Indicator] = {}
        # Reference counting: IndicatorKey -> subscriber count
        self._refcounts: dict[IndicatorKey, int] = {}
        # Zero-ref instances stay warm for fast interval switches.  They are
        # detached from stream dispatch and catch up from subscribe seed bars.
        self._idle_since: dict[IndicatorKey, float] = {}
        self._first_committed: dict[IndicatorKey, int] = {}
        self._last_committed: dict[IndicatorKey, int] = {}
        # Cold subscriptions can be active before storage has returned any
        # bars.  Preserve the window the client asked us to seed so a later
        # backfill completion rebuilds the requested history instead of only
        # the indicator's small warmup tail.
        self._desired_seed_bars: dict[IndicatorKey, int] = {}
        self._warm_ttl_seconds = max(0.0, float(
            config.INDICATOR_ENGINE_WARM_TTL_SECONDS
            if warm_ttl_seconds is None else warm_ttl_seconds
        ))
        self._warm_max_instances = max(0, int(
            config.INDICATOR_ENGINE_WARM_MAX_INSTANCES
            if warm_max_instances is None else warm_max_instances
        ))
        self._max_active_targets = max(1, int(
            config.INDICATOR_APP_MAX_ACTIVE_TARGETS
            if max_active_targets is None else max_active_targets
        ))
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
        self._idle_since.clear()
        self._first_committed.clear()
        self._last_committed.clear()
        self._desired_seed_bars.clear()
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
        market_type: str,
        indicator_name: str,
        params: dict[str, Any],
        bars: list[BarData],
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
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
        key = IndicatorKey(
            symbol,
            interval,
            indicator_name,
            params,
            market_type=market_type,
            exchange=exchange,
            code_hash=indicator_code_hash(indicator_name),
            series_identity=series_identity,
        )

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
        market_type: str,
        indicator_name: str,
        params: dict[str, Any],
        bars: list[BarData] | None = None,
        exchange: str = "binance",
        data_revision: dict[str, Any] | None = None,
        desired_seed_bars: int | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> tuple[IndicatorKey, IndicatorResult | None]:
        """Subscribe to an indicator -- create/reuse instance + optional init.

        Returns:
            (key, result) -- result is None if bars not provided.
        """
        self._prune_idle_instances()
        key = IndicatorKey(
            symbol,
            interval,
            indicator_name,
            params,
            market_type=market_type,
            exchange=exchange,
            code_hash=indicator_code_hash(indicator_name),
            series_identity=series_identity,
        )
        instance = self._get_or_create(key)
        if instance is None:
            return key, None

        # Bump refcount
        self._refcounts[key] = self._refcounts.get(key, 0) + 1
        self._idle_since.pop(key, None)
        if desired_seed_bars is not None:
            self._desired_seed_bars[key] = max(
                self._desired_seed_bars.get(key, 0),
                max(0, int(desired_seed_bars)),
            )

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
                input_range = {
                    "start": min(int(bar.time) for bar in bars),
                    "end": max(int(bar.time) for bar in bars),
                }
                self._first_committed[key] = input_range["start"]
                self._last_committed[key] = input_range["end"]
                result = instance.build_result(key)
                self._emit(
                    IndicatorEventType.INSTANCE_INITIALIZED,
                    key,
                    full_result=result,
                    detail={
                        "range": dict(input_range),
                        "computedRange": dict(input_range),
                        **(
                            {"dataRevision": dict(data_revision)}
                            if isinstance(data_revision, dict)
                            else {}
                        ),
                    },
                )
            except Exception as exc:
                logger.error("Init failed for %s: %s", key.uid, exc, exc_info=True)

        elif bars and instance.is_initialized:
            try:
                last_committed = self._last_committed.get(key, 0)
                first_committed = self._first_committed.get(key)
                confirmed = sorted(
                    (bar for bar in bars if getattr(bar, "is_closed", True)),
                    key=lambda bar: int(bar.time),
                )
                confirmed_times = {int(bar.time) for bar in confirmed}
                confirmed_start = min(confirmed_times) if confirmed_times else 0
                confirmed_end = max(confirmed_times) if confirmed_times else 0
                extends_left = bool(
                    confirmed
                    and (
                        first_committed is None
                        or confirmed_start < first_committed
                    )
                )
                truncated_before_tail = bool(
                    last_committed
                    and confirmed
                    and confirmed_start > last_committed
                    and last_committed not in confirmed_times
                )
                if extends_left or truncated_before_tail:
                    # A warm instance only supports append-only catch-up.  If
                    # the seed adds older history (or no longer overlaps the
                    # right checkpoint), recompute so the full result really
                    # covers every bar we advertise to range-cache consumers.
                    instance.recompute(confirmed)
                    self._first_committed[key] = confirmed_start
                    self._last_committed[key] = confirmed_end
                else:
                    catch_up = [bar for bar in confirmed if int(bar.time) > last_committed]
                    for bar in catch_up:
                        instance.update_closed(bar)
                        self._last_committed[key] = int(bar.time)
                result = instance.build_result(key)
                supplied_range = {
                    "start": min(int(bar.time) for bar in bars),
                    "end": max(int(bar.time) for bar in bars),
                }
                computed_range = {
                    "start": self._first_committed.get(key, supplied_range["start"]),
                    "end": self._last_committed.get(key, supplied_range["end"]),
                }
                self._emit(
                    IndicatorEventType.INSTANCE_INITIALIZED,
                    key,
                    full_result=result,
                    detail={
                        "range": supplied_range,
                        "computedRange": computed_range,
                        **(
                            {"dataRevision": dict(data_revision)}
                            if isinstance(data_revision, dict)
                            else {}
                        ),
                    },
                )
            except Exception as exc:
                logger.error("Warm resume failed for %s: %s", key.uid, exc, exc_info=True)

        return key, result

    def unsubscribe(self, key: IndicatorKey) -> None:
        """Unsubscribe, keeping a bounded zero-ref instance warm when enabled."""
        if key not in self._refcounts:
            return

        self._refcounts[key] -= 1
        if self._refcounts[key] <= 0:
            self._refcounts[key] = 0
            self._detach_from_stream(key)
            if self._warm_ttl_seconds <= 0 or self._warm_max_instances <= 0:
                self._destroy_instance(key)
            else:
                self._idle_since[key] = time.monotonic()
                self._enforce_warm_budget()

    def _get_or_create(self, key: IndicatorKey) -> Indicator | None:
        """Get existing instance or create a new one."""
        if key in self._instances:
            return self._instances[key]

        cls = registry.get(key.indicator_name)
        if cls is None:
            return None

        # Idle instances are only a warm optimization.  Reclaim them before
        # rejecting new live work, then fail closed without disturbing any
        # active target already running at the boundary.
        self._prune_idle_instances()
        while len(self._instances) >= self._max_active_targets and self._idle_since:
            oldest = min(self._idle_since, key=self._idle_since.get)
            self._destroy_instance(oldest)
        if len(self._instances) >= self._max_active_targets:
            raise IndicatorCapacityError(
                active=len(self._instances),
                maximum=self._max_active_targets,
            )

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
        self._idle_since.pop(key, None)
        self._first_committed.pop(key, None)
        self._last_committed.pop(key, None)
        self._desired_seed_bars.pop(key, None)

        self._detach_from_stream(key)

        self._emit(IndicatorEventType.INSTANCE_DESTROYED, key)
        logger.debug("Destroyed instance: %s", key.uid)

    def _detach_from_stream(self, key: IndicatorKey) -> None:
        """Stop realtime dispatch for an idle/destroyed instance."""
        topic = key.series_topic
        if topic in self._stream_keys:
            self._stream_keys[topic].discard(key)
            if not self._stream_keys[topic]:
                del self._stream_keys[topic]

    def _prune_idle_instances(self, now: float | None = None) -> None:
        if not self._idle_since:
            return
        current = time.monotonic() if now is None else now
        expired = [
            key for key, idle_since in self._idle_since.items()
            if current - idle_since >= self._warm_ttl_seconds
        ]
        for key in expired:
            self._destroy_instance(key)

    def _enforce_warm_budget(self) -> None:
        overflow = len(self._idle_since) - self._warm_max_instances
        if overflow <= 0:
            return
        oldest = sorted(self._idle_since, key=self._idle_since.get)
        for key in oldest[:overflow]:
            self._destroy_instance(key)

    # =============================================================
    #  Bar Event Handlers (called by DataManager bridge)
    # =============================================================

    def on_bar_closed(
        self,
        symbol: str,
        interval: str,
        bar: BarData,
        market_type: str = "spot",
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> None:
        """Handle a confirmed bar close event.

        Updates all indicator instances subscribed to this (symbol, interval).
        """
        key_topic = IndicatorKey(
            symbol,
            interval,
            "__topic__",
            {},
            market_type=market_type,
            exchange=exchange,
            series_identity=series_identity,
        ).series_topic
        topic = key_topic
        self._prune_idle_instances()
        keys = self._stream_keys.get(topic, set())

        for key in keys:
            instance = self._instances.get(key)
            if instance is None or not instance.is_initialized:
                continue
            if int(bar.time) <= self._last_committed.get(key, 0):
                continue

            try:
                instance.update_closed(bar)
                self._last_committed[key] = int(bar.time)
                values = instance.get_latest()
                self._emit(
                    IndicatorEventType.INDICATOR_UPDATED, key,
                    values=values, bar_timestamp=bar.time,
                    detail={"bar": bar.to_dict()},
                )
            except Exception as exc:
                logger.error("update_closed failed for %s: %s", key.uid, exc, exc_info=True)
                self._emit(
                    IndicatorEventType.INDICATOR_ERROR, key,
                    detail={"error": str(exc)}, bar_timestamp=bar.time,
                )

    def on_bar_updated(
        self,
        symbol: str,
        interval: str,
        bar: BarData,
        market_type: str = "spot",
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> None:
        """Handle a partial bar update (tick, forming bar).

        Computes preview values without advancing indicator state.
        """
        key_topic = IndicatorKey(
            symbol,
            interval,
            "__topic__",
            {},
            market_type=market_type,
            exchange=exchange,
            series_identity=series_identity,
        ).series_topic
        topic = key_topic
        self._prune_idle_instances()
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
                    detail={"bar": bar.to_dict()},
                )
            except Exception as exc:
                logger.error("update_partial failed for %s: %s", key.uid, exc, exc_info=True)

    def preview_for_key(
        self,
        key: IndicatorKey,
        bar: BarData,
    ) -> dict[str, float | None] | None:
        """Compute a non-committing preview for one subscribed indicator.

        WebSocket subscribers seed indicators from confirmed bars only.  When
        the latest market bar is already forming at subscription time, this
        gives that subscriber a deterministic initial preview instead of
        waiting for the next exchange tick.  It deliberately does not emit an
        engine event: callers can preserve protocol ordering by acknowledging
        the subscription before they send the preview frame.
        """
        self._prune_idle_instances()
        instance = self._instances.get(key)
        if instance is None or not instance.is_initialized:
            return None
        try:
            instance.update_partial(bar)
            return instance.get_preview()
        except Exception as exc:
            logger.error("initial preview failed for %s: %s", key.uid, exc, exc_info=True)
            return None

    def plan_series_correction(
        self,
        symbol: str,
        interval: str,
        *,
        market_type: str = "spot",
        exchange: str = "binance",
        dirty_range: dict[str, int] | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> dict[str, Any]:
        """Describe the minimum safe work for a historical correction.

        Idle warm instances are invalid after a historical write and are
        evicted here, before the bridge performs any storage query.  Active
        instances retain their full computed bar span: rebuilding a rolling or
        recursive indicator from only its warmup tail would silently change its
        state and truncate the series exposed to subscribers.
        """
        topic = IndicatorKey(
            symbol,
            interval,
            "__topic__",
            {},
            market_type=market_type,
            exchange=exchange,
            series_identity=series_identity,
        ).series_topic
        self._prune_idle_instances()
        for key in [
            candidate
            for candidate in self._idle_since
            if candidate.series_topic == topic
        ]:
            self._destroy_instance(key)

        active_keys = [
            key
            for key in self._stream_keys.get(topic, set())
            if self._refcounts.get(key, 0) > 0
            and self._instances.get(key) is not None
        ]
        if not active_keys:
            return {
                "hasActive": False,
                "requiresRecompute": False,
                "requiredTargetBars": 0,
            }

        requires_recompute = dirty_range is None
        required_target_bars = 1
        dirty_start = int((dirty_range or {}).get("start", 0))
        dirty_end = int((dirty_range or {}).get("end", dirty_start))
        for key in active_keys:
            instance = self._instances[key]
            required_target_bars = max(
                required_target_bars,
                int(instance.bar_count or 0),
                int(getattr(instance, "warmup_period", 0) or 0),
                int(self._desired_seed_bars.get(key, 0) or 0),
            )
            first = self._first_committed.get(key)
            last = self._last_committed.get(key)
            if first is None or last is None:
                requires_recompute = True
                continue
            # Only a correction wholly before this instance's seed is safe to
            # skip.  Writes inside the span or after its tail require refresh
            # so newly completed bars are caught up.
            if dirty_end >= int(first):
                requires_recompute = True

        return {
            "hasActive": True,
            "requiresRecompute": requires_recompute,
            "requiredTargetBars": required_target_bars,
        }

    def active_series_intervals(
        self,
        symbol: str,
        *,
        market_type: str = "spot",
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> tuple[str, ...]:
        """Return intervals with live builtin subscribers for one market.

        Historical source-bar amendments do not always carry derived repair
        metadata (for example after an aggregator restart).  The data bridge
        uses this bounded active set to route only corrections that can affect
        an actually subscribed derived indicator series.
        """
        self._prune_idle_instances()
        normalized_symbol = str(symbol).upper().strip()
        normalized_market = str(market_type).lower().strip()
        normalized_exchange = str(exchange).lower().strip()
        return tuple(
            sorted(
                {
                    key.interval
                    for keys in self._stream_keys.values()
                    for key in keys
                    if self._refcounts.get(key, 0) > 0
                    and key.symbol == normalized_symbol
                    and key.market_type == normalized_market
                    and key.exchange == normalized_exchange
                    and key.identity
                    == resolve_kline_series_identity(exchange, series_identity)
                }
            )
        )

    def resident_series_intervals(
        self,
        symbol: str,
        *,
        market_type: str = "spot",
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> tuple[str, ...]:
        """Return active plus bounded warm intervals for one market."""
        self._prune_idle_instances()
        normalized_symbol = str(symbol).upper().strip()
        normalized_market = str(market_type).lower().strip()
        normalized_exchange = str(exchange).lower().strip()
        return tuple(
            sorted(
                {
                    key.interval
                    for key in self._instances
                    if (self._refcounts.get(key, 0) > 0 or key in self._idle_since)
                    and key.symbol == normalized_symbol
                    and key.market_type == normalized_market
                    and key.exchange == normalized_exchange
                    and key.identity
                    == resolve_kline_series_identity(exchange, series_identity)
                }
            )
        )

    def on_series_correction_invalidated(
        self,
        symbol: str,
        interval: str,
        *,
        market_type: str = "spot",
        exchange: str = "binance",
        dirty_range: dict[str, int],
        data_revision: dict[str, Any] | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> None:
        """Notify active subscribers when corrected history is out of span."""
        topic = IndicatorKey(
            symbol,
            interval,
            "__topic__",
            {},
            market_type=market_type,
            exchange=exchange,
            series_identity=series_identity,
        ).series_topic
        self._prune_idle_instances()
        for key in list(self._stream_keys.get(topic, set())):
            if self._refcounts.get(key, 0) <= 0:
                continue
            detail: dict[str, Any] = {
                "range": dict(dirty_range),
                "dirtyRange": dict(dirty_range),
                "recomputed": False,
            }
            if isinstance(data_revision, dict):
                detail["dataRevision"] = dict(data_revision)
            self._emit(
                IndicatorEventType.INDICATOR_RECOMPUTED,
                key,
                detail=detail,
            )

    def on_bars_backfilled(
        self,
        symbol: str,
        interval: str,
        bars: list[BarData],
        market_type: str = "spot",
        exchange: str = "binance",
        dirty_range: dict[str, int] | None = None,
        data_revision: dict[str, Any] | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> None:
        """Handle historical bars being inserted (backfill/correction).

        Triggers a full recomputation for affected instances.
        """
        key_topic = IndicatorKey(
            symbol,
            interval,
            "__topic__",
            {},
            market_type=market_type,
            exchange=exchange,
            series_identity=series_identity,
        ).series_topic
        topic = key_topic
        self._prune_idle_instances()
        confirmed_bars = sorted(
            (
                bar
                for bar in bars
                if getattr(bar, "is_closed", True)
            ),
            key=lambda bar: int(bar.time),
        )
        # An idle instance is detached from realtime dispatch.  Its rolling
        # state cannot be repaired safely by append-only catch-up after a
        # historical correction, so evict it and force a clean seed on resume.
        idle_for_series = [
            key for key in self._idle_since
            if key.series_topic == topic
        ]
        for key in idle_for_series:
            self._destroy_instance(key)
        if not confirmed_bars:
            return
        keys = self._stream_keys.get(topic, set())

        for key in keys:
            instance = self._instances.get(key)
            if instance is None:
                continue

            try:
                instance.recompute(confirmed_bars)
                self._first_committed[key] = int(confirmed_bars[0].time)
                self._last_committed[key] = int(confirmed_bars[-1].time)
                result = instance.build_result(key)
                computed_range = {
                    "start": int(confirmed_bars[0].time),
                    "end": int(confirmed_bars[-1].time),
                }
                detail = {
                    "range": dict(dirty_range or computed_range),
                    "computedRange": computed_range,
                }
                if dirty_range is not None:
                    detail["dirtyRange"] = dict(dirty_range)
                if data_revision is not None:
                    detail["dataRevision"] = dict(data_revision)
                self._emit(
                    IndicatorEventType.INDICATOR_RECOMPUTED, key,
                    full_result=result,
                    detail=detail,
                )
                logger.info(
                    "Recomputed %s after backfill (%d bars)",
                    key.uid,
                    len(confirmed_bars),
                )
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
        self._prune_idle_instances()
        return self._instances.get(key)

    def get_result(self, key: IndicatorKey) -> IndicatorResult | None:
        """Get the current result for an indicator instance."""
        self._prune_idle_instances()
        instance = self._instances.get(key)
        if instance is None:
            return None
        return instance.build_result(key)

    def list_instances(self, symbol: str | None = None, interval: str | None = None) -> list[IndicatorKey]:
        """List active indicator instance keys, optionally filtered."""
        self._prune_idle_instances()
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
        self._prune_idle_instances()
        return {
            "started": self._started,
            "instance_count": len(self._instances),
            "stream_count": len(self._stream_keys),
            "listener_count": len(self._listeners),
            "warm_idle_count": len(self._idle_since),
            "warm_ttl_seconds": self._warm_ttl_seconds,
            "warm_max_instances": self._warm_max_instances,
            "max_active_targets": self._max_active_targets,
            "instances": [
                {
                    "key": key.uid,
                    "indicator": key.indicator_name,
                    "exchange": key.exchange,
                    "symbol": key.symbol,
                    "interval": key.interval,
                    "params": dict(key.params),
                    "code_hash": key.code_hash,
                    "initialized": inst.is_initialized,
                    "bar_count": inst.bar_count,
                    "refcount": self._refcounts.get(key, 0),
                    "idle": key in self._idle_since,
                    "first_committed": self._first_committed.get(key),
                    "last_committed": self._last_committed.get(key),
                }
                for key, inst in self._instances.items()
            ],
        }
