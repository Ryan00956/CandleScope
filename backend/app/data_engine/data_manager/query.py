"""
Query Engine — three-level data retrieval: Cache → Storage → Backfill.

The query engine is the **single entry point** for all bar data reads.
Charts, indicators, strategies, and APIs all call ``QueryEngine.query()``
instead of reaching into cache or storage directly.

Resolution strategy:
  1. **Cache hit** — fast path, returns immediately.
  2. **Storage fallback** — if the cache doesn't cover the requested
     range, the engine reads from the storage backend.
  3. **Backfill trigger** — if storage is also missing data and
     ``auto_backfill`` is enabled, a backfill task is spawned.

The engine also pre-warms the cache with storage results so that
subsequent queries for the same range are served from memory.

Usage::

    engine = QueryEngine(cache, storage, config, backfill_fn)

    result = engine.query("BTCUSDT", "1m", limit=500)
    result = engine.query("BTCUSDT", "1h", start_ms=..., end_ms=...)
    result = engine.query_latest("BTCUSDT", "1m", 100)
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_custom_interval,
    is_ephemeral_interval,
    last_closed_bar_open_ms,
    latest_eligible_bar_open_ms,
    parse_custom_interval,
    parse_interval_ms,
)
from app.data_engine.history import (
    BoundaryReason,
    ExchangeHistoryPolicyResolver,
    HistoryAvailability,
    HistoryDisposition,
    HistoryPlan,
    HistoryRequest,
    HistoryRequestPlanner,
    HistorySeriesKey,
    ResolvedHistoryContext,
)
from app.exchanges import HistoryEmptyPageSemantics

from .cache import BarCache
from .config import QueryConfig
from .custom_query import CustomIntervalQueryService
from .models import (
    BarData,
    MissingRange,
    QueryResult,
    QuerySource,
    SeriesKey,
    StorageBackend,
)

logger = logging.getLogger("data_manager.query")

# Signature for the optional backfill trigger callback
BackfillTrigger = Callable[[str, str, int, int, str, str], None]


class QueryEngine:
    """Three-level query engine: Cache → Storage → Backfill.

    This class owns **no** data — it orchestrates reads across the
    cache and storage backend, and optionally triggers backfill when
    gaps are detected.

    All public methods are synchronous (designed to be called via
    ``asyncio.to_thread`` from async contexts).

    Attributes:
        cache:      The in-memory ``BarCache`` instance.
        storage:    A ``StorageBackend`` implementation (or None).
        config:     ``QueryConfig`` with limits and feature flags.
        backfill_trigger:
                    Optional callback ``(symbol, interval, start_ms, end_ms)``
                    called when the engine detects missing data.
    """

    def __init__(
        self,
        cache: BarCache,
        storage: StorageBackend | None = None,
        config: QueryConfig | None = None,
        backfill_trigger: BackfillTrigger | None = None,
        history_policy: ExchangeHistoryPolicyResolver | None = None,
    ) -> None:
        self._cache = cache
        self._storage = storage
        self._cfg = config or QueryConfig()
        self._backfill_trigger = backfill_trigger
        self._history_policy = history_policy

        # Metrics
        self._queries = 0
        self._cache_hits = 0
        self._storage_reads = 0
        self._backfills_triggered = 0
        self.custom_intervals = CustomIntervalQueryService(
            cache=self._cache,
            config=self._cfg,
            base_query=self.query,
        )

    # ── Public: Dependency Access ────────────────────────────

    @property
    def storage(self) -> StorageBackend | None:
        """Return the configured storage backend, if any."""
        return self._storage

    def set_storage(self, storage: StorageBackend | None) -> None:
        """Set or clear the storage backend used by query operations."""
        self._storage = storage

    @property
    def backfill_trigger(self) -> BackfillTrigger | None:
        """Return the configured backfill trigger callback, if any."""
        return self._backfill_trigger

    def set_backfill_trigger(self, trigger: BackfillTrigger | None) -> None:
        """Set or clear the backfill trigger callback."""
        self._backfill_trigger = trigger

    def set_history_policy(
        self,
        history_policy: ExchangeHistoryPolicyResolver | None,
    ) -> None:
        """Set the shared exchange/calendar availability resolver."""
        self._history_policy = history_policy

    @property
    def history_policy(self) -> ExchangeHistoryPolicyResolver | None:
        return self._history_policy

    def set_bar_aggregator(self, bar_aggregator: Any | None) -> None:
        """Set the BarAggregator used for custom interval read aggregation."""
        self.custom_intervals.set_bar_aggregator(bar_aggregator)

    # ── Public: Main Query ───────────────────────────────────

    def query(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
    ) -> QueryResult:
        """Query bars for a (symbol, interval) with flexible parameters.

        This is the **primary query interface**.  All consumers
        (chart, indicator, strategy, API) should use this method.

        Args:
            symbol:    Trading pair, e.g. "BTCUSDT".
            interval:  K-line interval, e.g. "1m", "5m", "1h".
            start_ms:  Start of range in milliseconds (inclusive).
            end_ms:    End of range in milliseconds (inclusive).
            limit:     Maximum bars to return.  Capped by config.

        Returns:
            ``QueryResult`` with bars sorted ascending by time.

        Resolution order:
            1. Cache (fast path)
            2. Storage (if cache miss or partial)
            3. Backfill trigger (if storage also missing)

        Ephemeral intervals (e.g. 1s) use a cache-only fast path:
        no storage reads, no backfill triggers.
        """
        t0 = time.monotonic()
        self._queries += 1
        allow_backfill = self._cfg.auto_backfill if auto_backfill is None else auto_backfill

        if is_custom_interval(interval):
            return self.custom_intervals.query_from_base(
                symbol=symbol,
                interval=interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
                started_at=t0,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)

        # Ephemeral intervals are cache-only — skip storage and backfill
        if is_ephemeral_interval(interval):
            effective_limit = min(
                limit or self._cfg.default_limit,
                self._cfg.max_limit,
            )
            start_s = start_ms // 1000 if start_ms else None
            end_s = end_ms // 1000 if end_ms else None
            return self._query_cache_only(key, start_s, end_s, effective_limit, t0)
        effective_limit = min(
            limit or self._cfg.default_limit,
            self._cfg.max_limit,
        )
        history_end_ms = end_ms if end_ms is not None else int(time.time() * 1000)
        if start_ms is not None:
            history_start_ms = start_ms
        else:
            history_start_ms, _ = self._before_window(
                key,
                history_end_ms + 1,
                effective_limit,
            )
        planned = self._plan_history_range(key, history_start_ms, history_end_ms)

        # Convert ms → seconds for cache queries
        start_s = start_ms // 1000 if start_ms is not None else None
        end_s = end_ms // 1000 if end_ms is not None else None
        # An explicit range may end inside the target interval's forming
        # bucket.  That bucket is queryable from the live cache but is not
        # expected durable history, so do not treat it as a storage/backfill
        # shortfall.  Keep the original end for reads; use the closed edge only
        # when judging history completeness.
        closed_end_s = end_s
        if end_ms is not None:
            eligible_end_ms = latest_eligible_bar_open_ms(
                int(time.time() * 1000),
                interval,
                end_ms,
            )
            if eligible_end_ms is not None:
                closed_end_s = min(end_s, eligible_end_ms // 1000)

        # ── Step 1: Try cache ────────────────────────────────
        if start_s is not None or end_s is not None:
            cached = self._cache.query(key, start_s, end_s, effective_limit)
        else:
            cached = self._cache.get_latest(key, effective_limit)

        if cached and self._is_complete(
            cached,
            start_s,
            closed_end_s,
            effective_limit,
            interval=interval,
            key=key,
        ):
            self._cache_hits += 1
            elapsed = time.monotonic() - t0
            return self._apply_history_contract(QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=self._cache.series_count(key) > len(cached),
                cache_hit=True,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            ), planned)

        # ── Step 2: Try storage ──────────────────────────────
        storage_bars: list[BarData] = []
        backfill_triggered = False
        missing_ranges: list[MissingRange] = []

        if self._storage is not None:
            self._storage_reads += 1
            try:
                rows = self._storage.query_bars(
                    symbol=key.symbol,
                    interval=key.interval,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    limit=effective_limit,
                    order="DESC",
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                rows.reverse()
                storage_bars = [
                    BarData.from_storage_row(
                        row,
                        exchange=key.exchange,
                        market_type=key.market_type,
                    )
                    for row in rows
                ]
            except Exception as exc:
                logger.error("Storage query failed: %s", exc, exc_info=True)

            # Warm cache with storage results
            if storage_bars:
                self._cache.bulk_load(key, storage_bars)

        # ── Step 3: Merge cache + storage ────────────────────
        merged = self._merge(cached, storage_bars)

        # ── Step 3.5: Fill interior gaps from storage ────────
        # After merging cache + storage, there may still be interior
        # gaps (missing bars in the middle).  This happens when both
        # cache AND the initial storage query have holes — e.g. the
        # browser tab was backgrounded and WS messages were lost.
        # We detect each gap and do targeted storage reads to fill them.
        if merged and self._storage is not None and len(merged) >= 2:
            merged = self._fill_interior_gaps(
                key, merged, interval, missing_ranges, auto_backfill=allow_backfill,
            )
            backfill_triggered = bool(missing_ranges)

        if not merged:
            # Nothing anywhere — report a missing range if enabled.
            if allow_backfill:
                interval_secs = parse_custom_interval(key.interval) or 60

                trigger_start_ms = start_ms
                if trigger_start_ms is None:
                    trigger_start_ms = (end_ms or int(time.time() * 1000)) - (effective_limit * interval_secs * 1000)

                missing_range = self._trigger_backfill(
                    key,
                    trigger_start_ms,
                    end_ms,
                    reason="query_empty",
                    missing_bars=self._estimate_missing_bars(
                        trigger_start_ms,
                        end_ms,
                        key.interval,
                        key=key,
                    ),
                )
                if missing_range is not None:
                    missing_ranges.append(missing_range)
                    backfill_triggered = self._backfill_trigger is not None

            elapsed = time.monotonic() - t0
            return self._apply_history_contract(QueryResult(
                bars=[],
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
                backfill_triggered=backfill_triggered,
                missing_ranges=missing_ranges,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            ), planned, boundary_reached=bool(planned and planned[0].terminal))

        # ── Step 4: Check completeness & backfill ────────────
        tail_range: tuple[int, int] | None = None
        if (
            allow_backfill
            and not missing_ranges
            and not self._is_complete(
                merged,
                start_s,
                closed_end_s,
                effective_limit,
                interval=interval,
                key=key,
            )
        ):
            interval_secs = parse_custom_interval(key.interval) or 60
            now_ms = int(time.time() * 1000)
            earliest_bar_ms = merged[0].time * 1000
            latest_bar_ms = merged[-1].time * 1000

            # Determine which direction has a gap.  Tail completeness is
            # anchored to the last *closed target bucket*, not `end - one
            # fixed interval`: the old arithmetic missed exactly one absent
            # daily bar whenever the request edge landed on that bar's open.
            has_gap_before = (start_ms is not None and earliest_bar_ms > start_ms)
            tail_range = self._closed_tail_gap_range(
                key,
                latest_bar_ms=latest_bar_ms,
                requested_end_ms=end_ms,
                now_ms=now_ms,
            )
            has_gap_after = tail_range is not None

            if has_gap_before and has_gap_after:
                # Both sides have gaps — backfill the larger gap first
                # (forward catch-up is usually more urgent)
                missing_range = self._trigger_backfill(
                    key,
                    tail_range[0],
                    tail_range[1],
                    reason="query_tail_gap",
                )
            elif has_gap_after:
                # Scenario 1: Forward catch-up (e.g. app was closed overnight)
                missing_range = self._trigger_backfill(
                    key,
                    tail_range[0],
                    tail_range[1],
                    reason="query_tail_gap",
                )
            elif has_gap_before:
                # Scenario 2: Backward gap (start of requested range missing)
                missing_range = self._trigger_backfill(
                    key,
                    start_ms,
                    earliest_bar_ms - interval_secs * 1000,
                    reason="query_left_gap",
                )
            else:
                # Count-based shortfall — backfill backwards from earliest data
                needed_ms = (effective_limit - len(merged)) * interval_secs * 1000
                trigger_start = earliest_bar_ms - needed_ms
                missing_range = self._trigger_backfill(
                    key,
                    trigger_start,
                    earliest_bar_ms - interval_secs * 1000,
                    reason="query_shortfall",
                )
            if missing_range is not None:
                missing_ranges.append(missing_range)
                backfill_triggered = self._backfill_trigger is not None

        # Apply limit
        if len(merged) > effective_limit:
            merged = merged[-effective_limit:]

        source = QuerySource.CACHE if not storage_bars else (
            QuerySource.MIXED if cached else QuerySource.STORAGE
        )

        # ── Step 5: Detect tail gap ──────────────────────────
        # Keep this in lockstep with the actual closed-bar repair decision.
        # Wall-clock staleness is not a reliable signal at a forming boundary.
        tail_gap = bool(merged and backfill_triggered and tail_range is not None)

        elapsed = time.monotonic() - t0
        return self._apply_history_contract(QueryResult(
            bars=merged,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=source,
            total=len(merged),
            has_more=True,  # conservative — caller can paginate
            cache_hit=bool(cached),
            backfill_triggered=backfill_triggered,
            has_tail_gap=tail_gap,
            missing_ranges=missing_ranges,
            metadata={"elapsed_ms": round(elapsed * 1000, 2)},
        ), planned)

    # ── Public: Convenience Methods ──────────────────────────

    def query_latest(
        self, symbol: str, interval: str, limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
    ) -> QueryResult:
        """Shorthand for getting the latest N bars."""
        return self.query(
            symbol,
            interval,
            limit=limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )

    def query_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
    ) -> QueryResult:
        """Query bars strictly before a timestamp (for pagination)."""
        allow_backfill = self._cfg.auto_backfill if auto_backfill is None else auto_backfill
        if is_custom_interval(interval):
            return self.custom_intervals.query_before(
                symbol,
                interval,
                before_ms,
                limit,
                exchange=exchange,
                market_type=market_type,
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        before_s = before_ms // 1000
        effective_limit = min(limit, self._cfg.max_limit)
        history_start_ms, history_end_ms = self._before_window(
            key,
            before_ms,
            effective_limit,
        )
        planned = self._plan_history_range(key, history_start_ms, history_end_ms)
        history_fetch_allowed = planned is None or planned[0].has_fetch_work

        # Ephemeral intervals are cache-only — skip storage and backfill
        if is_ephemeral_interval(interval):
            cached = self._cache.get_before(key, before_s, effective_limit)
            return self._apply_history_contract(QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=self._cache.series_count(key) > len(cached),
                cache_hit=bool(cached),
                backfill_triggered=False,
                metadata={"ephemeral": True},
            ), planned)

        # Try cache first
        cached = self._cache.get_before(key, before_s, effective_limit)

        if len(cached) >= effective_limit:
            return self._apply_history_contract(QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=True,
                cache_hit=True,
            ), planned)

        # Fall back to storage
        storage_bars: list[BarData] = []
        if self._storage is not None:
            try:
                rows = self._storage.fetch_before(
                    symbol=key.symbol,
                    interval=key.interval,
                    before_ms=before_ms,
                    limit=effective_limit,
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                storage_bars = [
                    BarData.from_storage_row(
                        row,
                        exchange=key.exchange,
                        market_type=key.market_type,
                    )
                    for row in rows
                ]
                if storage_bars:
                    self._cache.bulk_load(key, storage_bars)
            except Exception as exc:
                logger.error("Storage fetch_before failed: %s", exc)

        merged = self._merge(cached, storage_bars)
        if len(merged) > effective_limit:
            merged = merged[-effective_limit:]

        backfill_triggered = False
        missing_ranges: list[MissingRange] = []
        if len(merged) < effective_limit and allow_backfill and history_fetch_allowed:
            # Only backfill the missing portion before existing data
            if merged:
                # Count expected opens, not wall-clock buckets, so weekends and
                # session breaks do not shrink the requested page.
                needed = effective_limit - len(merged)
                trigger_start_ms, trigger_end_ms = self._before_window(
                    key,
                    merged[0].time_ms,
                    needed,
                )
            else:
                # No data at all — use the calendar-derived page window.
                trigger_start_ms = history_start_ms
                trigger_end_ms = history_end_ms

            missing_range = self._trigger_backfill(
                key,
                trigger_start_ms,
                trigger_end_ms,
                reason="load_more_shortfall",
            )
            if missing_range is not None:
                missing_ranges.append(missing_range)
                backfill_triggered = self._backfill_trigger is not None

        # Determine has_more accurately:
        # - If we got a full page of results, there's likely more data
        # - If storage returned fewer bars than requested AND no backfill
        #   was triggered, there's no more data available
        # - If backfill was triggered, report has_more=True so the frontend
        #   can retry after backfill completes
        if len(merged) >= effective_limit:
            has_more = True
        elif backfill_triggered or missing_ranges:
            has_more = True
        elif not merged and not storage_bars:
            # Nothing found anywhere — no more data
            has_more = False
        elif storage_bars and len(storage_bars) < effective_limit:
            # Storage returned less than requested — we've hit the beginning
            has_more = False
        else:
            has_more = bool(merged)

        boundary_reached = False
        if planned is not None:
            plan, _ = planned
            boundary_reached = bool(
                (plan.terminal and len(merged) < effective_limit)
                or (
                    len(merged) < effective_limit
                    and plan.has_terminal_boundary
                )
            )

        result = QueryResult(
            bars=merged,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=QuerySource.MIXED if storage_bars else QuerySource.CACHE,
            total=len(merged),
            has_more=has_more,
            cache_hit=bool(cached),
            backfill_triggered=backfill_triggered,
            missing_ranges=missing_ranges,
        )
        result = self._apply_history_contract(
            result,
            planned,
            boundary_reached=boundary_reached,
        )
        if boundary_reached and result.bars:
            result.earliest_available_ms = result.bars[0].time_ms
        return result

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict:
        """Get cache + storage bounds for a series."""
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        ce, cl = self._cache.get_bounds(key)
        result: dict[str, Any] = {
            "cache_earliest": ce,
            "cache_latest": cl,
            "cache_count": self._cache.series_count(key),
        }

        if self._storage is not None:
            try:
                sb = self._storage.get_bounds(
                    key.symbol,
                    key.interval,
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                result.update({
                    "storage_earliest_ms": sb.get("earliest_open_time"),
                    "storage_latest_ms": sb.get("latest_open_time"),
                    "storage_count": sb.get("total_count"),
                })
            except Exception:
                result.update({
                    "storage_earliest_ms": None,
                    "storage_latest_ms": None,
                    "storage_count": None,
                })
        return result

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "total_queries": self._queries,
            "cache_hits": self._cache_hits,
            "storage_reads": self._storage_reads,
            "backfills_triggered": self._backfills_triggered,
            "config": {
                "default_limit": self._cfg.default_limit,
                "max_limit": self._cfg.max_limit,
                "auto_backfill": self._cfg.auto_backfill,
            },
        }

    # ── Internal ─────────────────────────────────────────────

    @staticmethod
    def _history_series_key(key: SeriesKey) -> HistorySeriesKey:
        return HistorySeriesKey(
            exchange=key.exchange,
            market_type=key.market_type,
            symbol=key.symbol,
            channel="kline",
            variant=key.interval,
        )

    def _plan_history_range(
        self,
        key: SeriesKey,
        start_ms: int,
        end_ms: int,
    ) -> tuple[HistoryPlan, ResolvedHistoryContext] | None:
        if self._history_policy is None or start_ms > end_ms:
            return None
        request = HistoryRequest(
            series=self._history_series_key(key),
            interval=key.interval,
            start_ms=int(start_ms),
            end_ms=int(end_ms),
        )
        try:
            return self._history_policy.plan(request)
        except Exception as exc:
            logger.error("History availability planning failed for %s: %s", key, exc)
            availability = HistoryAvailability(
                disposition=HistoryDisposition.UNKNOWN,
                status_reason=BoundaryReason.AVAILABILITY_UNKNOWN,
            )
            return (
                HistoryRequestPlanner.fail_closed(
                    request,
                    reason=BoundaryReason.AVAILABILITY_UNKNOWN,
                ),
                ResolvedHistoryContext(
                    availability=availability,
                    calendar=None,
                    policy=None,
                    empty_page_semantics=HistoryEmptyPageSemantics.UNKNOWN,
                ),
            )

    def _calendar_for(self, key: SeriesKey):
        if self._history_policy is None:
            return None
        try:
            return self._history_policy.calendar_for(self._history_series_key(key))
        except Exception as exc:
            logger.error("History calendar resolution failed for %s: %s", key, exc)
            return None

    def _before_window(
        self,
        key: SeriesKey,
        before_ms: int,
        limit: int,
    ) -> tuple[int, int]:
        """Return the expected-open window for a count-based left query."""
        calendar = self._calendar_for(key)
        if calendar is not None:
            interval_ms = parse_interval_ms(key.interval)
            if interval_ms is None or interval_ms <= 0:
                interval_ms = (parse_custom_interval(key.interval) or 60) * 1000
            bucket = compute_bucket_start_ms(
                int(before_ms) - 1,
                interval_ms,
                interval=key.interval,
            )
            next_bucket = compute_bucket_end_ms(
                bucket,
                interval_ms,
                interval=key.interval,
            )
            last = calendar.previous_expected_open(next_bucket, key.interval)
            if last is not None:
                first = last
                for _ in range(max(0, int(limit) - 1)):
                    previous = calendar.previous_expected_open(first, key.interval)
                    if previous is None:
                        break
                    first = previous
                return max(0, first), last
        interval_ms = parse_interval_ms(key.interval)
        if interval_ms is None or interval_ms <= 0:
            interval_ms = (parse_custom_interval(key.interval) or 60) * 1000
        return (
            max(0, int(before_ms) - (int(limit) * interval_ms)),
            int(before_ms) - interval_ms,
        )

    @staticmethod
    def _lower_history_bound(
        context: ResolvedHistoryContext,
        *,
        now_ms: int | None = None,
    ) -> tuple[int | None, str | None]:
        availability = context.availability
        candidates = [
            (int(bound.value_ms), bound.reason.value)
            for bound in (availability.data_start, availability.upstream_start)
            if bound is not None and bound.confirmed and not bound.retryable
        ]
        if availability.rolling_retention_ms is not None:
            current_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
            candidates.append((
                current_ms - availability.rolling_retention_ms,
                BoundaryReason.PROVIDER_RETENTION.value,
            ))
        if not candidates:
            return None, None
        return max(candidates, key=lambda item: item[0])

    def _apply_history_contract(
        self,
        result: QueryResult,
        planned: tuple[HistoryPlan, ResolvedHistoryContext] | None,
        *,
        boundary_reached: bool = False,
    ) -> QueryResult:
        if planned is None:
            result.next_before_ms = result.bars[0].time_ms if result.has_more and result.bars else None
            return result

        plan, context = planned
        earliest_ms, lower_reason = self._lower_history_bound(context)
        result.earliest_available_ms = earliest_ms
        result.availability_revision = context.revision or None
        result.excluded_ranges = [
            {
                "start_ms": exclusion.time_range.start_ms,
                "end_ms": exclusion.time_range.end_ms,
                "disposition": exclusion.disposition.value,
                "reason": exclusion.reason.value,
            }
            for exclusion in plan.exclusions
        ]

        terminal_reason = next(
            (
                exclusion.reason.value
                for exclusion in plan.exclusions
                if exclusion.disposition is HistoryDisposition.TERMINAL
            ),
            lower_reason,
        )
        terminal = bool(boundary_reached or (plan.terminal and not result.bars))
        if terminal:
            result.history_state = "exhausted"
            result.complete = True
            result.retryable = False
            result.terminal_reason = terminal_reason or BoundaryReason.SOURCE_EXHAUSTED.value
            result.has_more = False
        elif plan.retryable or (plan.unknown and not plan.has_fetch_work):
            result.history_state = "pending"
            result.complete = False
            result.retryable = True
            result.terminal_reason = None
        elif not plan.has_fetch_work:
            # A pure closure/holiday is fully explained but is not a permanent
            # series edge, so clients may cover it without caching exhaustion.
            result.history_state = "ready"
            result.complete = True
            result.retryable = False
            result.terminal_reason = None
        result.next_before_ms = result.bars[0].time_ms if result.has_more and result.bars else None
        return result

    def _merge(
        self, a: list[BarData], b: list[BarData],
    ) -> list[BarData]:
        """Merge two sorted bar lists, deduplicating by time.

        On conflict (same timestamp), cache data (``a``) wins because
        it is typically more recent (from the live stream), while
        storage data (``b``) may be stale backfill data.
        """
        if not a:
            return list(b)
        if not b:
            return list(a)

        combined: dict[int, BarData] = {}
        for bar in b:
            combined[bar.time] = bar  # storage first
        for bar in a:
            combined[bar.time] = bar  # cache overwrites — cache wins
        return sorted(combined.values(), key=lambda x: x.time)

    def _has_interior_gaps(
        self,
        bars: list[BarData],
        interval: str,
        key: SeriesKey | None = None,
    ) -> bool:
        """Check if bars have interior gaps (missing bars in the middle).

        A gap is detected when the time difference between consecutive
        bars exceeds 1.5× the expected interval.  This catches cases
        where the cache has enough bars by count, but is missing data
        in the middle (e.g. due to ingestion interruptions).
        """
        if len(bars) < 2:
            return False
        interval_secs = parse_custom_interval(interval) or 60
        threshold = interval_secs * 1.5
        for i in range(1, len(bars)):
            if bars[i].time - bars[i - 1].time > threshold:
                return True
        return False

    def _detect_gaps(
        self,
        bars: list[BarData],
        interval: str,
        key: SeriesKey | None = None,
    ) -> list[tuple[int, int]]:
        """Return a list of (gap_start_s, gap_end_s) for each interior gap.

        ``gap_start_s`` is the time of the bar *before* the gap.
        ``gap_end_s``   is the time of the bar *after*  the gap.
        """
        if len(bars) < 2:
            return []
        calendar = self._calendar_for(key) if key is not None else None
        calendar = self._calendar_for(key) if key is not None else None
        if calendar is not None:
            return any(
                (
                    expected := calendar.next_expected_open(
                        bars[index - 1].time_ms,
                        interval,
                    )
                ) is not None
                and expected < bars[index].time_ms
                for index in range(1, len(bars))
            )
        interval_secs = parse_custom_interval(interval) or 60
        threshold = interval_secs * 1.5
        gaps: list[tuple[int, int]] = []
        for i in range(1, len(bars)):
            if calendar is not None:
                expected = calendar.next_expected_open(
                    bars[i - 1].time_ms,
                    interval,
                )
                has_gap = expected is not None and expected < bars[i].time_ms
            else:
                has_gap = bars[i].time - bars[i - 1].time > threshold
            if has_gap:
                gaps.append((bars[i - 1].time, bars[i].time))
        return gaps

    def _fill_interior_gaps(
        self,
        key: SeriesKey,
        bars: list[BarData],
        interval: str,
        missing_ranges: list[MissingRange] | None = None,
        auto_backfill: bool = True,
    ) -> list[BarData]:
        """Detect interior gaps and fill them from storage.

        For each gap found, queries storage only for the truly missing
        open_time range, excluding the two boundary bars. Also warms the
        cache with any newly fetched bars.

        If storage doesn't have the data either, triggers backfill for
        each gap so the data will be available on the next query.

        Returns the (potentially augmented) bar list, still sorted.
        """
        gaps = self._detect_gaps(bars, interval, key)
        if not gaps:
            return bars

        logger.info(
            "Detected %d interior gap(s) in %s %s, attempting storage fill",
            len(gaps), key.symbol, key.interval,
        )

        all_fill_bars: list[BarData] = []

        for gap_start_s, gap_end_s in gaps:
            missing_start_ms, missing_end_ms, missing_bars = self._missing_bounds_between(
                gap_start_s,
                gap_end_s,
                interval,
                key=key,
            )
            if missing_start_ms is None or missing_end_ms is None:
                continue

            try:
                rows = self._storage.query_bars(
                    symbol=key.symbol,
                    interval=key.interval,
                    start_ms=missing_start_ms,
                    end_ms=missing_end_ms,
                    limit=5000,  # generous limit for gap fills
                    order="ASC",
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                fill_bars = [
                    BarData.from_storage_row(
                        row,
                        exchange=key.exchange,
                        market_type=key.market_type,
                    )
                    for row in rows
                ]
                if fill_bars:
                    all_fill_bars.extend(fill_bars)
                    logger.info(
                        "Filled missing gap [%d → %d] with %d bars from storage",
                        missing_start_ms, missing_end_ms, len(fill_bars),
                    )
                else:
                    # Storage also doesn't have data — report a missing range.
                    if auto_backfill:
                        logger.info(
                            "Storage has no data for missing gap [%d → %d], triggering backfill",
                            missing_start_ms, missing_end_ms,
                        )
                        missing_range = self._trigger_backfill(
                            key,
                            missing_start_ms,
                            missing_end_ms,
                            reason="query_interior_gap",
                            missing_bars=missing_bars,
                        )
                        if missing_range is not None and missing_ranges is not None:
                            missing_ranges.append(missing_range)
            except Exception as exc:
                logger.error(
                    "Failed to fill gap [%d → %d] from storage: %s",
                    missing_start_ms, missing_end_ms, exc,
                )

        if all_fill_bars:
            # Warm cache with the gap-fill data
            self._cache.bulk_load(key, all_fill_bars)
            # Merge into the result
            bars = self._merge(bars, all_fill_bars)

        return bars

    def _query_cache_only(
        self,
        key: SeriesKey,
        start_s: int | None,
        end_s: int | None,
        limit: int,
        started_at: float,
    ) -> QueryResult:
        """Ephemeral interval query — cache only, no storage, no backfill.

        Used for intervals like 1s where data is never persisted to DB.
        Returns whatever is currently in the in-memory cache.
        """
        if start_s is not None or end_s is not None:
            bars = self._cache.query(key, start_s, end_s, limit)
        else:
            bars = self._cache.get_latest(key, limit)

        self._cache_hits += 1 if bars else 0
        elapsed = time.monotonic() - started_at
        return QueryResult(
            bars=bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=QuerySource.CACHE,
            total=len(bars),
            has_more=self._cache.series_count(key) > len(bars),
            cache_hit=bool(bars),
            backfill_triggered=False,
            metadata={"elapsed_ms": round(elapsed * 1000, 2), "ephemeral": True},
        )

    def _is_complete(
        self,
        bars: list[BarData],
        start_s: int | None,
        end_s: int | None,
        limit: int,
        interval: str | None = None,
        key: SeriesKey | None = None,
    ) -> bool:
        """Heuristic: does the cache result satisfy the query?

        Now also checks for **interior gaps** — even if the bar count
        is sufficient, hidden gaps in the middle mean the data is
        incomplete and we must fall through to storage.
        """
        if not bars:
            return False

        # Even if count is enough, check for interior gaps first
        if interval and self._has_interior_gaps(bars, interval, key):
            logger.debug(
                "Cache has %d bars but interior gaps detected for %s",
                len(bars), interval,
            )
            return False

        # Check data freshness: if no explicit end bound was requested
        # (i.e. "give me the latest N bars"), verify the newest bar
        # isn't stale.  Without this, prewarm data from days ago can
        # satisfy count >= limit and skip backfill entirely.
        if interval and end_s is None:
            now_ms = int(time.time() * 1000)
            interval_ms = parse_interval_ms(interval)
            eligible_end_ms = latest_eligible_bar_open_ms(now_ms, interval)
            latest_open_ms = int(bars[-1].time) * 1000
            next_open_ms = (
                compute_bucket_end_ms(
                    compute_bucket_start_ms(
                        latest_open_ms,
                        interval_ms,
                        interval=interval,
                    ),
                    interval_ms,
                    interval=interval,
                )
                if interval_ms is not None and interval_ms > 0
                else None
            )
            if (
                eligible_end_ms is not None
                and next_open_ms is not None
                and next_open_ms <= eligible_end_ms
            ):
                logger.debug(
                    "Cache data stale for %s: latest=%d latest_closed=%d",
                    interval,
                    latest_open_ms,
                    eligible_end_ms,
                )
                return False

        if len(bars) >= limit:
            return True
            
        # If no explicit bounds were requested, we CANNOT be complete if we missed the limit
        if start_s is None and end_s is None:
            return False
            
        # If the query had explicit bounds, check coverage
        if start_s is not None and bars[0].time > start_s:
            return False
        if end_s is not None and bars[-1].time < end_s:
            return False
        return True

    @staticmethod
    def _closed_tail_gap_range(
        key: SeriesKey,
        *,
        latest_bar_ms: int,
        requested_end_ms: int | None,
        now_ms: int,
    ) -> tuple[int, int] | None:
        """Return a missing closed tail range, if the stored tail is behind.

        The range is expressed in target-bar open timestamps.  It is shared by
        latest, bounded-history, and recovery queries so an exact one-bar tail
        is detected regardless of whether ``requested_end_ms`` lands on a bar
        open, a bar close, or wall-clock time inside the following bar.
        """
        interval_ms = parse_interval_ms(key.interval)
        if interval_ms is None or interval_ms <= 0:
            return None
        eligible_end_ms = latest_eligible_bar_open_ms(
            now_ms,
            key.interval,
            requested_end_ms,
        )
        if eligible_end_ms is None:
            return None

        latest_bucket_ms = compute_bucket_start_ms(
            int(latest_bar_ms),
            interval_ms,
            interval=key.interval,
        )
        next_open_ms = compute_bucket_end_ms(
            latest_bucket_ms,
            interval_ms,
            interval=key.interval,
        )
        if next_open_ms > eligible_end_ms:
            return None
        return next_open_ms, eligible_end_ms

    def _trigger_backfill(
        self,
        key: SeriesKey,
        start_ms: int | None,
        end_ms: int | None,
        *,
        reason: str = "query_gap",
        missing_bars: int | None = None,
    ) -> MissingRange | None:
        """Fire the backfill trigger callback.

        All callers should compute meaningful start/end values before
        calling this method.  The fallback here is a safety net only.
        """
        now_ms = int(time.time() * 1000)
        effective_end = end_ms if end_ms is not None else now_ms
        last_closed_ms = last_closed_bar_open_ms(now_ms, key.interval)
        if last_closed_ms is None:
            logger.debug(
                "Skipping backfill for %s because its closed-bar boundary is unknown",
                key,
            )
            return None
        effective_end = min(effective_end, last_closed_ms)

        if start_ms is not None:
            effective_start = start_ms
        else:
            # Safety fallback: backfill at most 24 hours instead of from epoch 0
            effective_start = max(0, effective_end - 86_400_000)
            logger.warning(
                "Backfill start_ms is None for %s — "
                "defaulting to 24h lookback (%d → %d)",
                key, effective_start, effective_end,
            )

        if effective_start > effective_end:
            logger.debug(
                "Skipping invalid backfill range for %s: %d > %d",
                key,
                effective_start,
                effective_end,
            )
            return None

        planned = self._plan_history_range(key, effective_start, effective_end)
        if planned is not None:
            plan, _ = planned
            if not plan.has_fetch_work:
                logger.debug(
                    "Skipping non-fetchable history range for %s: %d-%d (%s)",
                    key,
                    effective_start,
                    effective_end,
                    plan.disposition.value,
                )
                return None
            effective_start = min(item.start_ms for item in plan.fetch_ranges)
            effective_end = max(item.end_ms for item in plan.fetch_ranges)

        if missing_bars is None:
            missing_bars = self._estimate_missing_bars(
                effective_start,
                effective_end,
                key.interval,
                key=key,
            )

        missing_range = MissingRange(
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            start_ms=int(effective_start),
            end_ms=int(effective_end),
            reason=reason,
            missing_bars=missing_bars,
        )
        if self._backfill_trigger is None:
            return missing_range

        self._backfills_triggered += 1
        try:
            self._backfill_trigger(
                key.symbol,
                key.interval,
                int(effective_start),
                int(effective_end),
                key.exchange,
                key.market_type,
            )
            return missing_range
        except Exception as exc:
            logger.error("Backfill trigger failed: %s", exc, exc_info=True)
            return missing_range

    def note_backfill_triggered(self, count: int = 1) -> None:
        """Record externally submitted backfill requests in query metrics."""
        self._backfills_triggered += max(0, count)

    def _missing_bounds_between(
        self,
        previous_s: int,
        next_s: int,
        interval: str,
        *,
        key: SeriesKey | None = None,
    ) -> tuple[int | None, int | None, int | None]:
        """Return the actual missing open_time range between two boundary bars."""
        calendar = self._calendar_for(key) if key is not None else None
        if calendar is not None:
            start_ms = calendar.next_expected_open(previous_s * 1000, interval)
            end_ms = calendar.previous_expected_open(next_s * 1000, interval)
            if start_ms is None or end_ms is None or start_ms > end_ms:
                return None, None, None
            return (
                start_ms,
                end_ms,
                calendar.count_expected(start_ms, end_ms, interval),
            )

        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            return None, None, None
        start_ms = previous_s * 1000 + interval_ms
        end_ms = next_s * 1000 - interval_ms
        if start_ms > end_ms:
            return None, None, None
        return start_ms, end_ms, self._estimate_missing_bars(
            start_ms,
            end_ms,
            interval,
            key=key,
        )

    def _estimate_missing_bars(
        self,
        start_ms: int | None,
        end_ms: int | None,
        interval: str,
        *,
        key: SeriesKey | None = None,
    ) -> int | None:
        if start_ms is None or end_ms is None or start_ms > end_ms:
            return None
        calendar = self._calendar_for(key) if key is not None else None
        if calendar is not None:
            return calendar.count_expected(start_ms, end_ms, interval)
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            return None
        return int((end_ms - start_ms) // interval_ms) + 1
