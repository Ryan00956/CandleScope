"""Host-owned lifecycle for a sidecar-backed ``candlescope.stream/1`` feed."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    ProviderStreamDescriptor,
    validate_provider_stream_batch,
    validate_provider_stream_close,
    validate_provider_stream_open,
)

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.metrics import LayerMetrics
from app.data_engine.ingestion.models import (
    DataSource,
    FeedMode,
    RawMessage,
    SessionHealth,
    StreamDescriptor,
)
from app.data_engine.ingestion.session_types import HealthCallback, MessageCallback


logger = logging.getLogger("plugin_provider_v2.session")
InvokeProvider = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class ProviderStreamSession:
    """Poll a supervised sidecar stream while isolating crashes and sequence drift."""

    def __init__(
        self,
        *,
        config: IngestionConfig,
        descriptor: StreamDescriptor,
        provider_descriptor: ProviderStreamDescriptor,
        channel_configuration: dict[str, Any],
        invoke: InvokeProvider,
    ) -> None:
        self._cfg = config
        self._descriptor = descriptor
        self._provider_descriptor = provider_descriptor
        self._channel = channel_configuration
        self._invoke = invoke
        self._metrics = LayerMetrics("L2_ProviderStream")
        self._health = SessionHealth.DISCONNECTED
        self._on_message: MessageCallback | None = None
        self._on_health_change: HealthCallback | None = None
        self._running = False
        self._task: asyncio.Task[None] | None = None
        self._provider_stream_id: str | None = None
        self._generation: int | None = None
        self._next_sequence = 1
        self._book_last_update_id: int | None = None
        self._consecutive_failures = 0
        self._last_message_time = 0.0

    @property
    def health(self) -> SessionHealth:
        return self._health

    @property
    def feed_mode(self) -> FeedMode:
        return FeedMode.PLUGIN_STREAM

    @property
    def manages_recovery_while_http(self) -> bool:
        return True

    @property
    def http_fallback_health_states(self) -> frozenset[SessionHealth]:
        if not self._channel["history"]:
            return frozenset()
        return frozenset({SessionHealth.UNHEALTHY})

    def on_message(self, callback: MessageCallback) -> None:
        self._on_message = callback

    def on_health_change(self, callback: HealthCallback) -> None:
        self._on_health_change = callback

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(
            self._run(), name=f"provider_stream_{self._descriptor.key}"
        )

    async def stop(self) -> None:
        self._running = False
        current = asyncio.current_task()
        task = self._task
        self._task = None
        if task is not None and not task.done() and task is not current:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._close_provider_stream()
        await self._set_health(SessionHealth.DISCONNECTED, "stopped")

    async def invalidate(self, reason: str) -> None:
        self._metrics.set("invalidated_reason", reason)
        await self.stop()

    def snapshot(self) -> dict[str, Any]:
        return {
            "layer": "L2_ProviderStream",
            "stream_key": self._descriptor.key,
            "data_plane": "candlescope.stream/1",
            "health": self._health.value,
            "provider_stream_id": self._provider_stream_id,
            "generation": self._generation,
            "next_sequence": self._next_sequence,
            "book_last_update_id": self._book_last_update_id,
            "consecutive_failures": self._consecutive_failures,
            "last_message_time": self._last_message_time,
            "metrics": self._metrics.snapshot(),
        }

    async def _run(self) -> None:
        delay = float(self._cfg.ws_reconnect_delay_initial)
        resync = False
        while self._running:
            try:
                await self._set_health(
                    SessionHealth.RECONNECTING if resync else SessionHealth.CONNECTING,
                    "provider stream reconnecting"
                    if resync
                    else "provider stream opening",
                )
                await self._open_provider_stream(resync=resync)
                self._consecutive_failures = 0
                delay = float(self._cfg.ws_reconnect_delay_initial)
                await self._set_health(
                    SessionHealth.CONNECTED, "provider stream connected"
                )
                await self._poll_until_failure()
                if self._running:
                    raise RuntimeError("provider stream ended unexpectedly")
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._metrics.inc("stream_failures")
                self._metrics.mark("last_failure_at")
                self._consecutive_failures += 1
                logger.warning(
                    "Provider stream failed (%s): %s",
                    self._descriptor.key,
                    exc,
                )
                await self._close_provider_stream()
                health = (
                    SessionHealth.UNHEALTHY
                    if self._consecutive_failures
                    >= self._cfg.ws_consecutive_failure_threshold
                    else SessionHealth.RECONNECTING
                )
                await self._set_health(health, str(exc)[:256])
                if not self._running:
                    break
                await asyncio.sleep(min(delay, self._cfg.ws_reconnect_delay_max))
                delay = min(delay * 2, self._cfg.ws_reconnect_delay_max)
                resync = True
        await self._close_provider_stream()

    async def _open_provider_stream(self, *, resync: bool) -> None:
        host_stream_id = "host-" + uuid.uuid4().hex
        raw = await self._invoke(
            {
                "operation": "stream.open",
                "hostStreamId": host_stream_id,
                "descriptor": self._provider_descriptor.to_wire(),
                "batchLimit": self._channel["maxBatch"],
                "resync": resync,
            }
        )
        opened = validate_provider_stream_open(
            raw, expected_host_stream_id=host_stream_id
        )
        self._provider_stream_id = opened["providerStreamId"]
        self._generation = opened["generation"]
        self._next_sequence = opened["nextSequence"]
        self._book_last_update_id = None
        self._metrics.inc("streams_opened")

    async def _poll_until_failure(self) -> None:
        while self._running:
            if self._provider_stream_id is None or self._generation is None:
                raise RuntimeError("provider stream is not open")
            raw = await self._invoke(
                {
                    "operation": "stream.poll",
                    "providerStreamId": self._provider_stream_id,
                    "afterSequence": self._next_sequence - 1,
                    "batchLimit": self._channel["maxBatch"],
                    "waitMs": min(5_000, self._channel["pollIntervalMs"]),
                }
            )
            batch = validate_provider_stream_batch(
                raw,
                expected_provider_stream_id=self._provider_stream_id,
                expected_generation=self._generation,
                expected_descriptor=self._provider_descriptor,
                max_events=self._channel["maxBatch"],
            )
            if batch["firstSequence"] != self._next_sequence:
                raise ValueError("provider transport sequence is not contiguous")
            next_book_id = self._validate_book_batch(batch["events"])
            for event in batch["events"]:
                message = RawMessage(
                    payload={
                        "eventType": event["eventType"],
                        "providerSequence": event["sequence"],
                        "payload": event["payload"],
                        "sourceQuality": batch["sourceQuality"],
                    },
                    source=DataSource.PLUGIN,
                    stream_type=self._descriptor.stream_type,
                    received_at_ms=int(time.time() * 1_000),
                    endpoint=f"plugin://{self._descriptor.exchange}",
                )
                if self._on_message is not None:
                    await self._on_message(message)
                self._last_message_time = time.monotonic()
                self._metrics.inc("events_forwarded")
            self._book_last_update_id = next_book_id
            self._next_sequence = batch["nextSequence"]
            self._metrics.inc("batches_received")
            self._metrics.mark("last_batch_at")
            if self._channel["pollIntervalMs"] > 0:
                await asyncio.sleep(self._channel["pollIntervalMs"] / 1_000)

    def _validate_book_batch(self, events: list[dict[str, Any]]) -> int | None:
        if self._provider_descriptor.channel != "full_depth":
            return None
        last_update_id = self._book_last_update_id
        max_depth_levels = int(self._channel["maxDepthLevels"])
        for event in events:
            payload = event["payload"]
            if (
                len(payload["bids"]) > max_depth_levels
                or len(payload["asks"]) > max_depth_levels
            ):
                raise ValueError("provider order book exceeds its declared depth")
            if event["eventType"] == "orderbook.snapshot":
                last_update_id = int(payload["lastUpdateId"])
                continue
            if last_update_id is None:
                raise ValueError("provider order book must begin with a snapshot")
            first_id = int(payload["firstUpdateId"])
            final_id = int(payload["finalUpdateId"])
            previous_id = int(payload["previousFinalUpdateId"])
            if (
                previous_id != last_update_id
                or first_id > last_update_id + 1
                or final_id < last_update_id + 1
            ):
                raise ValueError("provider order-book delta sequence has a gap")
            last_update_id = final_id
        return last_update_id

    async def _close_provider_stream(self) -> None:
        stream_id = self._provider_stream_id
        self._provider_stream_id = None
        self._generation = None
        self._book_last_update_id = None
        if stream_id is None:
            return
        with contextlib.suppress(Exception):
            raw = await self._invoke(
                {"operation": "stream.close", "providerStreamId": stream_id}
            )
            validate_provider_stream_close(raw, expected_provider_stream_id=stream_id)
        self._metrics.inc("streams_closed")

    async def _set_health(self, health: SessionHealth, reason: str) -> None:
        if health == self._health:
            return
        self._health = health
        self._metrics.set("health", health.value)
        self._metrics.mark("health_changed_at")
        if self._on_health_change is not None:
            await self._on_health_change(health, reason)
