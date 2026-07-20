"""
L4: Finalizer — determines when a bar should be closed (sealed).

Responsibilities:
  * Evaluate whether an active bar should transition from FORMING → CLOSED
  * Support multiple built-in finalization strategies:
      - SourceCloseFinalizer:    close when exchange sends is_closed=True (x=true)
      - CompositeCloseFinalizer: close when last component bar is closed (custom intervals)
      - EventDrivenFinalizer:    close previous bucket when next bucket's first event arrives
      - TimeBasedFinalizer:      close after bucket_end_ms + timeout (safety fallback)
      - BatchFinalizer:          close all bars immediately (backfill scenario)
  * Allow user-registered custom ``FinalizerStrategy`` implementations
  * Strategies are evaluated in priority order; first match wins

Strategy chain for **standard intervals** (e.g. 1m, 5m, 1h)::

    SourceCloseFinalizer  →  EventDrivenFinalizer  →  TimeBasedFinalizer
    (x=true from WS)         (next bucket arrived)     (timeout fallback)

Strategy chain for **custom intervals** (e.g. 91m, 7h)::

    CompositeCloseFinalizer  →  EventDrivenFinalizer  →  TimeBasedFinalizer
    (last component closed)      (next bucket arrived)     (timeout fallback)

Strategy chain for **backfill**::

    BatchFinalizer
    (all bars closed immediately)

Usage::

    finalizer = Finalizer(config, time_bucket)
    bar_event = finalizer.check(bar_state, trigger)
    if bar_event:
        # bar should be closed
        publisher.emit(bar_event)
"""
from __future__ import annotations

import logging
import time

from .config import BarAggregatorConfig
from .models import (
    BarState,
    BarStatus,
    BarEvent,
    BarEventType,
    BarFinality,
    BarStateChange,
    BarInput,
    BarInputSource,
    FinalizeTrigger,
    FinalizerStrategy,
    is_standard_interval,
)
from .time_bucket import TimeBucketEngine

logger = logging.getLogger("bar_aggregator.L4_Finalizer")


# ═══════════════════════════════════════════════════════════════
#  Built-in Finalization Strategies
# ═══════════════════════════════════════════════════════════════


class SourceCloseFinalizer:
    """Close a bar when the exchange signals is_closed=True (Binance ``x=true``).

    This is the **primary** strategy for standard intervals.  When the
    exchange WS pushes a kline event with ``x=true``, the bar's
    ``last_close_received`` flag is set to True by the BarStateEngine,
    and this strategy fires.

    Only effective for standard intervals where the exchange natively
    supports the interval and sends close signals.
    """

    def should_close(self, state: BarState, trigger: FinalizeTrigger) -> bool:
        # Only trigger on input events (not timers)
        if trigger.trigger_type != "input":
            return False
        # The BarStateEngine sets last_close_received when is_closed=True
        return state.last_close_received


class CompositeCloseFinalizer:
    """Close a custom-interval bar when its LAST component source bar is closed.

    For a 91m custom bar built from 1m source bars:
    - The 91m bucket spans [T, T+91m)
    - The last 1m component is [T+90m, T+91m)
    - When that last 1m bar's is_closed=True arrives, close the 91m bar

    This requires the TimeBucketEngine to determine whether the input
    is the last component of the bucket.
    """

    def __init__(self, time_bucket: TimeBucketEngine) -> None:
        self._time_bucket = time_bucket

    def should_close(self, state: BarState, trigger: FinalizeTrigger) -> bool:
        if trigger.trigger_type != "input":
            return False

        bar_input = trigger.input
        if bar_input is None or not bar_input.is_closed:
            return False

        # Check if this input is the last component of the bucket
        return self._time_bucket.is_last_component(
            input_open_time_ms=bar_input.open_time_ms,
            input_close_time_ms=bar_input.close_time_ms,
            bucket_start_ms=state.bucket_start_ms,
        )


class EventDrivenFinalizer:
    """Close the previous bar when the first event for a NEW bucket arrives.

    Logic: if we receive data for bucket N+1, then bucket N must be done.
    This is a reliable fallback when WS close signals are missed.
    """

    def should_close(self, state: BarState, trigger: FinalizeTrigger) -> bool:
        if trigger.trigger_type != "next_bucket":
            return False
        if state.requires_authoritative_close and not state.last_close_received:
            return False
        # The trigger carries the next bucket's start time
        if trigger.next_bucket_start is not None:
            return trigger.next_bucket_start > state.bucket_start_ms
        return False


class TimeBasedFinalizer:
    """Close a bar when current time exceeds bucket_end_ms + timeout.

    This is the **safety fallback** that catches all edge cases:
    - WS close signal was lost
    - No new data arrived for the next bucket
    - Network issues delayed data delivery

    The timeout is configurable via ``BarAggregatorConfig.finalize_timeout_ms``.
    """

    def __init__(self, timeout_ms: int = 5_000) -> None:
        self._timeout_ms = timeout_ms

    def should_close(self, state: BarState, trigger: FinalizeTrigger) -> bool:
        if state.requires_authoritative_close and not state.last_close_received:
            return False
        # Works with both "timer" and "input" triggers
        now_ms = trigger.current_time_ms
        deadline = state.bucket_end_ms + self._timeout_ms
        return now_ms >= deadline


class BatchFinalizer:
    """Close backfill bars when their data is complete.

    For **standard intervals** (e.g. 1m, 5m), each backfill bar maps
    1-to-1 with a bucket, so the bar can be sealed immediately.

    For **custom intervals** (e.g. 91m), a single bucket is built from
    many component source bars.  In this case we must wait until the
    *last* component bar arrives (i.e. ``is_closed=True`` on the final
    component) before sealing.  Closing prematurely would produce
    incomplete OHLCV data.

    When ``time_bucket`` is provided the strategy delegates to
    ``TimeBucketEngine.is_last_component()``; otherwise it falls back
    to the simple "close immediately" behaviour.
    """

    def __init__(self, time_bucket: TimeBucketEngine | None = None) -> None:
        self._time_bucket = time_bucket

    def should_close(self, state: BarState, trigger: FinalizeTrigger) -> bool:
        if not trigger.is_backfill:
            return False

        bar_input = trigger.input

        # No time-bucket engine → simple mode (standard intervals):
        # close immediately because each backfill bar *is* the bucket.
        if self._time_bucket is None:
            return True

        # Custom interval: only close when the *last* component bar
        # of the bucket has been received with is_closed=True.
        if bar_input is None or not bar_input.is_closed:
            return False

        return self._time_bucket.is_last_component(
            input_open_time_ms=bar_input.open_time_ms,
            input_close_time_ms=bar_input.close_time_ms,
            bucket_start_ms=state.bucket_start_ms,
        )


# ═══════════════════════════════════════════════════════════════
#  Finalizer — orchestrates multiple strategies
# ═══════════════════════════════════════════════════════════════


class Finalizer:
    """Orchestrates finalization strategies to determine bar closure.

    Maintains an ordered list of strategies.  When ``check()`` is called,
    strategies are evaluated in order; the first one returning True wins.

    The Finalizer is configured with sensible defaults based on the
    ``BarAggregatorConfig``, but users can add/remove strategies freely.
    """

    def __init__(
        self,
        config: BarAggregatorConfig,
        time_bucket: TimeBucketEngine,
        interval: str,
    ) -> None:
        self._cfg = config
        self._time_bucket = time_bucket
        self._interval = interval

        # Strategy chain (evaluated in order)
        self._strategies: list[tuple[str, FinalizerStrategy]] = []

        # Build default strategy chain
        self._build_default_chain()

    # ── Public: Strategy Management ──────────────────────────

    def add_strategy(
        self,
        name: str,
        strategy: FinalizerStrategy,
        priority: int | None = None,
    ) -> None:
        """Add a finalization strategy.

        Args:
            name:     Unique name for this strategy (for logging/removal)
            strategy: The strategy implementation
            priority: Insert position (0 = highest priority).
                      None = append to end (lowest priority).
        """
        # Remove existing strategy with same name
        self._strategies = [
            (n, s) for n, s in self._strategies if n != name
        ]
        if priority is not None and 0 <= priority < len(self._strategies):
            self._strategies.insert(priority, (name, strategy))
        else:
            self._strategies.append((name, strategy))
        logger.info(
            "Added finalizer strategy '%s' (%s) for interval %s",
            name, type(strategy).__name__, self._interval,
        )

    def remove_strategy(self, name: str) -> None:
        """Remove a strategy by name."""
        before = len(self._strategies)
        self._strategies = [
            (n, s) for n, s in self._strategies if n != name
        ]
        if len(self._strategies) < before:
            logger.info("Removed finalizer strategy '%s'", name)

    def clear_strategies(self) -> None:
        """Remove all strategies."""
        self._strategies.clear()

    def get_strategy_names(self) -> list[str]:
        """Return names of all registered strategies in evaluation order."""
        return [name for name, _ in self._strategies]

    # ── Public: Core Operation ───────────────────────────────

    def check(
        self,
        state: BarState,
        trigger: FinalizeTrigger,
    ) -> BarEvent | None:
        """Check if a bar should be closed.

        Evaluates all strategies in order.  Returns a ``BarEvent(CLOSED)``
        if any strategy says yes, otherwise None.

        Args:
            state:   The bar state to check
            trigger: Context about what triggered this check

        Returns:
            BarEvent with type CLOSED if the bar should close, else None
        """
        if state.status != BarStatus.FORMING:
            return None

        for name, strategy in self._strategies:
            try:
                if strategy.should_close(state, trigger):
                    state.close_reason = name
                    state.finality = (
                        BarFinality.AUTHORITATIVE
                        if name in {"batch", "source_close", "composite_close"}
                        else BarFinality.PROVISIONAL
                    )
                    logger.debug(
                        "Bar closed by '%s': %s@%s bucket=%d",
                        name, state.symbol, state.interval, state.bucket_start_ms,
                    )
                    return BarEvent(
                        event_type=BarEventType.CLOSED,
                        bar=state,
                    )
            except Exception as exc:
                logger.error(
                    "Finalizer strategy '%s' error: %s", name, exc,
                    exc_info=True,
                )

        return None

    def check_timeout(self, state: BarState) -> BarEvent | None:
        """Check if a bar should be force-closed by timeout.

        Convenience method for timer-based checks.  Creates a timer
        trigger and evaluates strategies.
        """
        trigger = FinalizeTrigger(
            trigger_type="timer",
            current_time_ms=int(time.time() * 1000),
        )
        return self.check(state, trigger)

    def flush(self, state: BarState) -> BarEvent:
        """Finalize a bar during teardown without inventing source authority.

        Unconfirmed native snapshots become EXPIRED; all other bars preserve
        the legacy forced-CLOSED behavior.

        Returns:
            BarEvent(CLOSED or EXPIRED)
        """
        unconfirmed = self.requires_authoritative_close(state)
        state.close_reason = (
            "shutdown_unconfirmed" if unconfirmed else "shutdown_fallback"
        )
        state.finality = BarFinality.PROVISIONAL
        return BarEvent(
            event_type=(
                BarEventType.EXPIRED
                if unconfirmed
                else BarEventType.CLOSED
            ),
            bar=state,
        )

    def flush_all(self, states: list[BarState]) -> list[BarEvent]:
        """Force-close multiple bars.

        Args:
            states: List of active BarStates to close

        Returns:
            List of BarEvent(CLOSED or EXPIRED) for each bar
        """
        return [self.flush(s) for s in states if s.status == BarStatus.FORMING]

    @staticmethod
    def requires_authoritative_close(state: BarState) -> bool:
        """Return whether a forming bar must fail closed without source confirmation."""
        return (
            state.status == BarStatus.FORMING
            and state.requires_authoritative_close
            and not state.last_close_received
        )

    def should_expire_unconfirmed(
        self,
        state: BarState,
        trigger: FinalizeTrigger,
    ) -> bool:
        """Decide when an unconfirmed native snapshot must be discarded."""
        if not self.requires_authoritative_close(state):
            return False
        if trigger.trigger_type == "flush":
            return True
        if trigger.trigger_type == "next_bucket":
            return (
                trigger.next_bucket_start is not None
                and trigger.next_bucket_start > state.bucket_start_ms
            )
        if trigger.trigger_type == "timer":
            return (
                trigger.current_time_ms
                >= state.bucket_end_ms + self._cfg.finalize_timeout_ms
            )
        return False

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "layer": "L4_Finalizer",
            "interval": self._interval,
            "strategies": [
                {"name": name, "type": type(s).__name__}
                for name, s in self._strategies
            ],
        }

    # ── Internal: Default Chain ──────────────────────────────

    def _build_default_chain(self) -> None:
        """Build the default strategy chain based on config and interval type."""
        is_standard = is_standard_interval(self._interval)

        # 1. Batch finalizer (always present, handles backfill)
        # For custom intervals, pass the time_bucket so BatchFinalizer
        # waits for the last component bar before closing.
        if is_standard:
            self._strategies.append(("batch", BatchFinalizer()))
        else:
            self._strategies.append(("batch", BatchFinalizer(self._time_bucket)))

        # 2. Source close is a non-optional authority boundary for native
        # cumulative snapshots.  The legacy config flag remains readable for
        # compatibility, but disabling it must not restore timeout-based
        # promotion of a partial exchange K-line.
        if is_standard:
            self._strategies.append(("source_close", SourceCloseFinalizer()))

        # 3. Composite close (for custom intervals)
        if not is_standard and self._cfg.use_composite_close:
            self._strategies.append((
                "composite_close",
                CompositeCloseFinalizer(self._time_bucket),
            ))

        # 4. Event-driven close (when next bucket's data arrives)
        if self._cfg.use_event_driven_close:
            self._strategies.append(("event_driven", EventDrivenFinalizer()))

        # 5. Time-based fallback (safety net)
        self._strategies.append((
            "time_based",
            TimeBasedFinalizer(timeout_ms=self._cfg.finalize_timeout_ms),
        ))

        logger.debug(
            "Built finalizer chain for %s (%s): %s",
            self._interval,
            "standard" if is_standard else "custom",
            [name for name, _ in self._strategies],
        )
