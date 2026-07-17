"""Daily open resolver for price snapshots."""
from __future__ import annotations

import logging
import inspect
from collections.abc import Callable
from typing import Any

from app.data_engine.interval_policy import (
    compute_bucket_start_ms,
    last_closed_bar_open_ms,
)

from .backfill_coordinator import priority_for_reason
from .price_cache import PriceSnapshot
from .query import BackfillTrigger

logger = logging.getLogger("data_manager.daily_open")

DAY_MS = 86_400_000


class DailyOpenService:
    """Resolve the current daily open without backfilling a forming 1d bar."""

    def __init__(
        self,
        *,
        storage_provider: Callable[[], Any | None],
        backfill_trigger_provider: Callable[[], BackfillTrigger | None],
    ) -> None:
        self._storage_provider = storage_provider
        # Kept in the constructor for DataManager/API compatibility.  The
        # historical fetcher intentionally admits only closed candles, so it
        # must not be used to fetch the current (forming) daily candle.
        self._backfill_trigger_provider = backfill_trigger_provider
        self._cache: dict[tuple[str, str, str], tuple[int, float]] = {}
        self._requested: set[tuple[str, str, str, int]] = set()

    async def resolve(self, snapshot: PriceSnapshot) -> float:
        """Return the best daily open for a price snapshot."""
        bucket_start_ms = compute_bucket_start_ms(
            snapshot.updated_at_ms,
            DAY_MS,
            interval="1d",
        )
        key = (snapshot.exchange, snapshot.market_type, snapshot.symbol)
        cached = self._cache.get(key)
        if cached is not None and cached[0] == bucket_start_ms:
            return cached[1]

        storage_open = await self._load_from_storage(snapshot, bucket_start_ms)
        if storage_open > 0:
            self._cache[key] = (bucket_start_ms, storage_open)
            return storage_open

        # The current 1d candle is forming and therefore cannot enter the
        # closed-only history pipeline.  Repair only the first 1m candle of
        # the UTC day once it has closed; its open is the same daily open.
        self._request_open_minute_backfill_once(snapshot, bucket_start_ms)
        return snapshot.daily_open or snapshot.open

    async def _load_from_storage(
        self,
        snapshot: PriceSnapshot,
        bucket_start_ms: int,
    ) -> float:
        storage = self._storage_provider()
        if storage is None:
            return 0.0
        for interval in ("1d", "1m"):
            try:
                rows = storage.query_bars(
                    symbol=snapshot.symbol,
                    interval=interval,
                    start_ms=bucket_start_ms,
                    end_ms=bucket_start_ms,
                    limit=1,
                    order="ASC",
                    exchange=snapshot.exchange,
                    market_type=snapshot.market_type,
                )
            except Exception as exc:
                logger.warning(
                    "Daily open storage query failed for %s:%s:%s@%s: %s",
                    snapshot.exchange,
                    snapshot.market_type,
                    snapshot.symbol,
                    interval,
                    exc,
                )
                continue
            if not rows:
                continue
            try:
                return float(rows[0].get("open", 0) or 0)
            except (TypeError, ValueError):
                continue
        return 0.0

    def _request_open_minute_backfill_once(
        self,
        snapshot: PriceSnapshot,
        bucket_start_ms: int,
    ) -> None:
        last_closed_minute = last_closed_bar_open_ms(snapshot.updated_at_ms, "1m")
        if last_closed_minute is None or last_closed_minute < bucket_start_ms:
            return
        request_key = (
            snapshot.exchange,
            snapshot.market_type,
            snapshot.symbol,
            bucket_start_ms,
        )
        if request_key in self._requested:
            return
        trigger = self._backfill_trigger_provider()
        if trigger is None:
            return
        self._requested.add(request_key)
        try:
            kwargs = self._supported_trigger_kwargs(
                trigger,
                {
                    "reason": "price_daily_open",
                    "priority": priority_for_reason("price_daily_open"),
                    "requester": "daily_open",
                    "metadata": {
                        "focus_scope": "price",
                        "subscription_tier": "price",
                        "requested_interval": "1m",
                        "daily_bucket_start_ms": bucket_start_ms,
                    },
                },
            )
            trigger(
                snapshot.symbol,
                "1m",
                bucket_start_ms,
                bucket_start_ms,
                snapshot.exchange,
                snapshot.market_type,
                **kwargs,
            )
        except Exception as exc:
            self._requested.discard(request_key)
            logger.warning(
                "Daily open minute backfill trigger failed for %s:%s:%s: %s",
                snapshot.exchange,
                snapshot.market_type,
                snapshot.symbol,
                exc,
            )

    @staticmethod
    def _supported_trigger_kwargs(
        trigger: BackfillTrigger,
        kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        filtered = {key: value for key, value in kwargs.items() if value is not None}
        try:
            signature = inspect.signature(trigger)
            supports_kwargs = any(
                param.kind is inspect.Parameter.VAR_KEYWORD
                for param in signature.parameters.values()
            )
            if not supports_kwargs:
                filtered = {
                    key: value
                    for key, value in filtered.items()
                    if key in signature.parameters
                }
        except (TypeError, ValueError):
            pass
        return filtered
