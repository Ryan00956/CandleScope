"""Retention and startup cleanup service for DataManager."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from app.data_engine.interval_policy import get_tier_for_interval, is_ephemeral_interval

from .cache import BarCache
from .event_bus import DataEventBus
from .models import StorageBackend

logger = logging.getLogger("data_manager.retention")

StorageProvider = Callable[[], StorageBackend | None]


class RetentionService:
    """Owns persistent and ephemeral retention maintenance."""

    def __init__(
        self,
        *,
        cache: BarCache,
        event_bus: DataEventBus,
        storage_provider: StorageProvider,
        db_limits: dict[str, int] | None = None,
    ) -> None:
        self._cache = cache
        self._event_bus = event_bus
        self._storage_provider = storage_provider
        self.db_limits: dict[str, int] = db_limits or {
            "minutes": 200_000,
            "hours": 50_000,
            "daily": 0,
        }

    def update_limits(
        self,
        *,
        db_limits: dict[str, int] | None = None,
        ephemeral_bars: int | None = None,
    ) -> None:
        """Update DB and ephemeral cache retention limits."""
        if db_limits is not None:
            self.db_limits.update(db_limits)
            logger.info("DB retention limits updated: %s", self.db_limits)
        if ephemeral_bars is not None:
            self._cache.set_ephemeral_limit(ephemeral_bars)
            logger.info("Ephemeral cache limit updated: %d bars", ephemeral_bars)

    def snapshot(self) -> dict:
        return {
            "db_limits": dict(self.db_limits),
            "ephemeral_bars": self._cache.get_ephemeral_limit(),
        }

    def run_startup_db_cleanup(self) -> None:
        """One-time DB cleanup at startup. Runs in a thread."""
        storage = self._storage_provider()
        if storage is None:
            return

        try:
            series_list = storage.list_series()
        except Exception as exc:
            logger.warning("Startup cleanup: failed to list series: %s", exc)
            return

        total_deleted = 0
        cleaned_count = 0

        for series in series_list:
            symbol = series.get("symbol", "")
            interval = series.get("interval", "")
            if not symbol or not interval:
                continue

            if is_ephemeral_interval(interval):
                continue

            tier = get_tier_for_interval(interval)
            max_bars = self.db_limits.get(tier, 0)
            if max_bars == 0:
                continue

            try:
                deleted = storage.delete_oldest(
                    symbol=symbol,
                    interval=interval,
                    keep=max_bars,
                )
                if deleted > 0:
                    total_deleted += deleted
                    cleaned_count += 1
                    logger.info(
                        "Startup cleanup: %s@%s deleted %d oldest bars (kept %d)",
                        symbol,
                        interval,
                        deleted,
                        max_bars,
                    )
            except Exception as exc:
                logger.warning(
                    "Startup cleanup failed for %s@%s: %s",
                    symbol,
                    interval,
                    exc,
                )

        if total_deleted > 0:
            logger.info(
                "Startup DB cleanup complete: %d bars deleted across %d series",
                total_deleted,
                cleaned_count,
            )
            print(
                f"[startup] DB cleanup: {total_deleted} bars deleted "
                f"across {cleaned_count} series"
            )
        else:
            logger.info("Startup DB cleanup: all series within limits")

    async def ephemeral_trim_loop(self) -> None:
        """Background loop: trim ephemeral cache series every 30 minutes."""
        try:
            while True:
                await asyncio.sleep(30 * 60)
                await self.run_ephemeral_trim()
        except asyncio.CancelledError:
            pass

    async def run_ephemeral_trim(self) -> None:
        """One pass of ephemeral cache trimming."""
        limit = self._cache.get_ephemeral_limit()
        trimmed_total = 0
        skipped = 0

        for key in self._cache.get_all_keys():
            if not is_ephemeral_interval(key.interval):
                continue

            if self._event_bus.get_subscriber_count(key) > 0:
                skipped += 1
                continue

            trimmed_total += self._cache.trim_series(key, limit)

        if trimmed_total > 0 or skipped > 0:
            logger.info(
                "Ephemeral trim: %d bars trimmed, %d series skipped (active)",
                trimmed_total,
                skipped,
            )
