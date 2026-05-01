"""Bridge BarAggregator events into DataManager cache, storage, and bus."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from app.data_engine.interval_policy import is_ephemeral_interval

from ..bar_aggregator import BarEvent, BarEventType, BarState
from .cache import BarCache
from .event_bus import DataEventBus
from .models import BarData, DataEvent, DataEventType, SeriesKey, StorageBackend

logger = logging.getLogger("data_manager.aggregator_bridge")

StorageProvider = Callable[[], StorageBackend | None]
StartedProvider = Callable[[], bool]
StreamMarker = Callable[[SeriesKey], None]


class AggregatorBridge:
    """Owns BarAggregator output handling for DataManager."""

    def __init__(
        self,
        *,
        cache: BarCache,
        event_bus: DataEventBus,
        storage_provider: StorageProvider,
        mark_bar_received: StreamMarker,
        is_started: StartedProvider,
    ) -> None:
        self._cache = cache
        self._event_bus = event_bus
        self._storage_provider = storage_provider
        self._mark_bar_received = mark_bar_received
        self._is_started = is_started

    async def on_bar_event(self, event: BarEvent) -> None:
        """Convert an aggregator event into cache updates and DataEvents."""
        if not self._is_started():
            return

        bar_state: BarState = event.bar
        bar_data = BarData.from_bar_state(bar_state)
        key = SeriesKey(
            bar_state.symbol,
            bar_state.interval,
            exchange=bar_state.exchange,
            market_type=bar_state.market_type,
        )

        dm_event_type = {
            BarEventType.CREATED: DataEventType.BAR_CREATED,
            BarEventType.UPDATED: DataEventType.BAR_UPDATED,
            BarEventType.CLOSED: DataEventType.BAR_CLOSED,
            BarEventType.AMENDED: DataEventType.BAR_AMENDED,
            BarEventType.EXPIRED: DataEventType.BAR_EXPIRED,
        }.get(event.event_type, DataEventType.BAR_UPDATED)

        await self._persist_bar_event(bar_state, dm_event_type)

        if dm_event_type == DataEventType.BAR_CLOSED:
            self._cache.append(key, bar_data)
        elif dm_event_type in (
            DataEventType.BAR_CREATED,
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_AMENDED,
        ):
            self._cache.upsert(key, bar_data)

        self._mark_bar_received(key)

        dm_event = DataEvent(
            event_type=dm_event_type,
            key=key,
            bar=bar_data,
        )
        if event.previous_bar is not None:
            dm_event.previous_bar = BarData.from_bar_state(event.previous_bar)

        await self._event_bus.emit(dm_event)

    async def _persist_bar_event(
        self,
        bar_state: BarState,
        event_type: DataEventType,
    ) -> None:
        """Persist finalized or corrected bars so storage matches live state."""
        if is_ephemeral_interval(bar_state.interval):
            return

        storage = self._storage_provider()
        if storage is None:
            return

        if event_type not in (DataEventType.BAR_CLOSED, DataEventType.BAR_AMENDED):
            return

        row = bar_state.to_storage_dict()
        source = (
            "data_manager_amended"
            if event_type == DataEventType.BAR_AMENDED
            else "data_manager_closed"
        )
        try:
            await asyncio.to_thread(
                storage.upsert_bars,
                bar_state.symbol,
                bar_state.interval,
                [row],
                source,
                bar_state.exchange,
                bar_state.market_type,
            )
        except Exception as exc:
            logger.warning(
                "Failed to persist %s for %s@%s %s: %s",
                event_type.value,
                bar_state.symbol,
                bar_state.interval,
                bar_state.bucket_start_ms,
                exc,
                exc_info=True,
            )
