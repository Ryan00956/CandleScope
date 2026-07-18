"""Single-writer deterministic replay session actor."""

from __future__ import annotations

import asyncio
import inspect
import math
import re
import time
from collections import deque
from dataclasses import dataclass, fields, is_dataclass
from types import MappingProxyType
from typing import Awaitable, Callable, Mapping, Protocol

from .canonical import canonical_sha256
from .checkpoints import CheckpointCodec, CheckpointError, CheckpointRing
from .clock import VirtualClock
from .commands import CommandHistory, CommandResult, ParsedCommand, parse_command
from .constants import (
    REPLAY_CORE_VERSION,
    REPLAY_PROTOCOL,
    CommandType,
    ReplayEventType,
    SessionState,
)
from .errors import ReplayDomainError, ReplayErrorCode
from .events import ReplayEventBuffer
from .models import (
    MAX_TIMESTAMP_MS,
    ReplayCommand,
    ReplayCursor,
    ReplayEvent,
    ReplaySessionConfig,
    validate_counter,
    validate_identifier,
    validate_timestamp_ms,
)
from .projection import ProjectionBatch, ProjectionCoalescer
from .sources.base import ReplayMarketSource


ACTOR_STATE_HASH_SCHEMA_VERSION = "replay-actor-state-hash.v1"
ACTOR_CHECKPOINT_STATE_SCHEMA_VERSION = "replay-actor-checkpoint-state.v2"
SOURCE_CHAIN_SCHEMA_VERSION = "replay-source-chain.v1"
MIN_TASK_EXIT_GRACE_SECONDS = 0.05
MAX_JOURNAL_ENTRIES = 4_096
_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


class ReplayReducer(Protocol):
    def apply_source_event(
        self,
        event: object,
    ) -> Mapping[str, object] | Awaitable[Mapping[str, object]]: ...

    def snapshot(self) -> Mapping[str, object]: ...

    def restore(self, state: Mapping[str, object]) -> None: ...

    def reset(self) -> None: ...

    def has_trading_state(self) -> bool: ...


class NullReplayReducer:
    def apply_source_event(self, event: object) -> Mapping[str, object]:
        del event
        return {}

    def snapshot(self) -> Mapping[str, object]:
        return {}

    def restore(self, state: Mapping[str, object]) -> None:
        if state:
            raise ValueError("null replay reducer cannot restore non-empty state")

    def reset(self) -> None:
        return None

    def has_trading_state(self) -> bool:
        return False


@dataclass(frozen=True, slots=True)
class ActorSnapshot:
    session_id: str
    state: SessionState
    revision: int
    sequence: int
    cursor: ReplayCursor
    state_hash: str
    data_epoch: str
    controller_client_id: str | None
    speed: int | str
    checkpoint_count: int

    def to_dict(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "state": self.state.value,
            "revision": self.revision,
            "sequence": self.sequence,
            "cursor": {
                "virtual_time_ms": self.cursor.virtual_time_ms,
                "source_sequence": self.cursor.source_sequence,
                "last_base_bar_open_ms": self.cursor.last_base_bar_open_ms,
                "last_trade_time_ms": self.cursor.last_trade_time_ms,
                "last_agg_trade_id": self.cursor.last_agg_trade_id,
                "at_end": self.cursor.at_end,
            },
            "state_hash": self.state_hash,
            "data_epoch": self.data_epoch,
            "controller_client_id": self.controller_client_id,
            "speed": self.speed,
            "checkpoint_count": self.checkpoint_count,
        }


@dataclass(frozen=True, slots=True)
class ActorMutation:
    """A candidate actor mutation that must commit before publication/ack."""

    kind: str
    session_id: str
    session_state: Mapping[str, object]
    checkpoint: bytes | None
    events: tuple[ReplayEvent, ...]
    source_events: tuple[Mapping[str, object], ...]
    component_state: Mapping[str, object]
    command: ReplayCommand | None = None
    result: CommandResult | None = None
    error: ReplayDomainError | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "session_state",
            MappingProxyType(dict(self.session_state)),
        )
        object.__setattr__(
            self,
            "source_events",
            tuple(MappingProxyType(dict(event)) for event in self.source_events),
        )
        object.__setattr__(
            self,
            "component_state",
            MappingProxyType(dict(self.component_state)),
        )


@dataclass(frozen=True, slots=True)
class _ActorRollback:
    payload: Mapping[str, object]
    state: SessionState
    status_reason: str
    controller_client_id: str | None
    controller_deadline_wall: float | None


@dataclass(frozen=True, slots=True)
class ActorRecoveryTarget:
    mutations: tuple[Mapping[str, object], ...]
    revision: int
    event_sequence: int
    command_log_offset: int
    state_hash: str

    def __post_init__(self) -> None:
        for name in ("revision", "event_sequence", "command_log_offset"):
            validate_counter(getattr(self, name), field_name=f"recovery {name}")
        if not isinstance(self.state_hash, str) or not _DIGEST_PATTERN.fullmatch(
            self.state_hash
        ):
            raise ValueError("recovery state_hash must be a SHA-256 digest")
        object.__setattr__(
            self,
            "mutations",
            tuple(MappingProxyType(dict(event)) for event in self.mutations),
        )


@dataclass(slots=True)
class ActorStreamSubscription:
    token: int
    initial_events: tuple[ReplayEvent, ...]
    reset: bool
    queue: asyncio.Queue[ReplayEvent]
    overflow: asyncio.Event

    async def next_event(self) -> ReplayEvent:
        if self.overflow.is_set():
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "replay stream subscriber queue overflowed",
            )
        event_task = asyncio.create_task(self.queue.get())
        overflow_task = asyncio.create_task(self.overflow.wait())
        try:
            done, pending = await asyncio.wait(
                {event_task, overflow_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            if overflow_task in done and overflow_task.result():
                if not event_task.done():
                    event_task.cancel()
                    await asyncio.gather(event_task, return_exceptions=True)
                raise ReplayDomainError(
                    ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                    "replay stream subscriber queue overflowed",
                )
            return event_task.result()
        finally:
            for task in (event_task, overflow_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(event_task, overflow_task, return_exceptions=True)


@dataclass(slots=True)
class _CommandRequest:
    command: ReplayCommand
    future: asyncio.Future[CommandResult]
    enqueued_wall: float


@dataclass(slots=True)
class _HeartbeatRequest:
    client_instance_id: str
    future: asyncio.Future[None]


@dataclass(slots=True)
class _SnapshotRequest:
    future: asyncio.Future[ActorSnapshot]


@dataclass(slots=True)
class _PublicSnapshotRequest:
    future: asyncio.Future[dict[str, object]]


@dataclass(slots=True)
class _ReportRequest:
    future: asyncio.Future[Mapping[str, object]]


@dataclass(slots=True)
class _CheckpointRequest:
    future: asyncio.Future[bytes]


@dataclass(slots=True)
class _DurableStateRequest:
    future: asyncio.Future[dict[str, object]]


@dataclass(slots=True)
class _SubscribeRequest:
    after_sequence: int | None
    max_pending: int
    future: asyncio.Future[ActorStreamSubscription]


@dataclass(slots=True)
class _UnsubscribeRequest:
    token: int
    future: asyncio.Future[None]


@dataclass(slots=True)
class _ShutdownRequest:
    future: asyncio.Future[None]
    step_timeout: float


_ActorRequest = (
    _CommandRequest
    | _HeartbeatRequest
    | _SnapshotRequest
    | _PublicSnapshotRequest
    | _ReportRequest
    | _CheckpointRequest
    | _DurableStateRequest
    | _SubscribeRequest
    | _UnsubscribeRequest
    | _ShutdownRequest
)


class _LatencyWindow:
    def __init__(self, *, max_samples: int = 2_048) -> None:
        self._values: deque[float] = deque(maxlen=max_samples)

    def add(self, milliseconds: float) -> None:
        if math.isfinite(milliseconds) and milliseconds >= 0:
            self._values.append(float(milliseconds))

    def snapshot(self) -> dict[str, int | float]:
        if not self._values:
            return {"samples": 0, "p50": 0.0, "p95": 0.0, "max": 0.0}
        ordered = sorted(self._values)

        def percentile(fraction: float) -> float:
            index = max(0, math.ceil(len(ordered) * fraction) - 1)
            return round(ordered[index], 3)

        return {
            "samples": len(ordered),
            "p50": percentile(0.50),
            "p95": percentile(0.95),
            "max": round(ordered[-1], 3),
        }


class ReplaySessionActor:
    """Own all mutable replay-domain state in one bounded asyncio actor."""

    def __init__(
        self,
        *,
        session_id: str,
        config: ReplaySessionConfig,
        source_factory: Callable[[], ReplayMarketSource],
        initial_virtual_time_ms: int,
        command_queue_size: int,
        event_buffer_size: int,
        max_emit_fps: int,
        controller_ttl_seconds: float,
        checkpoint_event_interval: int,
        checkpoint_virtual_ms: int,
        reducer: ReplayReducer | None = None,
        max_command_records: int = 4_096,
        max_recent_checkpoints: int = 32,
        restore_checkpoint: bytes | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        flush_hook: Callable[[], Awaitable[None]] | None = None,
        checkpoint_hook: Callable[[bytes], Awaitable[None]] | None = None,
        mutation_hook: Callable[[ActorMutation], Awaitable[None]] | None = None,
        recovery_target: ActorRecoveryTarget | None = None,
    ) -> None:
        self.session_id = validate_identifier(session_id, field_name="session_id")
        if not isinstance(config, ReplaySessionConfig):
            raise TypeError("config must be ReplaySessionConfig")
        if not callable(source_factory):
            raise TypeError("source_factory must be callable")
        self.config = config
        self._source_factory = source_factory
        self._initial_virtual_time_ms = validate_timestamp_ms(
            initial_virtual_time_ms,
            field_name="initial_virtual_time_ms",
        )
        self._queue_size = self._positive_int(command_queue_size, "command_queue_size")
        self._event_buffer_size = self._positive_int(
            event_buffer_size,
            "event_buffer_size",
        )
        self._max_emit_fps = self._positive_int(max_emit_fps, "max_emit_fps")
        if (
            isinstance(controller_ttl_seconds, bool)
            or not isinstance(controller_ttl_seconds, (int, float))
            or not math.isfinite(float(controller_ttl_seconds))
            or float(controller_ttl_seconds) <= 0
        ):
            raise ValueError("controller_ttl_seconds must be positive and finite")
        self._controller_ttl_seconds = float(controller_ttl_seconds)
        self._checkpoint_event_interval = self._positive_int(
            checkpoint_event_interval,
            "checkpoint_event_interval",
        )
        self._checkpoint_virtual_ms = self._positive_int(
            checkpoint_virtual_ms,
            "checkpoint_virtual_ms",
        )
        self._monotonic = monotonic
        self._flush_hook = flush_hook
        self._checkpoint_hook = checkpoint_hook
        self._mutation_hook = mutation_hook
        if recovery_target is not None and restore_checkpoint is None:
            raise ValueError("recovery_target requires restore_checkpoint")
        self._recovery_target = recovery_target
        self._recovering_tail = False
        self._restore_checkpoint = (
            bytes(restore_checkpoint) if restore_checkpoint else None
        )
        self._reducer: ReplayReducer = reducer or NullReplayReducer()

        self._queue: asyncio.Queue[_ActorRequest] = asyncio.Queue(
            maxsize=self._queue_size
        )
        self._events = ReplayEventBuffer(max_events=self._event_buffer_size)
        self._coalescer = ProjectionCoalescer(max_fps=self._max_emit_fps)
        self._projection_buffer: deque[ProjectionBatch] = deque(
            maxlen=self._event_buffer_size,
        )
        self._command_history = CommandHistory(max_records=max_command_records)
        self._checkpoint_codec = CheckpointCodec()
        self._checkpoints = CheckpointRing(max_recent=max_recent_checkpoints)

        self._source = self._new_source()
        self._snapshot_ref = self._source.snapshot_ref()
        self._data_epoch = self._extract_data_epoch(self._snapshot_ref)
        self._snapshot_ref_hash = canonical_sha256(self._snapshot_ref)
        self._session_config_hash = canonical_sha256(config)
        self._execution_version = config.execution_model.value
        self._clock = VirtualClock(
            initial_time_ms=self._initial_virtual_time_ms,
            monotonic=self._monotonic,
        )
        self._state = SessionState.INITIALIZING
        self._revision = 0
        self._sequence = 0
        self._domain_command_position = 0
        self._command_log_offset = 0
        self._event_chain_hash = self._initial_chain_hash()
        self._status_reason = "initializing"
        self._revealed = False
        self._journal_entries: list[dict[str, object]] = []
        self._controller_client_id: str | None = None
        self._controller_deadline_wall: float | None = None
        self._last_checkpoint_source_sequence = 0
        self._last_checkpoint_virtual_ms = self._initial_virtual_time_ms
        self._task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()
        self._startup_error: BaseException | None = None
        self._accepting = False
        self._closing = False
        self._closed = False
        self._exit_requested = False
        self._shutdown_request: _ShutdownRequest | None = None
        self._last_snapshot: ActorSnapshot | None = None
        self._degraded_reason: str | None = None
        self._pending_events: list[tuple[ReplayEvent, bool]] | None = None
        self._pending_source_events: list[Mapping[str, object]] | None = None
        self._subscribers: dict[
            int, tuple[asyncio.Queue[ReplayEvent], asyncio.Event]
        ] = {}
        self._next_subscriber_token = 1

        self._command_ack_latency = _LatencyWindow()
        self._pause_latency = _LatencyWindow()
        self._checkpoint_latency = _LatencyWindow()
        self._metrics: dict[str, int | float | str | None] = {
            "commands_submitted": 0,
            "commands_accepted": 0,
            "commands_rejected": 0,
            "command_queue_overflows": 0,
            "command_queue_high_water": 0,
            "events_processed": 0,
            "events_replayed_for_seek": 0,
            "controller_expirations": 0,
            "controller_takeovers": 0,
            "projection_buffer_evictions": 0,
            "checkpoints_created": 0,
            "checkpoint_bytes": 0,
            "shutdown_attempts": 0,
            "shutdown_timeouts": 0,
            "shutdown_failures": 0,
            "last_shutdown_error": None,
            "persistence_failures": 0,
            "subscriber_high_water": 0,
            "subscriber_overflows": 0,
            "subscriber_opens": 0,
            "subscriber_closes": 0,
        }

    @property
    def task(self) -> asyncio.Task[None] | None:
        return self._task

    async def start(self) -> None:
        if self._task is not None:
            await self._ready.wait()
            if self._startup_error is not None:
                raise self._startup_error
            return
        self._task = asyncio.create_task(
            self._run(),
            name=f"replay-actor-{self.session_id}",
        )
        await self._ready.wait()
        if self._startup_error is not None:
            await self._task
            raise self._startup_error

    async def submit(self, command: ReplayCommand) -> CommandResult:
        if not isinstance(command, ReplayCommand):
            raise TypeError("command must be ReplayCommand")
        self._ensure_accepting()
        if self._degraded_reason is not None:
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay session persistence is degraded",
                details={"reason": self._degraded_reason},
            )
        loop = asyncio.get_running_loop()
        request = _CommandRequest(
            command=command,
            future=loop.create_future(),
            enqueued_wall=self._read_wall(),
        )
        self._metrics["commands_submitted"] = (
            int(self._metrics["commands_submitted"] or 0) + 1
        )
        self._offer_request(request)
        return await request.future

    async def heartbeat(self, client_instance_id: str) -> None:
        self._ensure_accepting()
        client = validate_identifier(
            client_instance_id,
            field_name="client_instance_id",
        )
        loop = asyncio.get_running_loop()
        request = _HeartbeatRequest(client, loop.create_future())
        self._offer_request(request)
        await request.future

    async def snapshot(self) -> ActorSnapshot:
        if self._closed:
            return self.current_snapshot()
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        loop = asyncio.get_running_loop()
        request = _SnapshotRequest(loop.create_future())
        self._offer_request(request)
        return await request.future

    async def public_snapshot(self) -> dict[str, object]:
        if self._closed:
            return self._public_snapshot_value()
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        loop = asyncio.get_running_loop()
        request = _PublicSnapshotRequest(loop.create_future())
        self._offer_request(request)
        return await request.future

    async def report(self) -> Mapping[str, object]:
        if self._closed:
            return self._report_value()
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        loop = asyncio.get_running_loop()
        request = _ReportRequest(loop.create_future())
        self._offer_request(request)
        return await request.future

    async def checkpoint(self) -> bytes:
        if self._closed:
            blob = self.latest_checkpoint_blob()
            if blob is None:
                raise RuntimeError("closed replay actor has no checkpoint")
            return blob
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        loop = asyncio.get_running_loop()
        request = _CheckpointRequest(loop.create_future())
        self._offer_request(request)
        return await request.future

    async def durable_state(self) -> dict[str, object]:
        """Return the persistence cursor from inside the actor mailbox."""

        if self._closed:
            return self._durable_state()
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        loop = asyncio.get_running_loop()
        request = _DurableStateRequest(loop.create_future())
        self._offer_request(request)
        return await request.future

    async def subscribe(
        self,
        *,
        after_sequence: int | None,
        max_pending: int,
    ) -> ActorStreamSubscription:
        self._ensure_accepting()
        if after_sequence is not None:
            validate_counter(after_sequence, field_name="after_sequence")
        pending = self._positive_int(max_pending, "max_pending")
        loop = asyncio.get_running_loop()
        request = _SubscribeRequest(
            after_sequence=after_sequence,
            max_pending=pending,
            future=loop.create_future(),
        )
        self._offer_request(request)
        return await request.future

    async def unsubscribe(self, token: int) -> None:
        if self._closed:
            return
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        normalized = validate_counter(token, field_name="subscriber token")
        loop = asyncio.get_running_loop()
        request = _UnsubscribeRequest(normalized, loop.create_future())
        self._offer_request(request)
        await request.future

    def current_snapshot(self) -> ActorSnapshot:
        if self._last_snapshot is not None:
            return self._last_snapshot
        return self._snapshot_value(materialize=False)

    async def shutdown(self, *, step_timeout: float = 5.0) -> None:
        if (
            isinstance(step_timeout, bool)
            or not isinstance(step_timeout, (int, float))
            or not math.isfinite(float(step_timeout))
            or float(step_timeout) <= 0
        ):
            raise ValueError("step_timeout must be positive and finite")
        if self._task is None:
            self._closed = True
            self._accepting = False
            return
        if self._closed:
            return
        timeout = float(step_timeout)
        request = self._shutdown_request
        if request is None:
            self._accepting = False
            self._closing = True
            self._metrics["shutdown_attempts"] = (
                int(self._metrics["shutdown_attempts"] or 0) + 1
            )
            loop = asyncio.get_running_loop()
            request = _ShutdownRequest(loop.create_future(), timeout)
            self._shutdown_request = request
            try:
                await asyncio.wait_for(self._queue.put(request), timeout=timeout)
            except TimeoutError as exc:
                self._metrics["shutdown_timeouts"] = (
                    int(self._metrics["shutdown_timeouts"] or 0) + 1
                )
                await self._cancel_actor_task(timeout)
                raise ReplayDomainError(
                    ReplayErrorCode.PERSISTENCE_DEGRADED,
                    "replay actor shutdown enqueue timed out",
                ) from exc
            self._record_queue_high_water()
        error: BaseException | None = None
        try:
            # The actor may first finish one atomic event, then independently
            # time-bound flush and checkpoint persistence.
            await asyncio.wait_for(
                asyncio.shield(request.future),
                timeout=timeout * 3 + MIN_TASK_EXIT_GRACE_SECONDS,
            )
        except TimeoutError:
            self._metrics["shutdown_timeouts"] = (
                int(self._metrics["shutdown_timeouts"] or 0) + 1
            )
            error = ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay actor did not reach a shutdown barrier in time",
            )
            if not request.future.done():
                request.future.cancel()
            await self._cancel_actor_task(timeout)
        except BaseException as exc:
            error = exc
        if not self._task.done():
            try:
                # A completed shutdown barrier still needs one scheduler turn
                # for _run to leave its loop and finalize the task.  Windows
                # timer granularity can exceed a very small persistence-step
                # budget, so give task teardown a separate bounded grace.
                await asyncio.wait_for(
                    asyncio.shield(self._task),
                    timeout=max(timeout, MIN_TASK_EXIT_GRACE_SECONDS),
                )
            except TimeoutError:
                self._metrics["shutdown_timeouts"] = (
                    int(self._metrics["shutdown_timeouts"] or 0) + 1
                )
                if error is None:
                    error = ReplayDomainError(
                        ReplayErrorCode.PERSISTENCE_DEGRADED,
                        "replay actor task did not exit in time",
                    )
                await self._cancel_actor_task(timeout)
        if error is not None:
            raise error

    def latest_checkpoint_blob(self) -> bytes | None:
        records = self._checkpoints.records()
        return records[-1].encoded if records else None

    def event_buffer_after(self, sequence: int) -> tuple[ReplayEvent, ...] | None:
        return self._events.after(sequence)

    def projections(self) -> tuple[ProjectionBatch, ...]:
        return tuple(self._projection_buffer)

    def diagnostics(self) -> dict[str, object]:
        projection = self._coalescer.diagnostics()
        return {
            **self._metrics,
            "state": self._state.value,
            "revision": self._revision,
            "sequence": self._sequence,
            "queue_size": self._queue.qsize(),
            "queue_capacity": self._queue_size,
            "events": self._events.diagnostics(),
            "projection": projection,
            "projection_coalesced": projection["ordinary_coalesced"],
            "projection_buffer_size": len(self._projection_buffer),
            "checkpoints": self._checkpoints.diagnostics(),
            "command_history": self._command_history.diagnostics(),
            "command_ack_latency_ms": self._command_ack_latency.snapshot(),
            "pause_latency_ms": self._pause_latency.snapshot(),
            "checkpoint_latency_ms": self._checkpoint_latency.snapshot(),
            "task_done": bool(self._task is not None and self._task.done()),
            "accepting": self._accepting,
            "closing": self._closing,
            "closed": self._closed,
            "status_reason": self._status_reason,
            "degraded_reason": self._degraded_reason,
            "subscribers": len(self._subscribers),
        }

    async def _run(self) -> None:
        try:
            await self._bootstrap()
            self._accepting = True
            self._ready.set()
            while not self._exit_requested:
                await self._expire_controller_if_needed()
                request = self._take_ready_request()
                if request is not None:
                    await self._handle_request(request)
                    await self._process_one_due_source_after_request()
                    continue
                if self._state is SessionState.PLAYING:
                    if self._source.exhausted():
                        await self._mark_ended(reason="source_exhausted")
                        continue
                    event = self._source.peek()
                    if event is None:
                        raise ReplayDomainError(
                            ReplayErrorCode.DATASET_MISMATCH,
                            "replay source returned no event before exhaustion",
                        )
                    event_time = self._event_time_ms(event)
                    delay = self._clock.delay_until(event_time)
                    lease_delay = self._lease_delay()
                    if delay <= 0:
                        await self._process_source_event(publish=True)
                        await asyncio.sleep(0)
                        continue
                    timeout = delay if lease_delay is None else min(delay, lease_delay)
                    request = await self._wait_for_request(timeout)
                    if request is not None:
                        await self._handle_request(request)
                    continue
                request = await self._wait_for_request(self._lease_delay())
                if request is not None:
                    await self._handle_request(request)
        except asyncio.CancelledError:
            self._state = SessionState.ERROR
            self._accepting = False
            self._last_snapshot = self._snapshot_value(materialize=False)
            self._ready.set()
            self._fail_pending(RuntimeError("replay actor task was cancelled"))
            raise
        except BaseException as exc:
            self._state = SessionState.ERROR
            self._accepting = False
            self._startup_error = exc if not self._ready.is_set() else None
            self._last_snapshot = self._snapshot_value(materialize=False)
            self._ready.set()
            self._fail_pending(exc)
        finally:
            self._accepting = False
            self._closing = False
            self._closed = True
            for _queue, overflow in self._subscribers.values():
                overflow.set()
            self._subscribers.clear()
            self._ready.set()
            self._last_snapshot = self._snapshot_value(materialize=False)

    async def _process_one_due_source_after_request(self) -> None:
        """Prevent a saturated read/heartbeat mailbox from starving MAX playback."""

        if self._state is not SessionState.PLAYING or self._source.exhausted():
            return
        event = self._source.peek()
        if event is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay source returned no event before exhaustion",
            )
        if self._clock.delay_until(self._event_time_ms(event)) <= 0:
            await self._process_source_event(publish=True)
            await asyncio.sleep(0)

    async def _bootstrap(self) -> None:
        self._reducer.reset()
        if self._restore_checkpoint is not None:
            try:
                payload = self._checkpoint_codec.decode(self._restore_checkpoint)
                self._restore_payload(payload, restore_public_position=True)
            except (
                CheckpointError,
                ReplayDomainError,
                TypeError,
                ValueError,
                KeyError,
            ) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay checkpoint restore failed",
                    details={"reason": str(exc)},
                ) from exc
            self._checkpoints.add(
                self._restore_checkpoint,
                virtual_time_ms=self._clock.virtual_time_ms,
                source_sequence=self._source.cursor().source_sequence,
                state_hash=self._compute_state_hash(),
                initial=True,
            )
            self._last_checkpoint_source_sequence = (
                self._source.cursor().source_sequence
            )
            self._last_checkpoint_virtual_ms = self._clock.virtual_time_ms
            if self._recovery_target is not None:
                await self._recover_persisted_tail(self._recovery_target)
        else:
            first = self._source.peek()
            if first is None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "replay source is empty",
                )
            if self._event_time_ms(first) < self._initial_virtual_time_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "first replay event precedes initial virtual time",
                )
            self._state = SessionState.PAUSED
            self._create_checkpoint(initial=True)
        if self._source.exhausted():
            self._state = SessionState.ENDED
        else:
            self._state = SessionState.PAUSED
        self._clock.pause()
        if self._recovery_target is None:
            self._emit_status("initialized", mandatory=True)
        else:
            self._status_reason = "recovered_after_restart"

    async def _recover_persisted_tail(self, target: ActorRecoveryTarget) -> None:
        expected_source = self._source.cursor().source_sequence + 1
        expected_command = self._command_log_offset + 1
        self._recovering_tail = True
        try:
            for record in target.mutations:
                kind = record.get("kind")
                if kind == "command":
                    expected_command = await self._recover_command_mutation(
                        record,
                        expected_command=expected_command,
                    )
                    expected_source = self._source.cursor().source_sequence + 1
                    continue
                expected_source = await self._recover_source_mutation(
                    record,
                    expected_source=expected_source,
                )
        finally:
            self._recovering_tail = False
        self._revision = target.revision
        self._sequence = target.event_sequence
        self._command_log_offset = target.command_log_offset
        self._events = ReplayEventBuffer(
            max_events=self._event_buffer_size,
            initial_sequence=self._sequence,
        )
        self._controller_client_id = None
        self._controller_deadline_wall = None
        self._clock.pause()
        self._state = (
            SessionState.ENDED if self._source.exhausted() else SessionState.PAUSED
        )
        if self._compute_state_hash() != target.state_hash:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "recovered replay state hash does not match durable session state",
                details={
                    "expected_state_hash": target.state_hash,
                    "actual_state_hash": self._compute_state_hash(),
                },
            )
        self._status_reason = "recovered_after_restart"

    async def _recover_command_mutation(
        self,
        record: Mapping[str, object],
        *,
        expected_command: int,
    ) -> int:
        if set(record) != {
            "kind",
            "command",
            "accepted",
            "command_log_offset",
            "state_hash",
        }:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay command tail fields are incompatible",
            )
        offset = validate_counter(
            record["command_log_offset"],
            field_name="recovery command_log_offset",
        )
        if offset != expected_command:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay command tail is not contiguous",
                details={"expected": expected_command, "actual": offset},
            )
        command_payload = record["command"]
        accepted = record["accepted"]
        if not isinstance(command_payload, Mapping) or not isinstance(accepted, bool):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay command tail is invalid",
            )
        command = ReplayCommand.from_dict(command_payload)
        if accepted:
            if command.expected_revision != self._revision:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "recovered replay command revision does not match",
                )
            self._begin_candidate()
            try:
                await self._execute_command(command, parse_command(command))
            finally:
                self._pending_events = None
                self._pending_source_events = None
        self._command_log_offset = offset
        if self._compute_state_hash() != record["state_hash"]:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "recovered replay command-tail state hash does not match",
                details={"command_log_offset": offset},
            )
        return expected_command + 1

    async def _recover_source_mutation(
        self,
        record: Mapping[str, object],
        *,
        expected_source: int,
    ) -> int:
        if record.get("kind") != "source_event" or set(record) != {
            "kind",
            "source_sequence",
            "event",
            "state_hash",
        }:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay mutation tail fields are incompatible",
            )
        sequence = validate_counter(
            record["source_sequence"], field_name="recovery source_sequence"
        )
        if sequence != expected_source:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay source tail is not contiguous",
                details={"expected": expected_source, "actual": sequence},
            )
        event = self._source.peek()
        persisted_event = record["event"]
        if event is None or not isinstance(persisted_event, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay source tail exceeds the immutable dataset",
            )
        if self._event_payload(event) != dict(persisted_event):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay source event does not match immutable dataset",
                details={"source_sequence": sequence},
            )
        await self._apply_source_event_candidate(publish=False)
        if self._source.cursor().source_sequence != sequence:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "recovered replay source cursor drifted",
            )
        if self._compute_state_hash() != record["state_hash"]:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "recovered replay source-tail state hash does not match",
                details={"source_sequence": sequence},
            )
        return expected_source + 1

    async def _handle_request(self, request: _ActorRequest) -> None:
        try:
            if isinstance(request, _CommandRequest):
                await self._handle_command_request(request)
            elif isinstance(request, _HeartbeatRequest):
                self._handle_heartbeat_request(request)
            elif isinstance(request, _SnapshotRequest):
                self._materialize_clock()
                snapshot = self._snapshot_value(materialize=False)
                self._last_snapshot = snapshot
                if not request.future.done():
                    request.future.set_result(snapshot)
            elif isinstance(request, _PublicSnapshotRequest):
                self._materialize_clock()
                if not request.future.done():
                    request.future.set_result(self._public_snapshot_value())
            elif isinstance(request, _ReportRequest):
                if not request.future.done():
                    request.future.set_result(self._report_value())
            elif isinstance(request, _CheckpointRequest):
                if not request.future.done():
                    request.future.set_result(self._create_checkpoint(initial=False))
            elif isinstance(request, _DurableStateRequest):
                self._materialize_clock()
                if not request.future.done():
                    request.future.set_result(self._durable_state())
            elif isinstance(request, _SubscribeRequest):
                self._handle_subscribe_request(request)
            elif isinstance(request, _UnsubscribeRequest):
                self._handle_unsubscribe_request(request)
            else:
                await self._handle_shutdown_request(request)
        finally:
            self._queue.task_done()

    async def _handle_command_request(self, request: _CommandRequest) -> None:
        command = request.command
        try:
            try:
                replayed = self._command_history.replay(command)
            except ReplayDomainError as exc:
                self._metrics["commands_rejected"] = (
                    int(self._metrics["commands_rejected"] or 0) + 1
                )
                if not request.future.done():
                    request.future.set_exception(exc)
                return
            if replayed is not None:
                if not request.future.done():
                    request.future.set_result(replayed)
                return
            capacity_reserved = False
            rollback: _ActorRollback | None = None
            try:
                self._command_history.ensure_capacity()
                capacity_reserved = True
                rollback = self._capture_rollback()
                self._begin_candidate()
                parsed = parse_command(command)
                if command.expected_revision != self._revision:
                    raise ReplayDomainError(
                        ReplayErrorCode.REVISION_CONFLICT,
                        "command expected_revision does not match actor revision",
                        details={
                            "expected_revision": command.expected_revision,
                            "latest_revision": self._revision,
                            "state_hash": self._compute_state_hash(),
                        },
                    )
                result = await self._execute_command(command, parsed)
            except ReplayDomainError as exc:
                terminal_actor_error = self._state is SessionState.ERROR
                if rollback is not None:
                    self._restore_rollback(rollback, force_paused=False)
                    if terminal_actor_error:
                        self._state = SessionState.ERROR
                        self._pause_clock()
                if capacity_reserved:
                    self._command_log_offset += 1
                    try:
                        await self._commit_mutation(
                            kind="command",
                            command=command,
                            result=None,
                            error=exc,
                            checkpoint=None,
                        )
                    except BaseException as persistence_exc:
                        if rollback is not None:
                            self._restore_rollback(rollback, force_paused=True)
                        degraded = self._enter_persistence_degraded(persistence_exc)
                        if not request.future.done():
                            request.future.set_exception(degraded)
                        return
                    self._command_history.record_failure(command, exc)
                self._metrics["commands_rejected"] = (
                    int(self._metrics["commands_rejected"] or 0) + 1
                )
                if not request.future.done():
                    request.future.set_exception(exc)
                return
            self._command_log_offset += 1
            component_state = dict(self._reducer.snapshot())
            checkpoint = self._checkpoint_codec.encode(
                self._checkpoint_payload(component_state=component_state)
            )
            try:
                await self._commit_mutation(
                    kind="command",
                    command=command,
                    result=result,
                    error=None,
                    checkpoint=checkpoint,
                    component_state=component_state,
                )
            except BaseException as exc:
                assert rollback is not None
                self._restore_rollback(rollback, force_paused=True)
                degraded = self._enter_persistence_degraded(exc)
                if not request.future.done():
                    request.future.set_exception(degraded)
                return
            self._command_history.record_success(command, result)
            self._metrics["commands_accepted"] = (
                int(self._metrics["commands_accepted"] or 0) + 1
            )
            if self._checkpoint_due():
                self._record_checkpoint(checkpoint, initial=False)
            if not request.future.done():
                request.future.set_result(result)
        except BaseException as exc:
            if not request.future.done():
                request.future.set_exception(exc)
            raise
        finally:
            elapsed_ms = max(0.0, (self._read_wall() - request.enqueued_wall) * 1_000)
            self._command_ack_latency.add(elapsed_ms)
            if command.type is CommandType.PAUSE:
                self._pause_latency.add(elapsed_ms)

    async def _execute_command(
        self,
        command: ReplayCommand,
        parsed: ParsedCommand,
    ) -> CommandResult:
        command_type = parsed.type
        if self._state is SessionState.ENDED and command_type not in {
            CommandType.ACQUIRE_CONTROLLER,
            CommandType.ADD_JOURNAL_NOTE,
            CommandType.REVEAL_HISTORY,
        }:
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_ENDED,
                "replay session has ended",
            )
        if self._state is SessionState.ERROR:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "replay session is in ERROR state",
            )
        if command_type is CommandType.ACQUIRE_CONTROLLER:
            self._acquire_controller(
                command.client_instance_id,
                takeover=bool(parsed.values["takeover"]),
            )
            self._revision += 1
            self._emit_status("controller_acquired", mandatory=True)
            return self._command_result(
                command.command_id, {"controller": command.client_instance_id}
            )
        self._require_controller(command.client_instance_id)
        if command_type is CommandType.RELEASE_CONTROLLER:
            self._revision += 1
            if (
                self._state is SessionState.PLAYING
                and self.config.pause_on_controller_loss
            ):
                self._pause_clock()
                self._state = SessionState.PAUSED
            self._controller_client_id = None
            self._controller_deadline_wall = None
            self._emit_status("controller_released", mandatory=True)
            return self._command_result(command.command_id, {"controller": None})
        if command_type is CommandType.PLAY:
            self._require_state(SessionState.PAUSED, command_type)
            if self._source.exhausted():
                raise ReplayDomainError(
                    ReplayErrorCode.SESSION_ENDED, "replay source is exhausted"
                )
            self._revision += 1
            self._state = SessionState.PLAYING
            if not self._recovering_tail:
                self._clock.start()
            self._emit_status("play", mandatory=True)
            return self._command_result(command.command_id, {})
        if command_type is CommandType.PAUSE:
            self._require_state(SessionState.PLAYING, command_type)
            self._revision += 1
            self._pause_clock()
            self._state = SessionState.PAUSED
            self._emit_status("pause", mandatory=True)
            return self._command_result(command.command_id, {})
        if command_type is CommandType.SET_SPEED:
            if self._state not in {SessionState.PAUSED, SessionState.PLAYING}:
                self._invalid_transition(command_type)
            self._revision += 1
            self._clock.set_speed(
                parsed.values["speed"],  # type: ignore[arg-type]
                cap_ms=self._next_source_boundary(),
            )
            self._emit_status("speed_changed", mandatory=True)
            return self._command_result(
                command.command_id, {"speed": self._clock.speed}
            )
        if command_type is CommandType.STEP:
            self._require_state(SessionState.PAUSED, command_type)
            count = int(parsed.values["count"])
            self._preflight_event_count(count)
            self._revision += 1
            consumed = 0
            for _ in range(count):
                await self._process_source_event(publish=True, checkpoint=False)
                consumed += 1
            if self._state is not SessionState.ENDED:
                self._emit_status("step_complete", mandatory=True)
            return self._command_result(command.command_id, {"consumed": consumed})
        if command_type is CommandType.ADVANCE_BY:
            self._require_state(SessionState.PAUSED, command_type)
            delta_ms = int(parsed.values["ms"])
            target = self._clock.virtual_time_ms + delta_ms
            if target > MAX_TIMESTAMP_MS:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "advance target exceeds timestamp range",
                )
            self._revision += 1
            consumed = await self._advance_to(
                target,
                publish=True,
                checkpoint=False,
            )
            if self._state is not SessionState.ENDED:
                self._emit_status("advance_complete", mandatory=True)
            return self._command_result(
                command.command_id,
                {"consumed": consumed, "target_virtual_time_ms": target},
            )
        if command_type is CommandType.SEEK_TO:
            self._require_state(SessionState.PAUSED, command_type)
            if self._reducer.has_trading_state():
                raise ReplayDomainError(
                    ReplayErrorCode.SEEK_REQUIRES_FORK_OR_RESET,
                    "seek requires fork or reset after trading state changes",
                )
            target = int(parsed.values["virtual_time_ms"])
            await self._seek_to(target)
            self._revision += 1
            self._emit_status("seek_complete", mandatory=True)
            return self._command_result(
                command.command_id,
                {"target_virtual_time_ms": target},
            )
        if command_type in {
            CommandType.PLACE_ORDER,
            CommandType.CANCEL_ORDER,
            CommandType.CLOSE_POSITION,
        }:
            if self._state not in {SessionState.PAUSED, SessionState.PLAYING}:
                self._invalid_transition(command_type)
            apply_command = getattr(self._reducer, "apply_command", None)
            if not callable(apply_command):
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_EXECUTION_MODEL,
                    "replay reducer does not provide paper trading",
                )
            projection = apply_command(
                command_type,
                parsed.values,
                command_id=command.command_id,
                source_sequence=self._source.cursor().source_sequence,
                virtual_time_ms=self._clock.virtual_time_ms,
            )
            if inspect.isawaitable(projection):
                projection = await projection
            if not isinstance(projection, Mapping):
                raise TypeError("replay command reducer projection must be an object")
            self._revision += 1
            self._domain_command_position += 1
            self._emit(
                ReplayEventType.ORDER,
                {
                    "command_type": command_type.value,
                    "projection": dict(projection),
                },
                mandatory=True,
            )
            return self._command_result(command.command_id, dict(projection))
        if command_type is CommandType.ADD_JOURNAL_NOTE:
            if len(self._journal_entries) >= MAX_JOURNAL_ENTRIES:
                raise ReplayDomainError(
                    ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                    "replay journal entry limit exceeded",
                    details={"limit": MAX_JOURNAL_ENTRIES},
                )
            entry = {
                "entry_id": command.command_id,
                "virtual_time_ms": self._clock.virtual_time_ms,
                "text": str(parsed.values["text"]),
            }
            self._journal_entries.append(entry)
            self._revision += 1
            self._domain_command_position += 1
            self._emit(ReplayEventType.JOURNAL, entry, mandatory=True)
            return self._command_result(command.command_id, {"journal_entry": entry})
        if command_type is CommandType.REVEAL_HISTORY:
            self._require_state(SessionState.ENDED, command_type)
            if self._revealed:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "replay history has already been revealed",
                )
            self._revealed = True
            self._revision += 1
            self._domain_command_position += 1
            self._emit_status("history_revealed", mandatory=True)
            return self._command_result(command.command_id, {"revealed": True})
        if command_type is CommandType.END_SESSION:
            if self._state not in {SessionState.PAUSED, SessionState.PLAYING}:
                self._invalid_transition(command_type)
            end_projection = await self._mark_ended(
                reason="command",
                open_order_disposition=str(parsed.values["open_order_disposition"]),
                position_disposition=str(parsed.values["position_disposition"]),
                commit_command=True,
            )
            return self._command_result(
                command.command_id,
                {"session_end": end_projection},
            )
        raise ReplayDomainError(
            ReplayErrorCode.INVALID_STATE_TRANSITION,
            f"unsupported actor command {command_type.value}",
        )

    def _handle_heartbeat_request(self, request: _HeartbeatRequest) -> None:
        try:
            self._require_controller(request.client_instance_id)
            self._controller_deadline_wall = (
                self._read_wall() + self._controller_ttl_seconds
            )
            if not request.future.done():
                request.future.set_result(None)
        except ReplayDomainError as exc:
            if not request.future.done():
                request.future.set_exception(exc)

    def _handle_subscribe_request(self, request: _SubscribeRequest) -> None:
        try:
            replay = (
                None
                if request.after_sequence is None
                else self._events.after(request.after_sequence)
            )
            # An empty catch-up has no frame that can prove the client has
            # converged with this actor instance. This matters after process
            # recovery because controller ownership is intentionally cleared
            # without advancing the durable event sequence. Publish an atomic
            # snapshot whenever there is nothing to replay.
            reset = replay is None or not replay
            if reset:
                snapshot = self._public_snapshot_value()
                initial_events = (
                    ReplayEvent(
                        type=ReplayEventType.SNAPSHOT,
                        protocol=REPLAY_PROTOCOL,
                        session_id=self.session_id,
                        sequence=self._sequence,
                        revision=self._revision,
                        virtual_time_ms=self._clock.virtual_time_ms,
                        state_hash=self._compute_state_hash(),
                        data_epoch=self._data_epoch,
                        data={"reset": True, "snapshot": snapshot},
                    ),
                )
            else:
                initial_events = replay
            token = self._next_subscriber_token
            self._next_subscriber_token += 1
            queue: asyncio.Queue[ReplayEvent] = asyncio.Queue(
                maxsize=request.max_pending
            )
            overflow = asyncio.Event()
            self._subscribers[token] = (queue, overflow)
            self._metrics["subscriber_opens"] = (
                int(self._metrics["subscriber_opens"] or 0) + 1
            )
            subscription = ActorStreamSubscription(
                token=token,
                initial_events=initial_events,
                reset=reset,
                queue=queue,
                overflow=overflow,
            )
            if not request.future.done():
                request.future.set_result(subscription)
        except BaseException as exc:
            if not request.future.done():
                request.future.set_exception(exc)

    def _handle_unsubscribe_request(self, request: _UnsubscribeRequest) -> None:
        if self._subscribers.pop(request.token, None) is not None:
            self._metrics["subscriber_closes"] = (
                int(self._metrics["subscriber_closes"] or 0) + 1
            )
        if not request.future.done():
            request.future.set_result(None)

    async def _handle_shutdown_request(self, request: _ShutdownRequest) -> None:
        errors: list[str] = []
        rollback = self._capture_rollback()
        self._begin_candidate()
        if self._state is SessionState.PLAYING:
            self._pause_clock()
            self._state = SessionState.PAUSED
            self._revision += 1
            self._emit_status("shutdown_pause", mandatory=True)
        if self._flush_hook is not None:
            try:
                await asyncio.wait_for(self._flush_hook(), timeout=request.step_timeout)
            except TimeoutError:
                self._metrics["shutdown_timeouts"] = (
                    int(self._metrics["shutdown_timeouts"] or 0) + 1
                )
                errors.append("flush timeout")
            except Exception as exc:
                errors.append(f"flush failed: {exc}")
        checkpoint: bytes | None = None
        try:
            checkpoint = self._checkpoint_codec.encode(self._checkpoint_payload())
        except Exception as exc:
            errors.append(f"checkpoint encode failed: {exc}")
        mutation_committed = False
        if not errors and checkpoint is not None:
            try:
                await asyncio.wait_for(
                    self._commit_mutation(
                        kind="shutdown",
                        command=None,
                        result=None,
                        error=None,
                        checkpoint=checkpoint,
                    ),
                    timeout=request.step_timeout,
                )
                mutation_committed = True
            except TimeoutError:
                self._metrics["shutdown_timeouts"] = (
                    int(self._metrics["shutdown_timeouts"] or 0) + 1
                )
                errors.append("state persistence timeout")
            except Exception as exc:
                errors.append(f"state persistence failed: {exc}")
        if not errors and checkpoint is not None and self._checkpoint_hook is not None:
            try:
                await asyncio.wait_for(
                    self._checkpoint_hook(checkpoint),
                    timeout=request.step_timeout,
                )
            except TimeoutError:
                self._metrics["shutdown_timeouts"] = (
                    int(self._metrics["shutdown_timeouts"] or 0) + 1
                )
                errors.append("checkpoint timeout")
            except Exception as exc:
                errors.append(f"checkpoint failed: {exc}")
        if not errors and checkpoint is not None:
            self._record_checkpoint(checkpoint, initial=False)
        if errors:
            if not mutation_committed:
                self._restore_rollback(rollback, force_paused=True)
            else:
                self._pending_events = None
                self._pending_source_events = None
            self._state = SessionState.ERROR
            self._metrics["shutdown_failures"] = (
                int(self._metrics["shutdown_failures"] or 0) + 1
            )
            self._metrics["last_shutdown_error"] = "; ".join(errors)[:500]
            self._emit_status("shutdown_error", mandatory=True)
            error = ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay actor shutdown failed",
                details={"errors": tuple(errors)},
            )
            if not request.future.done():
                request.future.set_exception(error)
        elif not request.future.done():
            request.future.set_result(None)
        self._store_projection_batches(self._coalescer.flush())
        self._last_snapshot = self._snapshot_value(materialize=False)
        self._exit_requested = True

    async def _process_source_event(
        self,
        *,
        publish: bool,
        checkpoint: bool = True,
    ) -> None:
        owns_candidate = self._pending_events is None
        rollback = self._capture_rollback() if owns_candidate else None
        if owns_candidate:
            self._begin_candidate()
        try:
            await self._apply_source_event_candidate(publish=publish)
        except BaseException:
            if rollback is not None:
                self._restore_rollback(rollback, force_paused=False)
            raise
        if not owns_candidate:
            return
        component_state = dict(self._reducer.snapshot())
        checkpoint_blob = (
            self._checkpoint_codec.encode(
                self._checkpoint_payload(component_state=component_state)
            )
            if checkpoint and self._checkpoint_due()
            else None
        )
        try:
            await self._commit_mutation(
                kind="source_event",
                command=None,
                result=None,
                error=None,
                checkpoint=checkpoint_blob,
                component_state=component_state,
            )
        except BaseException as exc:
            assert rollback is not None
            self._restore_rollback(rollback, force_paused=True)
            self._enter_persistence_degraded(exc)
            return
        if checkpoint_blob is not None:
            self._record_checkpoint(checkpoint_blob, initial=False)

    async def _apply_source_event_candidate(
        self,
        *,
        publish: bool,
    ) -> None:
        event = self._source.peek()
        if event is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay source exhausted before expected event",
            )
        event_time = self._event_time_ms(event)
        if event_time < self._clock.virtual_time_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay source event time moved backward",
                details={
                    "event_time_ms": event_time,
                    "virtual_time_ms": self._clock.virtual_time_ms,
                },
            )
        try:
            projection = self._reducer.apply_source_event(event)
            if inspect.isawaitable(projection):
                projection = await projection
            if not isinstance(projection, Mapping):
                raise TypeError("replay reducer projection must be an object")
        except BaseException:
            self._pause_clock()
            self._state = SessionState.ERROR
            raise
        consumed = self._source.next()
        if consumed != event:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay source changed between peek and atomic commit",
            )
        self._clock.advance_to(event_time)
        source_cursor = self._source.cursor()
        self._event_chain_hash = self._next_chain_hash(
            self._event_chain_hash,
            event,
            source_cursor.source_sequence,
        )
        self._metrics["events_processed"] = (
            int(self._metrics["events_processed"] or 0) + 1
        )
        if self._pending_source_events is not None:
            self._pending_source_events.append(self._event_payload(event))
        end_projection: Mapping[str, object] = {}
        if self._source.exhausted():
            end_projection = await self._finalize_reducer(
                open_order_disposition="expire",
                position_disposition="keep",
            )
            self._state = SessionState.ENDED
            self._pause_clock()
            self._controller_client_id = None
            self._controller_deadline_wall = None
        if publish:
            self._emit(
                ReplayEventType.DELTA,
                {
                    "source_sequence": source_cursor.source_sequence,
                    "source_event": self._event_payload(event),
                    "projection": dict(projection),
                },
                mandatory=False,
            )
            if self._state is SessionState.ENDED:
                self._emit(
                    ReplayEventType.ENDED,
                    {
                        "reason": "source_exhausted",
                        "projection": dict(end_projection),
                    },
                    mandatory=True,
                )

    async def _advance_to(
        self,
        target_time_ms: int,
        *,
        publish: bool,
        checkpoint: bool = True,
    ) -> int:
        target = validate_timestamp_ms(target_time_ms, field_name="target_time_ms")
        if target < self._clock.virtual_time_ms:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "advance target cannot move backward",
            )
        consumed = 0
        while (event := self._source.peek()) is not None:
            event_time = self._event_time_ms(event)
            if event_time > target:
                break
            await self._process_source_event(
                publish=publish,
                checkpoint=checkpoint,
            )
            consumed += 1
        if self._state is not SessionState.ENDED:
            self._clock.advance_to(target)
        return consumed

    async def _seek_to(self, target_time_ms: int) -> None:
        target = validate_timestamp_ms(target_time_ms, field_name="target_time_ms")
        if target < self._initial_virtual_time_ms:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "seek target precedes replay start",
            )
        self._validate_seek_target(target)
        selected = self._checkpoints.select_valid(
            self._checkpoint_codec,
            target_virtual_time_ms=target,
            validator=self._checkpoint_matches_actor,
        )
        rollback_payload = self._checkpoint_payload()
        public_revision = self._revision
        public_sequence = self._sequence
        public_command_log_offset = self._command_log_offset
        try:
            self._restore_payload(selected.payload, restore_public_position=False)
            self._revision = public_revision
            self._sequence = public_sequence
            self._command_log_offset = public_command_log_offset
            while (event := self._source.peek()) is not None:
                if self._event_time_ms(event) > target:
                    break
                await self._process_source_event(publish=False, checkpoint=False)
                self._metrics["events_replayed_for_seek"] = (
                    int(self._metrics["events_replayed_for_seek"] or 0) + 1
                )
            if self._source.exhausted():
                self._state = SessionState.ENDED
            else:
                self._state = SessionState.PAUSED
                self._clock.advance_to(target)
        except BaseException:
            self._restore_payload(rollback_payload, restore_public_position=False)
            self._revision = public_revision
            self._sequence = public_sequence
            self._command_log_offset = public_command_log_offset
            raise

    def _validate_seek_target(self, target: int) -> None:
        source = self._new_source()
        previous_time = self._initial_virtual_time_ms
        last_time: int | None = None
        while (event := source.next()) is not None:
            event_time = self._event_time_ms(event)
            if event_time < previous_time:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "source order changed during seek validation",
                )
            previous_time = event_time
            last_time = event_time
        if last_time is None or target > last_time:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "seek target exceeds replay horizon",
            )

    async def _mark_ended(
        self,
        *,
        reason: str,
        open_order_disposition: str = "expire",
        position_disposition: str = "keep",
        commit_command: bool = False,
    ) -> Mapping[str, object]:
        if self._state is SessionState.ENDED:
            return {}
        projection = await self._finalize_reducer(
            open_order_disposition=open_order_disposition,
            position_disposition=position_disposition,
        )
        if commit_command:
            self._revision += 1
            if callable(getattr(self._reducer, "finalize_session", None)):
                self._domain_command_position += 1
        self._pause_clock()
        self._state = SessionState.ENDED
        self._controller_client_id = None
        self._controller_deadline_wall = None
        self._emit(
            ReplayEventType.ENDED,
            {"reason": reason, "projection": dict(projection)},
            mandatory=True,
        )
        return projection

    async def _finalize_reducer(
        self,
        *,
        open_order_disposition: str,
        position_disposition: str,
    ) -> Mapping[str, object]:
        finalize = getattr(self._reducer, "finalize_session", None)
        if not callable(finalize):
            return {}
        projection = finalize(
            open_order_disposition=open_order_disposition,
            position_disposition=position_disposition,
            virtual_time_ms=self._clock.virtual_time_ms,
        )
        if inspect.isawaitable(projection):
            projection = await projection
        if not isinstance(projection, Mapping):
            raise TypeError("replay session-end projection must be an object")
        return projection

    async def _expire_controller_if_needed(self) -> None:
        deadline = self._controller_deadline_wall
        if deadline is None or self._read_wall() < deadline:
            return
        rollback = self._capture_rollback()
        self._begin_candidate()
        self._controller_client_id = None
        self._controller_deadline_wall = None
        self._revision += 1
        self._metrics["controller_expirations"] = (
            int(self._metrics["controller_expirations"] or 0) + 1
        )
        if self._state is SessionState.PLAYING and self.config.pause_on_controller_loss:
            self._pause_clock()
            self._state = SessionState.PAUSED
        self._emit_status("controller_expired", mandatory=True)
        component_state = dict(self._reducer.snapshot())
        checkpoint = self._checkpoint_codec.encode(
            self._checkpoint_payload(component_state=component_state)
        )
        try:
            await self._commit_mutation(
                kind="controller_expired",
                command=None,
                result=None,
                error=None,
                checkpoint=checkpoint,
                component_state=component_state,
            )
        except BaseException as exc:
            self._restore_rollback(rollback, force_paused=True)
            self._enter_persistence_degraded(exc)

    def _acquire_controller(self, client_id: str, *, takeover: bool) -> None:
        existing = self._controller_client_id
        if existing is not None and existing != client_id and not takeover:
            raise ReplayDomainError(
                ReplayErrorCode.CONTROLLER_CONFLICT,
                "another client owns the replay controller lease",
                details={"controller_client_id": existing},
            )
        if existing is not None and existing != client_id:
            self._metrics["controller_takeovers"] = (
                int(self._metrics["controller_takeovers"] or 0) + 1
            )
        self._controller_client_id = client_id
        self._controller_deadline_wall = (
            self._read_wall() + self._controller_ttl_seconds
        )

    def _require_controller(self, client_id: str) -> None:
        if self._controller_client_id != client_id:
            raise ReplayDomainError(
                ReplayErrorCode.CONTROLLER_CONFLICT,
                "client does not own the replay controller lease",
                details={"controller_client_id": self._controller_client_id},
            )

    def _require_state(self, required: SessionState, command_type: CommandType) -> None:
        if self._state is not required:
            self._invalid_transition(command_type)

    def _invalid_transition(self, command_type: CommandType) -> None:
        raise ReplayDomainError(
            ReplayErrorCode.INVALID_STATE_TRANSITION,
            f"command {command_type.value} is invalid while session is {self._state.value}",
            details={"state": self._state.value, "command": command_type.value},
        )

    def _preflight_event_count(self, count: int) -> None:
        source, _ = self._source_at_sequence(
            self._source.cursor().source_sequence,
            expected_chain=self._event_chain_hash,
        )
        for _ in range(count):
            if source.next() is None:
                raise ReplayDomainError(
                    ReplayErrorCode.SESSION_ENDED,
                    "step count exceeds remaining source events",
                    details={"count": count},
                )

    def _capture_rollback(self) -> _ActorRollback:
        return _ActorRollback(
            payload=self._checkpoint_payload(),
            state=self._state,
            status_reason=self._status_reason,
            controller_client_id=self._controller_client_id,
            controller_deadline_wall=self._controller_deadline_wall,
        )

    def _begin_candidate(self) -> None:
        if self._pending_events is not None or self._pending_source_events is not None:
            raise RuntimeError("nested replay actor mutation candidate")
        self._pending_events = []
        self._pending_source_events = []

    def _restore_rollback(
        self,
        rollback: _ActorRollback,
        *,
        force_paused: bool,
    ) -> None:
        self._pending_events = None
        self._pending_source_events = None
        self._restore_payload(rollback.payload, restore_public_position=False)
        self._revision = int(rollback.payload["revision"])
        self._sequence = int(rollback.payload["event_sequence"])
        self._status_reason = rollback.status_reason
        self._controller_client_id = rollback.controller_client_id
        self._controller_deadline_wall = rollback.controller_deadline_wall
        if force_paused and rollback.state is not SessionState.ENDED:
            self._state = SessionState.PAUSED
            self._pause_clock()
            self._controller_client_id = None
            self._controller_deadline_wall = None
        else:
            self._state = rollback.state
            if rollback.state is SessionState.PLAYING:
                self._clock.start()

    async def _commit_mutation(
        self,
        *,
        kind: str,
        command: ReplayCommand | None,
        result: CommandResult | None,
        error: ReplayDomainError | None,
        checkpoint: bytes | None,
        component_state: Mapping[str, object] | None = None,
    ) -> None:
        pending_events = tuple(self._pending_events or ())
        events = tuple(event for event, _ in pending_events)
        source_events = tuple(self._pending_source_events or ())
        components = (
            dict(self._reducer.snapshot())
            if component_state is None
            else dict(component_state)
        )
        persisted_components = dict(components)
        persisted_components["journal"] = [
            dict(entry) for entry in self._journal_entries
        ]
        mutation = ActorMutation(
            kind=kind,
            session_id=self.session_id,
            session_state=self._durable_state(component_state=components),
            checkpoint=checkpoint,
            events=events,
            source_events=source_events,
            component_state=persisted_components,
            command=command,
            result=result,
            error=error,
        )
        if self._mutation_hook is not None:
            await self._mutation_hook(mutation)
        for event, mandatory in pending_events:
            self._publish_event(event, mandatory=mandatory)
        self._pending_events = None
        self._pending_source_events = None

    def _durable_state(
        self,
        *,
        component_state: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        return {
            "state": self._state.value,
            "status_reason": self._status_reason,
            "revision": self._revision,
            "event_sequence": self._sequence,
            "source_sequence": self._source.cursor().source_sequence,
            "command_log_offset": self._command_log_offset,
            "state_hash": self._compute_state_hash(component_state=component_state),
            "data_epoch": self._data_epoch,
            "cursor": self._cursor_dict(),
            "revealed": self._revealed,
            "accepting": self._accepting and not self._closing,
            "degraded_reason": self._degraded_reason,
        }

    def _enter_persistence_degraded(self, error: BaseException) -> ReplayDomainError:
        self._metrics["persistence_failures"] = (
            int(self._metrics["persistence_failures"] or 0) + 1
        )
        if isinstance(error, ReplayDomainError):
            reason = error.message
            details = dict(error.details)
        else:
            reason = f"{type(error).__name__}: {error}"
            details = {}
        self._degraded_reason = reason[:500]
        self._status_reason = "persistence_degraded"
        if self._state is not SessionState.ENDED:
            self._pause_clock()
            self._state = SessionState.PAUSED
        details["reason"] = self._degraded_reason
        return ReplayDomainError(
            ReplayErrorCode.PERSISTENCE_DEGRADED,
            "replay mutation was rolled back because persistence failed",
            details=details,
        )

    def _create_checkpoint(self, *, initial: bool) -> bytes:
        started = time.perf_counter()
        payload = self._checkpoint_payload()
        encoded = self._checkpoint_codec.encode(payload)
        self._record_checkpoint(encoded, initial=initial, started=started)
        return encoded

    def _record_checkpoint(
        self,
        encoded: bytes,
        *,
        initial: bool,
        started: float | None = None,
    ) -> None:
        if started is None:
            started = time.perf_counter()
        self._checkpoints.add(
            encoded,
            virtual_time_ms=self._clock.virtual_time_ms,
            source_sequence=self._source.cursor().source_sequence,
            state_hash=self._compute_state_hash(),
            initial=initial,
        )
        self._last_checkpoint_source_sequence = self._source.cursor().source_sequence
        self._last_checkpoint_virtual_ms = self._clock.virtual_time_ms
        elapsed_ms = (time.perf_counter() - started) * 1_000
        self._checkpoint_latency.add(elapsed_ms)
        self._metrics["checkpoints_created"] = (
            int(self._metrics["checkpoints_created"] or 0) + 1
        )
        self._metrics["checkpoint_bytes"] = int(
            self._metrics["checkpoint_bytes"] or 0
        ) + len(encoded)

    def _checkpoint_due(self) -> bool:
        cursor = self._source.cursor()
        return (
            cursor.source_sequence - self._last_checkpoint_source_sequence
            >= self._checkpoint_event_interval
            or self._clock.virtual_time_ms - self._last_checkpoint_virtual_ms
            >= self._checkpoint_virtual_ms
        )

    def _maybe_checkpoint(self) -> None:
        if self._checkpoint_due():
            self._create_checkpoint(initial=False)

    def _checkpoint_payload(
        self,
        *,
        component_state: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        components = (
            dict(self._reducer.snapshot())
            if component_state is None
            else dict(component_state)
        )
        state_hash = self._compute_state_hash(component_state=components)
        cursor = self._cursor()
        source_cursor = self._source.cursor()
        return {
            "schema_version": ACTOR_CHECKPOINT_STATE_SCHEMA_VERSION,
            "core_version": REPLAY_CORE_VERSION,
            "execution_version": self._execution_version,
            "data_epoch": self._data_epoch,
            "snapshot_ref_hash": self._snapshot_ref_hash,
            "session_config_hash": self._session_config_hash,
            "session_state": self._state.value,
            "virtual_time_ms": cursor.virtual_time_ms,
            "source_sequence": cursor.source_sequence,
            "source_cursor": {
                "source_sequence": source_cursor.source_sequence,
                "last_event_time_ms": source_cursor.last_event_time_ms,
                "last_base_bar_open_ms": source_cursor.last_base_bar_open_ms,
                "at_end": source_cursor.at_end,
            },
            "clock_speed": self._clock.speed,
            "revision": self._revision,
            "event_sequence": self._sequence,
            "domain_command_position": self._domain_command_position,
            "command_log_offset": self._command_log_offset,
            "event_chain_hash": self._event_chain_hash,
            "revealed": self._revealed,
            "journal_entries": [dict(entry) for entry in self._journal_entries],
            "component_state": components,
            "state_hash": state_hash,
        }

    def _restore_payload(
        self,
        payload: Mapping[str, object],
        *,
        restore_public_position: bool,
    ) -> None:
        required = {
            "schema_version",
            "core_version",
            "execution_version",
            "data_epoch",
            "snapshot_ref_hash",
            "session_config_hash",
            "session_state",
            "virtual_time_ms",
            "source_sequence",
            "source_cursor",
            "clock_speed",
            "revision",
            "event_sequence",
            "domain_command_position",
            "command_log_offset",
            "event_chain_hash",
            "revealed",
            "journal_entries",
            "component_state",
            "state_hash",
        }
        if set(payload) != required:
            raise ValueError("actor checkpoint fields are incompatible")
        if not self._checkpoint_matches_actor(payload):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint identity/version does not match actor",
            )
        source_sequence = validate_counter(
            payload["source_sequence"],
            field_name="source_sequence",
        )
        revision = validate_counter(payload["revision"], field_name="revision")
        event_sequence = validate_counter(
            payload["event_sequence"],
            field_name="event_sequence",
        )
        domain_command_position = validate_counter(
            payload["domain_command_position"],
            field_name="domain_command_position",
        )
        command_log_offset = validate_counter(
            payload["command_log_offset"],
            field_name="command_log_offset",
        )
        revealed = payload["revealed"]
        if not isinstance(revealed, bool):
            raise TypeError("revealed must be a boolean")
        raw_journal = payload["journal_entries"]
        if not isinstance(raw_journal, list) or len(raw_journal) > MAX_JOURNAL_ENTRIES:
            raise ValueError("journal_entries is invalid or exceeds its bound")
        journal_entries: list[dict[str, object]] = []
        for raw_entry in raw_journal:
            if not isinstance(raw_entry, Mapping) or set(raw_entry) != {
                "entry_id",
                "virtual_time_ms",
                "text",
            }:
                raise ValueError("journal entry fields are incompatible")
            entry_id = validate_identifier(raw_entry["entry_id"], field_name="entry_id")
            entry_time = validate_timestamp_ms(
                raw_entry["virtual_time_ms"], field_name="journal virtual_time_ms"
            )
            text = raw_entry["text"]
            if not isinstance(text, str) or not text or len(text) > 4_000:
                raise ValueError("journal entry text is invalid")
            journal_entries.append(
                {
                    "entry_id": entry_id,
                    "virtual_time_ms": entry_time,
                    "text": text,
                }
            )
        try:
            stored_state = SessionState(payload["session_state"])
        except (TypeError, ValueError) as exc:
            raise ValueError("session_state is invalid") from exc
        if stored_state in {SessionState.INITIALIZING, SessionState.ERROR}:
            raise ValueError("session_state is not checkpoint-restorable")
        expected_chain = self._require_digest(
            payload["event_chain_hash"],
            "event_chain_hash",
        )
        source, chain = self._source_at_sequence(
            source_sequence,
            expected_chain=expected_chain,
        )
        if chain != expected_chain:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint source chain does not match immutable dataset",
            )
        source_cursor_payload = payload["source_cursor"]
        source_cursor_fields = {
            "source_sequence",
            "last_event_time_ms",
            "last_base_bar_open_ms",
            "at_end",
        }
        if (
            not isinstance(source_cursor_payload, Mapping)
            or set(source_cursor_payload) != source_cursor_fields
        ):
            raise ValueError("source_cursor fields are incompatible")
        cursor_source_sequence = validate_counter(
            source_cursor_payload["source_sequence"],
            field_name="source_cursor.source_sequence",
        )
        if cursor_source_sequence != source_sequence:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint source cursor sequence is inconsistent",
            )

        def optional_timestamp(value: object, field_name: str) -> int | None:
            if value is None:
                return None
            return validate_timestamp_ms(value, field_name=field_name)

        cursor_at_end = source_cursor_payload["at_end"]
        if not isinstance(cursor_at_end, bool):
            raise TypeError("source_cursor.at_end must be a boolean")
        normalized_source_cursor = {
            "source_sequence": cursor_source_sequence,
            "last_event_time_ms": optional_timestamp(
                source_cursor_payload["last_event_time_ms"],
                "source_cursor.last_event_time_ms",
            ),
            "last_base_bar_open_ms": optional_timestamp(
                source_cursor_payload["last_base_bar_open_ms"],
                "source_cursor.last_base_bar_open_ms",
            ),
            "at_end": cursor_at_end,
        }
        actual_source_cursor = source.cursor()
        if normalized_source_cursor != {
            "source_sequence": actual_source_cursor.source_sequence,
            "last_event_time_ms": actual_source_cursor.last_event_time_ms,
            "last_base_bar_open_ms": actual_source_cursor.last_base_bar_open_ms,
            "at_end": actual_source_cursor.at_end,
        }:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint source cursor does not match immutable dataset",
            )
        virtual_time = validate_timestamp_ms(
            payload["virtual_time_ms"],
            field_name="virtual_time_ms",
        )
        if (
            actual_source_cursor.last_event_time_ms is not None
            and actual_source_cursor.last_event_time_ms > virtual_time
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint virtual clock precedes its source cursor",
            )
        next_event = source.peek()
        if next_event is not None and self._event_time_ms(next_event) < virtual_time:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint virtual clock passed an unconsumed source event",
            )
        if source.exhausted() and stored_state is not SessionState.ENDED:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "exhausted checkpoint source is not marked ENDED",
            )
        component_state = payload["component_state"]
        if not isinstance(component_state, Mapping):
            raise TypeError("component_state must be an object")
        self._reducer.restore(component_state)
        self._source = source
        self._event_chain_hash = expected_chain
        self._clock = VirtualClock(
            initial_time_ms=virtual_time,
            speed=payload["clock_speed"],  # type: ignore[arg-type]
            monotonic=self._monotonic,
        )
        self._state = (
            SessionState.ENDED
            if stored_state is SessionState.ENDED or source.exhausted()
            else SessionState.PAUSED
        )
        self._domain_command_position = domain_command_position
        self._command_log_offset = command_log_offset
        self._revealed = revealed
        self._journal_entries = journal_entries
        if restore_public_position:
            self._revision = revision
            self._sequence = event_sequence
            self._events = ReplayEventBuffer(
                max_events=self._event_buffer_size,
                initial_sequence=self._sequence,
            )
        expected_state_hash = self._require_digest(payload["state_hash"], "state_hash")
        actual_state_hash = self._compute_state_hash()
        if actual_state_hash != expected_state_hash:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint state hash does not match restored state",
                details={
                    "expected_state_hash": expected_state_hash,
                    "actual_state_hash": actual_state_hash,
                },
            )

    def _checkpoint_matches_actor(self, payload: Mapping[str, object]) -> bool:
        return (
            payload.get("schema_version") == ACTOR_CHECKPOINT_STATE_SCHEMA_VERSION
            and payload.get("core_version") == REPLAY_CORE_VERSION
            and payload.get("execution_version") == self._execution_version
            and payload.get("data_epoch") == self._data_epoch
            and payload.get("snapshot_ref_hash") == self._snapshot_ref_hash
            and payload.get("session_config_hash") == self._session_config_hash
        )

    def _compute_state_hash(
        self,
        *,
        component_state: Mapping[str, object] | None = None,
    ) -> str:
        cursor = self._cursor()
        components = (
            dict(self._reducer.snapshot())
            if component_state is None
            else dict(component_state)
        )
        return canonical_sha256(
            {
                "schema_version": ACTOR_STATE_HASH_SCHEMA_VERSION,
                "core_version": REPLAY_CORE_VERSION,
                "execution_version": self._execution_version,
                "data_epoch": self._data_epoch,
                "snapshot_ref_hash": self._snapshot_ref_hash,
                "session_config_hash": self._session_config_hash,
                "cursor": {
                    "virtual_time_ms": cursor.virtual_time_ms,
                    "source_sequence": cursor.source_sequence,
                    "last_base_bar_open_ms": cursor.last_base_bar_open_ms,
                    "last_trade_time_ms": cursor.last_trade_time_ms,
                    "last_agg_trade_id": cursor.last_agg_trade_id,
                    "at_end": cursor.at_end,
                },
                "event_chain_hash": self._event_chain_hash,
                "domain_command_position": self._domain_command_position,
                "blind_audit": {
                    "blind_mode": self.config.blind_mode,
                    "revealed": self._revealed,
                },
                "components": components,
            }
        )

    def _command_result(
        self,
        command_id: str,
        data: Mapping[str, object],
    ) -> CommandResult:
        return CommandResult(
            command_id=command_id,
            revision=self._revision,
            sequence=self._sequence,
            state=self._state,
            state_hash=self._compute_state_hash(),
            cursor=self._cursor(),
            data=data,
        )

    def _snapshot_value(
        self,
        *,
        materialize: bool,
        component_state: Mapping[str, object] | None = None,
    ) -> ActorSnapshot:
        if materialize:
            self._materialize_clock()
        return ActorSnapshot(
            session_id=self.session_id,
            state=self._state,
            revision=self._revision,
            sequence=self._sequence,
            cursor=self._cursor(),
            state_hash=self._compute_state_hash(component_state=component_state),
            data_epoch=self._data_epoch,
            controller_client_id=self._controller_client_id,
            speed=self._clock.speed,
            checkpoint_count=len(self._checkpoints.records()),
        )

    def _cursor(self) -> ReplayCursor:
        source_cursor = self._source.cursor()
        return ReplayCursor(
            virtual_time_ms=self._clock.virtual_time_ms,
            source_sequence=source_cursor.source_sequence,
            last_base_bar_open_ms=source_cursor.last_base_bar_open_ms,
            at_end=source_cursor.at_end,
        )

    def _cursor_dict(self) -> dict[str, object]:
        cursor = self._cursor()
        return {
            "virtual_time_ms": cursor.virtual_time_ms,
            "source_sequence": cursor.source_sequence,
            "last_base_bar_open_ms": cursor.last_base_bar_open_ms,
            "last_trade_time_ms": cursor.last_trade_time_ms,
            "last_agg_trade_id": cursor.last_agg_trade_id,
            "at_end": cursor.at_end,
        }

    def _public_snapshot_value(self) -> dict[str, object]:
        component_state = dict(self._reducer.snapshot())
        snapshot = self._snapshot_value(
            materialize=False,
            component_state=component_state,
        )
        return {
            "protocol": REPLAY_PROTOCOL,
            **snapshot.to_dict(),
            "status_reason": self._status_reason,
            "config": self.config.to_dict(),
            "components": component_state,
            "journal": [dict(entry) for entry in self._journal_entries],
            "revealed": self._revealed,
            "degraded_reason": self._degraded_reason,
        }

    def _report_value(self) -> Mapping[str, object]:
        build_report = getattr(self._reducer, "build_report", None)
        if not callable(build_report):
            return MappingProxyType({})
        report = build_report()
        to_dict = getattr(report, "to_dict", None)
        if not callable(to_dict):
            raise TypeError("replay reducer report must provide to_dict()")
        payload = to_dict()
        if not isinstance(payload, Mapping):
            raise TypeError("replay reducer report payload must be an object")
        return MappingProxyType(dict(payload))

    def _emit_status(self, reason: str, *, mandatory: bool) -> None:
        self._status_reason = reason
        self._emit(
            ReplayEventType.STATUS,
            {
                "state": self._state.value,
                "reason": reason,
                "speed": self._clock.speed,
                "controller_client_id": self._controller_client_id,
            },
            mandatory=mandatory,
        )

    def _emit(
        self,
        event_type: ReplayEventType,
        data: Mapping[str, object],
        *,
        mandatory: bool,
    ) -> None:
        self._sequence += 1
        event = ReplayEvent(
            type=event_type,
            protocol=REPLAY_PROTOCOL,
            session_id=self.session_id,
            sequence=self._sequence,
            revision=self._revision,
            virtual_time_ms=self._clock.virtual_time_ms,
            state_hash=self._compute_state_hash(),
            data_epoch=self._data_epoch,
            data=data,
        )
        if self._pending_events is not None:
            self._pending_events.append((event, mandatory))
            return
        self._publish_event(event, mandatory=mandatory)

    def _publish_event(self, event: ReplayEvent, *, mandatory: bool) -> None:
        self._events.append(event)
        batches = self._coalescer.offer(
            event,
            wall_time=self._read_wall(),
            mandatory=mandatory,
        )
        self._store_projection_batches(batches)
        for token, (queue, overflow) in tuple(self._subscribers.items()):
            try:
                queue.put_nowait(event)
                self._metrics["subscriber_high_water"] = max(
                    int(self._metrics["subscriber_high_water"] or 0),
                    queue.qsize(),
                )
            except asyncio.QueueFull:
                overflow.set()
                self._subscribers.pop(token, None)
                self._metrics["subscriber_overflows"] = (
                    int(self._metrics["subscriber_overflows"] or 0) + 1
                )

    def _store_projection_batches(self, batches: tuple[ProjectionBatch, ...]) -> None:
        for batch in batches:
            if len(self._projection_buffer) == self._projection_buffer.maxlen:
                self._metrics["projection_buffer_evictions"] = (
                    int(self._metrics["projection_buffer_evictions"] or 0) + 1
                )
            self._projection_buffer.append(batch)

    def _materialize_clock(self) -> None:
        if not self._clock.playing:
            return
        self._clock.materialize(cap_ms=self._next_source_boundary())

    def _pause_clock(self) -> None:
        self._clock.pause(cap_ms=self._next_source_boundary())

    def _next_source_boundary(self) -> int:
        event = self._source.peek()
        if event is None:
            return self._clock.virtual_time_ms
        return self._event_time_ms(event)

    def _source_at_sequence(
        self,
        source_sequence: int,
        *,
        expected_chain: str | None,
    ) -> tuple[ReplayMarketSource, str]:
        source = self._new_source()
        chain = self._initial_chain_hash()
        previous_time = self._initial_virtual_time_ms
        for sequence in range(1, source_sequence + 1):
            event = source.next()
            if event is None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "checkpoint source cursor exceeds immutable dataset",
                )
            event_time = self._event_time_ms(event)
            if event_time < previous_time:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "immutable source event order is invalid",
                )
            previous_time = event_time
            chain = self._next_chain_hash(chain, event, sequence)
        if expected_chain is not None and chain != expected_chain:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "immutable source content changed at checkpoint cursor",
            )
        return source, chain

    def _new_source(self) -> ReplayMarketSource:
        source = self._source_factory()
        for method_name in (
            "snapshot_ref",
            "peek",
            "next",
            "advance_until",
            "cursor",
            "exhausted",
        ):
            if not callable(getattr(source, method_name, None)):
                raise TypeError(f"replay source is missing {method_name}()")
        snapshot_ref = source.snapshot_ref()
        data_epoch = self._extract_data_epoch(snapshot_ref)
        if hasattr(self, "_data_epoch") and data_epoch != self._data_epoch:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "source factory returned a different data_epoch",
            )
        if (
            hasattr(self, "_snapshot_ref_hash")
            and canonical_sha256(snapshot_ref) != self._snapshot_ref_hash
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "source factory returned a different immutable snapshot_ref",
            )
        return source

    def _initial_chain_hash(self) -> str:
        return canonical_sha256(
            {
                "schema_version": SOURCE_CHAIN_SCHEMA_VERSION,
                "data_epoch": self._data_epoch,
                "source_sequence": 0,
            }
        )

    @staticmethod
    def _next_chain_hash(previous: str, event: object, sequence: int) -> str:
        return canonical_sha256(
            {
                "schema_version": SOURCE_CHAIN_SCHEMA_VERSION,
                "previous": previous,
                "source_sequence": sequence,
                "event": ReplaySessionActor._event_payload(event),
            }
        )

    @staticmethod
    def _event_payload(event: object) -> dict[str, object]:
        to_dict = getattr(event, "to_dict", None)
        if callable(to_dict):
            payload = to_dict()
        elif is_dataclass(event) and not isinstance(event, type):
            payload = {
                field.name: getattr(event, field.name) for field in fields(event)
            }
        elif isinstance(event, Mapping):
            payload = dict(event)
        else:
            raise TypeError("replay source event must be a dataclass or object mapping")
        if not isinstance(payload, Mapping):
            raise TypeError("replay source event payload must be an object")
        return dict(payload)

    @staticmethod
    def _event_time_ms(event: object) -> int:
        if isinstance(event, Mapping):
            candidates = (
                event.get("event_time_ms"),
                event.get("trade_time_ms"),
                event.get("close_time_ms"),
            )
        else:
            candidates = (
                getattr(event, "event_time_ms", None),
                getattr(event, "trade_time_ms", None),
                getattr(event, "close_time_ms", None),
            )
        for value in candidates:
            if value is not None:
                return validate_timestamp_ms(value, field_name="source_event_time_ms")
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_MISMATCH,
            "replay source event has no supported event time",
        )

    @staticmethod
    def _extract_data_epoch(snapshot_ref: object) -> str:
        value = (
            snapshot_ref.get("data_epoch")
            if isinstance(snapshot_ref, Mapping)
            else getattr(snapshot_ref, "data_epoch", None)
        )
        if not isinstance(value, str) or not _DIGEST_PATTERN.fullmatch(value):
            raise ValueError("replay source snapshot_ref data_epoch is invalid")
        return value

    @staticmethod
    def _require_digest(value: object, field_name: str) -> str:
        if not isinstance(value, str) or not _DIGEST_PATTERN.fullmatch(value):
            raise ValueError(f"{field_name} must be a SHA-256 digest")
        return value

    def _take_ready_request(self) -> _ActorRequest | None:
        try:
            return self._queue.get_nowait()
        except asyncio.QueueEmpty:
            return None

    async def _wait_for_request(self, timeout: float | None) -> _ActorRequest | None:
        if timeout is None:
            return await self._queue.get()
        if timeout <= 0:
            return None
        try:
            return await asyncio.wait_for(self._queue.get(), timeout=timeout)
        except TimeoutError:
            return None

    def _offer_request(self, request: _ActorRequest) -> None:
        try:
            self._queue.put_nowait(request)
        except asyncio.QueueFull as exc:
            self._metrics["command_queue_overflows"] = (
                int(self._metrics["command_queue_overflows"] or 0) + 1
            )
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "replay actor command queue capacity exceeded",
                details={"queue_capacity": self._queue_size},
            ) from exc
        self._record_queue_high_water()

    def _record_queue_high_water(self) -> None:
        self._metrics["command_queue_high_water"] = max(
            int(self._metrics["command_queue_high_water"] or 0),
            self._queue.qsize(),
        )

    def _lease_delay(self) -> float | None:
        if self._controller_deadline_wall is None:
            return None
        return max(0.0, self._controller_deadline_wall - self._read_wall())

    def _ensure_accepting(self) -> None:
        if self._task is None or not self._accepting or self._closing or self._closed:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "replay actor is not accepting requests",
            )

    async def _cancel_actor_task(self, timeout: float) -> None:
        task = self._task
        if task is None or task.done():
            return
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=timeout)
        if task not in done:
            self._metrics["shutdown_timeouts"] = (
                int(self._metrics["shutdown_timeouts"] or 0) + 1
            )
            self._metrics["last_shutdown_error"] = (
                "actor task ignored cancellation after shutdown timeout"
            )
            return
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except BaseException:
            # _run already records ERROR and fails every queued request.
            pass

    def _fail_pending(self, error: BaseException) -> None:
        while True:
            try:
                request = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            future = request.future
            if not future.done():
                future.set_exception(error)
            self._queue.task_done()

    def _read_wall(self) -> float:
        value = self._monotonic()
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("monotonic clock must return a number")
        wall = float(value)
        if not math.isfinite(wall):
            raise ValueError("monotonic clock must return a finite number")
        return wall

    @staticmethod
    def _positive_int(value: object, field_name: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"{field_name} must be a positive integer")
        return value
