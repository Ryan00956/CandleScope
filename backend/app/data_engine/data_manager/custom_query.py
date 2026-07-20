"""Custom interval query service for QueryEngine."""
from __future__ import annotations

import time
import asyncio
import logging
import threading
from bisect import bisect_right
from collections.abc import Callable
from typing import Any

from app.data_engine.interval_policy import (
    aggregate_tail_is_closed,
    aggregate_rows_by_month,
    compute_bucket_end_ms,
    compute_bucket_start,
    compute_bucket_start_ms,
    compute_month_bucket_ms,
    enhanced_components_are_complete,
    find_best_base_interval,
    next_month_bucket,
    parse_custom_interval,
    parse_interval_ms,
    parse_monthly_count,
    row_is_closed,
)
from app.data_engine.market_data.kline_metrics import serialize_kline_enhancements
from app.data_engine.history.calendar import expected_bucket_end_ms
from app.data_engine.kline_quality import source_rank

from .cache import BarCache
from .config import QueryConfig
from .models import BarData, MissingRange, QueryResult, QuerySource, SeriesKey

BaseQuery = Callable[..., QueryResult]
BaseQueryBefore = Callable[..., QueryResult]
CalendarProvider = Callable[[SeriesKey], Any | None]
logger = logging.getLogger("data_manager.custom_query")


def _run_async_blocking(coro):
    """Run an async helper from sync query code, even inside an active loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: dict[str, Any] = {}

    def _runner() -> None:
        try:
            result["value"] = asyncio.run(coro)
        except Exception as exc:  # pragma: no cover - re-raised in caller thread
            result["error"] = exc

    thread = threading.Thread(target=_runner, name="custom-query-aggregate", daemon=True)
    thread.start()
    thread.join()
    if "error" in result:
        raise result["error"]
    return result.get("value")


def _bar_data_to_storage_rows(
    bars: list[BarData],
    source_interval: str,
) -> list[dict]:
    """Convert query output bars back into BarAggregator batch input rows."""
    source_ms = parse_interval_ms(source_interval) or 60_000
    rows: list[dict] = []
    for bar in bars:
        open_time_ms = bar.time_ms
        rows.append({
            "open_time": open_time_ms,
            "close_time": open_time_ms + source_ms - 1,
            "open": bar.open,
            "high": bar.high,
            "low": bar.low,
            "close": bar.close,
            "volume": bar.volume,
            "quote_volume": bar.quote_volume,
            "trades": bar.trades,
            "taker_buy_base": bar.taker_buy_base,
            "taker_buy_quote": bar.taker_buy_quote,
            "enhanced_fields": sorted(bar.enhanced_fields),
            "is_closed": bool(bar.is_closed),
        })
    return rows


def _aggregate_rows_to_interval(
    base_rows: list[dict],
    custom_interval_seconds: int,
    *,
    interval: str | None = None,
    source_interval: str | None = None,
    source_interval_seconds: int | None = None,
    calendar: Any | None = None,
) -> list[dict]:
    """Aggregate lightweight-chart rows into a custom interval."""
    if not base_rows:
        return []

    expected_bucket_starts: list[int] = []
    if calendar is not None and interval is not None:
        first_ms = min(int(row["time"]) for row in base_rows) * 1000
        last_ms = max(int(row["time"]) for row in base_rows) * 1000
        first_bucket_ms = calendar.previous_expected_open(first_ms + 1, interval)
        expected_bucket_starts = list(calendar.expected_opens(
            first_bucket_ms if first_bucket_ms is not None else first_ms,
            last_ms,
            interval,
        ))

    buckets: dict[int, list[dict]] = {}
    for row in base_rows:
        ts = row["time"]
        if expected_bucket_starts:
            position = bisect_right(expected_bucket_starts, int(ts) * 1000) - 1
            if position < 0:
                continue
            bucket_start = expected_bucket_starts[position] // 1000
            if int(ts) * 1000 >= expected_bucket_end_ms(
                calendar,
                expected_bucket_starts[position],
                interval,
            ):
                continue
        else:
            bucket_start = compute_bucket_start(
                ts,
                custom_interval_seconds,
                interval=interval,
            )
        buckets.setdefault(bucket_start, []).append(row)

    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = sorted(buckets[bucket_start], key=lambda row: row["time"])
        bucket_end = (
            expected_bucket_end_ms(calendar, bucket_start * 1000, interval) // 1000
            if calendar is not None and interval is not None
            else bucket_start + custom_interval_seconds
        )
        expected_source_opens: list[int] | None = None
        if calendar is not None and source_interval is not None:
            expected_source_opens = [
                int(open_ms) // 1000
                for open_ms in calendar.expected_opens(
                    bucket_start * 1000,
                    bucket_end * 1000 - 1,
                    source_interval,
                )
            ]
            actual_source_opens = [int(row["time"]) for row in rows]
            is_expected_prefix = bool(
                expected_source_opens
                and actual_source_opens
                == expected_source_opens[:len(actual_source_opens)]
            )
            reaches_expected_tail = bool(
                is_expected_prefix
                and len(actual_source_opens) == len(expected_source_opens)
            )
            enhanced_complete = bool(
                is_expected_prefix
                and (reaches_expected_tail or not row_is_closed(rows[-1]))
            )
        else:
            reaches_expected_tail = False
            enhanced_complete = enhanced_components_are_complete(
                rows,
                bucket_start_seconds=bucket_start,
                bucket_end_seconds=bucket_end,
                source_interval_seconds=source_interval_seconds,
            )
        enhanced_rows = [
            serialize_kline_enhancements(
                volume=row.get("volume"),
                quote_volume=row.get("quote_volume"),
                trades=row.get("trades"),
                taker_buy_base=row.get("taker_buy_base"),
                taker_buy_quote=row.get("taker_buy_quote"),
            )
            for row in rows
        ]
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(row["high"] for row in rows),
            "low": min(row["low"] for row in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(row["volume"] for row in rows), 8),
            "quote_volume": _sum_optional_field(enhanced_rows, "quote_volume")
            if enhanced_complete else None,
            "trades": _sum_optional_field(enhanced_rows, "trades", integer=True)
            if enhanced_complete else None,
            "taker_buy_base": _sum_optional_field(enhanced_rows, "taker_buy_base")
            if enhanced_complete else None,
            "taker_buy_quote": _sum_optional_field(enhanced_rows, "taker_buy_quote")
            if enhanced_complete else None,
            "is_closed": bool(
                enhanced_complete
                and (
                    row_is_closed(rows[-1]) and reaches_expected_tail
                    if expected_source_opens is not None
                    else aggregate_tail_is_closed(
                        rows,
                        bucket_end_seconds=bucket_end,
                        source_interval_seconds=source_interval_seconds,
                    )
                )
            ),
        })
    return result


def _sum_optional_field(
    rows: list[dict],
    field: str,
    *,
    integer: bool = False,
) -> float | int | None:
    """Sum an additive field only when every component provides it."""
    values = [row.get(field) for row in rows]
    if any(value is None for value in values):
        return None
    if integer:
        return sum(int(value) for value in values)
    return round(sum(float(value) for value in values), 8)


def _base_capacity_factor(
    target_interval: str,
    base_interval: str,
    nominal_factor: int,
) -> int:
    """Return a safe source-row capacity for one target bucket.

    Month intervals use a nominal 30-day duration for parsing, while real
    calendar buckets can contain 31 days per component month.  Capacity must
    use the maximum calendar width or long 2M/3M pagination can stop early.
    """
    months = parse_monthly_count(target_interval)
    base_ms = parse_interval_ms(base_interval)
    if months is None or base_ms is None or base_ms <= 0:
        return max(1, int(nominal_factor))
    maximum_month_bucket_ms = months * 31 * 86_400_000
    return max(
        int(nominal_factor),
        (maximum_month_bucket_ms + base_ms - 1) // base_ms,
    )


class CustomIntervalQueryService:
    """Build custom interval responses from standard interval bars."""

    def __init__(
        self,
        *,
        cache: BarCache,
        config: QueryConfig,
        base_query: BaseQuery,
        base_query_before: BaseQueryBefore | None = None,
        calendar_provider: CalendarProvider | None = None,
        bar_aggregator: Any | None = None,
    ) -> None:
        self._cache = cache
        self._cfg = config
        self._base_query = base_query
        self._base_query_before = base_query_before
        self._calendar_provider = calendar_provider
        self._bar_aggregator = bar_aggregator

    def set_bar_aggregator(self, bar_aggregator: Any | None) -> None:
        """Set the BarAggregator used for closed custom-bucket aggregation."""
        self._bar_aggregator = bar_aggregator

    def _calendar_for(self, key: SeriesKey) -> Any | None:
        if self._calendar_provider is None:
            return None
        try:
            return self._calendar_provider(key)
        except Exception as exc:
            logger.error("Custom interval calendar resolution failed for %s: %s", key, exc)
            return None

    def project_base_repair_to_target(
        self,
        *,
        symbol: str,
        target_interval: str,
        base_interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str,
        market_type: str,
    ) -> dict[str, int | str] | None:
        """Project a durable base gap onto affected derived candle opens."""
        if (
            target_interval == base_interval
            or parse_custom_interval(target_interval) is None
            or int(start_ms) > int(end_ms)
        ):
            return None
        key = SeriesKey(
            symbol,
            target_interval,
            exchange=exchange,
            market_type=market_type,
        )
        calendar = self._calendar_for(key)
        interval_ms = parse_interval_ms(target_interval)
        if interval_ms is None or interval_ms <= 0:
            interval_ms = (parse_custom_interval(target_interval) or 60) * 1000

        def _containing_open(component_open_ms: int) -> int | None:
            if calendar is None:
                return compute_bucket_start_ms(
                    component_open_ms,
                    interval_ms,
                    interval=target_interval,
                )
            candidate = calendar.previous_expected_open(
                int(component_open_ms) + 1,
                target_interval,
            )
            if candidate is None:
                return None
            bucket_end_ms = expected_bucket_end_ms(
                calendar,
                candidate,
                target_interval,
            )
            if candidate <= component_open_ms < bucket_end_ms:
                return int(candidate)
            return None

        target_start_ms = _containing_open(int(start_ms))
        target_end_ms = _containing_open(int(end_ms))
        if (
            target_start_ms is None
            or target_end_ms is None
            or target_start_ms > target_end_ms
        ):
            return None
        return {
            "interval": target_interval,
            "start_ms": target_start_ms,
            "end_ms": target_end_ms,
        }

    @staticmethod
    def _merge_base_page_results(
        results: list[QueryResult],
        bars: list[BarData],
    ) -> QueryResult:
        """Combine directional base pages without losing history semantics."""
        if not results:
            return QueryResult(bars=bars, total=len(bars))
        if len(results) == 1 and bars == results[0].bars:
            return results[0]

        newest = results[0]
        oldest = results[-1]
        missing_by_identity = {}
        exclusions_by_identity: dict[tuple[Any, ...], dict[str, Any]] = {}
        for result in results:
            for item in result.missing_ranges:
                missing_by_identity.setdefault(
                    (
                        item.symbol,
                        item.interval,
                        item.exchange,
                        item.market_type,
                        item.start_ms,
                        item.end_ms,
                        item.reason,
                    ),
                    item,
                )
            for exclusion in result.excluded_ranges:
                identity = (
                    exclusion.get("start_ms"),
                    exclusion.get("end_ms"),
                    exclusion.get("disposition"),
                    exclusion.get("reason"),
                )
                exclusions_by_identity.setdefault(identity, dict(exclusion))

        missing_ranges = list(missing_by_identity.values())
        all_rows_final = all(
            result.metadata.get("all_rows_final") is True
            for result in results
        )
        pending = bool(
            missing_ranges
            or not all_rows_final
            or any(result.retryable or result.history_state == "pending" for result in results)
        )
        if pending:
            history_state = "pending"
            complete = False
            retryable = True
            terminal_reason = oldest.terminal_reason
            has_more = True
        else:
            history_state = oldest.history_state
            complete = all(result.complete for result in results)
            retryable = False
            terminal_reason = oldest.terminal_reason
            has_more = oldest.has_more

        sources = {result.source for result in results}
        source = next(iter(sources)) if len(sources) == 1 else QuerySource.MIXED
        revisions = [result.availability_revision for result in results if result.availability_revision]
        earliest_values = [
            result.earliest_available_ms
            for result in results
            if result.earliest_available_ms is not None
        ]
        return QueryResult(
            bars=bars,
            symbol=newest.symbol,
            interval=newest.interval,
            exchange=newest.exchange,
            market_type=newest.market_type,
            source=source,
            total=len(bars),
            has_more=has_more,
            cache_hit=any(result.cache_hit for result in results),
            backfill_triggered=any(result.backfill_triggered for result in results),
            has_tail_gap=any(result.has_tail_gap for result in results),
            missing_ranges=missing_ranges,
            metadata={
                **newest.metadata,
                "all_rows_final": all_rows_final,
                "expected_closed_rows": sum(
                    int(result.metadata.get("expected_closed_rows") or 0)
                    for result in results
                ),
                "untrusted_final_rows": sum(
                    int(result.metadata.get("untrusted_final_rows") or 0)
                    for result in results
                ),
                "base_page_count": len(results),
            },
            history_state=history_state,
            complete=complete,
            retryable=retryable,
            terminal_reason=terminal_reason,
            earliest_available_ms=min(earliest_values) if earliest_values else None,
            next_before_ms=oldest.next_before_ms,
            availability_revision=revisions[-1] if revisions else None,
            excluded_ranges=list(exclusions_by_identity.values()),
        )

    def _page_base_history(
        self,
        *,
        symbol: str,
        interval: str,
        before_ms: int,
        target_limit: int,
        lower_bound_ms: int | None,
        exchange: str,
        market_type: str,
        auto_backfill: bool | None,
        initial_result: QueryResult | None = None,
    ) -> QueryResult:
        """Read enough base rows across the per-query limit, newest to oldest."""
        if self._base_query_before is None:
            if initial_result is not None:
                return initial_result
            return self._base_query(
                symbol,
                interval,
                end_ms=before_ms - 1,
                limit=min(target_limit, self._cfg.max_limit),
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
            )

        results: list[QueryResult] = []
        by_time: dict[int, BarData] = {}
        cursor_ms = int(before_ms)
        if initial_result is not None:
            results.append(initial_result)
            for bar in initial_result.bars:
                by_time[bar.time] = bar
            if initial_result.bars:
                cursor_ms = min(bar.time_ms for bar in initial_result.bars)

        page_capacity = max(1, int(target_limit))
        if lower_bound_ms is not None:
            interval_ms = parse_interval_ms(interval)
            if interval_ms is not None and interval_ms > 0:
                span_capacity = (
                    max(0, int(before_ms) - int(lower_bound_ms))
                    + interval_ms
                    - 1
                ) // interval_ms + 1
                page_capacity = max(page_capacity, span_capacity)
        max_pages = max(
            2,
            (page_capacity + self._cfg.max_limit - 1) // self._cfg.max_limit + 4,
        )
        while len(results) < max_pages:
            reached_lower_bound = bool(
                lower_bound_ms is not None
                and by_time
                and min(bar.time_ms for bar in by_time.values()) <= lower_bound_ms
            )
            reached_count = lower_bound_ms is None and len(by_time) >= target_limit
            if reached_lower_bound or reached_count:
                break
            if results:
                previous = results[-1]
                if (
                    not previous.has_more
                    and not previous.retryable
                    and not previous.missing_ranges
                ):
                    break

            remaining = max(1, target_limit - len(by_time))
            page_limit = (
                self._cfg.max_limit
                if lower_bound_ms is not None
                else min(self._cfg.max_limit, remaining)
            )
            page = self._base_query_before(
                symbol,
                interval,
                cursor_ms,
                page_limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
            )
            results.append(page)
            if not page.bars:
                break
            next_cursor_ms = min(bar.time_ms for bar in page.bars)
            for bar in page.bars:
                existing = by_time.get(bar.time)
                if existing is None or source_rank(bar.source) > source_rank(existing.source):
                    # Pages are read newest-to-oldest. Preserve the newer page
                    # on equal authority, but never let it mask a higher-grade
                    # row from an overlapping older page.
                    by_time[bar.time] = bar
            if next_cursor_ms >= cursor_ms:
                logger.error(
                    "Custom base pagination made no progress for %s %s at %d",
                    symbol,
                    interval,
                    cursor_ms,
                )
                break
            cursor_ms = next_cursor_ms

        bars = sorted(by_time.values(), key=lambda bar: bar.time)
        if lower_bound_ms is not None:
            bars = [bar for bar in bars if bar.time_ms >= lower_bound_ms]
        return self._merge_base_page_results(results, bars)

    def query_from_base(
        self,
        *,
        symbol: str,
        interval: str,
        start_ms: int | None,
        end_ms: int | None,
        limit: int | None,
        started_at: float,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
    ) -> QueryResult:
        """Serve custom intervals by aggregating a standard interval on read."""
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None:
            return QueryResult(
                bars=[],
                symbol=symbol.upper(),
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
                metadata={"elapsed_ms": round((time.monotonic() - started_at) * 1000, 2)},
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        calendar = self._calendar_for(key)
        effective_limit = min(limit or self._cfg.default_limit, self._cfg.max_limit)
        base_interval, factor = find_best_base_interval(custom_seconds, interval=interval)
        capacity_factor = _base_capacity_factor(interval, base_interval, factor)
        custom_ms = custom_seconds * 1000

        month_count = parse_monthly_count(interval)
        aligned_start_ms = None
        if start_ms is not None:
            if calendar is not None:
                alignment_end_ms = (
                    int(end_ms)
                    if end_ms is not None
                    else int(start_ms) + max(custom_ms, 366 * 86_400_000)
                )
                aligned_start_ms = calendar.first_expected_open(
                    int(start_ms),
                    alignment_end_ms,
                    interval,
                )
            elif month_count is not None:
                aligned_start_ms = compute_month_bucket_ms(start_ms, month_count)
            else:
                aligned_start_ms = compute_bucket_start_ms(
                    start_ms,
                    custom_ms,
                    interval=interval,
                )
            if aligned_start_ms is None:
                aligned_start_ms = int(start_ms)

        # ``end_ms`` addresses custom bar opens.  The base read must cover the
        # complete final custom bucket; otherwise a timestamp-complete custom
        # response can silently contain a one-component partial aggregate.
        base_end_ms = end_ms
        if end_ms is not None:
            if calendar is not None:
                end_bucket_start_ms = calendar.previous_expected_open(
                    int(end_ms) + 1,
                    interval,
                )
                if end_bucket_start_ms is not None:
                    base_end_ms = expected_bucket_end_ms(
                        calendar,
                        end_bucket_start_ms,
                        interval,
                    ) - 1
            elif month_count is not None:
                end_bucket_start_ms = compute_month_bucket_ms(end_ms, month_count)
                base_end_ms = (
                    next_month_bucket(end_bucket_start_ms // 1000, month_count) * 1000
                    - 1
                )
            else:
                end_bucket_start_ms = compute_bucket_start_ms(
                    end_ms,
                    custom_ms,
                    interval=interval,
                )
                base_end_ms = end_bucket_start_ms + custom_ms - 1

        if start_ms is not None and end_ms is not None:
            estimated_custom = max(1, ((end_ms - aligned_start_ms) // custom_ms) + 2)
            base_limit = estimated_custom * capacity_factor + capacity_factor
        else:
            base_limit = (effective_limit + 2) * capacity_factor + capacity_factor

        seed_limit = min(base_limit, self._cfg.max_limit)
        seed_start_ms = aligned_start_ms if base_limit <= self._cfg.max_limit else None
        base_result = self._base_query(
            symbol,
            base_interval,
            start_ms=seed_start_ms,
            end_ms=base_end_ms,
            limit=seed_limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )
        if base_limit > self._cfg.max_limit and self._base_query_before is not None:
            base_result = self._page_base_history(
                symbol=symbol,
                interval=base_interval,
                before_ms=(
                    int(base_end_ms) + 1
                    if base_end_ms is not None
                    else int(time.time() * 1000) + 1
                ),
                target_limit=base_limit,
                lower_bound_ms=aligned_start_ms,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=auto_backfill,
                initial_result=base_result,
            )
        derived_bars = self.aggregate_custom_bars(
            base_result.bars,
            symbol=symbol,
            interval=interval,
            source_interval=base_interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        derived_bars, omitted_incomplete = self._omit_bars_overlapping_base_gaps(
            derived_bars,
            base_result.missing_ranges,
            interval=interval,
            calendar=calendar,
        )
        derived_total = len(derived_bars)
        if derived_total > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        elapsed = time.monotonic() - started_at
        has_more = bool(
            base_result.has_more
            or derived_total > effective_limit
            or base_result.missing_ranges
            or base_result.retryable
        )
        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=base_result.source,
            total=len(derived_bars),
            has_more=has_more,
            cache_hit=base_result.cache_hit,
            backfill_triggered=base_result.backfill_triggered,
            has_tail_gap=base_result.has_tail_gap,
            missing_ranges=base_result.missing_ranges,
            metadata={
                **base_result.metadata,
                "elapsed_ms": round(elapsed * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "base_source": base_result.source.value,
                "omitted_incomplete_aggregates": omitted_incomplete,
            },
            history_state=base_result.history_state,
            complete=base_result.complete,
            retryable=base_result.retryable,
            terminal_reason=base_result.terminal_reason,
            earliest_available_ms=(
                derived_bars[0].time_ms
                if base_result.history_state == "exhausted" and derived_bars
                else base_result.earliest_available_ms
            ),
            next_before_ms=(
                derived_bars[0].time_ms if has_more and derived_bars else None
            ),
            availability_revision=base_result.availability_revision,
            excluded_ranges=list(base_result.excluded_ranges),
        )

    def query_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
    ) -> QueryResult:
        """Paginate custom intervals by rebuilding them from base bars."""
        started_at = time.monotonic()
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None:
            return QueryResult(
                bars=[],
                symbol=symbol.upper(),
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        calendar = self._calendar_for(key)
        effective_limit = min(limit, self._cfg.max_limit)
        base_interval, factor = find_best_base_interval(custom_seconds, interval=interval)
        capacity_factor = _base_capacity_factor(interval, base_interval, factor)
        custom_ms = custom_seconds * 1000

        month_count = parse_monthly_count(interval)
        if calendar is not None:
            last_bucket_start_ms = calendar.previous_expected_open(
                before_ms,
                interval,
            )
            if last_bucket_start_ms is None:
                last_bucket_start_ms = compute_bucket_start_ms(
                    before_ms - 1,
                    custom_ms,
                    interval=interval,
                )
            base_end_ms = expected_bucket_end_ms(
                calendar,
                last_bucket_start_ms,
                interval,
            ) - 1
        elif month_count is not None:
            last_bucket_start_ms = compute_month_bucket_ms(before_ms - 1, month_count)
            base_end_ms = next_month_bucket(
                last_bucket_start_ms // 1000,
                month_count,
            ) * 1000 - 1
        else:
            last_bucket_start_ms = compute_bucket_start_ms(
                before_ms - 1,
                custom_ms,
                interval=interval,
            )
            base_end_ms = last_bucket_start_ms + custom_ms - 1
        base_limit = (effective_limit + 2) * capacity_factor

        base_result = self._page_base_history(
            symbol=symbol,
            interval=base_interval,
            before_ms=base_end_ms + 1,
            target_limit=base_limit,
            lower_bound_ms=None,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )
        derived_bars = self.aggregate_custom_bars(
            base_result.bars,
            symbol=symbol,
            interval=interval,
            source_interval=base_interval,
            end_ms=base_end_ms,
            exchange=exchange,
            market_type=market_type,
        )
        derived_bars, omitted_incomplete = self._omit_bars_overlapping_base_gaps(
            derived_bars,
            base_result.missing_ranges,
            interval=interval,
            calendar=calendar,
        )
        derived_bars = [bar for bar in derived_bars if bar.time_ms < before_ms]
        derived_total = len(derived_bars)
        if derived_total > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        has_more = bool(
            base_result.has_more
            or derived_total > effective_limit
            or base_result.missing_ranges
            or base_result.retryable
        )
        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=base_result.source,
            total=len(derived_bars),
            has_more=has_more,
            cache_hit=base_result.cache_hit,
            backfill_triggered=base_result.backfill_triggered,
            has_tail_gap=base_result.has_tail_gap,
            missing_ranges=base_result.missing_ranges,
            metadata={
                **base_result.metadata,
                "elapsed_ms": round((time.monotonic() - started_at) * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "base_source": base_result.source.value,
                "omitted_incomplete_aggregates": omitted_incomplete,
            },
            history_state=base_result.history_state,
            complete=base_result.complete,
            retryable=base_result.retryable,
            terminal_reason=base_result.terminal_reason,
            earliest_available_ms=(
                derived_bars[0].time_ms
                if base_result.history_state == "exhausted" and derived_bars
                else base_result.earliest_available_ms
            ),
            next_before_ms=(
                derived_bars[0].time_ms if has_more and derived_bars else None
            ),
            availability_revision=base_result.availability_revision,
            excluded_ranges=list(base_result.excluded_ranges),
        )

    def aggregate_custom_bars(
        self,
        base_bars: list[BarData],
        symbol: str,
        interval: str,
        source_interval: str | None = None,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[BarData]:
        """Aggregate standard-interval bars into a custom interval."""
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None or not base_bars:
            return []

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        calendar = self._calendar_for(key)

        result = self._aggregate_read_only(
            base_bars,
            interval,
            custom_seconds,
            source_interval=source_interval,
            calendar=calendar,
        )
        if self._bar_aggregator is not None and source_interval is not None:
            canonical_closed = {bar.time: bar.is_closed for bar in result}
            try:
                states = _run_async_blocking(self._bar_aggregator.aggregate_batch(
                    symbol.upper(),
                    interval,
                    source_interval,
                    _bar_data_to_storage_rows(base_bars, source_interval),
                    exchange=exchange,
                    market_type=market_type,
                ))
            except Exception as exc:
                logger.warning(
                    "BarAggregator custom query aggregation failed for %s from %s: %s",
                    interval,
                    source_interval,
                    exc,
                )
            else:
                aggregated = {
                    int(state.bucket_start_ms) // 1000: BarData.from_bar_state(
                        state,
                        is_closed=canonical_closed.get(
                            int(state.bucket_start_ms) // 1000,
                        ),
                    )
                    for state in states
                }
                if aggregated:
                    result = [
                        aggregated.get(bar.time, bar)
                        for bar in result
                    ]

        if start_ms is not None:
            result = [bar for bar in result if bar.time_ms >= start_ms]
        if end_ms is not None:
            result = [bar for bar in result if bar.time_ms <= end_ms]
        return result

    @staticmethod
    def _omit_bars_overlapping_base_gaps(
        bars: list[BarData],
        missing_ranges: list[MissingRange],
        *,
        interval: str,
        calendar: Any | None,
    ) -> tuple[list[BarData], int]:
        """Never publish an OHLCV aggregate built across a known base-series hole."""
        if not bars or not missing_ranges:
            return bars, 0

        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            custom_seconds = parse_custom_interval(interval)
            interval_ms = (custom_seconds or 60) * 1000

        month_count = parse_monthly_count(interval)
        safe: list[BarData] = []
        for bar in bars:
            start_ms = int(bar.time_ms)
            if calendar is not None:
                end_exclusive_ms = expected_bucket_end_ms(
                    calendar,
                    start_ms,
                    interval,
                )
            elif month_count is not None:
                end_exclusive_ms = next_month_bucket(
                    start_ms // 1000,
                    month_count,
                ) * 1000
            else:
                end_exclusive_ms = compute_bucket_end_ms(
                    start_ms,
                    interval_ms,
                    interval=interval,
                )
            overlaps = any(
                int(item.start_ms) < end_exclusive_ms
                and int(item.end_ms) >= start_ms
                for item in missing_ranges
            )
            if not overlaps:
                safe.append(bar)
        return safe, len(bars) - len(safe)

    @staticmethod
    def _aggregate_read_only(
        base_bars: list[BarData],
        interval: str,
        custom_seconds: int,
        *,
        source_interval: str | None = None,
        calendar: Any | None = None,
    ) -> list[BarData]:
        """Read-only aggregation used for partial buckets and fallback."""
        source_interval_ms = parse_interval_ms(source_interval) if source_interval else None
        source_interval_seconds = (
            source_interval_ms // 1000
            if source_interval_ms is not None
            else None
        )
        month_count = parse_monthly_count(interval)
        if month_count is not None and calendar is None:
            aggregated = aggregate_rows_by_month(
                [bar.to_aggregation_dict() for bar in base_bars],
                months=month_count,
                source_interval_seconds=source_interval_seconds,
            )
        else:
            aggregated = _aggregate_rows_to_interval(
                [bar.to_aggregation_dict() for bar in base_bars],
                custom_seconds,
                interval=interval,
                source_interval=source_interval,
                source_interval_seconds=source_interval_seconds,
                calendar=calendar,
            )

        return [BarData.from_dict(row) for row in aggregated]
