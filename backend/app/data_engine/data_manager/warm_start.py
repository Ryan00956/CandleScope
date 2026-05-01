"""Warm-start helpers for seeding BarAggregator state."""
from __future__ import annotations

import logging
import time
from collections.abc import Callable

from app.data_engine.interval_policy import (
    is_monthly_interval,
    is_standard_interval,
    parse_custom_interval,
    parse_monthly_count,
)

from ..bar_aggregator import (
    BarAggregator,
    BarInput,
    BarInputSource,
    BarState,
)
from .cache import BarCache
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
    ) -> None:
        self._cache = cache
        self._bar_aggregator = bar_aggregator
        self._base_interval = base_interval
        self._storage_provider = storage_provider
        self._backfill_trigger_provider = backfill_trigger_provider

    async def seed_if_needed(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        had_stream: bool,
    ) -> None:
        """Seed the relevant active bucket after DataManager starts a stream."""
        market_type = self._normalize_market_type(market_type)
        if not is_standard_interval(interval):
            try:
                await self._seed_custom_interval(
                    symbol,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
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
    ) -> None:
        """Seed the currently-forming custom bucket from recent base bars."""
        symbol = symbol.upper()
        exchange = exchange.strip().lower()
        market_type = self._normalize_market_type(market_type)
        storage = self._storage_provider()
        if storage is None:
            return

        base_interval = self._base_interval
        base_seconds = parse_custom_interval(base_interval) or 60
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

        cached_rows = self._cache.query(
            base_key,
            start_time=fetch_start_ms // 1000,
            end_time=now_ms // 1000,
        )
        for cached in cached_rows:
            open_time_ms = cached.time * 1000
            if open_time_ms < fetch_start_ms:
                continue

            close_time_ms = open_time_ms + (base_seconds * 1000) - 1
            rows_by_open_time[open_time_ms] = {
                "open_time": open_time_ms,
                "close_time": close_time_ms,
                "open": cached.open,
                "high": cached.high,
                "low": cached.low,
                "close": cached.close,
                "volume": cached.volume,
                "quote_volume": 0.0,
                "trades": 0,
                "taker_buy_base": 0.0,
                "taker_buy_quote": 0.0,
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
                trigger = self._backfill_trigger_provider()
                if trigger is not None:
                    try:
                        trigger(
                            symbol,
                            base_interval,
                            bucket_start_ms,
                            now_ms,
                            exchange,
                            market_type,
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
        if self._custom_bucket_is_synced(current_state, rows):
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
    def _custom_bucket_is_synced(state: BarState | None, rows: list[dict]) -> bool:
        """Check whether the in-memory custom bar matches its base parts."""
        if state is None or not rows:
            return False

        first = rows[0]
        last = rows[-1]
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
    ) -> None:
        """Force a recent custom-interval rebuild to overwrite stale rows."""
        trigger = self._backfill_trigger_provider()
        if trigger is None:
            return

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
            trigger(
                symbol.upper(),
                interval,
                start_ms,
                now_ms,
                exchange,
                self._normalize_market_type(market_type),
            )
        except Exception as exc:
            logger.warning(
                "Failed to trigger custom tail repair for %s@%s: %s",
                symbol,
                interval,
                exc,
                exc_info=True,
            )

    @staticmethod
    def _normalize_market_type(market_type: str) -> str:
        return (market_type or "spot").strip().lower()
