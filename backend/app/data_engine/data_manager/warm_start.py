"""Warm-start helpers for seeding BarAggregator state."""
from __future__ import annotations

import logging
import inspect
import time
from collections.abc import Callable
from typing import Any

from app.data_engine.interval_policy import (
    is_monthly_interval,
    parse_custom_interval,
    parse_interval_spec,
    parse_monthly_count,
    row_is_closed,
)
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolver,
    IntervalRoute,
    IntervalRouteKind,
)
from app.data_engine.market_data.kline_metrics import declared_enhanced_fields

from ..bar_aggregator import (
    BarAggregator,
    BarInput,
    BarInputSource,
    BarState,
)
from .cache import BarCache
from .backfill_coordinator import priority_for_reason
from .models import BarData, SeriesKey, StorageBackend
from .query import BackfillTrigger

logger = logging.getLogger("data_manager.warm_start")

StorageProvider = Callable[[], StorageBackend | None]
BackfillProvider = Callable[[], BackfillTrigger | None]


class AggregatorWarmStartService:
    """Seeds aggregator state from cache/storage when streams are started."""

    def __init__(
        self,
        *,
        cache: BarCache,
        bar_aggregator: BarAggregator,
        base_interval: str,
        storage_provider: StorageProvider,
        backfill_trigger_provider: BackfillProvider,
        interval_resolver: IntervalResolver | None = None,
    ) -> None:
        self._cache = cache
        self._bar_aggregator = bar_aggregator
        self._base_interval = base_interval
        self._storage_provider = storage_provider
        self._backfill_trigger_provider = backfill_trigger_provider
        self._interval_resolver = interval_resolver or IntervalResolver()

    async def seed_if_needed(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        had_stream: bool,
        focus_scope: str = "foreground",
        subscription_tier: str | None = None,
    ) -> None:
        """Seed the relevant active bucket after DataManager starts a stream."""
        market_type = self._normalize_market_type(market_type)
        route = self._interval_resolver.resolve(
            exchange=exchange,
            market_type=market_type,
            interval=interval,
            purpose=IntervalPurpose.REALTIME,
        )
        interval = route.canonical_interval
        if route.kind is IntervalRouteKind.DERIVED:
            try:
                await self._seed_custom_interval(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    focus_scope=focus_scope,
                    subscription_tier=subscription_tier,
                    route=route,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to seed active custom bucket for %s@%s: %s",
                    symbol,
                    interval,
                    exc,
                    exc_info=True,
                )
            if not had_stream:
                self._trigger_custom_tail_repair(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                    focus_scope=focus_scope,
                    subscription_tier=subscription_tier,
                    route=route,
                )
            return

        if had_stream:
            return

        try:
            await self._seed_standard_interval(
                symbol,
                interval,
                exchange=exchange,
                market_type=market_type,
            )
        except Exception as exc:
            logger.warning(
                "Failed to seed standard interval %s@%s: %s",
                symbol,
                interval,
                exc,
                exc_info=True,
            )

    async def _seed_custom_interval(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        focus_scope: str = "foreground",
        subscription_tier: str | None = None,
        route: IntervalRoute | None = None,
    ) -> None:
        """Seed the currently-forming custom bucket from recent base bars."""
        symbol = symbol.upper()
        exchange = exchange.strip().lower()
        market_type = self._normalize_market_type(market_type)
        storage = self._storage_provider()
        if storage is None:
            return

        base_interval = route.base_interval if route is not None else self._base_interval
        if base_interval is None:
            raise ValueError("derived warm-start route has no base interval")
        base_seconds = parse_custom_interval(base_interval) or 60
        base_spec = parse_interval_spec(base_interval)
        now_ms = int(time.time() * 1000)
        bucket_start_ms = self._bar_aggregator.compute_bucket(interval, now_ms)
        if bucket_start_ms is None:
            return
        prev_bucket_start_ms = self._bar_aggregator.previous_bucket(interval, bucket_start_ms)
        fetch_start_ms = (
            prev_bucket_start_ms
            if prev_bucket_start_ms is not None
            else bucket_start_ms
        )

        rows = storage.query_bars(
            symbol=symbol,
            interval=base_interval,
            start_ms=fetch_start_ms,
            end_ms=now_ms,
            order="ASC",
            exchange=exchange,
            market_type=market_type,
        )
        base_key = SeriesKey(symbol, base_interval, exchange=exchange, market_type=market_type)
        rows_by_open_time = {int(row["open_time"]): dict(row) for row in rows}
        for open_time_ms, row in rows_by_open_time.items():
            row.setdefault(
                "close_time",
                (
                    base_spec.next_ms(open_time_ms) - 1
                    if base_spec is not None
                    else open_time_ms + (base_seconds * 1000) - 1
                ),
            )

        cached_rows = self._cache.query(
            base_key,
            start_time=fetch_start_ms // 1000,
            end_time=now_ms // 1000,
        )
        for cached in cached_rows:
            open_time_ms = cached.time * 1000
            if open_time_ms < fetch_start_ms:
                continue

            close_time_ms = (
                base_spec.next_ms(open_time_ms) - 1
                if base_spec is not None
                else open_time_ms + (base_seconds * 1000) - 1
            )
            rows_by_open_time[open_time_ms] = {
                "open_time": open_time_ms,
                "close_time": close_time_ms,
                "open": cached.open,
                "high": cached.high,
                "low": cached.low,
                "close": cached.close,
                "volume": cached.volume,
                "quote_volume": cached.quote_volume,
                "trades": cached.trades,
                "taker_buy_base": cached.taker_buy_base,
                "taker_buy_quote": cached.taker_buy_quote,
                "enhanced_fields": sorted(cached.enhanced_fields),
                "is_closed": bool(cached.is_closed),
            }

        if not is_monthly_interval(interval):
            elapsed_in_bucket_ms = now_ms - bucket_start_ms
            expected_closed_components = max(
                0,
                int(elapsed_in_bucket_ms / (base_seconds * 1000)),
            )
            actual_in_bucket = sum(
                1
                for open_time in rows_by_open_time
                if bucket_start_ms <= open_time < now_ms
            )
            if expected_closed_components > 0 and actual_in_bucket < expected_closed_components:
                missing = expected_closed_components - actual_in_bucket
                logger.warning(
                    "Custom seed %s@%s: expected %d base bars in current bucket "
                    "but found %d (%d missing). Triggering base backfill.",
                    symbol,
                    interval,
                    expected_closed_components,
                    actual_in_bucket,
                    missing,
                )
                try:
                    self._call_backfill_trigger(
                        symbol=symbol,
                        interval=base_interval,
                        start_ms=bucket_start_ms,
                        end_ms=now_ms,
                        exchange=exchange,
                        market_type=market_type,
                        reason=self._warmup_reason(focus_scope, subscription_tier),
                        requester="warm_start_custom_seed",
                        metadata={
                            "focus_scope": focus_scope,
                            "subscription_tier": subscription_tier,
                            "requested_interval": interval,
                            "base_interval": base_interval,
                            "had_stream": True,
                        },
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to trigger base backfill during custom seed: %s",
                        exc,
                    )
        else:
            logger.debug(
                "Custom seed %s@%s: skipping completeness check for monthly interval",
                symbol,
                interval,
            )

        if not rows_by_open_time:
            return

        rows = sorted(rows_by_open_time.values(), key=lambda row: int(row["open_time"]))
        current_state = self._bar_aggregator.get_bucket_state(
            symbol,
            interval,
            bucket_start_ms,
            exchange=exchange,
            market_type=market_type,
        )
        if self._custom_bucket_is_synced(
            current_state,
            rows,
            exchange=exchange,
            market_type=market_type,
        ):
            self._cache.upsert(
                SeriesKey(symbol, interval, exchange=exchange, market_type=market_type),
                BarData.from_bar_state(current_state),
            )
            return

        components: list[BarInput] = []
        for row in rows:
            open_time_ms = int(row["open_time"])
            close_time_ms = int(
                row.get("close_time", open_time_ms + (base_seconds * 1000) - 1)
            )
            is_closed = close_time_ms < now_ms
            explicit_fields = row.get("enhanced_fields")
            if isinstance(explicit_fields, (str, bytes, dict)):
                explicit_fields = ()
            components.append(BarInput(
                symbol=symbol,
                source_interval=base_interval,
                exchange=exchange,
                open_time_ms=open_time_ms,
                close_time_ms=close_time_ms,
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row.get("volume", 0)),
                source=BarInputSource.BACKFILL if is_closed else BarInputSource.REALTIME,
                is_closed=is_closed,
                market_type=market_type,
                quote_volume=float(row.get("quote_volume", 0) or 0),
                trades=int(row.get("trades", 0) or 0),
                taker_buy_base=float(row.get("taker_buy_base", 0) or 0),
                taker_buy_quote=float(row.get("taker_buy_quote", 0) or 0),
                enhanced_fields=declared_enhanced_fields(
                    exchange,
                    market_type,
                    row,
                    explicit_fields=explicit_fields,
                ),
                sequence=open_time_ms,
            ))

        rebuilt_state = await self._bar_aggregator.replay_components(
            symbol,
            interval,
            components,
            exchange,
            market_type,
            bucket_start_ms=bucket_start_ms,
            expire_existing=True,
            emit_events=True,
        )
        if rebuilt_state is not None:
            self._cache.upsert(
                SeriesKey(symbol, interval, exchange=exchange, market_type=market_type),
                BarData.from_bar_state(rebuilt_state),
            )

    @staticmethod
    def _custom_bucket_is_synced(
        state: BarState | None,
        rows: list[dict],
        *,
        exchange: str,
        market_type: str,
    ) -> bool:
        """Check whether the in-memory custom bar matches its base parts."""
        if state is None or not rows:
            return False

        rows = [
            row
            for row in rows
            if state.bucket_start_ms
            <= int(row["open_time"])
            < state.bucket_end_ms
        ]
        if not rows:
            return False

        first = rows[0]
        last = rows[-1]
        field_sets: list[frozenset[str]] = []
        for row in rows:
            explicit_fields = row.get("enhanced_fields")
            if isinstance(explicit_fields, (str, bytes, dict)):
                explicit_fields = ()
            field_sets.append(declared_enhanced_fields(
                exchange,
                market_type,
                row,
                explicit_fields=explicit_fields,
            ))
        components_are_contiguous = (
            int(first["open_time"]) == state.bucket_start_ms
            and all(
                int(current["open_time"]) == int(previous["close_time"]) + 1
                for previous, current in zip(rows, rows[1:])
            )
        )
        last_close_time = int(last.get("close_time", last["open_time"]))
        last_is_forming = (
            not row_is_closed(last)
            or last_close_time >= int(time.time() * 1000)
        )
        covers_available_bucket = (
            last_close_time + 1 >= state.bucket_end_ms
            or last_is_forming
        )
        expected_enhanced_fields = (
            frozenset.intersection(*field_sets)
            if components_are_contiguous and covers_available_bucket
            else frozenset()
        )
        expected = {
            "open": float(first["open"]),
            "high": max(float(row["high"]) for row in rows),
            "low": min(float(row["low"]) for row in rows),
            "close": float(last["close"]),
            "volume": round(sum(float(row.get("volume", 0) or 0) for row in rows), 8),
            "quote_volume": round(
                sum(float(row.get("quote_volume", 0) or 0) for row in rows),
                8,
            ),
            "trades": sum(int(row.get("trades", 0) or 0) for row in rows),
            "taker_buy_base": round(
                sum(float(row.get("taker_buy_base", 0) or 0) for row in rows),
                8,
            ),
            "taker_buy_quote": round(
                sum(float(row.get("taker_buy_quote", 0) or 0) for row in rows),
                8,
            ),
            "components": len(rows),
            "enhanced_fields": expected_enhanced_fields,
        }

        def _same(a: float, b: float, tol: float = 1e-8) -> bool:
            return abs(float(a) - float(b)) <= tol

        return (
            _same(state.open, expected["open"])
            and _same(state.high, expected["high"])
            and _same(state.low, expected["low"])
            and _same(state.close, expected["close"])
            and _same(state.volume, expected["volume"])
            and _same(state.quote_volume, expected["quote_volume"])
            and state.trades == expected["trades"]
            and _same(state.taker_buy_base, expected["taker_buy_base"])
            and _same(state.taker_buy_quote, expected["taker_buy_quote"])
            and state.enhanced_fields == expected["enhanced_fields"]
            and state.tick_count == expected["components"]
        )

    async def _seed_standard_interval(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Seed the BarAggregator with the currently-forming standard bar."""
        symbol = symbol.upper()
        exchange = exchange.strip().lower()
        market_type = self._normalize_market_type(market_type)
        storage = self._storage_provider()
        if storage is None:
            return

        interval_seconds = parse_custom_interval(interval) or 60
        interval_ms = interval_seconds * 1000
        now_ms = int(time.time() * 1000)
        bucket_start_ms = self._bar_aggregator.compute_bucket(interval, now_ms)
        if bucket_start_ms is None:
            return

        if self._bar_aggregator.get_bucket_state(
            symbol,
            interval,
            bucket_start_ms,
            exchange=exchange,
            market_type=market_type,
        ) is not None:
            return

        rows = storage.query_bars(
            symbol=symbol,
            interval=interval,
            start_ms=bucket_start_ms,
            end_ms=bucket_start_ms,
            limit=1,
            order="ASC",
            exchange=exchange,
            market_type=market_type,
        )
        if not rows:
            return

        row = rows[0]
        open_time_ms = int(row["open_time"])
        if open_time_ms != bucket_start_ms:
            return

        close_time_ms = int(row.get("close_time", open_time_ms + interval_ms - 1))
        enhanced_fields = declared_enhanced_fields(
            exchange,
            market_type,
            row,
        )
        bar_input = BarInput(
            symbol=symbol,
            source_interval=interval,
            exchange=exchange,
            open_time_ms=open_time_ms,
            close_time_ms=close_time_ms,
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=float(row.get("volume", 0)),
            source=BarInputSource.MANUAL,
            is_closed=False,
            market_type=market_type,
            quote_volume=float(row.get("quote_volume", 0) or 0),
            trades=int(row.get("trades", 0) or 0),
            taker_buy_base=float(row.get("taker_buy_base", 0) or 0),
            taker_buy_quote=float(row.get("taker_buy_quote", 0) or 0),
            enhanced_fields=enhanced_fields,
            sequence=open_time_ms,
        )

        await self._bar_aggregator.seed_active_bar(
            symbol,
            interval,
            bar_input,
            exchange=exchange,
            market_type=market_type,
            emit_events=False,
        )
        logger.debug(
            "Seeded standard interval %s@%s: bucket=%d OHLCV=(%s,%s,%s,%s) V=%s",
            symbol,
            interval,
            bucket_start_ms,
            row["open"],
            row["high"],
            row["low"],
            row["close"],
            row.get("volume", 0),
        )

    def _trigger_custom_tail_repair(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        focus_scope: str = "foreground",
        subscription_tier: str | None = None,
        route: IntervalRoute | None = None,
    ) -> None:
        """Force a recent custom-interval rebuild to overwrite stale rows."""
        interval_seconds = parse_custom_interval(interval) or 60
        now_ms = int(time.time() * 1000)

        month_count = parse_monthly_count(interval)
        if month_count is not None:
            repair_window_ms = month_count * 2 * 31 * 86_400 * 1000
        else:
            repair_window_ms = min(
                max(interval_seconds * 16 * 1000, 6 * 60 * 60 * 1000),
                7 * 24 * 60 * 60 * 1000,
            )
        start_ms = max(0, now_ms - repair_window_ms)

        try:
            self._call_backfill_trigger(
                symbol=symbol.upper(),
                interval=interval,
                start_ms=start_ms,
                end_ms=now_ms,
                exchange=exchange,
                market_type=self._normalize_market_type(market_type),
                reason=self._warmup_reason(focus_scope, subscription_tier),
                requester="warm_start_custom_tail",
                metadata={
                    "focus_scope": focus_scope,
                    "subscription_tier": subscription_tier,
                    "requested_interval": interval,
                    "base_interval": (
                        route.base_interval if route is not None else self._base_interval
                    ),
                    "had_stream": False,
                },
            )
        except Exception as exc:
            logger.warning(
                "Failed to trigger custom tail repair for %s@%s: %s",
                symbol,
                interval,
                exc,
                exc_info=True,
            )

    def _call_backfill_trigger(
        self,
        *,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str,
        market_type: str,
        reason: str,
        requester: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        trigger = self._backfill_trigger_provider()
        if trigger is None:
            return
        raw_kwargs = {
            "reason": reason,
            "priority": priority_for_reason(reason),
            "requester": requester,
            "metadata": {
                key: value
                for key, value in (metadata or {}).items()
                if value is not None
            },
        }
        kwargs: dict[str, Any] = {
            key: value
            for key, value in raw_kwargs.items()
            if value is not None
        }
        try:
            signature = inspect.signature(trigger)
            supports_kwargs = any(
                param.kind is inspect.Parameter.VAR_KEYWORD
                for param in signature.parameters.values()
            )
            if not supports_kwargs:
                kwargs = {
                    key: value
                    for key, value in kwargs.items()
                    if key in signature.parameters
                }
        except (TypeError, ValueError):
            pass

        trigger(symbol, interval, start_ms, end_ms, exchange, market_type, **kwargs)

    @staticmethod
    def _warmup_reason(focus_scope: str, subscription_tier: str | None) -> str:
        if str(subscription_tier or "").lower() == "full":
            return "full_subscription_warmup"
        if str(focus_scope or "").lower() == "subscription":
            return "full_subscription_warmup"
        return "visible_seed_gap"

    @staticmethod
    def _normalize_market_type(market_type: str) -> str:
        return (market_type or "spot").strip().lower()
