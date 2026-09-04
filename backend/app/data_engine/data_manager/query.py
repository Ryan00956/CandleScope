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
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from app.data_engine.interval_policy import (
    IntervalAlignment,
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_ephemeral_interval,
    latest_eligible_bar_open_ms,
    parse_custom_interval,
    parse_interval_ms,
    parse_interval_spec,
)
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolutionErrorCode,
    IntervalResolver,
    IntervalRouteKind,
)
from app.data_engine.market_data.kline_metrics import kline_available_fields
from app.data_engine.kline_quality import incoming_source_can_replace
from app.data_engine.series_identity import (
    KlineSeriesIdentity,
    resolve_kline_series_identity,
)
from app.data_engine.history import (
    AlwaysOpenCalendar,
    BoundaryReason,
    ExchangeHistoryPolicyResolver,
    HistoryAvailability,
    HistoryDisposition,
    HistoryPlan,
    HistoryRequest,
    HistoryRequestPlanner,
    HistorySeriesKey,
    ResolvedHistoryContext,
    containing_expected_open_ms,
    latest_closed_expected_open_ms,
)
from app.exchanges import HistoryEmptyPageSemantics, supports_history_identity

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
StorageQueryRow = dict[str, Any] | tuple[Any, ...]


@dataclass
class _QueryIOMetrics:
    """Per-invocation storage/decode work attached to ``QueryResult`` metadata."""

    storage_reads: int = 0
    storage_rows: int = 0
    storage_read_seconds: float = 0.0
    storage_failures: int = 0
    projected_storage_reads: int = 0
    projected_storage_rows: int = 0
    row_decode_rows: int = 0
    row_decode_seconds: float = 0.0
    compact_row_decode_rows: int = 0
    fast_row_decode_rows: int = 0
    compact_decode_fallback_rows: int = 0
    legacy_row_decode_rows: int = 0

    def metadata(self) -> dict[str, int | float]:
        return {
            "storage_reads": self.storage_reads,
            "storage_rows": self.storage_rows,
            "storage_read_ms": round(self.storage_read_seconds * 1000, 2),
            "storage_failures": self.storage_failures,
            "projected_storage_reads": self.projected_storage_reads,
            "projected_storage_rows": self.projected_storage_rows,
            "row_decode_rows": self.row_decode_rows,
            "row_decode_ms": round(self.row_decode_seconds * 1000, 2),
            "compact_row_decode_rows": self.compact_row_decode_rows,
            "fast_row_decode_rows": self.fast_row_decode_rows,
            "compact_decode_fallback_rows": self.compact_decode_fallback_rows,
            "legacy_row_decode_rows": self.legacy_row_decode_rows,
        }


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
        interval_resolver: IntervalResolver | None = None,
    ) -> None:
        self._cache = cache
        self._storage = storage
        self._cfg = config or QueryConfig()
        self._backfill_trigger = backfill_trigger
        self._history_policy = history_policy
        self._interval_resolver = interval_resolver or IntervalResolver()

        # Metrics
        self._metrics_lock = threading.Lock()
        self._queries = 0
        self._query_before_calls = 0
        self._cache_hits = 0
        self._storage_reads = 0
        self._storage_rows = 0
        self._storage_read_seconds = 0.0
        self._storage_failures = 0
        self._projected_storage_reads = 0
        self._projected_storage_rows = 0
        self._row_decode_rows = 0
        self._row_decode_seconds = 0.0
        self._compact_row_decode_rows = 0
        self._fast_row_decode_rows = 0
        self._compact_decode_fallback_rows = 0
        self._legacy_row_decode_rows = 0
        self._backfills_triggered = 0
        self.custom_intervals = CustomIntervalQueryService(
            cache=self._cache,
            config=self._cfg,
            base_query=self.query,
            base_query_before=self.query_before,
            target_query=self._query_materialized_target,
            target_query_before=self._query_materialized_target_before,
            target_writer=self._write_materialized_target,
            calendar_provider=self._calendar_for,
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

    @property
    def auto_backfill_default(self) -> bool:
        """Return whether callers that omit an override may submit repairs."""
        return bool(self._cfg.auto_backfill)

    def set_bar_aggregator(self, bar_aggregator: Any | None) -> None:
        """Set the BarAggregator used for custom interval read aggregation."""
        self.custom_intervals.set_bar_aggregator(bar_aggregator)

    def _query_materialized_target(self, *args: Any, **kwargs: Any) -> QueryResult:
        """Read a derived target through the common cache/storage path only."""
        kwargs["_materialized_only"] = True
        return self.query(*args, **kwargs)

    def _query_materialized_target_before(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> QueryResult:
        """Read a derived target page without recursively deriving it."""
        kwargs["_materialized_only"] = True
        return self.query_before(*args, **kwargs)

    def _write_materialized_target(self, *args: Any, **kwargs: Any) -> int:
        """Persist a verified derived page through the configured backend."""
        storage = self._storage
        writer = getattr(storage, "upsert_bars", None)
        if not callable(writer):
            return 0
        return int(writer(*args, **kwargs) or 0)

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
        series_identity: KlineSeriesIdentity | None = None,
        auto_backfill: bool | None = None,
        _materialized_only: bool = False,
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
        io_metrics = _QueryIOMetrics()
        with self._metrics_lock:
            self._queries += 1
        allow_backfill = self._cfg.auto_backfill if auto_backfill is None else auto_backfill

        route = self._interval_resolver.resolve(
            exchange=exchange,
            market_type=market_type,
            interval=interval,
            purpose=IntervalPurpose.HISTORY,
        )
        exchange = route.exchange
        market_type = route.market_type
        interval = route.canonical_interval
        identity = resolve_kline_series_identity(exchange, series_identity)

        if route.kind is IntervalRouteKind.DERIVED and not _materialized_only:
            if not identity.is_legacy_default_for(exchange):
                raise IntervalResolutionError(
                    IntervalResolutionErrorCode.SERIES_IDENTITY_UNSUPPORTED,
                    "Derived intervals do not yet support non-default series identity",
                    exchange=exchange,
                    market_type=market_type,
                    interval=interval,
                    purpose=IntervalPurpose.HISTORY,
                )
            result = self.custom_intervals.query_from_base(
                symbol=symbol,
                interval=interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
                started_at=t0,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                route=route,
            )
            key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
            return self._apply_custom_finality_contract(result, key, end_ms=end_ms)

        key = SeriesKey(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            **identity.to_dict(),
        )
        if not identity.is_legacy_default_for(exchange):
            allow_backfill = bool(
                allow_backfill
                and supports_history_identity(
                    exchange=exchange,
                    market_type=market_type,
                    interval=interval,
                    identity=identity,
                )
            )

        # Ephemeral intervals are cache-only — skip storage and backfill
        if is_ephemeral_interval(interval):
            effective_limit = min(
                limit or self._cfg.default_limit,
                self._cfg.max_limit,
            )
            start_s = start_ms // 1000 if start_ms else None
            end_s = end_ms // 1000 if end_ms else None
            return self._attach_io_metrics(
                self._query_cache_only(key, start_s, end_s, effective_limit, t0),
                io_metrics,
            )
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
        now_ms = int(time.time() * 1000)
        eligible_end_ms = self._latest_eligible_open_ms(
            key,
            now_ms=now_ms,
            requested_end_ms=end_ms,
        )
        expected_closed_through_s = (
            eligible_end_ms // 1000 if eligible_end_ms is not None else None
        )
        closed_end_s = end_s
        if end_ms is not None:
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
            expected_closed_through_s=expected_closed_through_s,
        ):
            with self._metrics_lock:
                self._cache_hits += 1
            elapsed = time.monotonic() - t0
            return self._attach_io_metrics(self._apply_history_contract(QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                **key.identity.to_dict(),
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=self._cache.series_count(key) > len(cached),
                cache_hit=True,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            ), planned, expected_closed_through_s=expected_closed_through_s), io_metrics)

        # ── Step 2: Try storage ──────────────────────────────
        storage_bars: list[BarData] = []
        backfill_triggered = False
        missing_ranges: list[MissingRange] = []

        if self._storage is not None:
            try:
                rows = self._query_storage_rows(
                    key,
                    io_metrics,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    limit=effective_limit,
                    order="DESC",
                )
                rows.reverse()
                storage_bars = self._storage_rows_to_bars(key, rows, io_metrics)
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
        if merged and len(merged) >= 2:
            merged = self._fill_interior_gaps(
                key,
                merged,
                interval,
                missing_ranges,
                auto_backfill=allow_backfill,
                io_metrics=io_metrics,
            )
            backfill_triggered = bool(
                allow_backfill and missing_ranges and self._backfill_trigger is not None
            )

        if not merged:
            # Detection is independent from submission: bounded wait re-queries
            # disable duplicate scheduling but must still report an open gap.
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
                submit=allow_backfill,
            )
            if missing_range is not None:
                missing_ranges.append(missing_range)
                backfill_triggered = allow_backfill and self._backfill_trigger is not None

            elapsed = time.monotonic() - t0
            return self._attach_io_metrics(self._apply_history_contract(QueryResult(
                bars=[],
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                **key.identity.to_dict(),
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
                backfill_triggered=backfill_triggered,
                missing_ranges=missing_ranges,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            ), planned,
                boundary_reached=bool(planned and planned[0].terminal),
                expected_closed_through_s=expected_closed_through_s,
            ), io_metrics)

        quality_range = self._trigger_untrusted_finality_backfill(
            key,
            merged,
            expected_closed_through_s=expected_closed_through_s,
            submit=allow_backfill,
        )
        if quality_range is not None:
            missing_ranges.append(quality_range)
            backfill_triggered = bool(
                backfill_triggered
                or (allow_backfill and self._backfill_trigger is not None)
            )

        # ── Step 4: Check completeness & backfill ────────────
        tail_range: tuple[int, int] | None = None
        if (
            not missing_ranges
            and not self._is_complete(
                merged,
                start_s,
                closed_end_s,
                effective_limit,
                interval=interval,
                key=key,
                expected_closed_through_s=expected_closed_through_s,
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
                    submit=allow_backfill,
                )
            elif has_gap_after:
                # Scenario 1: Forward catch-up (e.g. app was closed overnight)
                missing_range = self._trigger_backfill(
                    key,
                    tail_range[0],
                    tail_range[1],
                    reason="query_tail_gap",
                    submit=allow_backfill,
                )
            elif has_gap_before:
                # Scenario 2: Backward gap (start of requested range missing)
                missing_range = self._trigger_backfill(
                    key,
                    start_ms,
                    earliest_bar_ms - interval_secs * 1000,
                    reason="query_left_gap",
                    submit=allow_backfill,
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
                    submit=allow_backfill,
                )
            if missing_range is not None:
                missing_ranges.append(missing_range)
                backfill_triggered = allow_backfill and self._backfill_trigger is not None

        # Apply limit
        if len(merged) > effective_limit:
            merged = merged[-effective_limit:]

        source = QuerySource.CACHE if not storage_bars else (
            QuerySource.MIXED if cached else QuerySource.STORAGE
        )

        # ── Step 5: Detect tail gap ──────────────────────────
        # Keep this in lockstep with the actual closed-bar repair decision.
        # Wall-clock staleness is not a reliable signal at a forming boundary.
        tail_gap = any(item.reason == "query_tail_gap" for item in missing_ranges)

        elapsed = time.monotonic() - t0
        return self._attach_io_metrics(self._apply_history_contract(QueryResult(
            bars=merged,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            **key.identity.to_dict(),
            source=source,
            total=len(merged),
            has_more=True,  # conservative — caller can paginate
            cache_hit=bool(cached),
            backfill_triggered=backfill_triggered,
            has_tail_gap=tail_gap,
            missing_ranges=missing_ranges,
            metadata={"elapsed_ms": round(elapsed * 1000, 2)},
        ), planned, expected_closed_through_s=expected_closed_through_s), io_metrics)

    # ── Public: Convenience Methods ──────────────────────────

    def query_latest(
        self, symbol: str, interval: str, limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
        auto_backfill: bool | None = None,
    ) -> QueryResult:
        """Shorthand for getting the latest N bars."""
        return self.query(
            symbol,
            interval,
            limit=limit,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
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
        series_identity: KlineSeriesIdentity | None = None,
        auto_backfill: bool | None = None,
        _materialized_only: bool = False,
    ) -> QueryResult:
        """Query bars strictly before a timestamp (for pagination)."""
        io_metrics = _QueryIOMetrics()
        with self._metrics_lock:
            self._query_before_calls += 1
        allow_backfill = self._cfg.auto_backfill if auto_backfill is None else auto_backfill
        route = self._interval_resolver.resolve(
            exchange=exchange,
            market_type=market_type,
            interval=interval,
            purpose=IntervalPurpose.HISTORY,
        )
        exchange = route.exchange
        market_type = route.market_type
        interval = route.canonical_interval
        identity = resolve_kline_series_identity(exchange, series_identity)
        if route.kind is IntervalRouteKind.DERIVED and not _materialized_only:
            if not identity.is_legacy_default_for(exchange):
                raise IntervalResolutionError(
                    IntervalResolutionErrorCode.SERIES_IDENTITY_UNSUPPORTED,
                    "Derived intervals do not yet support non-default series identity",
                    exchange=exchange,
                    market_type=market_type,
                    interval=interval,
                    purpose=IntervalPurpose.HISTORY,
                )
            result = self.custom_intervals.query_before(
                symbol,
                interval,
                before_ms,
                limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                route=route,
            )
            key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
            return self._apply_custom_finality_contract(
                result,
                key,
                end_ms=max(0, int(before_ms) - 1),
            )

        key = SeriesKey(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            **identity.to_dict(),
        )
        if not identity.is_legacy_default_for(exchange):
            allow_backfill = bool(
                allow_backfill
                and supports_history_identity(
                    exchange=exchange,
                    market_type=market_type,
                    interval=interval,
                    identity=identity,
                )
            )
        before_s = before_ms // 1000
        effective_limit = min(limit, self._cfg.max_limit)
        history_start_ms, history_end_ms = self._before_window(
            key,
            before_ms,
            effective_limit,
        )
        planned = self._plan_history_range(key, history_start_ms, history_end_ms)
        history_fetch_allowed = planned is None or planned[0].has_fetch_work
        eligible_end_ms = self._latest_eligible_open_ms(
            key,
            now_ms=int(time.time() * 1000),
            requested_end_ms=history_end_ms,
        )
        expected_closed_through_s = (
            eligible_end_ms // 1000 if eligible_end_ms is not None else None
        )

        # Ephemeral intervals are cache-only — skip storage and backfill
        if is_ephemeral_interval(interval):
            cached = self._cache.get_before(key, before_s, effective_limit)
            return self._attach_io_metrics(self._apply_history_contract(QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                **key.identity.to_dict(),
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=self._cache.series_count(key) > len(cached),
                cache_hit=bool(cached),
                backfill_triggered=False,
                metadata={"ephemeral": True},
            ), planned, expected_closed_through_s=expected_closed_through_s), io_metrics)

        # Try cache first
        cached = self._cache.get_before(key, before_s, effective_limit)

        # A count-full page is only a cache hit when its timestamps are also
        # contiguous.  A missing interior bar can otherwise be hidden by one
        # extra older bar returned by the count-based cache window.
        if (
            len(cached) >= effective_limit
            and not self._detect_gaps(cached, interval, key)
            and self._before_right_gap(
                key,
                cached,
                history_end_ms=history_end_ms,
            ) is None
            and self._all_expected_rows_final(
                cached,
                expected_closed_through_s=expected_closed_through_s,
            )
        ):
            with self._metrics_lock:
                self._cache_hits += 1
            return self._attach_io_metrics(self._apply_history_contract(QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                **key.identity.to_dict(),
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=True,
                cache_hit=True,
            ), planned, expected_closed_through_s=expected_closed_through_s), io_metrics)

        # Fall back to storage
        storage_bars: list[BarData] = []
        if self._storage is not None:
            try:
                rows = self._fetch_storage_rows_before(
                    key,
                    io_metrics,
                    before_ms=before_ms,
                    limit=effective_limit,
                )
                storage_bars = self._storage_rows_to_bars(key, rows, io_metrics)
                if storage_bars:
                    self._cache.bulk_load(key, storage_bars)
            except Exception as exc:
                logger.error("Storage fetch_before failed: %s", exc)

        merged = self._merge(cached, storage_bars)
        if len(merged) > effective_limit:
            merged = merged[-effective_limit:]

        backfill_triggered = False
        missing_ranges: list[MissingRange] = []
        if merged and len(merged) >= 2:
            merged = self._fill_interior_gaps(
                key,
                merged,
                interval,
                missing_ranges,
                auto_backfill=allow_backfill and history_fetch_allowed,
                repair_start_ms=history_start_ms,
                repair_end_ms=history_end_ms,
                io_metrics=io_metrics,
            )
            if len(merged) > effective_limit:
                merged = merged[-effective_limit:]

        if merged:
            merged = self._fill_before_right_gap(
                key,
                merged,
                interval,
                history_end_ms=history_end_ms,
                missing_ranges=missing_ranges,
                auto_backfill=allow_backfill and history_fetch_allowed,
                io_metrics=io_metrics,
            )
            if len(merged) > effective_limit:
                merged = merged[-effective_limit:]
            backfill_triggered = bool(
                allow_backfill and missing_ranges and self._backfill_trigger is not None
            )

        quality_range = self._trigger_untrusted_finality_backfill(
            key,
            merged,
            expected_closed_through_s=expected_closed_through_s,
            submit=allow_backfill and history_fetch_allowed,
        )
        if quality_range is not None:
            missing_ranges.append(quality_range)
            backfill_triggered = bool(
                backfill_triggered
                or (
                    allow_backfill
                    and history_fetch_allowed
                    and self._backfill_trigger is not None
                )
            )

        if len(merged) < effective_limit and history_fetch_allowed:
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

            if planned is not None:
                lower_bound_ms, _ = self._lower_history_bound(planned[1])
                if lower_bound_ms is not None:
                    trigger_start_ms = max(trigger_start_ms, lower_bound_ms)

            # A confirmed availability edge can consume the unfilled slots of
            # a count-based page.  Do not submit a synthetic shortfall wholly
            # outside that edge; any fetchable interior holes were reported by
            # the exact continuity passes above.
            if trigger_start_ms <= trigger_end_ms:
                missing_range = self._trigger_backfill(
                    key,
                    trigger_start_ms,
                    trigger_end_ms,
                    reason="load_more_shortfall",
                    submit=allow_backfill,
                )
                if missing_range is not None:
                    missing_ranges.append(missing_range)
                    backfill_triggered = allow_backfill and self._backfill_trigger is not None

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
            **key.identity.to_dict(),
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
            expected_closed_through_s=expected_closed_through_s,
        )
        if boundary_reached and result.bars:
            result.earliest_available_ms = result.bars[0].time_ms
        return self._attach_io_metrics(result, io_metrics)

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> dict:
        """Get cache + storage bounds for a series."""
        identity = resolve_kline_series_identity(exchange, series_identity)
        key = SeriesKey(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            **identity.to_dict(),
        )
        ce, cl = self._cache.get_bounds(key)
        result: dict[str, Any] = {
            "cache_earliest": ce,
            "cache_latest": cl,
            "cache_count": self._cache.series_count(key),
        }

        if self._storage is not None:
            try:
                identity_kwargs = (
                    {}
                    if key.identity.is_legacy_default_for(key.exchange)
                    else {"series_identity": key.identity}
                )
                sb = self._storage.get_bounds(
                    key.symbol,
                    key.interval,
                    exchange=key.exchange,
                    market_type=key.market_type,
                    **identity_kwargs,
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
        with self._metrics_lock:
            metrics = {
                "total_queries": self._queries,
                "query_before_calls": self._query_before_calls,
                "cache_hits": self._cache_hits,
                "storage_reads": self._storage_reads,
                "storage_rows": self._storage_rows,
                "storage_read_ms": round(self._storage_read_seconds * 1000, 2),
                "storage_failures": self._storage_failures,
                "projected_storage_reads": self._projected_storage_reads,
                "projected_storage_rows": self._projected_storage_rows,
                "row_decode_rows": self._row_decode_rows,
                "row_decode_ms": round(self._row_decode_seconds * 1000, 2),
                "compact_row_decode_rows": self._compact_row_decode_rows,
                "fast_row_decode_rows": self._fast_row_decode_rows,
                "compact_decode_fallback_rows": self._compact_decode_fallback_rows,
                "legacy_row_decode_rows": self._legacy_row_decode_rows,
                "backfills_triggered": self._backfills_triggered,
            }
        return {
            **metrics,
            "custom_intervals": self.custom_intervals.snapshot(),
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
        if (
            self._history_policy is None
            or start_ms > end_ms
            or not key.identity.is_legacy_default_for(key.exchange)
        ):
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

    def _latest_eligible_open_ms(
        self,
        key: SeriesKey,
        *,
        now_ms: int,
        requested_end_ms: int | None = None,
    ) -> int | None:
        calendar = self._calendar_for(key)
        if calendar is not None:
            return latest_closed_expected_open_ms(
                calendar,
                now_ms,
                key.interval,
                requested_end_ms,
            )
        return latest_eligible_bar_open_ms(
            now_ms,
            key.interval,
            requested_end_ms,
        )

    def _before_window(
        self,
        key: SeriesKey,
        before_ms: int,
        limit: int,
    ) -> tuple[int, int]:
        """Return the expected-open window for a count-based left query."""
        calendar = self._calendar_for(key)
        if calendar is not None and not isinstance(calendar, AlwaysOpenCalendar):
            last = containing_expected_open_ms(
                calendar,
                int(before_ms) - 1,
                key.interval,
            )
            if last is not None:
                first = last
                for _ in range(max(0, int(limit) - 1)):
                    previous = calendar.previous_expected_open(first, key.interval)
                    if previous is None:
                        break
                    first = previous
                return max(0, first), last
        spec = parse_interval_spec(key.interval)
        if spec is not None:
            last = spec.floor_ms(int(before_ms) - 1)
            count = max(0, int(limit) - 1)
            if spec.alignment is not IntervalAlignment.CALENDAR_MONTH:
                return max(0, last - count * spec.nominal_ms), last
            first = last
            for _ in range(count):
                first = spec.previous_ms(first)
            return max(0, first), last
        interval_ms = parse_interval_ms(key.interval)
        if interval_ms is None or interval_ms <= 0:
            interval_ms = (parse_custom_interval(key.interval) or 60) * 1000
        last = compute_bucket_start_ms(
            int(before_ms) - 1,
            interval_ms,
            interval=key.interval,
        )
        first = last
        for _ in range(max(0, int(limit) - 1)):
            first = compute_bucket_start_ms(
                first - 1,
                interval_ms,
                interval=key.interval,
            )
        return max(0, first), last

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
        expected_closed_through_s: int | None = None,
    ) -> QueryResult:
        # Start from the observed continuity result.  Availability planning may
        # override this below (terminal edge, market closure, unknown source),
        # but an ordinary fully covered fetch must not retain QueryResult's
        # conservative ``complete=False`` default forever.
        if result.missing_ranges:
            result.history_state = "pending"
            result.complete = False
            result.retryable = True
            result.terminal_reason = None
        else:
            result.history_state = "ready"
            result.complete = True
            result.retryable = False
            result.terminal_reason = None
        if planned is None:
            result.next_before_ms = result.bars[0].time_ms if result.has_more and result.bars else None
            return self._apply_finality_contract(
                result,
                expected_closed_through_s=expected_closed_through_s,
            )

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
        if terminal and result.missing_ranges:
            # Reaching a confirmed left edge only terminates pagination beyond
            # that edge.  It must not turn a repairable hole inside the
            # fetchable part of this page into a completed/exhausted result.
            result.history_state = "pending"
            result.complete = False
            result.retryable = True
            result.terminal_reason = terminal_reason or lower_reason
            result.has_more = True
        elif terminal:
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
        return self._apply_finality_contract(
            result,
            expected_closed_through_s=expected_closed_through_s,
        )

    @staticmethod
    def _expected_closed_rows(
        bars: list[BarData],
        *,
        expected_closed_through_s: int | None,
    ) -> list[BarData]:
        """Return rows whose buckets must already carry trusted finality.

        A latest/history response may include the current forming tail.  It is
        intentionally outside the closed edge and cannot make an otherwise
        healthy page permanently pending.
        """
        if expected_closed_through_s is None:
            return [bar for bar in bars if bar.is_closed]
        return [bar for bar in bars if bar.time <= expected_closed_through_s]

    @classmethod
    def _untrusted_expected_rows(
        cls,
        bars: list[BarData],
        *,
        expected_closed_through_s: int | None,
    ) -> list[BarData]:
        return [
            bar
            for bar in cls._expected_closed_rows(
                bars,
                expected_closed_through_s=expected_closed_through_s,
            )
            if not bar.trusted_final
        ]

    @classmethod
    def _all_expected_rows_final(
        cls,
        bars: list[BarData],
        *,
        expected_closed_through_s: int | None,
    ) -> bool:
        return not cls._untrusted_expected_rows(
            bars,
            expected_closed_through_s=expected_closed_through_s,
        )

    def _apply_finality_contract(
        self,
        result: QueryResult,
        *,
        expected_closed_through_s: int | None,
    ) -> QueryResult:
        expected = self._expected_closed_rows(
            result.bars,
            expected_closed_through_s=expected_closed_through_s,
        )
        untrusted = [bar for bar in expected if not bar.trusted_final]
        result.metadata["all_rows_final"] = not untrusted
        result.metadata["expected_closed_rows"] = len(expected)
        result.metadata["untrusted_final_rows"] = len(untrusted)
        if expected_closed_through_s is not None:
            result.metadata["expected_closed_through_ms"] = (
                int(expected_closed_through_s) * 1000
            )
        if untrusted:
            result.metadata["untrusted_final_start_ms"] = untrusted[0].time_ms
            result.metadata["untrusted_final_end_ms"] = untrusted[-1].time_ms
            result.history_state = "pending"
            result.complete = False
            result.retryable = True
            result.terminal_reason = None
            result.has_more = True
        return result

    def _storage_rows_to_bars(
        self,
        key: SeriesKey,
        rows: list[StorageQueryRow],
        io_metrics: _QueryIOMetrics | None = None,
    ) -> list[BarData]:
        """Convert one storage page with capability resolution amortized."""
        started_at = time.monotonic()
        declared_fields = kline_available_fields(key.exchange, key.market_type)
        compact = bool(rows and isinstance(rows[0], tuple))
        fast_path_used = False
        try:
            if compact:
                bars, fast_path_used = BarData.from_storage_component_page(
                    rows,
                    exchange=key.exchange,
                    market_type=key.market_type,
                    declared_fields=declared_fields,
                )
                return bars
            return [
                BarData.from_storage_row(
                    row,
                    exchange=key.exchange,
                    market_type=key.market_type,
                    declared_fields=declared_fields,
                )
                for row in rows
            ]
        finally:
            elapsed = time.monotonic() - started_at
            if io_metrics is not None:
                io_metrics.row_decode_rows += len(rows)
                io_metrics.row_decode_seconds += elapsed
                if compact:
                    io_metrics.compact_row_decode_rows += len(rows)
                    if fast_path_used:
                        io_metrics.fast_row_decode_rows += len(rows)
                    else:
                        io_metrics.compact_decode_fallback_rows += len(rows)
                else:
                    io_metrics.legacy_row_decode_rows += len(rows)
            with self._metrics_lock:
                self._row_decode_rows += len(rows)
                self._row_decode_seconds += elapsed
                if compact:
                    self._compact_row_decode_rows += len(rows)
                    if fast_path_used:
                        self._fast_row_decode_rows += len(rows)
                    else:
                        self._compact_decode_fallback_rows += len(rows)
                else:
                    self._legacy_row_decode_rows += len(rows)

    def _query_storage_rows(
        self,
        key: SeriesKey,
        io_metrics: _QueryIOMetrics,
        *,
        start_ms: int | None,
        end_ms: int | None,
        limit: int,
        order: str,
    ) -> list[StorageQueryRow]:
        """Use the optional compact storage projection when available."""
        storage = self._storage
        if storage is None:
            return []
        identity_kwargs = (
            {}
            if key.identity.is_legacy_default_for(key.exchange)
            else {"series_identity": key.identity}
        )
        compact_query = getattr(storage, "query_bar_components", None)
        if callable(compact_query):
            return self._measure_storage_read(
                io_metrics,
                lambda: compact_query(
                    symbol=key.symbol,
                    interval=key.interval,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    limit=limit,
                    order=order,
                    exchange=key.exchange,
                    market_type=key.market_type,
                    **identity_kwargs,
                ),
                projected=True,
            )
        return self._measure_storage_read(
            io_metrics,
            lambda: storage.query_bars(
                symbol=key.symbol,
                interval=key.interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
                order=order,
                exchange=key.exchange,
                market_type=key.market_type,
                **identity_kwargs,
            ),
        )

    def _fetch_storage_rows_before(
        self,
        key: SeriesKey,
        io_metrics: _QueryIOMetrics,
        *,
        before_ms: int,
        limit: int,
    ) -> list[StorageQueryRow]:
        """Use the optional compact before-page projection when available."""
        storage = self._storage
        if storage is None:
            return []
        identity_kwargs = (
            {}
            if key.identity.is_legacy_default_for(key.exchange)
            else {"series_identity": key.identity}
        )
        compact_fetch = getattr(storage, "fetch_before_bar_components", None)
        if callable(compact_fetch):
            return self._measure_storage_read(
                io_metrics,
                lambda: compact_fetch(
                    symbol=key.symbol,
                    interval=key.interval,
                    before_ms=before_ms,
                    limit=limit,
                    exchange=key.exchange,
                    market_type=key.market_type,
                    **identity_kwargs,
                ),
                projected=True,
            )
        return self._measure_storage_read(
            io_metrics,
            lambda: storage.fetch_before(
                symbol=key.symbol,
                interval=key.interval,
                before_ms=before_ms,
                limit=limit,
                exchange=key.exchange,
                market_type=key.market_type,
                **identity_kwargs,
            ),
        )

    def _measure_storage_read(
        self,
        io_metrics: _QueryIOMetrics,
        read: Callable[[], list[StorageQueryRow]],
        *,
        projected: bool = False,
    ) -> list[StorageQueryRow]:
        """Measure one physical storage call for both local and cumulative metrics."""
        started_at = time.monotonic()
        try:
            rows = read()
        except BaseException:
            elapsed = time.monotonic() - started_at
            io_metrics.storage_reads += 1
            io_metrics.storage_read_seconds += elapsed
            io_metrics.storage_failures += 1
            if projected:
                io_metrics.projected_storage_reads += 1
            with self._metrics_lock:
                self._storage_reads += 1
                self._storage_read_seconds += elapsed
                self._storage_failures += 1
                if projected:
                    self._projected_storage_reads += 1
            raise

        elapsed = time.monotonic() - started_at
        row_count = len(rows)
        io_metrics.storage_reads += 1
        io_metrics.storage_rows += row_count
        io_metrics.storage_read_seconds += elapsed
        if projected:
            io_metrics.projected_storage_reads += 1
            io_metrics.projected_storage_rows += row_count
        with self._metrics_lock:
            self._storage_reads += 1
            self._storage_rows += row_count
            self._storage_read_seconds += elapsed
            if projected:
                self._projected_storage_reads += 1
                self._projected_storage_rows += row_count
        return rows

    @staticmethod
    def _attach_io_metrics(
        result: QueryResult,
        io_metrics: _QueryIOMetrics,
    ) -> QueryResult:
        result.metadata.update(io_metrics.metadata())
        return result

    @staticmethod
    def _storage_row_open_time(row: StorageQueryRow) -> int:
        """Read the timestamp from either legacy mappings or compact tuples."""
        if isinstance(row, tuple):
            return int(row[0])
        return int(row["open_time"])

    def _apply_custom_finality_contract(
        self,
        result: QueryResult,
        key: SeriesKey,
        *,
        end_ms: int | None,
    ) -> QueryResult:
        eligible_end_ms = self._latest_eligible_open_ms(
            key,
            now_ms=int(time.time() * 1000),
            requested_end_ms=end_ms,
        )
        expected_closed_through_s = (
            eligible_end_ms // 1000 if eligible_end_ms is not None else None
        )

        # The custom service intentionally emits legacy chart-shaped rows.  If
        # every base component in the result was final, promote each completed
        # derived bucket to the canonical aggregated source before caching it.
        if result.metadata.get("all_rows_final") is True:
            promoted: list[BarData] = []
            changed = False
            for bar in result.bars:
                expected_closed = (
                    bar.is_closed
                    if expected_closed_through_s is None
                    else bar.time <= expected_closed_through_s
                )
                if expected_closed and not bar.trusted_final:
                    promoted.append(bar.with_source("backfill_aggregated"))
                    changed = True
                else:
                    promoted.append(bar)
            if changed:
                result.bars = promoted
                self._cache.bulk_load(key, promoted)

        return self._apply_finality_contract(
            result,
            expected_closed_through_s=expected_closed_through_s,
        )

    def _trigger_untrusted_finality_backfill(
        self,
        key: SeriesKey,
        bars: list[BarData],
        *,
        expected_closed_through_s: int | None,
        submit: bool,
    ) -> MissingRange | None:
        untrusted = self._untrusted_expected_rows(
            bars,
            expected_closed_through_s=expected_closed_through_s,
        )
        if not untrusted:
            return None
        return self._trigger_backfill(
            key,
            untrusted[0].time_ms,
            untrusted[-1].time_ms,
            reason="query_untrusted_finality",
            missing_bars=len(untrusted),
            submit=submit,
        )

    def _merge(
        self, a: list[BarData], b: list[BarData],
    ) -> list[BarData]:
        """Merge two sorted bar lists, deduplicating by time.

        On conflict (same timestamp), the higher-quality source wins.  Equal
        ranks prefer ``b`` (the freshly-read storage row) so a stale cache
        cannot hide a later revision from the same authority.
        """
        if not a:
            return list(b)
        if not b:
            return list(a)

        combined: dict[int, BarData] = {}
        for bar in a:
            existing = combined.get(bar.time)
            if existing is None or incoming_source_can_replace(existing.source, bar.source):
                combined[bar.time] = bar
        for bar in b:
            existing = combined.get(bar.time)
            if existing is None or incoming_source_can_replace(existing.source, bar.source):
                combined[bar.time] = bar
        return sorted(combined.values(), key=lambda x: x.time)

    def _has_interior_gaps(
        self,
        bars: list[BarData],
        interval: str,
        key: SeriesKey | None = None,
    ) -> bool:
        """Check for missing *expected* opens between consecutive bars.

        Keep the cache-completeness fast path on the same calendar-aware
        definition as exact gap repair.  Fixed wall-clock deltas incorrectly
        classify weekends and session closures as missing history.
        """
        return bool(self._detect_gaps(bars, interval, key))

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
        repair_start_ms: int | None = None,
        repair_end_ms: int | None = None,
        io_metrics: _QueryIOMetrics | None = None,
    ) -> list[BarData]:
        """Detect interior gaps and fill them from storage.

        For each gap found, queries storage only for the truly missing
        open_time range, excluding the two boundary bars. Also warms the
        cache with any newly fetched bars.

        After all storage reads, the merged result is checked again.  This is
        important when storage returns only part of a gap: only the exact
        remaining sub-ranges are then reported for backfill.

        ``repair_start_ms`` and ``repair_end_ms`` optionally clip repair work
        to a count-based query window.  A full ``query_before`` page may carry
        extra older bars solely because missing timestamps consumed slots;
        those older bars must not expand the requested repair range.

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

        if self._storage is not None:
            for gap_start_s, gap_end_s in gaps:
                missing_start_ms, missing_end_ms, _ = self._missing_bounds_between(
                    gap_start_s,
                    gap_end_s,
                    interval,
                    key=key,
                    repair_start_ms=repair_start_ms,
                    repair_end_ms=repair_end_ms,
                )
                if missing_start_ms is None or missing_end_ms is None:
                    continue

                try:
                    metrics = io_metrics or _QueryIOMetrics()
                    rows = self._query_storage_rows(
                        key,
                        metrics,
                        start_ms=missing_start_ms,
                        end_ms=missing_end_ms,
                        limit=5000,  # generous limit for gap fills
                        order="ASC",
                    )
                    fill_bars = self._storage_rows_to_bars(
                        key,
                        [
                            row
                            for row in rows
                            if missing_start_ms
                            <= self._storage_row_open_time(row)
                            <= missing_end_ms
                        ],
                        metrics,
                    )
                    if fill_bars:
                        all_fill_bars.extend(fill_bars)
                        logger.info(
                            "Filled missing gap [%d → %d] with %d bars from storage",
                            missing_start_ms, missing_end_ms, len(fill_bars),
                        )
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

        remaining_gaps = self._detect_gaps(bars, interval, key)
        known_ranges = {
            (item.start_ms, item.end_ms, item.reason)
            for item in (missing_ranges or [])
        }
        for gap_start_s, gap_end_s in remaining_gaps:
            missing_start_ms, missing_end_ms, missing_bars = self._missing_bounds_between(
                gap_start_s,
                gap_end_s,
                interval,
                key=key,
                repair_start_ms=repair_start_ms,
                repair_end_ms=repair_end_ms,
            )
            if missing_start_ms is None or missing_end_ms is None:
                continue
            missing_range = self._trigger_backfill(
                key,
                missing_start_ms,
                missing_end_ms,
                reason="query_interior_gap",
                missing_bars=missing_bars,
                submit=auto_backfill,
            )
            if missing_range is None or missing_ranges is None:
                continue
            identity = (
                missing_range.start_ms,
                missing_range.end_ms,
                missing_range.reason,
            )
            if identity not in known_ranges:
                missing_ranges.append(missing_range)
                known_ranges.add(identity)

        return bars

    def _before_right_gap(
        self,
        key: SeriesKey,
        bars: list[BarData],
        *,
        history_end_ms: int,
    ) -> tuple[int, int] | None:
        """Return missing expected opens between a before-page tail and its target edge.

        Count-based pages can be full and internally contiguous while still
        being shifted entirely to the left by a missing block immediately
        before ``before_ms``.  Count and interior continuity alone therefore
        cannot prove that the requested page is complete.
        """
        if not bars:
            return None
        latest_ms = int(bars[-1].time_ms)
        calendar = self._calendar_for(key)
        if calendar is not None:
            missing_start_ms = calendar.next_expected_open(latest_ms, key.interval)
        else:
            interval_ms = parse_interval_ms(key.interval)
            if interval_ms is None or interval_ms <= 0:
                return None
            latest_bucket_ms = compute_bucket_start_ms(
                latest_ms,
                interval_ms,
                interval=key.interval,
            )
            missing_start_ms = compute_bucket_end_ms(
                latest_bucket_ms,
                interval_ms,
                interval=key.interval,
            )
        if missing_start_ms is None or missing_start_ms > history_end_ms:
            return None
        if self._estimate_missing_bars(
            missing_start_ms,
            history_end_ms,
            key.interval,
            key=key,
        ) in {None, 0}:
            return None
        return int(missing_start_ms), int(history_end_ms)

    def _fill_before_right_gap(
        self,
        key: SeriesKey,
        bars: list[BarData],
        interval: str,
        *,
        history_end_ms: int,
        missing_ranges: list[MissingRange],
        auto_backfill: bool,
        io_metrics: _QueryIOMetrics | None = None,
    ) -> list[BarData]:
        """Fill and report the right-boundary gap of a count-based page."""
        gap = self._before_right_gap(key, bars, history_end_ms=history_end_ms)
        if gap is None:
            return bars

        original_tail = bars[-1]
        if self._storage is not None:
            try:
                metrics = io_metrics or _QueryIOMetrics()
                rows = self._query_storage_rows(
                    key,
                    metrics,
                    start_ms=gap[0],
                    end_ms=gap[1],
                    limit=5000,
                    order="ASC",
                )
                fill_bars = self._storage_rows_to_bars(
                    key,
                    [
                        row
                        for row in rows
                        if gap[0] <= self._storage_row_open_time(row) <= gap[1]
                    ],
                    metrics,
                )
            except Exception as exc:
                logger.error(
                    "Failed to fill before-page right gap [%d → %d] from storage: %s",
                    gap[0],
                    gap[1],
                    exc,
                )
                fill_bars = []
            if fill_bars:
                self._cache.bulk_load(key, fill_bars)
                # Check only the newly extended tail for partial storage fills;
                # older interior gaps were handled by the preceding pass.
                repaired_tail = self._fill_interior_gaps(
                    key,
                    self._merge([original_tail], fill_bars),
                    interval,
                    missing_ranges,
                    auto_backfill=auto_backfill,
                    repair_start_ms=gap[0],
                    repair_end_ms=gap[1],
                    io_metrics=io_metrics,
                )
                bars = self._merge(bars, repaired_tail)

        remaining = self._before_right_gap(key, bars, history_end_ms=history_end_ms)
        if remaining is None:
            return bars
        missing_range = self._trigger_backfill(
            key,
            remaining[0],
            remaining[1],
            reason="query_before_right_gap",
            missing_bars=self._estimate_missing_bars(
                remaining[0],
                remaining[1],
                interval,
                key=key,
            ),
            submit=auto_backfill,
        )
        if missing_range is not None:
            identity = (
                missing_range.start_ms,
                missing_range.end_ms,
                missing_range.reason,
            )
            known = {
                (item.start_ms, item.end_ms, item.reason)
                for item in missing_ranges
            }
            if identity not in known:
                missing_ranges.append(missing_range)
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

        if bars:
            with self._metrics_lock:
                self._cache_hits += 1
        elapsed = time.monotonic() - started_at
        result = QueryResult(
            bars=bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            **key.identity.to_dict(),
            source=QuerySource.CACHE,
            total=len(bars),
            has_more=self._cache.series_count(key) > len(bars),
            cache_hit=bool(bars),
            backfill_triggered=False,
            metadata={"elapsed_ms": round(elapsed * 1000, 2), "ephemeral": True},
        )
        eligible_end_ms = self._latest_eligible_open_ms(
            key,
            now_ms=int(time.time() * 1000),
            requested_end_ms=(end_s * 1000 if end_s is not None else None),
        )
        return self._apply_finality_contract(
            result,
            expected_closed_through_s=(
                eligible_end_ms // 1000 if eligible_end_ms is not None else None
            ),
        )

    def _is_complete(
        self,
        bars: list[BarData],
        start_s: int | None,
        end_s: int | None,
        limit: int,
        interval: str | None = None,
        key: SeriesKey | None = None,
        expected_closed_through_s: int | None = None,
    ) -> bool:
        """Heuristic: does the cache result satisfy the query?

        Now also checks for **interior gaps** — even if the bar count
        is sufficient, hidden gaps in the middle mean the data is
        incomplete and we must fall through to storage.
        """
        if not bars:
            return False

        if not self._all_expected_rows_final(
            bars,
            expected_closed_through_s=expected_closed_through_s,
        ):
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
            eligible_end_ms = (
                self._latest_eligible_open_ms(key, now_ms=now_ms)
                if key is not None
                else latest_eligible_bar_open_ms(now_ms, interval)
            )
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

        # Count alone cannot prove an explicitly bounded request is complete:
        # an extra older row can hide a missing right-edge bar (and vice versa).
        # Resolve expected edges through the series calendar so weekends and
        # market closures are not mistaken for data gaps.
        if interval and (start_s is not None or end_s is not None):
            coverage_start_ms = (
                int(start_s) * 1000 if start_s is not None else bars[0].time_ms
            )
            coverage_end_ms = (
                int(end_s) * 1000 if end_s is not None else bars[-1].time_ms
            )
            calendar = self._calendar_for(key) if key is not None else None
            if calendar is not None:
                expected_first = calendar.first_expected_open(
                    coverage_start_ms,
                    coverage_end_ms,
                    interval,
                )
                expected_last = calendar.last_expected_open(
                    coverage_start_ms,
                    coverage_end_ms,
                    interval,
                )
            else:
                interval_ms = parse_interval_ms(interval)
                if interval_ms is None or interval_ms <= 0:
                    expected_first = coverage_start_ms
                    expected_last = coverage_end_ms
                else:
                    expected_first = compute_bucket_start_ms(
                        coverage_start_ms,
                        interval_ms,
                        interval=interval,
                    )
                    if expected_first < coverage_start_ms:
                        expected_first = compute_bucket_end_ms(
                            expected_first,
                            interval_ms,
                            interval=interval,
                        )
                    expected_last = compute_bucket_start_ms(
                        coverage_end_ms,
                        interval_ms,
                        interval=interval,
                    )

            if (
                start_s is not None
                and expected_first is not None
                and bars[0].time_ms > expected_first
            ):
                return False
            if (
                end_s is not None
                and expected_last is not None
                and bars[-1].time_ms < expected_last
            ):
                return False

        if len(bars) >= limit:
            return True
            
        # If no explicit bounds were requested, we CANNOT be complete if we missed the limit
        if start_s is None and end_s is None:
            return False
            
        # Explicit expected-edge coverage was checked above.
        return True

    def _closed_tail_gap_range(
        self,
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
        eligible_end_ms = self._latest_eligible_open_ms(
            key,
            now_ms=now_ms,
            requested_end_ms=requested_end_ms,
        )
        if eligible_end_ms is None:
            return None

        calendar = self._calendar_for(key)
        if calendar is not None:
            next_open_ms = calendar.next_expected_open(
                int(latest_bar_ms),
                key.interval,
            )
            if next_open_ms is None or next_open_ms > eligible_end_ms:
                return None
            last_open_ms = calendar.last_expected_open(
                next_open_ms,
                eligible_end_ms,
                key.interval,
            )
            if last_open_ms is None or last_open_ms < next_open_ms:
                return None
            return next_open_ms, last_open_ms

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
        submit: bool = True,
    ) -> MissingRange | None:
        """Fire the backfill trigger callback.

        All callers should compute meaningful start/end values before
        calling this method.  The fallback here is a safety net only.
        """
        now_ms = int(time.time() * 1000)
        effective_end = end_ms if end_ms is not None else now_ms
        last_closed_ms = self._latest_eligible_open_ms(key, now_ms=now_ms)
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
            **key.identity.to_dict(),
            start_ms=int(effective_start),
            end_ms=int(effective_end),
            reason=reason,
            missing_bars=missing_bars,
        )
        if not submit:
            return missing_range
        if self._backfill_trigger is None:
            return missing_range

        with self._metrics_lock:
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
        with self._metrics_lock:
            self._backfills_triggered += max(0, count)

    def _missing_bounds_between(
        self,
        previous_s: int,
        next_s: int,
        interval: str,
        *,
        key: SeriesKey | None = None,
        repair_start_ms: int | None = None,
        repair_end_ms: int | None = None,
    ) -> tuple[int | None, int | None, int | None]:
        """Return the actual missing open_time range between two boundary bars."""
        calendar = self._calendar_for(key) if key is not None else None
        if calendar is not None:
            start_ms = calendar.next_expected_open(previous_s * 1000, interval)
            end_ms = calendar.previous_expected_open(next_s * 1000, interval)
            if start_ms is None or end_ms is None:
                return None, None, None
        else:
            interval_ms = parse_interval_ms(interval)
            if interval_ms is None or interval_ms <= 0:
                return None, None, None
            previous_bucket_ms = compute_bucket_start_ms(
                previous_s * 1000,
                interval_ms,
                interval=interval,
            )
            next_bucket_ms = compute_bucket_start_ms(
                next_s * 1000,
                interval_ms,
                interval=interval,
            )
            start_ms = compute_bucket_end_ms(
                previous_bucket_ms,
                interval_ms,
                interval=interval,
            )
            end_ms = compute_bucket_start_ms(
                next_bucket_ms - 1,
                interval_ms,
                interval=interval,
            )

        if repair_start_ms is not None:
            start_ms = max(start_ms, int(repair_start_ms))
        if repair_end_ms is not None:
            end_ms = min(end_ms, int(repair_end_ms))
        if start_ms > end_ms:
            return None, None, None
        missing_bars = self._estimate_missing_bars(
            start_ms,
            end_ms,
            interval,
            key=key,
        )
        if missing_bars is not None and missing_bars <= 0:
            return None, None, None
        return start_ms, end_ms, missing_bars

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
