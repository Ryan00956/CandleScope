"""Custom interval query service for QueryEngine."""
from __future__ import annotations

import time
import asyncio
import logging
import threading
from collections.abc import Callable
from typing import Any

from app.data_engine.interval_policy import (
    aggregate_tail_is_closed,
    aggregate_rows_by_month,
    compute_bucket_start,
    compute_bucket_start_ms,
    compute_month_bucket_ms,
    enhanced_components_are_complete,
    find_best_base_interval,
    next_month_bucket,
    parse_custom_interval,
    parse_interval_ms,
    parse_monthly_count,
)
from app.data_engine.market_data.kline_metrics import serialize_kline_enhancements

from .cache import BarCache
from .config import QueryConfig
from .models import BarData, QueryResult, QuerySource, SeriesKey

BaseQuery = Callable[..., QueryResult]
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
    source_interval_seconds: int | None = None,
) -> list[dict]:
    """Aggregate lightweight-chart rows into a custom interval."""
    if not base_rows:
        return []

    buckets: dict[int, list[dict]] = {}
    for row in base_rows:
        ts = row["time"]
        bucket_start = compute_bucket_start(
            ts,
            custom_interval_seconds,
            interval=interval,
        )
        buckets.setdefault(bucket_start, []).append(row)

    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = sorted(buckets[bucket_start], key=lambda row: row["time"])
        bucket_end = bucket_start + custom_interval_seconds
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
            "is_closed": aggregate_tail_is_closed(
                rows,
                bucket_end_seconds=bucket_end,
                source_interval_seconds=source_interval_seconds,
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


class CustomIntervalQueryService:
    """Build custom interval responses from standard interval bars."""

    def __init__(
        self,
        *,
        cache: BarCache,
        config: QueryConfig,
        base_query: BaseQuery,
        bar_aggregator: Any | None = None,
    ) -> None:
        self._cache = cache
        self._cfg = config
        self._base_query = base_query
        self._bar_aggregator = bar_aggregator

    def set_bar_aggregator(self, bar_aggregator: Any | None) -> None:
        """Set the BarAggregator used for closed custom-bucket aggregation."""
        self._bar_aggregator = bar_aggregator

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

        effective_limit = min(limit or self._cfg.default_limit, self._cfg.max_limit)
        base_interval, factor = find_best_base_interval(custom_seconds, interval=interval)
        custom_ms = custom_seconds * 1000

        month_count = parse_monthly_count(interval)
        aligned_start_ms = None
        if start_ms is not None:
            if month_count is not None:
                aligned_start_ms = compute_month_bucket_ms(start_ms, month_count)
            else:
                aligned_start_ms = compute_bucket_start_ms(
                    start_ms,
                    custom_ms,
                    interval=interval,
                )

        if start_ms is not None and end_ms is not None:
            estimated_custom = max(1, ((end_ms - aligned_start_ms) // custom_ms) + 2)
            base_limit = estimated_custom * factor + factor
        else:
            base_limit = (effective_limit + 2) * factor + factor

        base_result = self._base_query(
            symbol,
            base_interval,
            start_ms=aligned_start_ms,
            end_ms=end_ms,
            limit=base_limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
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
        if len(derived_bars) > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        elapsed = time.monotonic() - started_at
        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=base_result.source,
            total=len(derived_bars),
            has_more=base_result.has_more or len(derived_bars) >= effective_limit,
            cache_hit=base_result.cache_hit,
            backfill_triggered=base_result.backfill_triggered,
            has_tail_gap=base_result.has_tail_gap,
            missing_ranges=base_result.missing_ranges,
            metadata={
                "elapsed_ms": round(elapsed * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "base_source": base_result.source.value,
            },
        )

    def query_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
        exchange: str = "binance",
        market_type: str = "spot",
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

        effective_limit = min(limit, self._cfg.max_limit)
        base_interval, factor = find_best_base_interval(custom_seconds, interval=interval)
        custom_ms = custom_seconds * 1000

        month_count = parse_monthly_count(interval)
        if month_count is not None:
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
        base_limit = (effective_limit + 2) * factor

        base_result = self._base_query(
            symbol,
            base_interval,
            end_ms=base_end_ms,
            limit=base_limit,
            exchange=exchange,
            market_type=market_type,
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
        derived_bars = [bar for bar in derived_bars if bar.time_ms < before_ms]
        if len(derived_bars) > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=base_result.source,
            total=len(derived_bars),
            has_more=bool(derived_bars) or base_result.backfill_triggered,
            cache_hit=base_result.cache_hit,
            backfill_triggered=base_result.backfill_triggered,
            missing_ranges=base_result.missing_ranges,
            metadata={
                "elapsed_ms": round((time.monotonic() - started_at) * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "base_source": base_result.source.value,
            },
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

        result = self._aggregate_read_only(
            base_bars,
            interval,
            custom_seconds,
            source_interval=source_interval,
        )
        if self._bar_aggregator is not None and source_interval is not None:
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
                    int(state.bucket_start_ms) // 1000: BarData.from_bar_state(state)
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
    def _aggregate_read_only(
        base_bars: list[BarData],
        interval: str,
        custom_seconds: int,
        *,
        source_interval: str | None = None,
    ) -> list[BarData]:
        """Read-only aggregation used for partial buckets and fallback."""
        source_interval_ms = parse_interval_ms(source_interval) if source_interval else None
        source_interval_seconds = (
            source_interval_ms // 1000
            if source_interval_ms is not None
            else None
        )
        month_count = parse_monthly_count(interval)
        if month_count is not None:
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
                source_interval_seconds=source_interval_seconds,
            )

        return [BarData.from_dict(row) for row in aggregated]
