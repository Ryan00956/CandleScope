"""
L3: Bar State Engine — maintains OHLCV accumulation state per time bucket.

Responsibilities:
  * Create new BarState when a new bucket is encountered
  * Apply incoming BarInput to the appropriate BarState using merge rules
  * Track active (FORMING) bars and recently closed bars in memory
  * Auto-evict old bars to prevent unbounded memory growth
  * Support user-customizable merge strategies (default: standard OHLCV)

The default OHLCV merge rule is:
  O = first Open,  H = max(High),  L = min(Low),  C = last Close,  V = sum(Volume)

Users can override this by providing a ``BarMergeStrategy`` implementation.

Usage::

    engine = BarStateEngine(config, time_bucket)
    state, change = engine.apply("BTCUSDT", "1m", bucket_start, bar_input)
"""
from __future__ import annotations

import logging
import time
from collections import OrderedDict

from .config import BarAggregatorConfig
from .models import (
    BarInput,
    BarInputSource,
    BarFinality,
    BarState,
    BarStatus,
    BarStateChange,
    BarMergeStrategy,
    MergeMode,
)
from .time_bucket import TimeBucketEngine

logger = logging.getLogger("bar_aggregator.L3_BarState")


# ═══════════════════════════════════════════════════════════════
#  Default Merge Strategy
# ═══════════════════════════════════════════════════════════════


def has_complete_closed_component_coverage(state: BarState) -> bool:
    """Return whether component snapshots authoritatively cover the bucket."""
    ordered = sorted(
        state.source_snapshots.values(),
        key=lambda item: (int(item["open_time_ms"]), int(item["close_time_ms"])),
    )
    if not ordered or not all(bool(item.get("is_closed")) for item in ordered):
        return False
    if int(ordered[0]["open_time_ms"]) != state.bucket_start_ms:
        return False
    if int(ordered[-1]["close_time_ms"]) + 1 < state.bucket_end_ms:
        return False
    return all(
        int(current["open_time_ms"]) == int(previous["close_time_ms"]) + 1
        for previous, current in zip(ordered, ordered[1:])
    )


class StandardOHLCVMerge:
    """Standard OHLCV merge: O=first, H=max, L=min, C=last, V=snapshot/sum.

    For kline sources each WS update is a **cumulative snapshot** (volume
    is the running total for the whole bar), so we *replace* additive
    fields instead of accumulating.

    For tick/trade sources each event is an incremental single trade, so
    we *sum* them as before.
    """

    def apply(self, state: BarState, bar_input: BarInput, is_new: bool) -> BarState:
        now_ms = int(time.time() * 1000)
        merge_mode = self._resolve_merge_mode(state, bar_input)

        if is_new:
            # First input for this bucket — initialize from input
            state.open = bar_input.open
            state.high = bar_input.high
            state.low = bar_input.low
            state.close = bar_input.close
            if merge_mode == MergeMode.PRICE_ONLY:
                # Price-only inputs refresh the forming target candle but
                # their additive fields are not target-interval totals.
                state.volume = 0.0
                state.quote_volume = 0.0
                state.trades = 0
                state.taker_buy_base = 0.0
                state.taker_buy_quote = 0.0
                state.enhanced_fields = frozenset()
            else:
                state.volume = round(bar_input.volume, 8)
                state.quote_volume = round(bar_input.quote_volume, 8)
                state.trades = bar_input.trades
                state.taker_buy_base = round(bar_input.taker_buy_base, 8)
                state.taker_buy_quote = round(bar_input.taker_buy_quote, 8)
                state.enhanced_fields = bar_input.enhanced_fields
            state.tick_count = 1
            state.first_input_at_ms = bar_input.open_time_ms
            state.last_input_at_ms = bar_input.open_time_ms
            state.created_at_ms = now_ms
        else:
            # Subsequent input — merge into existing state
            state.high = max(state.high, bar_input.high)
            state.low = min(state.low, bar_input.low)
            state.close = bar_input.close

            if merge_mode == MergeMode.INCREMENTAL:
                # Trade ticks are incremental — accumulate
                state.volume = round(state.volume + bar_input.volume, 8)
                state.quote_volume = round(state.quote_volume + bar_input.quote_volume, 8)
                state.trades += bar_input.trades
                state.taker_buy_base = round(state.taker_buy_base + bar_input.taker_buy_base, 8)
                state.taker_buy_quote = round(state.taker_buy_quote + bar_input.taker_buy_quote, 8)
                state.enhanced_fields = (
                    state.enhanced_fields & bar_input.enhanced_fields
                )
            elif merge_mode == MergeMode.PRICE_ONLY:
                pass
            else:
                # Kline snapshots are cumulative — replace
                state.volume = round(bar_input.volume, 8)
                state.quote_volume = round(bar_input.quote_volume, 8)
                state.trades = bar_input.trades
                state.taker_buy_base = round(bar_input.taker_buy_base, 8)
                state.taker_buy_quote = round(bar_input.taker_buy_quote, 8)
                state.enhanced_fields = bar_input.enhanced_fields

            state.tick_count += 1
            state.last_input_at_ms = bar_input.open_time_ms

        # Track whether the last component bar is closed.
        # Only update from the native channel (source_interval matches
        # the target interval) or from tick data.  Cross-interval
        # routing (e.g. OKX 1m → 5m) must NOT set this flag, because
        # a 1m bar closing does not mean the 5m bar should close —
        # doing so would cause SourceCloseFinalizer to seal the bar
        # after only one component, freezing the chart.
        if merge_mode in (MergeMode.SNAPSHOT, MergeMode.INCREMENTAL):
            state.last_close_received = bar_input.is_closed
        state.updated_at_ms = now_ms

        return state

    @staticmethod
    def _resolve_merge_mode(state: BarState, bar_input: BarInput) -> MergeMode:
        """Return the effective merge mode for standard-interval bars.

        New router paths set ``merge_mode`` explicitly.  The fallback keeps
        direct public API calls compatible while older callers are migrated.
        """
        if bar_input.merge_mode is not None:
            return bar_input.merge_mode
        if bar_input.source_interval == "tick":
            return MergeMode.INCREMENTAL
        return MergeMode.SNAPSHOT


class ComponentSnapshotOHLCVMerge:
    """Component-aware merge for custom intervals.

    Custom targets may receive source bars out of chronological order:
      * a current forming bar is seeded from partial cache/storage first
      * missing earlier components may arrive later via backfill
      * the same source bar may be re-sent with fresher OHLCV

    To keep custom bars correct, we store the latest snapshot for each
    source component and rebuild the custom bar from those snapshots.
    """

    @staticmethod
    def _snapshot_from_input(bar_input: BarInput) -> dict:
        return {
            "open_time_ms": bar_input.open_time_ms,
            "close_time_ms": bar_input.close_time_ms,
            "open": bar_input.open,
            "high": bar_input.high,
            "low": bar_input.low,
            "close": bar_input.close,
            "volume": bar_input.volume,
            "quote_volume": bar_input.quote_volume,
            "trades": bar_input.trades,
            "taker_buy_base": bar_input.taker_buy_base,
            "taker_buy_quote": bar_input.taker_buy_quote,
            "enhanced_fields": bar_input.enhanced_fields,
            "is_closed": bar_input.is_closed,
            # ``open_time_ms`` identifies the component; it says nothing about
            # which of two cumulative snapshots for that component is newer.
            # Keep an unavailable freshness sequence explicit so replacement
            # can fall back to monotonic cumulative evidence instead of
            # silently treating every update as equally fresh.
            "sequence": bar_input.sequence,
        }

    @staticmethod
    def _is_monotonic_candidate(existing: dict, candidate: dict) -> bool:
        """Return whether ``candidate`` can safely supersede ``existing``.

        Kline component payloads are cumulative snapshots.  Even a payload
        with a newer transport timestamp must not make finality, extrema, or
        additive totals move backwards.  A deliberate correction that needs
        to reduce one of these fields must rebuild/expire the target bucket
        instead of being mistaken for an ordinary live update.
        """
        if int(candidate["close_time_ms"]) != int(existing["close_time_ms"]):
            return False
        if float(candidate["open"]) != float(existing["open"]):
            return False
        if bool(existing["is_closed"]) and not bool(candidate["is_closed"]):
            return False
        if float(candidate["high"]) < float(existing["high"]):
            return False
        if float(candidate["low"]) > float(existing["low"]):
            return False
        if float(candidate["volume"]) < float(existing["volume"]):
            return False

        existing_fields = frozenset(existing["enhanced_fields"])
        candidate_fields = frozenset(candidate["enhanced_fields"])
        if not existing_fields.issubset(candidate_fields):
            return False
        for field in existing_fields:
            if field == "trades":
                if int(candidate[field]) < int(existing[field]):
                    return False
            elif float(candidate[field]) < float(existing[field]):
                return False
        return True

    @staticmethod
    def _has_monotonic_progress(existing: dict, candidate: dict) -> bool:
        """Return whether cumulative/finality fields prove forward progress."""
        if not bool(existing["is_closed"]) and bool(candidate["is_closed"]):
            return True
        if float(candidate["high"]) > float(existing["high"]):
            return True
        if float(candidate["low"]) < float(existing["low"]):
            return True
        if float(candidate["volume"]) > float(existing["volume"]):
            return True
        existing_fields = frozenset(existing["enhanced_fields"])
        for field in existing_fields:
            if field == "trades":
                if int(candidate[field]) > int(existing[field]):
                    return True
            elif float(candidate[field]) > float(existing[field]):
                return True
        return False

    @classmethod
    def _should_replace(
        cls,
        existing: dict,
        candidate: dict,
        *,
        allow_authoritative_correction: bool = False,
    ) -> bool:
        if candidate == existing:
            return False

        existing_sequence = existing.get("sequence")
        candidate_sequence = candidate.get("sequence")
        if (
            allow_authoritative_correction
            and int(candidate["close_time_ms"]) == int(existing["close_time_ms"])
            and existing_sequence is not None
            and candidate_sequence is not None
            and int(candidate_sequence) > int(existing_sequence)
        ):
            # A closed backfill snapshot with a strictly newer freshness
            # sequence is an authoritative correction. It may legitimately
            # reduce extrema, volume, or other cumulative fields that a bad
            # earlier snapshot overstated.
            return True

        if not cls._is_monotonic_candidate(existing, candidate):
            return False

        if existing_sequence is not None and candidate_sequence is not None:
            if int(candidate_sequence) < int(existing_sequence):
                return False
            if int(candidate_sequence) > int(existing_sequence):
                return True

        # Equal or unavailable sequences are not freshness evidence.  Accept
        # only when cumulative/finality fields themselves prove progress;
        # ambiguous close-only changes fail closed.
        return cls._has_monotonic_progress(existing, candidate)

    def apply(self, state: BarState, bar_input: BarInput, is_new: bool) -> BarState:
        now_ms = int(time.time() * 1000)
        snapshots = state.source_snapshots

        if is_new and snapshots:
            # Closed custom bars may be amended by late backfill components.
            # Keep the existing component history and merge the new snapshot.
            pass

        input_key = bar_input.input_key
        candidate = self._snapshot_from_input(bar_input)
        existing = snapshots.get(input_key)
        if existing is not None and not self._should_replace(
            existing,
            candidate,
            allow_authoritative_correction=(
                bar_input.source in {BarInputSource.BACKFILL, BarInputSource.CORRECTION}
                and bar_input.is_closed
            ),
        ):
            logger.debug(
                "Ignored non-monotonic or stale component snapshot %s "
                "(existing_sequence=%r, candidate_sequence=%r)",
                input_key,
                existing.get("sequence"),
                candidate.get("sequence"),
            )
            return state

        snapshots[input_key] = candidate
        ordered = sorted(
            snapshots.values(),
            key=lambda snap: (
                int(snap["open_time_ms"]),
                int(snap["close_time_ms"]),
                int(snap["sequence"]) if snap.get("sequence") is not None else -1,
            ),
        )

        first = ordered[0]
        last = ordered[-1]

        state.open = float(first["open"])
        state.high = max(float(snap["high"]) for snap in ordered)
        state.low = min(float(snap["low"]) for snap in ordered)
        state.close = float(last["close"])
        state.volume = round(sum(float(snap["volume"]) for snap in ordered), 8)
        state.quote_volume = round(sum(float(snap["quote_volume"]) for snap in ordered), 8)
        state.trades = sum(int(snap["trades"]) for snap in ordered)
        state.taker_buy_base = round(sum(float(snap["taker_buy_base"]) for snap in ordered), 8)
        state.taker_buy_quote = round(sum(float(snap["taker_buy_quote"]) for snap in ordered), 8)
        state.enhanced_fields = frozenset.intersection(*(
            frozenset(snap["enhanced_fields"])
            for snap in ordered
        ))
        components_are_contiguous = (
            int(first["open_time_ms"]) == state.bucket_start_ms
            and all(
                int(current["open_time_ms"]) == int(previous["close_time_ms"]) + 1
                for previous, current in zip(ordered, ordered[1:])
            )
        )
        covers_available_bucket = (
            int(last["close_time_ms"]) + 1 >= state.bucket_end_ms
            or not bool(last["is_closed"])
        )
        if not components_are_contiguous or not covers_available_bucket:
            state.enhanced_fields = frozenset()
        state.tick_count = len(ordered)
        state.first_input_at_ms = int(first["open_time_ms"])
        state.last_input_at_ms = int(last["open_time_ms"])
        state.last_close_received = bool(last["is_closed"])
        if is_new and state.created_at_ms == 0:
            state.created_at_ms = now_ms
        state.updated_at_ms = now_ms
        return state


# ═══════════════════════════════════════════════════════════════
#  Bar State Engine
# ═══════════════════════════════════════════════════════════════


class BarStateEngine:
    """Maintains OHLCV state for all active time buckets.

    Manages a collection of ``BarState`` objects, one per active bucket
    per (symbol, interval) pair.  Applies incoming ``BarInput`` events
    using a configurable merge strategy.
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

        # Input semantics, not the target interval's global spelling, choose
        # snapshot replacement versus component accumulation.
        self._merge_strategy: BarMergeStrategy = StandardOHLCVMerge()
        self._component_merge_strategy = ComponentSnapshotOHLCVMerge()
        self._merge_strategy_overridden = False

        # Active (FORMING) bars: {(exchange, market_type, symbol, bucket_start_ms) → BarState}
        # Using OrderedDict to maintain insertion order for eviction
        self._active: OrderedDict[tuple[str, str, str, int], BarState] = OrderedDict()

        # Recently closed bars: {(exchange, market_type, symbol, bucket_start_ms) → BarState}
        self._closed: OrderedDict[tuple[str, str, str, int], BarState] = OrderedDict()

        # Eviction buffers — populated by _enforce_*_limit(), consumed by caller.
        # The aggregator checks these after each apply()/close_bar() call
        # and emits the appropriate lifecycle events.
        self.evicted_closed: list[BarState] = []
        self.evicted_expired: list[BarState] = []

    # ── Public: Configuration ────────────────────────────────

    def set_merge_strategy(self, strategy: BarMergeStrategy) -> None:
        """Replace the OHLCV merge strategy.

        Example — Heikin-Ashi bars::

            class HeikinAshiMerge:
                def apply(self, state, bar_input, is_new):
                    # custom HA logic
                    return state
            engine.set_merge_strategy(HeikinAshiMerge())
        """
        self._merge_strategy = strategy
        self._merge_strategy_overridden = True
        logger.info("Merge strategy changed to: %s", type(strategy).__name__)

    @property
    def merge_strategy(self) -> BarMergeStrategy:
        """Current merge strategy."""
        return self._merge_strategy

    def _strategy_for(self, bar_input: BarInput) -> BarMergeStrategy:
        if self._merge_strategy_overridden:
            return self._merge_strategy
        if bar_input.merge_mode == MergeMode.COMPONENT:
            return self._component_merge_strategy
        return self._merge_strategy

    # ── Public: Core Operation ───────────────────────────────

    def apply(
        self,
        exchange: str,
        market_type: str,
        symbol: str,
        bucket_start_ms: int,
        bar_input: BarInput,
    ) -> tuple[BarState, BarStateChange]:
        """Apply a BarInput to the appropriate bucket state.

        If the bucket doesn't exist yet, a new BarState is created.
        If it exists, the input is merged into it.

        Args:
            symbol:          Trading pair (e.g. "BTCUSDT")
            bucket_start_ms: The bucket this input belongs to
            bar_input:       The input data to merge

        Returns:
            Tuple of (updated BarState, what changed)
        """
        exchange = exchange.strip().lower()
        market_type = market_type.strip().lower()
        key = (exchange, market_type, symbol, bucket_start_ms)
        merge_strategy = self._strategy_for(bar_input)

        if key in self._active:
            # Existing active bar — merge
            state = self._active[key]
            previous_component = (
                state.source_snapshots.get(bar_input.input_key)
                if merge_strategy is self._component_merge_strategy
                else None
            )
            state = merge_strategy.apply(state, bar_input, is_new=False)
            self._mark_authoritative_close_policy(state, bar_input)
            self._active[key] = state
            if (
                merge_strategy is self._component_merge_strategy
                and previous_component is not None
                and state.source_snapshots.get(bar_input.input_key) is previous_component
            ):
                return state, BarStateChange.NO_CHANGE
            # Move to end (most recently updated)
            self._active.move_to_end(key)
            return state, BarStateChange.UPDATED

        # Check if this bucket was already closed
        if key in self._closed:
            # Already closed — this is an amendment (e.g. late data from backfill)
            old_state = self._closed[key]
            # For backfill data, we overwrite (is_new=True) instead of merge,
            # because backfill bars are complete final data and should replace
            # existing state rather than accumulate on top of it.
            if bar_input.source in {
                BarInputSource.BACKFILL,
                BarInputSource.CORRECTION,
            }:
                was_authoritative = old_state.finality == BarFinality.AUTHORITATIVE
                previous_component = (
                    old_state.source_snapshots.get(bar_input.input_key)
                    if merge_strategy is self._component_merge_strategy
                    else None
                )
                state = merge_strategy.apply(old_state, bar_input, is_new=True)
                state.status = BarStatus.CLOSED  # keep it closed
                if bar_input.merge_mode != MergeMode.COMPONENT:
                    state.finality = BarFinality.AUTHORITATIVE
                    state.close_reason = "backfill_amendment"
                elif has_complete_closed_component_coverage(state):
                    # Late component repair may promote a provisional close
                    # only after the state proves complete closed coverage.
                    state.finality = BarFinality.AUTHORITATIVE
                    state.close_reason = "backfill_amendment"
                self._closed[key] = state
                if (
                    merge_strategy is self._component_merge_strategy
                    and previous_component is not None
                    and state.source_snapshots.get(bar_input.input_key) is previous_component
                    and was_authoritative == (
                        state.finality == BarFinality.AUTHORITATIVE
                    )
                ):
                    return state, BarStateChange.NO_CHANGE
                return state, BarStateChange.AMENDED
            # Realtime data for an already-closed bar — ignore
            return old_state, BarStateChange.NO_CHANGE

        # New bucket — create fresh BarState
        bucket_start, bucket_end = self._time_bucket.compute_bucket_range(bucket_start_ms)
        state = BarState(
            symbol=symbol,
            interval=self._interval,
            bucket_start_ms=bucket_start,
            bucket_end_ms=bucket_end,
            exchange=exchange,
            market_type=market_type,
            open=0.0,
            high=0.0,
            low=0.0,
            close=0.0,
            volume=0.0,
        )
        state = merge_strategy.apply(state, bar_input, is_new=True)
        self._mark_authoritative_close_policy(state, bar_input)
        self._active[key] = state

        # Evict oldest active bars if limit exceeded
        self._enforce_active_limit(exchange, market_type, symbol)

        return state, BarStateChange.CREATED

    def _mark_authoritative_close_policy(
        self,
        state: BarState,
        bar_input: BarInput,
    ) -> None:
        """Mark native cumulative snapshots as requiring explicit finality."""
        merge_mode = bar_input.merge_mode
        if merge_mode is None:
            merge_mode = (
                MergeMode.INCREMENTAL
                if bar_input.source_interval == "tick"
                else MergeMode.SNAPSHOT
            )
        # Native/cumulative kline snapshots are only final when their source
        # explicitly confirms closure (for example Binance ``x=true``).
        # Incremental trade-built bars intentionally retain the legacy
        # next-bucket/timeout policy because they have no source-close flag.
        if merge_mode in (MergeMode.SNAPSHOT, MergeMode.PRICE_ONLY):
            state.requires_authoritative_close = True

    # ── Public: State Queries ────────────────────────────────

    def get_active(
        self, exchange: str, market_type: str, symbol: str, bucket_start_ms: int,
    ) -> BarState | None:
        """Get a specific active (FORMING) bar state."""
        return self._active.get((exchange.strip().lower(), market_type.strip().lower(), symbol, bucket_start_ms))

    def get_closed(
        self, exchange: str, market_type: str, symbol: str, bucket_start_ms: int,
    ) -> BarState | None:
        """Get a specific closed bar state from recent memory."""
        return self._closed.get((exchange.strip().lower(), market_type.strip().lower(), symbol, bucket_start_ms))

    def get_state(
        self, exchange: str, market_type: str, symbol: str, bucket_start_ms: int,
    ) -> BarState | None:
        """Get bar state (active or closed)."""
        key = (exchange.strip().lower(), market_type.strip().lower(), symbol, bucket_start_ms)
        return self._active.get(key) or self._closed.get(key)

    def get_all_active(self, exchange: str, market_type: str, symbol: str) -> list[BarState]:
        """Get all active (FORMING) bars for a symbol, ordered by bucket_start."""
        exchange = exchange.strip().lower()
        market_type = market_type.strip().lower()
        return sorted(
            [
                s for (ex, mt, sym, _), s in self._active.items()
                if ex == exchange and mt == market_type and sym == symbol
            ],
            key=lambda s: s.bucket_start_ms,
        )

    def get_recent_closed(
        self, exchange: str, market_type: str, symbol: str, limit: int = 100,
    ) -> list[BarState]:
        """Get recently closed bars for a symbol, newest first."""
        exchange = exchange.strip().lower()
        market_type = market_type.strip().lower()
        bars = [
            s for (ex, mt, sym, _), s in self._closed.items()
            if ex == exchange and mt == market_type and sym == symbol
        ]
        bars.sort(key=lambda s: s.bucket_start_ms, reverse=True)
        return bars[:limit]

    def get_latest_bar(self, exchange: str, market_type: str, symbol: str) -> BarState | None:
        """Get the most recent bar (active preferred, then closed)."""
        active = self.get_all_active(exchange, market_type, symbol)
        if active:
            return active[-1]
        closed = self.get_recent_closed(exchange, market_type, symbol, limit=1)
        return closed[0] if closed else None

    # ── Public: Lifecycle Management ─────────────────────────

    def close_bar(
        self, exchange: str, market_type: str, symbol: str, bucket_start_ms: int,
    ) -> BarState | None:
        """Move a bar from active to closed.

        Called by the Finalizer when a bar should be sealed.

        Returns the closed BarState, or None if not found.
        """
        key = (exchange.strip().lower(), market_type.strip().lower(), symbol, bucket_start_ms)
        state = self._active.pop(key, None)
        if state is None:
            return None

        state.status = BarStatus.CLOSED
        state.updated_at_ms = int(time.time() * 1000)
        self._closed[key] = state

        # Enforce closed bars limit
        self._enforce_closed_limit(exchange, market_type, symbol)

        return state

    def expire_bar(
        self, exchange: str, market_type: str, symbol: str, bucket_start_ms: int,
    ) -> BarState | None:
        """Remove a bar from memory entirely.

        Returns the expired BarState, or None if not found.
        """
        key = (exchange.strip().lower(), market_type.strip().lower(), symbol, bucket_start_ms)
        state = self._active.pop(key, None) or self._closed.pop(key, None)
        if state is not None:
            state.status = BarStatus.EXPIRED
        return state

    def force_close_all_active(self, exchange: str, market_type: str, symbol: str) -> list[BarState]:
        """Force-close all active bars for a symbol.

        Used during shutdown or when switching intervals.

        Returns list of closed BarStates.
        """
        closed: list[BarState] = []
        keys_to_close = [
            (ex, mt, sym, bs) for (ex, mt, sym, bs) in self._active
            if ex == exchange.strip().lower() and mt == market_type.strip().lower() and sym == symbol
        ]
        for key in keys_to_close:
            state = self.close_bar(key[0], key[1], key[2], key[3])
            if state:
                closed.append(state)
        return closed

    def clear(
        self,
        symbol: str | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> None:
        """Clear all state.  If symbol is given, clear only that symbol."""
        if symbol is None:
            self._active.clear()
            self._closed.clear()
        else:
            normalized_exchange = exchange.strip().lower() if exchange else None
            normalized_market = market_type.strip().lower() if market_type else None
            self._active = OrderedDict(
                (k, v)
                for k, v in self._active.items()
                if k[2] != symbol
                or (normalized_exchange is not None and k[0] != normalized_exchange)
                or (normalized_market is not None and k[1] != normalized_market)
            )
            self._closed = OrderedDict(
                (k, v)
                for k, v in self._closed.items()
                if k[2] != symbol
                or (normalized_exchange is not None and k[0] != normalized_exchange)
                or (normalized_market is not None and k[1] != normalized_market)
            )

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of engine state."""
        return {
            "engine": "BarStateEngine",
            "interval": self._interval,
            "merge_strategy": type(self._merge_strategy).__name__,
            "active_bars": len(self._active),
            "closed_bars": len(self._closed),
            "max_active": self._cfg.max_active_bars,
            "max_closed": self._cfg.max_closed_bars_in_memory,
        }

    # ── Internal: Eviction ───────────────────────────────────

    def _enforce_active_limit(self, exchange: str, market_type: str, symbol: str) -> None:
        """Evict oldest active bars if over the limit.

        Bars which require an explicit source-close confirmation are expired
        rather than promoted to CLOSED.  Other bars retain the legacy
        force-close behavior and are appended to ``self.evicted_closed``.
        """
        normalized_exchange = exchange.strip().lower()
        normalized_market = market_type.strip().lower()
        symbol_keys = [
            k for k in self._active
            if k[0] == normalized_exchange and k[1] == normalized_market and k[2] == symbol
        ]
        while len(symbol_keys) > self._cfg.max_active_bars:
            oldest_key = symbol_keys.pop(0)
            state = self._active.pop(oldest_key, None)
            if state:
                if (
                    state.requires_authoritative_close
                    and not state.last_close_received
                ):
                    state.close_reason = "active_capacity_unconfirmed"
                    state.finality = BarFinality.PROVISIONAL
                    logger.warning(
                        "Expiring unconfirmed active bar at capacity: "
                        "%s:%s:%s@%s bucket=%d",
                        normalized_exchange,
                        normalized_market,
                        symbol,
                        self._interval,
                        oldest_key[3],
                    )
                    state.status = BarStatus.EXPIRED
                    state.updated_at_ms = int(time.time() * 1000)
                    self.evicted_expired.append(state)
                    continue
                logger.warning(
                    "Force-closing oldest active bar: %s:%s:%s@%s bucket=%d",
                    normalized_exchange, normalized_market, symbol, self._interval, oldest_key[3],
                )
                state.status = BarStatus.CLOSED
                state.close_reason = "active_capacity_fallback"
                state.finality = BarFinality.PROVISIONAL
                state.updated_at_ms = int(time.time() * 1000)
                self._closed[oldest_key] = state
                self.evicted_closed.append(state)

    def _enforce_closed_limit(self, exchange: str, market_type: str, symbol: str) -> None:
        """Evict oldest closed bars if over the limit.

        Expired bars are appended to ``self.evicted_expired`` so the
        aggregator can emit EXPIRED events for them after processing.
        """
        normalized_exchange = exchange.strip().lower()
        normalized_market = market_type.strip().lower()
        symbol_keys = [
            k for k in self._closed
            if k[0] == normalized_exchange and k[1] == normalized_market and k[2] == symbol
        ]
        while len(symbol_keys) > self._cfg.max_closed_bars_in_memory:
            oldest_key = symbol_keys.pop(0)
            evicted = self._closed.pop(oldest_key, None)
            if evicted:
                evicted.status = BarStatus.EXPIRED
                self.evicted_expired.append(evicted)
