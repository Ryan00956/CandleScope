"""
Real-time Ingestion — Market Data Ingress Pipeline.

Six-layer architecture:
  L1 Transport   → raw WS / HTTP I/O
  L2 Session     → WS lifecycle, reconnect, health
  L3 FeedControl → WS ↔ HTTP failover
  L4 Normalize   → raw JSON → MarketEvent
  L5 Continuity  → dedup, gap detection, backfill
  L6 Delivery    → fan-out to subscribers (callbacks / async iterators)

Usage::

    from ingestion import MarketDataIngress, StreamDescriptor, StreamType

    ingress = MarketDataIngress()
    await ingress.start()

    # Subscribe to a kline stream
    desc = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
    pipeline = await ingress.add_stream(desc)

    # Consume events
    async for event in pipeline.delivery.subscribe():
        print(event.to_dict())

    # Or use callbacks
    pipeline.delivery.on_market_event(my_handler)

    await ingress.stop()
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable

from .config import IngestionConfig
from .models import (
    StreamType,
    StreamDescriptor,
    MarketEvent,
    GapMarker,
    IngestionEvent,
    FeedMode,
    DataSource,
    SessionHealth,
)
from .transport import TransportLayer, TransportError
from .session import SessionLayer
from .session_types import HealthCallback, SessionLike
from .feed_control import FeedControlLayer
from .normalize import NormalizeLayer
from .continuity import ContinuityLayer
from .delivery import DeliveryLayer, DeliveryQueueSubscriber
from .shared_ws import SharedWsHubRegistry, SharedWsSessionAdapter

logger = logging.getLogger("ingestion")

__all__ = [
    # Config
    "IngestionConfig",
    # Models
    "StreamType",
    "StreamDescriptor",
    "MarketEvent",
    "GapMarker",
    "IngestionEvent",
    "FeedMode",
    "DataSource",
    "SessionHealth",
    # Layers
    "TransportLayer",
    "TransportError",
    "SessionLayer",
    "SessionLike",
    "FeedControlLayer",
    "NormalizeLayer",
    "ContinuityLayer",
    "DeliveryLayer",
    "DeliveryQueueSubscriber",
    # Orchestrator
    "StreamPipeline",
    "MarketDataIngress",
]


class StreamPipeline:
    """A fully-wired L3→L4→L5→L6 pipeline for a single stream.

    Created by ``MarketDataIngress.add_stream()``.
    """

    def __init__(
        self,
        config: IngestionConfig,
        transport: TransportLayer,
        descriptor: StreamDescriptor,
        session_factory: Callable[[], SessionLike] | None = None,
    ) -> None:
        self.descriptor = descriptor

        # Build layers
        self.feed_control = FeedControlLayer(
            config,
            transport,
            descriptor,
            session_factory=session_factory,
        )
        self.normalize = NormalizeLayer(config, descriptor)
        self.continuity = ContinuityLayer(config, transport, descriptor)
        self.delivery = DeliveryLayer(config, descriptor)

        # Wire: L3 → L4 → L5 → L6
        self.feed_control.on_data(self.normalize.ingest)
        self.normalize.on_event(self.continuity.ingest)
        self.continuity.on_event(self.delivery.deliver_event)
        self.continuity.on_gap(self.delivery.deliver_gap)

    async def start(self) -> None:
        await self.feed_control.start()

    async def stop(self) -> None:
        await self.feed_control.stop()
        await self.delivery.close_all_subscribers()

    def on_health_change(self, callback: HealthCallback) -> None:
        """Observe L2 health changes while preserving L3's internal handler."""

        self.feed_control.on_health_change(callback)

    def snapshot(self) -> dict:
        return {
            "stream_key": self.descriptor.key,
            "feed_control": self.feed_control.snapshot(),
            "normalize": self.normalize.snapshot(),
            "continuity": self.continuity.snapshot(),
            "delivery": self.delivery.snapshot(),
        }


class MarketDataIngress:
    """Top-level orchestrator — manages all stream pipelines.

    Owns the shared L1 Transport layer and creates per-stream pipelines.
    """

    def __init__(self, config: IngestionConfig | None = None) -> None:
        self._cfg = config or IngestionConfig()
        self._transport = TransportLayer(self._cfg)
        self._shared_ws = SharedWsHubRegistry(self._cfg, self._transport)
        self._pipelines: dict[str, StreamPipeline] = {}
        self._stream_locks: dict[str, tuple[asyncio.Lock, int]] = {}
        self._started = False

    @property
    def config(self) -> IngestionConfig:
        return self._cfg

    @property
    def transport(self) -> TransportLayer:
        return self._transport

    @property
    def pipelines(self) -> dict[str, StreamPipeline]:
        return dict(self._pipelines)

    # ── Lifecycle ────────────────────────────────────────────

    async def start(self) -> None:
        """Initialize shared resources (HTTP session)."""
        if self._started:
            return
        await self._transport.start()
        self._started = True
        logger.info("MarketDataIngress started")

    async def stop(self) -> None:
        """Stop all pipelines and release resources."""
        for key in list(self._pipelines):
            await self.remove_stream(key)
        await self._transport.stop()
        self._started = False
        logger.info("MarketDataIngress stopped")

    # ── Stream management ────────────────────────────────────

    async def add_stream(
        self,
        descriptor: StreamDescriptor,
        *,
        on_health: HealthCallback | None = None,
    ) -> StreamPipeline:
        """Create and start a new stream pipeline.

        Raises ValueError if the stream is already running.
        """
        descriptor.validate()
        key = descriptor.key
        async with self._hold_stream_lock(key):
            if key in self._pipelines:
                raise ValueError(f"Stream already exists: {key}")

            if not self._started:
                await self.start()

            pipeline = StreamPipeline(
                self._cfg,
                self._transport,
                descriptor,
                session_factory=self._create_session_factory(descriptor),
            )
            if on_health is not None:
                pipeline.on_health_change(on_health)
            self._pipelines[key] = pipeline
            try:
                await pipeline.start()
            except BaseException:
                cleanup_succeeded = False
                try:
                    await asyncio.shield(pipeline.stop())
                    cleanup_succeeded = True
                except BaseException:
                    logger.exception(
                        "Failed to roll back partially started stream: %s",
                        key,
                    )
                if cleanup_succeeded and self._pipelines.get(key) is pipeline:
                    self._pipelines.pop(key, None)
                raise
            logger.info("Stream added: %s", key)
            return pipeline

    async def remove_stream(self, key: str) -> None:
        """Stop and remove a stream pipeline."""
        async with self._hold_stream_lock(key):
            pipeline = self._pipelines.get(key)
            if pipeline:
                await pipeline.stop()
                if self._pipelines.get(key) is pipeline:
                    self._pipelines.pop(key, None)
                logger.info("Stream removed: %s", key)

    def get_pipeline(self, key: str) -> StreamPipeline | None:
        """Get a pipeline by its key."""
        return self._pipelines.get(key)

    @asynccontextmanager
    async def _hold_stream_lock(self, key: str) -> AsyncIterator[None]:
        state = self._stream_locks.get(key)
        if state is None:
            lock = asyncio.Lock()
            users = 0
        else:
            lock, users = state
        self._stream_locks[key] = (lock, users + 1)

        acquired = False
        try:
            await lock.acquire()
            acquired = True
            yield
        finally:
            if acquired:
                lock.release()
            current = self._stream_locks.get(key)
            if current is not None and current[0] is lock:
                remaining = current[1] - 1
                if remaining <= 0:
                    self._stream_locks.pop(key, None)
                else:
                    self._stream_locks[key] = (lock, remaining)

    def _create_session_factory(
        self,
        descriptor: StreamDescriptor,
    ) -> Callable[[], SessionLike] | None:
        shared_hub = self._shared_ws.get_hub(descriptor)
        if shared_hub is not None:
            return lambda: SharedWsSessionAdapter(shared_hub, descriptor)

        if not self._transport.supports_ws(descriptor):
            return None

        return lambda: SessionLayer(
            config=self._cfg,
            transport=self._transport,
            descriptor=descriptor,
        )

    # ── Observability ────────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "started": self._started,
            "transport": self._transport.snapshot(),
            "pipelines": {
                key: p.snapshot() for key, p in self._pipelines.items()
            },
        }
