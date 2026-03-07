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
from typing import AsyncIterator

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
from .metrics import LayerMetrics
from .transport import TransportLayer, TransportError
from .session import SessionLayer
from .feed_control import FeedControlLayer
from .normalize import NormalizeLayer
from .continuity import ContinuityLayer
from .delivery import DeliveryLayer

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
    "FeedControlLayer",
    "NormalizeLayer",
    "ContinuityLayer",
    "DeliveryLayer",
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
    ) -> None:
        self.descriptor = descriptor

        # Build layers
        self.feed_control = FeedControlLayer(config, transport, descriptor)
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
        self._pipelines: dict[str, StreamPipeline] = {}
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

    async def add_stream(self, descriptor: StreamDescriptor) -> StreamPipeline:
        """Create and start a new stream pipeline.

        Raises ValueError if the stream is already running.
        """
        descriptor.validate()
        key = descriptor.key

        if key in self._pipelines:
            raise ValueError(f"Stream already exists: {key}")

        if not self._started:
            await self.start()

        pipeline = StreamPipeline(self._cfg, self._transport, descriptor)
        self._pipelines[key] = pipeline
        await pipeline.start()
        logger.info("Stream added: %s", key)
        return pipeline

    async def remove_stream(self, key: str) -> None:
        """Stop and remove a stream pipeline."""
        pipeline = self._pipelines.pop(key, None)
        if pipeline:
            await pipeline.stop()
            logger.info("Stream removed: %s", key)

    def get_pipeline(self, key: str) -> StreamPipeline | None:
        """Get a pipeline by its key."""
        return self._pipelines.get(key)

    # ── Observability ────────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "started": self._started,
            "transport": self._transport.snapshot(),
            "pipelines": {
                key: p.snapshot() for key, p in self._pipelines.items()
            },
        }
