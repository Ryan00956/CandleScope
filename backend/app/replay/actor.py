"""Single-writer deterministic replay session actor."""

from __future__ import annotations

import asyncio
import inspect
import math
import re
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Awaitable, Callable, Protocol, Sequence

from .canonical import canonical_sha256
from .checkpoints import CheckpointCodec, CheckpointError, CheckpointRing
from .clock import CLOCK_SCHEMA_VERSION, ClockSnapshot, VirtualClock
from .commands import CommandHistory, CommandResult, ParsedCommand, parse_command
from .constants import (
    REPLAY_CORE_VERSION,
    REPLAY_PROTOCOL,
    CommandType,
    ReplayEventType,
    SessionState,
    SourceKind,
)
from .errors import ReplayDomainError, ReplayErrorCode
from .internal_commands import InternalCommandType
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
from .period_summary import ReplayPeriodSummary
from .projection import ProjectionBatch, ProjectionCoalescer
from .source_chain import (
    initial_source_chain_hash,
    next_source_chain_hash,
    source_event_payload,
)
from .sources.base import ReplayMarketSource, SourceCursor


ACTOR_STATE_HASH_SCHEMA_VERSION = "replay-actor-state-hash.v1"
ACTOR_CHECKPOINT_STATE_SCHEMA_VERSION = "replay-actor-checkpoint-state.v2"
MIN_TASK_EXIT_GRACE_SECONDS = 0.05
MAX_JOURNAL_ENTRIES = 4_096
COMMAND_EVENT_LOOP_YIELD_INTERVAL = 64
MAX_SOURCE_GOAL_SCAN_EVENTS = 100_000
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

    def final_state_transport_anchor(self) -> int | None: ...

    def final_state_transport_projection(
        self,
        replace_from_open_ms: int | None,
    ) -> Mapping[str, object]: ...


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

    def final_state_transport_anchor(self) -> int | None:
        return None

    def final_state_transport_projection(
        self,
        replace_from_open_ms: int | None,
    ) -> Mapping[str, object]:
        del replace_from_open_ms
        raise ReplayDomainError(
            ReplayErrorCode.INVALID_STATE_TRANSITION,
            "final-state projection is unavailable without a replay reducer",
        )


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
    component_state: Mapping[str, object]
    expected_state_hash: str
    source: ReplayMarketSource
    source_cursor: SourceCursor
    clock: ClockSnapshot
    state: SessionState
    status_reason: str
    controller_client_id: str | None
    controller_deadline_wall: float | None
    revision: int
    sequence: int
    domain_command_position: int
    command_log_offset: int
    event_chain_hash: str
    revealed: bool
    journal_entries: tuple[Mapping[str, object], ...]
    final_state_anchor_source_sequence: int | None
    final_state_anchor_bar_open_ms: int | None


@dataclass(frozen=True, slots=True)
class _SeekPlan:
    target_time_ms: int
    checkpoint_payload: Mapping[str, object]
    checkpoint_source: ReplayMarketSource
    replay_event_count: int


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
    queue: asyncio.Queue[ProjectionBatch]
    overflow: asyncio.Event

    async def next_event(self) -> ProjectionBatch:
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
class _SubscriberState:
    queue: asyncio.Queue[ProjectionBatch]
    overflow: asyncio.Event
    next_sequence: int


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
class _SummaryAuthorityRequest:
    future: asyncio.Future[dict[str, object]]


@dataclass(slots=True)
class _PeriodSummaryJumpRequest:
    summary: ReplayPeriodSummary
    client_instance_id: str
    expected_revision: int
    future: asyncio.Future[dict[str, object]]


@dataclass(slots=True)
class _SourceChunkPlanRequest:
    target_time_ms: int
    max_events: int
    future: asyncio.Future[dict[str, object]]


@dataclass(slots=True)
class _SourceGoalScanRequest:
    max_events: int
    future: asyncio.Future[dict[str, object]]


@dataclass(slots=True)
class _SourceEventsPageRequest:
    after_sequence: int
    limit: int
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
    force_pause_reason: bool


_ActorRequest = (
    _CommandRequest
    | _HeartbeatRequest
    | _SnapshotRequest
    | _PublicSnapshotRequest
    | _ReportRequest
    | _CheckpointRequest
    | _DurableStateRequest
    | _SummaryAuthorityRequest
    | _PeriodSummaryJumpRequest
    | _SourceChunkPlanRequest
    | _SourceGoalScanRequest
    | _SourceEventsPageRequest
    | _SubscribeRequest
    | _UnsubscribeRequest
    | _ShutdownRequest
)


def _consume_abandoned_future(future: asyncio.Future[object]) -> None:
    """Retrieve a detached mutation failure after its caller was cancelled."""

    if future.cancelled():
        return
    try:
        future.exception()
    except BaseException:
        pass


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
        retained_checkpoints: Sequence[tuple[bytes, bool]] = (),
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
        # A command can never stage more source events than the already
        # configured resumable-event budget.  This keeps reducer work,
        # candidate projections, and rollback memory deterministically bounded.
        self._max_atomic_command_source_events = self._event_buffer_size
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
        self._retained_checkpoints = tuple(
            (bytes(encoded), bool(is_initial))
            for encoded, is_initial in retained_checkpoints
        )
        self._reducer: ReplayReducer = reducer or NullReplayReducer()
        # Reducer snapshots are detached, immutable-by-contract component
        # states.  The actor is the sole reducer writer, so repeated state
        # hashes/checkpoints for one actor state can safely reuse the same
        # materialization until a reducer mutation explicitly invalidates it.
        self._component_state_cache: dict[str, object] | None = None
        self._component_state_revision = 0
        self._state_hash_cache_key: tuple[object, ...] | None = None
        self._state_hash_cache: str | None = None

        self._queue: asyncio.Queue[_ActorRequest] = asyncio.Queue(
            maxsize=self._queue_size
        )
        self._events = ReplayEventBuffer(max_events=self._event_buffer_size)
        self._coalescer = ProjectionCoalescer(
            max_fps=self._max_emit_fps,
            max_pending_events=self._event_buffer_size,
        )
        self._projection_buffer: deque[ProjectionBatch] = deque(
            maxlen=self._event_buffer_size,
        )
        self._projection_buffer_domain_events = 0
        self._command_history = CommandHistory(max_records=max_command_records)
        self._checkpoint_codec = CheckpointCodec()
        self._max_recent_checkpoints = self._positive_int(
            max_recent_checkpoints,
            "max_recent_checkpoints",
        )
        self._checkpoints = CheckpointRing(max_recent=self._max_recent_checkpoints)

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
        self._final_state_anchor_source_sequence: int | None = None
        self._final_state_anchor_bar_open_ms: int | None = None
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
        self._subscribers: dict[int, _SubscriberState] = {}
        self._next_subscriber_token = 1
        # Transport cleanup has to remain actor-owned even when the bounded
        # business mailbox is saturated.  These structures form a coalescing
        # control inbox: at most one cleanup is retained per active subscriber,
        # and only the actor task removes entries from ``_subscribers``.
        self._unsubscribe_completions: dict[int, asyncio.Future[None]] = {}
        self._deferred_unsubscribes: set[int] = set()

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
            "projection_buffer_evicted_domain_events": 0,
            "projection_buffer_oversize_drops": 0,
            "checkpoints_created": 0,
            "checkpoint_bytes": 0,
            "shutdown_attempts": 0,
            "shutdown_timeouts": 0,
            "shutdown_failures": 0,
            "last_shutdown_error": None,
            "runtime_failures": 0,
            "last_runtime_error_type": None,
            "last_runtime_error_message": None,
            "persistence_failures": 0,
            "subscriber_high_water": 0,
            "subscriber_overflows": 0,
            "subscriber_opens": 0,
            "subscriber_closes": 0,
            "subscriber_cleanup_deferrals": 0,
            "component_snapshot_materializations": 0,
            "command_source_event_limit": self._max_atomic_command_source_events,
            "command_preflight_events": 0,
            "command_resource_rejections": 0,
            "period_summary_jumps": 0,
            "period_summary_skipped_events": 0,
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

    async def summary_authority(self) -> dict[str, object]:
        """Return only hashes/cursors needed to select a trusted summary."""

        if self._closed:
            return self._summary_authority_value()
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        loop = asyncio.get_running_loop()
        request = _SummaryAuthorityRequest(loop.create_future())
        self._offer_request(request)
        return await request.future

    async def apply_period_summary(
        self,
        summary: ReplayPeriodSummary,
        *,
        client_instance_id: str,
        expected_revision: int,
    ) -> dict[str, object]:
        """Atomically restore one exact derived summary inside the mailbox."""

        if not isinstance(summary, ReplayPeriodSummary):
            raise TypeError("summary must be ReplayPeriodSummary")
        self._ensure_accepting()
        if self._degraded_reason is not None:
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay session persistence is degraded",
                details={"reason": self._degraded_reason},
            )
        client = validate_identifier(
            client_instance_id,
            field_name="client_instance_id",
        )
        revision = validate_counter(expected_revision, field_name="expected_revision")
        loop = asyncio.get_running_loop()
        request = _PeriodSummaryJumpRequest(
            summary=summary,
            client_instance_id=client,
            expected_revision=revision,
            future=loop.create_future(),
        )
        self._offer_request(request)
        # A caller cancellation must not cancel a summary mutation that may
        # already be committing.  Durable advance intent reconciles its result.
        try:
            return await asyncio.shield(request.future)
        except asyncio.CancelledError:
            request.future.add_done_callback(_consume_abandoned_future)
            raise

    async def source_chunk_plan(
        self,
        *,
        target_time_ms: int,
        max_events: int,
    ) -> dict[str, object]:
        """Plan one bounded immutable-source chunk from inside the mailbox."""

        self._ensure_accepting()
        target = validate_timestamp_ms(target_time_ms, field_name="target_time_ms")
        maximum = self._positive_int(max_events, "max_events")
        maximum = min(maximum, self._max_atomic_command_source_events)
        loop = asyncio.get_running_loop()
        request = _SourceChunkPlanRequest(
            target_time_ms=target,
            max_events=maximum,
            future=loop.create_future(),
        )
        self._offer_request(request)
        return await request.future

    async def scan_source_goal(self, *, max_events: int) -> dict[str, object]:
        """Scan one immutable-source goal without mutating the live cursor."""

        self._ensure_accepting()
        maximum = self._positive_int(max_events, "max_events")
        if maximum > MAX_SOURCE_GOAL_SCAN_EVENTS:
            raise ValueError(
                f"max_events cannot exceed {MAX_SOURCE_GOAL_SCAN_EVENTS}"
            )
        loop = asyncio.get_running_loop()
        request = _SourceGoalScanRequest(
            max_events=maximum,
            future=loop.create_future(),
        )
        self._offer_request(request)
        return await request.future

    async def source_events_page(
        self,
        *,
        after_sequence: int,
        limit: int,
    ) -> dict[str, object]:
        """Read one bounded page from the revealed immutable source prefix."""

        self._ensure_accepting()
        after = validate_counter(after_sequence, field_name="after_sequence")
        maximum = min(self._positive_int(limit, "limit"), 1_000)
        loop = asyncio.get_running_loop()
        request = _SourceEventsPageRequest(
            after_sequence=after,
            limit=maximum,
            future=loop.create_future(),
        )
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
        try:
            # Keep caller cancellation from cancelling the ownership future.
            # If the actor already published a token, cancellation must enqueue
            # its cleanup before it can escape this method.
            return await asyncio.shield(request.future)
        except asyncio.CancelledError:
            if request.future.done():
                if not request.future.cancelled():
                    try:
                        subscription = request.future.result()
                    except BaseException:
                        pass
                    else:
                        self._request_unsubscribe(subscription.token)
            else:
                # The synchronous mailbox handler observes this tombstone before
                # allocating a subscriber token.
                request.future.cancel()
            raise

    async def unsubscribe(self, token: int) -> None:
        completion = self.request_unsubscribe(token)
        if completion is not None:
            # The cleanup remains owned by the actor if this waiter is cancelled.
            await asyncio.shield(completion)

    def request_unsubscribe(self, token: int) -> asyncio.Future[None] | None:
        """Synchronously transfer cleanup ownership to the actor control inbox."""

        if self._closed:
            return None
        if self._task is None:
            raise RuntimeError("replay actor has not started")
        normalized = validate_counter(token, field_name="subscriber token")
        return self._request_unsubscribe(normalized)

    def current_snapshot(self) -> ActorSnapshot:
        if self._last_snapshot is not None:
            return self._last_snapshot
        return self._snapshot_value(materialize=False)

    async def shutdown(
        self,
        *,
        step_timeout: float = 5.0,
        force_pause_reason: bool = False,
    ) -> None:
        if (
            isinstance(step_timeout, bool)
            or not isinstance(step_timeout, (int, float))
            or not math.isfinite(float(step_timeout))
            or float(step_timeout) <= 0
        ):
            raise ValueError("step_timeout must be positive and finite")
        if not isinstance(force_pause_reason, bool):
            raise TypeError("force_pause_reason must be a bool")
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
            request = _ShutdownRequest(
                loop.create_future(),
                timeout,
                force_pause_reason,
            )
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
        elif force_pause_reason:
            request.force_pause_reason = True
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

    def has_active_subscribers(self) -> bool:
        """Return whether this event-loop-confined actor has a live stream owner."""

        return bool(self._subscribers)

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
            "projection_buffer_domain_events": self._projection_buffer_domain_events,
            "projection_buffer_capacity_events": self._event_buffer_size,
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
            "pending_unsubscribes": len(self._unsubscribe_completions),
        }

    async def _run(self) -> None:
        try:
            await self._bootstrap()
            self._accepting = True
            self._ready.set()
            while not self._exit_requested:
                self._drain_deferred_unsubscribes()
                await self._expire_controller_if_needed()
                self._flush_due_projections()
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
                    timeout = self._minimum_timeout(
                        delay,
                        lease_delay,
                        self._projection_flush_delay(),
                    )
                    request = await self._wait_for_request(timeout)
                    if request is not None:
                        await self._handle_request(request)
                    continue
                request = await self._wait_for_request(
                    self._minimum_timeout(
                        self._lease_delay(),
                        self._projection_flush_delay(),
                    )
                )
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
            started = self._ready.is_set()
            self._state = SessionState.ERROR
            self._accepting = False
            self._startup_error = exc if not started else None
            if started:
                self._metrics["runtime_failures"] = (
                    int(self._metrics["runtime_failures"] or 0) + 1
                )
                self._metrics["last_runtime_error_type"] = type(exc).__name__[:200]
                self._metrics["last_runtime_error_message"] = str(exc)[:500]
            self._last_snapshot = self._snapshot_value(materialize=False)
            self._ready.set()
            self._fail_pending(exc)
        finally:
            self._accepting = False
            self._closing = False
            self._closed = True
            self._drain_deferred_unsubscribes()
            # Read-only requests do not require ``accepting`` and can therefore
            # enter behind the shutdown barrier.  Once that barrier requests
            # loop exit, no later mailbox item will be handled; fail the tail
            # synchronously so callers cannot wait forever after a clean stop.
            self._fail_pending(
                RuntimeError("replay actor closed before queued request completed")
            )
            for subscriber in self._subscribers.values():
                subscriber.overflow.set()
            self._subscribers.clear()
            for completion in self._unsubscribe_completions.values():
                if not completion.done():
                    completion.set_result(None)
            self._unsubscribe_completions.clear()
            self._deferred_unsubscribes.clear()
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
        self._invalidate_component_state()
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
            self._restore_checkpoint_ring()
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
        if self._state is SessionState.ENDED or self._source.exhausted():
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
                if kind == "internal_state":
                    expected_command, expected_source = (
                        self._recover_internal_state_mutation(record)
                    )
                    continue
                expected_source = await self._recover_source_mutation(
                    record,
                    expected_source=expected_source,
                )
        finally:
            self._recovering_tail = False
            # Recovery has no surviving stream subscriber. Its first frame is
            # an authoritative full snapshot, so a pre-crash hidden-prefix
            # transport anchor must not leak into the next live command.
            self._final_state_anchor_source_sequence = None
            self._final_state_anchor_bar_open_ms = None
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
        if self._state is not SessionState.ENDED:
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

    def _recover_internal_state_mutation(
        self,
        record: Mapping[str, object],
    ) -> tuple[int, int]:
        if set(record) != {
            "kind",
            "mutation_kind",
            "checkpoint",
            "state_hash",
        }:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay internal mutation fields are incompatible",
            )
        mutation_kind = record["mutation_kind"]
        checkpoint = record["checkpoint"]
        if not isinstance(mutation_kind, str) or not mutation_kind:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay internal mutation kind is invalid",
            )
        if not isinstance(checkpoint, bytes):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay internal checkpoint is invalid",
            )
        try:
            payload = self._checkpoint_codec.decode(checkpoint)
            if not self._checkpoint_matches_actor(payload):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "persisted replay internal checkpoint identity changed",
                )
            self._restore_payload(payload, restore_public_position=True)
        except (CheckpointError, TypeError, ValueError, KeyError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay internal checkpoint restore failed",
            ) from exc
        expected_state_hash = self._require_digest(
            record["state_hash"], "internal mutation state_hash"
        )
        if self._compute_state_hash() != expected_state_hash:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay internal mutation state hash does not match",
            )
        return (
            self._command_log_offset + 1,
            self._source.cursor().source_sequence + 1,
        )

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
        command = ReplayCommand.from_persisted_dict(command_payload)
        if accepted:
            if command.expected_revision != self._revision:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "recovered replay command revision does not match",
                )
            self._begin_candidate(capture_source_events=False)
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
        _, recovered_state_hash, _ = await self._apply_source_event_candidate(
            publish=False,
            materialize_state=True,
        )
        if self._source.cursor().source_sequence != sequence:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "recovered replay source cursor drifted",
            )
        if recovered_state_hash != record["state_hash"]:
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
            elif isinstance(request, _SummaryAuthorityRequest):
                self._materialize_clock()
                if not request.future.done():
                    request.future.set_result(self._summary_authority_value())
            elif isinstance(request, _PeriodSummaryJumpRequest):
                await self._handle_period_summary_jump(request)
            elif isinstance(request, _SourceChunkPlanRequest):
                if not request.future.done():
                    request.future.set_result(
                        self._source_chunk_plan(
                            target_time_ms=request.target_time_ms,
                            max_events=request.max_events,
                        )
                    )
            elif isinstance(request, _SourceGoalScanRequest):
                result = await self._scan_source_goal(
                    max_events=request.max_events,
                    cancelled=request.future.cancelled,
                )
                if not request.future.done():
                    request.future.set_result(result)
            elif isinstance(request, _SourceEventsPageRequest):
                if not request.future.done():
                    request.future.set_result(
                        self._source_events_page(
                            after_sequence=request.after_sequence,
                            limit=request.limit,
                        )
                    )
            elif isinstance(request, _SubscribeRequest):
                self._handle_subscribe_request(request)
            elif isinstance(request, _UnsubscribeRequest):
                self._handle_unsubscribe_request(request)
            else:
                await self._handle_shutdown_request(request)
        finally:
            # Controller requests are serialized through the actor.  A valid
            # atomic command can itself take longer than the lease TTL, which
            # means a heartbeat queued by the live client cannot be handled
            # until that command finishes.  Treat completion of that in-flight
            # owner request as fresh liveness so the next loop iteration does
            # not expire the controller before it can drain the heartbeat.
            if isinstance(request, (_CommandRequest, _PeriodSummaryJumpRequest)):
                self._renew_controller_lease_if_owned(
                    request.command.client_instance_id
                    if isinstance(request, _CommandRequest)
                    else request.client_instance_id
                )
            self._queue.task_done()

    async def _handle_period_summary_jump(
        self,
        request: _PeriodSummaryJumpRequest,
    ) -> None:
        if request.future.cancelled():
            return
        summary = request.summary
        rollback: _ActorRollback | None = None
        candidate_started = False
        try:
            if (
                canonical_sha256(summary.hash_material()) != summary.summary_hash
                or canonical_sha256(summary.end_component_state)
                != summary.end_component_state_hash
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period summary checksum changed after validation",
                )
            self._require_controller(request.client_instance_id)
            if request.expected_revision != self._revision:
                raise ReplayDomainError(
                    ReplayErrorCode.REVISION_CONFLICT,
                    "summary jump expected_revision does not match actor revision",
                    details={
                        "expected_revision": request.expected_revision,
                        "latest_revision": self._revision,
                        "state_hash": self._compute_state_hash(),
                    },
                )
            self._require_state(
                SessionState.PAUSED,
                InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT,
            )
            if summary.session_id != self.session_id:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period summary belongs to a different replay session",
                )
            expected_source_kind = (
                "BAR" if self.config.source_kind is SourceKind.BAR else "AGG_TRADE"
            )
            if summary.source_kind != expected_source_kind:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period summary source kind does not match actor",
                )
            identities = {
                "data_epoch": self._data_epoch,
                "snapshot_ref_hash": self._snapshot_ref_hash,
                "session_config_hash": self._session_config_hash,
                "execution_version": self._execution_version,
            }
            observed = {
                "data_epoch": summary.data_epoch,
                "snapshot_ref_hash": summary.snapshot_ref_hash,
                "session_config_hash": summary.session_config_hash,
                "execution_version": summary.execution_version,
            }
            if observed != identities:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period summary immutable identity does not match actor",
                )
            if self._domain_command_position != summary.base_domain_command_position:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "period summary lineage was invalidated by a domain mutation",
                    details={
                        "summary_domain_command_position": (
                            summary.base_domain_command_position
                        ),
                        "current_domain_command_position": (
                            self._domain_command_position
                        ),
                    },
                )
            current_cursor = self._source.cursor()
            if not (
                summary.base_source_sequence
                <= current_cursor.source_sequence
                < summary.end_source_sequence
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "period summary does not advance the current source cursor",
                    details={
                        "base_source_sequence": summary.base_source_sequence,
                        "current_source_sequence": current_cursor.source_sequence,
                        "end_source_sequence": summary.end_source_sequence,
                    },
                )
            if self._clock.virtual_time_ms >= summary.end_virtual_time_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "period summary end time is not ahead of the current clock",
                )
            if current_cursor.source_sequence == summary.base_source_sequence:
                if self._event_chain_hash != summary.base_event_chain_hash:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "period summary base event chain does not match actor",
                    )
                if (
                    canonical_sha256(self._component_state())
                    != summary.base_component_state_hash
                ):
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "period summary base component state does not match actor",
                    )
            if self._has_active_trading_path():
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "period summary cannot skip an active trading path",
                )

            fast_position = getattr(self._source, "fork_at_sequence", None)
            if not callable(fast_position):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source cannot position a period summary cursor",
                )
            try:
                positioned = fast_position(
                    summary.end_source_sequence,
                    last_event_time_ms=summary.end_source_cursor["last_event_time_ms"],
                )
            except ReplayDomainError:
                raise
            except Exception as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source rejected the period summary cursor",
                ) from exc
            self._validate_positioned_source(
                positioned,
                summary.end_source_cursor,
            )
            next_event = positioned.peek()
            if (
                next_event is not None
                and self._event_time_ms(next_event) < summary.end_virtual_time_ms
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period summary skipped beyond an unconsumed source event",
                )

            rollback = self._capture_rollback()
            self._begin_candidate(capture_source_events=False)
            candidate_started = True
            speed = self._clock.speed
            self._invalidate_component_state()
            self._reducer.restore(summary.end_component_state)
            self._source = positioned
            self._event_chain_hash = summary.end_event_chain_hash
            self._clock = VirtualClock(
                initial_time_ms=summary.end_virtual_time_ms,
                speed=speed,
                monotonic=self._monotonic,
            )
            self._state = SessionState.PAUSED
            self._revision += 1
            self._emit_reset_snapshot(
                "fast_forward_summary_jump",
                mandatory=True,
            )
            component_state = self._component_state()
            if canonical_sha256(component_state) != summary.end_component_state_hash:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period summary restored component state changed",
                )
            state_hash = self._compute_state_hash()
            checkpoint = self._checkpoint_codec.encode(
                self._checkpoint_payload(
                    component_state=component_state,
                    state_hash=state_hash,
                )
            )
            try:
                await self._commit_mutation(
                    kind="summary_jump",
                    command=None,
                    result=None,
                    error=None,
                    checkpoint=checkpoint,
                    component_state=component_state,
                    state_hash=state_hash,
                )
            except asyncio.CancelledError:
                assert rollback is not None
                self._restore_rollback(rollback, force_paused=True)
                raise
            except Exception as exc:
                assert rollback is not None
                self._restore_rollback(rollback, force_paused=True)
                raise self._enter_persistence_degraded(exc) from exc
            self._record_checkpoint(checkpoint, initial=False)
            skipped = summary.end_source_sequence - current_cursor.source_sequence
            self._metrics["period_summary_jumps"] = (
                int(self._metrics["period_summary_jumps"] or 0) + 1
            )
            self._metrics["period_summary_skipped_events"] = (
                int(self._metrics["period_summary_skipped_events"] or 0) + skipped
            )
            if not request.future.done():
                request.future.set_result(
                    {
                        "summary_id": summary.summary_id,
                        "summary_hash": summary.summary_hash,
                        "skipped_source_events": skipped,
                        "snapshot": self._public_snapshot_value(),
                        "authority": self._summary_authority_value(),
                    }
                )
        except BaseException as exc:
            if (
                candidate_started
                and rollback is not None
                and self._pending_events is not None
            ):
                self._restore_rollback(rollback, force_paused=False)
            if not request.future.done():
                request.future.set_exception(exc)

    def _summary_authority_value(self) -> dict[str, object]:
        cursor = self._source.cursor()
        component_state = self._component_state()
        return {
            "schema_version": "replay.summary-authority.v1",
            "session_id": self.session_id,
            "data_epoch": self._data_epoch,
            "snapshot_ref_hash": self._snapshot_ref_hash,
            "session_config_hash": self._session_config_hash,
            "execution_version": self._execution_version,
            "virtual_time_ms": self._clock.virtual_time_ms,
            "source_cursor": {
                "source_sequence": cursor.source_sequence,
                "last_event_time_ms": cursor.last_event_time_ms,
                "last_base_bar_open_ms": cursor.last_base_bar_open_ms,
                "at_end": cursor.at_end,
            },
            "event_chain_hash": self._event_chain_hash,
            "component_state_hash": canonical_sha256(component_state),
            "domain_command_position": self._domain_command_position,
            "has_active_trading_path": self._has_active_trading_path(),
            "has_trading_state": self._reducer.has_trading_state(),
            "state_hash": self._compute_state_hash(),
            "revision": self._revision,
        }

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
                self._begin_candidate(capture_source_events=False)
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
                    except asyncio.CancelledError:
                        if rollback is not None:
                            self._restore_rollback(rollback, force_paused=True)
                        raise
                    except Exception as persistence_exc:
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
            component_state = self._component_state()
            # _execute_command has already produced the authoritative final
            # state hash for its CommandResult.  Reuse it for the checkpoint
            # and durable row instead of hashing the same retained bar window
            # again through two explicit component-state call sites.
            state_hash = result.state_hash
            checkpoint = self._checkpoint_codec.encode(
                self._checkpoint_payload(
                    component_state=component_state,
                    state_hash=state_hash,
                )
            )
            try:
                await self._commit_mutation(
                    kind="command",
                    command=command,
                    result=result,
                    error=None,
                    checkpoint=checkpoint,
                    component_state=component_state,
                    state_hash=state_hash,
                )
            except asyncio.CancelledError:
                assert rollback is not None
                self._restore_rollback(rollback, force_paused=True)
                raise
            except Exception as exc:
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
            # A successful SEEK establishes a new checkpoint cadence origin.
            # Its persisted checkpoint must enter the in-memory ring even when
            # the rewound cursor is below the previous high-water marks.
            if (
                command.type is CommandType.SEEK_TO
                or self._state is SessionState.ENDED
                or self._checkpoint_due()
            ):
                self._record_checkpoint(checkpoint, initial=False)
            if not request.future.done():
                request.future.set_result(result)
        except asyncio.CancelledError:
            if not request.future.done():
                request.future.cancel()
            raise
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
            InternalCommandType.REVEAL_HISTORY_AUTHORIZED,
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
            await self._preflight_event_count(count)
            self._revision += 1
            consumed = 0
            for _ in range(count):
                await self._process_source_event(publish=True, checkpoint=False)
                consumed += 1
                if consumed % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                    await asyncio.sleep(0)
            if self._state is not SessionState.ENDED:
                self._emit_status("step_complete", mandatory=True)
            return self._command_result(command.command_id, {"consumed": consumed})
        if command_type is InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT:
            self._require_state(SessionState.PAUSED, command_type)
            if self._has_active_trading_path():
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "optimized fast-forward requires an account without trading state",
                )
            count = self._positive_int(parsed.values["count"], "count")
            tail_events = validate_counter(
                parsed.values["tail_events"], field_name="tail_events"
            )
            await self._preflight_event_count(count)
            self._revision += 1
            consumed = 0
            coalesced = count - tail_events
            for index in range(count):
                await self._process_source_event(
                    publish=index >= coalesced,
                    checkpoint=False,
                )
                consumed += 1
                if coalesced > 0 and tail_events > 0 and consumed == coalesced:
                    # Hidden prefix events do not reserve transport sequences.
                    # Publish one commit-gated atomic cursor reset before the
                    # visible tail so its first DELTA advances both source and
                    # transport authority by exactly one.
                    self._emit_reset_snapshot(
                        "fast_forward_coalesced_prefix",
                        mandatory=True,
                    )
                if consumed % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                    await asyncio.sleep(0)
            if self._has_active_trading_path():
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "optimized fast-forward created unexpected trading state",
                )
            # The optimized path changes only projection delivery. One reset
            # snapshot makes the client converge to the same exact reducer,
            # cursor, event-chain, and component state as the STEP reference.
            self._emit_reset_snapshot("fast_forward_complete", mandatory=True)
            return self._command_result(
                command.command_id,
                {
                    "consumed": consumed,
                    "coalesced_projection_events": coalesced,
                    "tail_events_published": tail_events,
                    "reference_semantics": "ORDERED_SOURCE_EVENT_REDUCER_V1",
                },
            )
        if command_type is InternalCommandType.FAST_FORWARD_FINAL_STATE:
            self._require_state(SessionState.PAUSED, command_type)
            target = int(parsed.values["target_virtual_time_ms"])
            if target < self._clock.virtual_time_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "final-state target cannot move backward",
                )
            maximum = self._positive_int(parsed.values["max_events"], "max_events")
            self._enforce_command_source_event_limit(maximum)
            require_empty_account = bool(parsed.values["require_empty_account"])
            snapshot_only = bool(parsed.values["snapshot_only"])
            if snapshot_only and target != self._clock.virtual_time_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "snapshot-only final-state command must target the current cursor",
                )
            if require_empty_account and self._has_active_trading_path():
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "empty-account final-state advance found active trading state",
                )
            self._ensure_final_state_transport_anchor()
            self._revision += 1
            if snapshot_only:
                self._emit_final_state_projection(
                    "fast_forward_final_state_cancelled",
                    mandatory=True,
                )
                return self._command_result(
                    command.command_id,
                    {
                        "consumed": 0,
                        "target_virtual_time_ms": target,
                        "target_reached": True,
                        "coalesced_projection_events": 0,
                        "published_projection_events": 0,
                        "batch_reducer_events": 0,
                        "require_empty_account": require_empty_account,
                        "snapshot_published": True,
                        "reference_semantics": ("ORDERED_SOURCE_EVENT_REDUCER_V1"),
                    },
                )
            consumed = 0
            published_projection_events = 0
            batch_apply = getattr(
                self._reducer,
                "apply_source_events_final_state",
                None,
            )
            batch_support = getattr(
                self._reducer,
                "supports_final_state_batch",
                None,
            )
            batch_preflight = getattr(
                self._reducer,
                "can_apply_source_events_final_state",
                None,
            )
            safe_prefix = getattr(
                self._reducer,
                "final_state_safe_prefix_length",
                None,
            )
            use_batch = callable(batch_apply) and (
                require_empty_account
                or (callable(batch_support) and bool(batch_support()))
            )
            batch_limit = maximum
            stop_after_interaction = False
            if (
                not use_batch
                and callable(batch_apply)
                and (callable(safe_prefix) or callable(batch_preflight))
            ):
                preview = self._preview_final_state_batch(
                    target_time_ms=target,
                    max_events=maximum,
                )
                if preview:
                    if callable(safe_prefix):
                        prefix_result = safe_prefix(preview)
                        if inspect.isawaitable(prefix_result):
                            prefix_result = await prefix_result
                        if (
                            isinstance(prefix_result, bool)
                            or not isinstance(prefix_result, int)
                            or prefix_result < 0
                            or prefix_result > len(preview)
                        ):
                            raise TypeError(
                                "replay reducer final-state safe prefix is invalid"
                            )
                        if prefix_result > 0:
                            use_batch = True
                            batch_limit = prefix_result
                        else:
                            # Commit the interaction event by itself. The
                            # training coordinator can then run account risk
                            # before scanning the following prefix.
                            stop_after_interaction = True
                    else:
                        preflight_result = batch_preflight(preview)
                        if inspect.isawaitable(preflight_result):
                            preflight_result = await preflight_result
                        use_batch = bool(preflight_result)
            batch_reducer_events = 0
            if use_batch:
                consumed = await self._apply_final_state_batch(
                    target_time_ms=target,
                    max_events=batch_limit,
                    apply_batch=batch_apply,
                )
                batch_reducer_events = consumed
            else:
                event_limit = 1 if stop_after_interaction else maximum
                while consumed < event_limit:
                    event = self._source.peek()
                    if event is None or self._event_time_ms(event) > target:
                        break
                    _, _, published = await self._apply_source_event_candidate(
                        publish=False,
                        publish_interactions=True,
                        materialize_state=False,
                    )
                    consumed += 1
                    if published:
                        published_projection_events += 1
                    if consumed % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                        await asyncio.sleep(0)
            next_event = self._source.peek()
            target_reached = (
                self._state is SessionState.ENDED
                or next_event is None
                or self._event_time_ms(next_event) > target
            )
            if target_reached and self._state is not SessionState.ENDED:
                self._clock.advance_to(target)
            if require_empty_account and self._has_active_trading_path():
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "empty-account final-state advance created trading state",
                )
            if target_reached:
                self._emit_final_state_projection(
                    "fast_forward_final_state_complete",
                    mandatory=True,
                )
            return self._command_result(
                command.command_id,
                {
                    "consumed": consumed,
                    "target_virtual_time_ms": target,
                    "target_reached": target_reached,
                    "coalesced_projection_events": (
                        consumed - published_projection_events
                    ),
                    "published_projection_events": published_projection_events,
                    "batch_reducer_events": batch_reducer_events,
                    "require_empty_account": require_empty_account,
                    "snapshot_published": target_reached,
                    "reference_semantics": "ORDERED_SOURCE_EVENT_REDUCER_V1",
                },
            )
        if command_type is CommandType.ADVANCE_BY:
            self._require_state(SessionState.PAUSED, command_type)
            delta_ms = int(parsed.values["ms"])
            target = self._clock.virtual_time_ms + delta_ms
            if target > MAX_TIMESTAMP_MS:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "advance target exceeds timestamp range",
                )
            expected_count = await self._preflight_advance_target(target)
            self._revision += 1
            consumed = await self._advance_to(
                target,
                publish=True,
                checkpoint=False,
                max_events=expected_count,
            )
            if consumed != expected_count:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source changed after advance preflight",
                    details={"expected": expected_count, "actual": consumed},
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
            plan = await self._preflight_seek_target(target)
            await self._seek_to(plan)
            self._revision += 1
            self._emit_reset_snapshot("seek_complete", mandatory=True)
            return self._command_result(
                command.command_id,
                {"target_virtual_time_ms": target},
            )
        if command_type in {
            CommandType.PLACE_ORDER,
            CommandType.REPLACE_ORDER,
            CommandType.CANCEL_ORDER,
            CommandType.CANCEL_ORDERS,
            CommandType.CLOSE_POSITION,
            CommandType.EXECUTE_POSITION_INTENT,
            CommandType.SET_POSITION_PROTECTION,
            CommandType.SET_POSITION_LEVERAGE,
            InternalCommandType.ADJUST_CAPITAL,
            InternalCommandType.EXECUTE_HISTORICAL_BOOK_CLOSE,
            InternalCommandType.EXECUTE_REVEALED_REFERENCE_CLOSE,
        }:
            if self._state not in {SessionState.PAUSED, SessionState.PLAYING}:
                self._invalid_transition(command_type)
            apply_command = getattr(self._reducer, "apply_command", None)
            if not callable(apply_command):
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_EXECUTION_MODEL,
                    "replay reducer does not provide paper trading",
                )
            self._invalidate_component_state()
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
        if command_type in {
            CommandType.REVEAL_HISTORY,
            InternalCommandType.REVEAL_HISTORY_AUTHORIZED,
        }:
            if command_type is CommandType.REVEAL_HISTORY:
                self._require_state(SessionState.ENDED, command_type)
            elif self._state not in {
                SessionState.PAUSED,
                SessionState.PLAYING,
                SessionState.ENDED,
            }:
                self._invalid_transition(command_type)
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
            # END_SESSION atomically releases the controller before publishing
            # replay.ended. A heartbeat already queued by the former owner must
            # not race that terminal event and tear down its WebSocket sender.
            # A client may explicitly reacquire after END_SESSION for the
            # remaining terminal mutations (journal/reveal). Renew only that
            # proven owner; former owners and stale viewers remain harmless
            # terminal no-ops with no lease or revision side effect.
            if self._state is SessionState.ENDED:
                if self._controller_client_id == request.client_instance_id:
                    self._controller_deadline_wall = (
                        self._read_wall() + self._controller_ttl_seconds
                    )
                if not request.future.done():
                    request.future.set_result(None)
                return
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
        # A caller can disconnect while this request waits behind one atomic
        # domain event.  Never allocate an actor-owned token that no caller can
        # receive and later release.
        if request.future.cancelled():
            return
        try:
            # Close any pre-handoff projection range before capturing the
            # subscriber's snapshot/catch-up floor.  Reusing a range that
            # started before the snapshot would replay old bar appends/ticks.
            self._publish_projection_batches(
                self._coalescer.flush(wall_time=self._read_wall())
            )
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
            queue: asyncio.Queue[ProjectionBatch] = asyncio.Queue(
                maxsize=request.max_pending
            )
            overflow = asyncio.Event()
            self._subscribers[token] = _SubscriberState(
                queue=queue,
                overflow=overflow,
                next_sequence=self._sequence + 1,
            )
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
        self._complete_unsubscribe(request.token)

    def _request_unsubscribe(self, token: int) -> asyncio.Future[None] | None:
        """Transfer subscriber cleanup ownership to the actor without overflow.

        The regular mailbox remains strictly bounded.  If it is full, one
        coalesced control record is retained for the active token; a full
        business queue guarantees the actor will wake and drain this record.
        """

        existing = self._unsubscribe_completions.get(token)
        if existing is not None:
            return existing
        if self._closed or token not in self._subscribers:
            return None
        loop = asyncio.get_running_loop()
        completion: asyncio.Future[None] = loop.create_future()
        self._unsubscribe_completions[token] = completion
        request = _UnsubscribeRequest(token, completion)
        try:
            self._queue.put_nowait(request)
        except asyncio.QueueFull:
            self._deferred_unsubscribes.add(token)
            self._metrics["subscriber_cleanup_deferrals"] = (
                int(self._metrics["subscriber_cleanup_deferrals"] or 0) + 1
            )
        else:
            self._record_queue_high_water()
        return completion

    def _drain_deferred_unsubscribes(self) -> None:
        for token in tuple(self._deferred_unsubscribes):
            self._complete_unsubscribe(token)

    def _complete_unsubscribe(self, token: int) -> None:
        self._deferred_unsubscribes.discard(token)
        if self._subscribers.pop(token, None) is not None:
            self._metrics["subscriber_closes"] = (
                int(self._metrics["subscriber_closes"] or 0) + 1
            )
        completion = self._unsubscribe_completions.pop(token, None)
        if completion is not None and not completion.done():
            completion.set_result(None)

    async def _handle_shutdown_request(self, request: _ShutdownRequest) -> None:
        if self._state is SessionState.ENDED:
            # Every transition into ENDED is acknowledged only after its command
            # or source-event mutation has atomically persisted the terminal
            # state. Reaper eviction is therefore a resource barrier, not a new
            # domain mutation. Rewriting the same (potentially large) checkpoint
            # here can race the report handoff and turn a durable terminal actor
            # into ERROR solely because eviction persistence timed out.
            if not request.future.done():
                request.future.set_result(None)
            self._publish_projection_batches(
                self._coalescer.flush(wall_time=self._read_wall())
            )
            self._last_snapshot = self._snapshot_value(materialize=False)
            self._exit_requested = True
            return
        errors: list[str] = []
        try:
            rollback = self._capture_rollback()
        except BaseException as exc:
            self._state = SessionState.ERROR
            self._metrics["shutdown_failures"] = (
                int(self._metrics["shutdown_failures"] or 0) + 1
            )
            self._metrics["last_shutdown_error"] = str(exc)[:500]
            self._last_snapshot = self._snapshot_value(materialize=False)
            self._exit_requested = True
            if not request.future.done():
                request.future.set_exception(exc)
            return
        self._begin_candidate()
        if self._state is SessionState.PLAYING or (
            request.force_pause_reason and self._state is SessionState.PAUSED
        ):
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
        self._publish_projection_batches(
            self._coalescer.flush(wall_time=self._read_wall())
        )
        self._last_snapshot = self._snapshot_value(materialize=False)
        self._exit_requested = True

    async def _process_source_event(
        self,
        *,
        publish: bool,
        publish_interactions: bool = False,
        checkpoint: bool = True,
    ) -> bool:
        owns_candidate = self._pending_events is None
        rollback = self._capture_rollback() if owns_candidate else None
        if owns_candidate:
            self._begin_candidate()
        try:
            (
                component_state,
                state_hash,
                published,
            ) = await self._apply_source_event_candidate(
                publish=publish,
                publish_interactions=publish_interactions,
                materialize_state=owns_candidate or publish or checkpoint,
            )
        except BaseException:
            if rollback is not None:
                self._restore_rollback(rollback, force_paused=False)
            raise
        if not owns_candidate:
            return published
        assert component_state is not None
        assert state_hash is not None
        checkpoint_blob = (
            self._checkpoint_codec.encode(
                self._checkpoint_payload(
                    component_state=component_state,
                    state_hash=state_hash,
                )
            )
            if checkpoint
            and (
                self._state is SessionState.ENDED
                or self._checkpoint_due()
                or (
                    rollback is not None
                    and self._review_checkpoint_required(
                        rollback.component_state,
                        component_state,
                    )
                )
            )
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
                state_hash=state_hash,
            )
        except asyncio.CancelledError:
            assert rollback is not None
            self._restore_rollback(rollback, force_paused=True)
            raise
        except Exception as exc:
            assert rollback is not None
            self._restore_rollback(rollback, force_paused=True)
            self._enter_persistence_degraded(exc)
            return False
        if checkpoint_blob is not None:
            self._record_checkpoint(checkpoint_blob, initial=False)
        return published

    def _preview_final_state_batch(
        self,
        *,
        target_time_ms: int,
        max_events: int,
    ) -> tuple[object, ...]:
        source = self._fork_current_source()
        events: list[object] = []
        while len(events) < max_events:
            event = source.peek()
            if event is None:
                break
            event_time = self._event_time_ms(event)
            if event_time > target_time_ms:
                break
            if event_time < self._clock.virtual_time_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source event time moved backward",
                    details={
                        "event_time_ms": event_time,
                        "virtual_time_ms": self._clock.virtual_time_ms,
                    },
                )
            consumed = source.next()
            if consumed != event:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source changed during final-state interaction preview",
                )
            events.append(event)
        return tuple(events)

    async def _apply_final_state_batch(
        self,
        *,
        target_time_ms: int,
        max_events: int,
        apply_batch: Callable[
            [Sequence[object]],
            Mapping[str, object] | Awaitable[Mapping[str, object]],
        ],
    ) -> int:
        events: list[object] = []
        while len(events) < max_events:
            event = self._source.peek()
            if event is None:
                break
            event_time = self._event_time_ms(event)
            if event_time > target_time_ms:
                break
            if event_time < self._clock.virtual_time_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source event time moved backward",
                    details={
                        "event_time_ms": event_time,
                        "virtual_time_ms": self._clock.virtual_time_ms,
                    },
                )
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
            events.append(event)
            if len(events) % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)
        if not events:
            return 0
        try:
            self._invalidate_component_state()
            projection = apply_batch(tuple(events))
            if inspect.isawaitable(projection):
                projection = await projection
            if not isinstance(projection, Mapping):
                raise TypeError("replay reducer batch projection must be an object")
        except BaseException:
            self._pause_clock()
            self._state = SessionState.ERROR
            raise
        if self._source.exhausted():
            event_time = self._event_time_ms(events[-1])
            terminal_time = getattr(self._source, "terminal_time_ms", event_time)
            terminal_time = validate_timestamp_ms(
                terminal_time,
                field_name="source_terminal_time_ms",
            )
            if terminal_time < event_time:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source terminal time precedes its last event",
                )
            self._clock.advance_to(terminal_time)
            await self._finalize_reducer(
                open_order_disposition="expire",
                position_disposition="keep",
            )
            self._state = SessionState.ENDED
            self._pause_clock()
            self._controller_client_id = None
            self._controller_deadline_wall = None
        return len(events)

    async def _apply_source_event_candidate(
        self,
        *,
        publish: bool,
        publish_interactions: bool = False,
        materialize_state: bool,
    ) -> tuple[dict[str, object] | None, str | None, bool]:
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
            self._invalidate_component_state()
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
            terminal_time = getattr(self._source, "terminal_time_ms", event_time)
            terminal_time = validate_timestamp_ms(
                terminal_time,
                field_name="source_terminal_time_ms",
            )
            if terminal_time < event_time:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source terminal time precedes its last event",
                )
            self._clock.advance_to(terminal_time)
            end_projection = await self._finalize_reducer(
                open_order_disposition="expire",
                position_disposition="keep",
            )
            self._state = SessionState.ENDED
            self._pause_clock()
            self._controller_client_id = None
            self._controller_deadline_wall = None
        immediate_delivery = self._projection_requires_immediate_delivery(projection)
        should_publish = publish or (publish_interactions and immediate_delivery)
        if not materialize_state and not should_publish:
            return None, None, False
        component_state = self._component_state()
        state_hash = self._compute_state_hash()
        if should_publish:
            if publish_interactions:
                # Earlier final-state chunks may have consumed source events
                # without publishing transport frames. A DELTA here would
                # therefore cross the client's causal source-sequence floor.
                # Publish the exact compact post-interaction state atomically.
                self._emit_final_state_projection(
                    "fast_forward_final_state_interaction",
                    mandatory=True,
                )
                # The command may continue scanning after this mandatory
                # interaction. Start the next compact suffix exactly at the
                # state the client has just observed.
                self._ensure_final_state_transport_anchor()
            else:
                self._emit(
                    ReplayEventType.DELTA,
                    {
                        "source_sequence": source_cursor.source_sequence,
                        "source_event": self._event_payload(event),
                        "projection": dict(projection),
                    },
                    mandatory=immediate_delivery,
                    state_hash=state_hash,
                )
                if self._state is SessionState.ENDED:
                    self._emit(
                        ReplayEventType.ENDED,
                        {
                            "reason": "source_exhausted",
                            "projection": dict(end_projection),
                        },
                        mandatory=True,
                        state_hash=state_hash,
                    )
        return component_state, state_hash, should_publish

    @staticmethod
    def _projection_requires_immediate_delivery(
        projection: Mapping[str, object],
    ) -> bool:
        """Never coalesce trade/account mutations that users must observe."""

        for field_name in ("orders", "fills", "warnings"):
            value = projection.get(field_name)
            if isinstance(value, (list, tuple)) and value:
                return True
        return False

    async def _advance_to(
        self,
        target_time_ms: int,
        *,
        publish: bool,
        checkpoint: bool = True,
        max_events: int | None = None,
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
            if max_events is not None and consumed >= max_events:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "advance exceeded its preflight source-event boundary",
                    details={"limit": max_events},
                )
            await self._process_source_event(
                publish=publish,
                checkpoint=checkpoint,
            )
            consumed += 1
            if consumed % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)
        if self._state is not SessionState.ENDED:
            self._clock.advance_to(target)
        return consumed

    async def _seek_to(self, plan: _SeekPlan) -> None:
        target = plan.target_time_ms
        # SEEK rewinds only market-derived state. Journal/reveal effects are
        # accepted session commands, so their ordered domain-command position
        # must remain monotonic across a view rebuild. The checkpoint hash is
        # first validated in its original historical state, then these durable
        # session-level effects are overlaid before replaying market events.
        session_domain_command_position = self._domain_command_position
        session_journal_entries = [dict(entry) for entry in self._journal_entries]
        session_revealed = self._revealed
        session_speed = self._clock.speed
        public_command_log_offset = self._command_log_offset
        self._restore_payload(
            plan.checkpoint_payload,
            restore_public_position=False,
            source_override=plan.checkpoint_source,
        )
        self._domain_command_position = session_domain_command_position
        self._journal_entries = session_journal_entries
        self._revealed = session_revealed
        self._clock.set_speed(session_speed)
        self._command_log_offset = public_command_log_offset
        consumed = 0
        while consumed < plan.replay_event_count:
            event = self._source.peek()
            if event is None or self._event_time_ms(event) > target:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "seek source changed after preflight",
                    details={
                        "expected": plan.replay_event_count,
                        "actual": consumed,
                    },
                )
            await self._process_source_event(publish=False, checkpoint=False)
            consumed += 1
            self._metrics["events_replayed_for_seek"] = (
                int(self._metrics["events_replayed_for_seek"] or 0) + 1
            )
            if consumed % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)
        next_event = self._source.peek()
        if next_event is not None and self._event_time_ms(next_event) <= target:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek exceeded its preflight source-event boundary",
                details={"limit": plan.replay_event_count},
            )
        if self._source.exhausted():
            self._state = SessionState.ENDED
        else:
            self._state = SessionState.PAUSED
            self._clock.advance_to(target)

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
        self._invalidate_component_state()
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
        component_state = self._component_state()
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
        except asyncio.CancelledError:
            self._restore_rollback(rollback, force_paused=True)
            raise
        except Exception as exc:
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

    def _renew_controller_lease_if_owned(self, client_id: str) -> None:
        if self._controller_client_id == client_id:
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

    def _require_state(
        self,
        required: SessionState,
        command_type: CommandType | InternalCommandType,
    ) -> None:
        if self._state is not required:
            self._invalid_transition(command_type)

    def _invalid_transition(
        self,
        command_type: CommandType | InternalCommandType,
    ) -> None:
        raise ReplayDomainError(
            ReplayErrorCode.INVALID_STATE_TRANSITION,
            f"command {command_type.value} is invalid while session is {self._state.value}",
            details={"state": self._state.value, "command": command_type.value},
        )

    async def _preflight_event_count(self, count: int) -> None:
        self._enforce_command_source_event_limit(count)
        source = self._fork_current_source()
        for index in range(count):
            if source.next() is None:
                raise ReplayDomainError(
                    ReplayErrorCode.SESSION_ENDED,
                    "step count exceeds remaining source events",
                    details={"count": count},
                )
            self._metrics["command_preflight_events"] = (
                int(self._metrics["command_preflight_events"] or 0) + 1
            )
            if (index + 1) % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)

    def _source_chunk_plan(
        self,
        *,
        target_time_ms: int,
        max_events: int,
    ) -> dict[str, object]:
        source = self._fork_current_source()
        count = 0
        last_event_time_ms: int | None = None
        event_times_ms: list[int] = []
        while count < max_events and (event := source.peek()) is not None:
            event_time = self._event_time_ms(event)
            if event_time > target_time_ms:
                break
            if source.next() != event:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source changed during chunk planning",
                )
            count += 1
            last_event_time_ms = event_time
            event_times_ms.append(event_time)
        next_event = source.peek()
        return {
            "revision": self._revision,
            "cursor": self._cursor_dict(),
            "event_count": count,
            "last_event_time_ms": last_event_time_ms,
            "event_times_ms": tuple(event_times_ms),
            "has_more_before_target": (
                next_event is not None
                and self._event_time_ms(next_event) <= target_time_ms
            ),
            "max_events": max_events,
        }

    async def _scan_source_goal(
        self,
        *,
        max_events: int,
        cancelled: Callable[[], bool] | None = None,
    ) -> dict[str, object]:
        """Perform one O(N) read-only scan from the current pinned cursor."""

        source = self._fork_current_source()
        start_cursor = self._cursor_dict()
        count = 0
        last_event_time_ms: int | None = None
        while count < max_events:
            if cancelled is not None and cancelled():
                break
            event = source.next()
            if event is None:
                break
            count += 1
            last_event_time_ms = self._event_time_ms(event)
            if count % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)
                if cancelled is not None and cancelled():
                    break
        was_cancelled = cancelled is not None and cancelled()
        exhausted = False if was_cancelled else source.peek() is None
        return {
            "revision": self._revision,
            "start_cursor": start_cursor,
            "event_count": count,
            "last_event_time_ms": last_event_time_ms,
            "exhausted": exhausted,
            "cancelled": was_cancelled,
            "max_events": max_events,
        }

    def _source_events_page(
        self,
        *,
        after_sequence: int,
        limit: int,
    ) -> dict[str, object]:
        read_page = getattr(self._source, "read_revealed_page", None)
        if not callable(read_page):
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_SOURCE,
                "replay source does not expose aggregate-trade pages",
            )
        page = read_page(after_sequence=after_sequence, limit=limit)
        if not isinstance(page, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay source page response is invalid",
            )
        return dict(page)

    async def _preflight_advance_target(self, target_time_ms: int) -> int:
        source = self._fork_current_source()
        count = 0
        while (event := source.peek()) is not None:
            if self._event_time_ms(event) > target_time_ms:
                break
            if count >= self._max_atomic_command_source_events:
                self._reject_command_resource_limit(
                    requested=count + 1,
                    operation="advance_by",
                )
            consumed = source.next()
            if consumed != event:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source changed during advance preflight",
                )
            count += 1
            self._metrics["command_preflight_events"] = (
                int(self._metrics["command_preflight_events"] or 0) + 1
            )
            if count % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)
        return count

    async def _preflight_seek_target(self, target_time_ms: int) -> _SeekPlan:
        target = validate_timestamp_ms(target_time_ms, field_name="target_time_ms")
        if target < self._initial_virtual_time_ms:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "seek target precedes replay start",
            )
        future_journal_times = [
            int(entry["virtual_time_ms"])
            for entry in self._journal_entries
            if int(entry["virtual_time_ms"]) > target
        ]
        if future_journal_times:
            raise ReplayDomainError(
                ReplayErrorCode.SEEK_REQUIRES_FORK_OR_RESET,
                "seek target precedes a durable journal entry",
                details={
                    "target_virtual_time_ms": target,
                    "earliest_blocking_journal_time_ms": min(future_journal_times),
                    "blocking_journal_entries": len(future_journal_times),
                },
            )

        positioning_events = 0
        if target >= self._clock.virtual_time_ms:
            # Forward and identity seeks can start from the exact current
            # candidate. This avoids recounting the consumed prefix; any
            # still-unconsumed events at the same timestamp remain in budget.
            checkpoint_payload = self._checkpoint_payload()
            checkpoint_source = self._fork_current_source()
        else:
            selected = self._checkpoints.select_valid(
                self._checkpoint_codec,
                target_virtual_time_ms=target,
                validator=self._checkpoint_matches_actor,
            )
            checkpoint_payload = selected.payload
            (
                checkpoint_source,
                positioning_events,
            ) = await self._source_for_seek_checkpoint(selected.payload)

        scan_source = self._fork_source(checkpoint_source)
        previous_time = scan_source.cursor().last_event_time_ms
        if previous_time is None:
            previous_time = self._initial_virtual_time_ms
        replay_events = 0
        total_events = positioning_events
        while (event := scan_source.peek()) is not None:
            event_time = self._event_time_ms(event)
            if event_time < previous_time:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "source order changed during seek preflight",
                )
            if event_time > target:
                break
            if total_events >= self._max_atomic_command_source_events:
                self._reject_command_resource_limit(
                    requested=total_events + 1,
                    operation="seek_to",
                )
            consumed = scan_source.next()
            if consumed != event:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source changed during seek preflight",
                )
            previous_time = event_time
            replay_events += 1
            total_events += 1
            self._metrics["command_preflight_events"] = (
                int(self._metrics["command_preflight_events"] or 0) + 1
            )
            if total_events % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)

        if scan_source.exhausted():
            last_time = scan_source.cursor().last_event_time_ms
            if last_time is None or target > last_time:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "seek target exceeds replay horizon",
                )
        return _SeekPlan(
            target_time_ms=target,
            checkpoint_payload=checkpoint_payload,
            checkpoint_source=checkpoint_source,
            replay_event_count=replay_events,
        )

    async def _source_for_seek_checkpoint(
        self,
        payload: Mapping[str, object],
    ) -> tuple[ReplayMarketSource, int]:
        source_sequence = validate_counter(
            payload.get("source_sequence"),
            field_name="seek checkpoint source_sequence",
        )
        raw_cursor = payload.get("source_cursor")
        if not isinstance(raw_cursor, Mapping) or set(raw_cursor) != {
            "source_sequence",
            "last_event_time_ms",
            "last_base_bar_open_ms",
            "at_end",
        }:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek checkpoint source cursor is incompatible",
            )
        cursor_sequence = validate_counter(
            raw_cursor["source_sequence"],
            field_name="seek checkpoint cursor source_sequence",
        )
        if cursor_sequence != source_sequence:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek checkpoint source cursor is inconsistent",
            )
        raw_last_time = raw_cursor["last_event_time_ms"]
        last_time = (
            None
            if raw_last_time is None
            else validate_timestamp_ms(
                raw_last_time,
                field_name="seek checkpoint last_event_time_ms",
            )
        )
        raw_last_base = raw_cursor["last_base_bar_open_ms"]
        last_base = (
            None
            if raw_last_base is None
            else validate_timestamp_ms(
                raw_last_base,
                field_name="seek checkpoint last_base_bar_open_ms",
            )
        )
        at_end = raw_cursor["at_end"]
        if not isinstance(at_end, bool):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek checkpoint at_end flag is invalid",
            )
        expected_cursor = {
            "source_sequence": source_sequence,
            "last_event_time_ms": last_time,
            "last_base_bar_open_ms": last_base,
            "at_end": at_end,
        }
        expected_chain = self._require_digest(
            payload.get("event_chain_hash"),
            "seek checkpoint event_chain_hash",
        )

        fast_position = getattr(self._source, "fork_at_sequence", None)
        if callable(fast_position):
            try:
                source = fast_position(
                    source_sequence,
                    last_event_time_ms=last_time,
                )
            except ReplayDomainError:
                raise
            except Exception as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source rejected the seek checkpoint cursor",
                ) from exc
            self._validate_positioned_source(source, expected_cursor)
            return source, 0

        source = self._new_source()
        chain = self._initial_chain_hash()
        previous_time = self._initial_virtual_time_ms
        for index in range(source_sequence):
            if index >= self._max_atomic_command_source_events:
                self._reject_command_resource_limit(
                    requested=index + 1,
                    operation="seek_to",
                )
            event = source.next()
            if event is None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "seek checkpoint source cursor exceeds immutable data",
                )
            event_time = self._event_time_ms(event)
            if event_time < previous_time:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "source order changed while positioning seek checkpoint",
                )
            previous_time = event_time
            chain = self._next_chain_hash(chain, event, index + 1)
            self._metrics["command_preflight_events"] = (
                int(self._metrics["command_preflight_events"] or 0) + 1
            )
            if (index + 1) % COMMAND_EVENT_LOOP_YIELD_INTERVAL == 0:
                await asyncio.sleep(0)
        if chain != expected_chain:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek checkpoint source chain changed",
            )
        self._validate_positioned_source(source, expected_cursor)
        return source, source_sequence

    def _validate_positioned_source(
        self,
        source: ReplayMarketSource,
        expected_cursor: Mapping[str, object],
    ) -> None:
        if source is self._source:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek checkpoint source is not isolated",
            )
        if canonical_sha256(source.snapshot_ref()) != self._snapshot_ref_hash:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek checkpoint source changed immutable identity",
            )
        actual = source.cursor()
        if {
            "source_sequence": actual.source_sequence,
            "last_event_time_ms": actual.last_event_time_ms,
            "last_base_bar_open_ms": actual.last_base_bar_open_ms,
            "at_end": actual.at_end,
        } != dict(expected_cursor):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "seek checkpoint source does not match its durable cursor",
            )

    def _enforce_command_source_event_limit(self, count: int) -> None:
        if count > self._max_atomic_command_source_events:
            self._reject_command_resource_limit(
                requested=count,
                operation="step",
            )

    def _reject_command_resource_limit(
        self,
        *,
        requested: int,
        operation: str,
    ) -> None:
        self._metrics["command_resource_rejections"] = (
            int(self._metrics["command_resource_rejections"] or 0) + 1
        )
        raise ReplayDomainError(
            ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
            "replay command source-event budget exceeded",
            details={
                "operation": operation,
                "requested_at_least": requested,
                "limit": self._max_atomic_command_source_events,
            },
        )

    def _fork_current_source(self) -> ReplayMarketSource:
        # Fork the already pinned source cursor.  Reopening the factory here
        # can revalidate a large Parquet manifest on every STEP and defeats the
        # incremental actor boundary.
        return self._fork_source(self._source)

    def _fork_source(self, original: ReplayMarketSource) -> ReplayMarketSource:
        fork = getattr(original, "fork", None)
        if not callable(fork):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay source does not provide an isolated cursor fork",
            )
        source = fork()
        if source is original:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay source cannot provide an isolated cursor fork",
            )
        snapshot_ref = source.snapshot_ref()
        if (
            type(snapshot_ref) is not type(self._snapshot_ref)
            or snapshot_ref != self._snapshot_ref
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "forked replay source changed immutable identity",
            )
        if source.cursor() != original.cursor():
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "forked replay source did not preserve the current cursor",
            )
        return source

    def _capture_rollback(self) -> _ActorRollback:
        source = self._fork_current_source()
        component_state = MappingProxyType(dict(self._component_state()))
        expected_state_hash = self._compute_state_hash()
        return _ActorRollback(
            component_state=component_state,
            expected_state_hash=expected_state_hash,
            source=source,
            source_cursor=source.cursor(),
            clock=ClockSnapshot(
                schema_version=CLOCK_SCHEMA_VERSION,
                virtual_time_ms=self._clock.virtual_time_ms,
                speed=self._clock.speed,
                playing=self._clock.playing,
            ),
            state=self._state,
            status_reason=self._status_reason,
            controller_client_id=self._controller_client_id,
            controller_deadline_wall=self._controller_deadline_wall,
            revision=self._revision,
            sequence=self._sequence,
            domain_command_position=self._domain_command_position,
            command_log_offset=self._command_log_offset,
            event_chain_hash=self._event_chain_hash,
            revealed=self._revealed,
            journal_entries=tuple(
                MappingProxyType(dict(entry)) for entry in self._journal_entries
            ),
            final_state_anchor_source_sequence=(
                self._final_state_anchor_source_sequence
            ),
            final_state_anchor_bar_open_ms=self._final_state_anchor_bar_open_ms,
        )

    def _begin_candidate(
        self,
        *,
        capture_source_events: bool | None = None,
    ) -> None:
        if self._pending_events is not None or self._pending_source_events is not None:
            raise RuntimeError("nested replay actor mutation candidate")
        if capture_source_events is None:
            capture_source_events = self._mutation_hook is not None
        self._pending_events = []
        self._pending_source_events = [] if capture_source_events else None

    def _restore_rollback(
        self,
        rollback: _ActorRollback,
        *,
        force_paused: bool,
    ) -> None:
        self._pending_events = None
        self._pending_source_events = None
        snapshot_ref = rollback.source.snapshot_ref()
        if (
            type(snapshot_ref) is not type(self._snapshot_ref)
            or snapshot_ref != self._snapshot_ref
            or canonical_sha256(snapshot_ref) != self._snapshot_ref_hash
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "rollback source changed immutable identity",
            )
        if rollback.source.cursor() != rollback.source_cursor:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "rollback source changed its isolated cursor",
            )
        self._invalidate_component_state()
        self._reducer.restore(rollback.component_state)
        self._source = rollback.source
        should_play = (
            not force_paused
            and rollback.state is SessionState.PLAYING
            and rollback.clock.playing
        )
        self._clock = VirtualClock.from_snapshot(
            ClockSnapshot(
                schema_version=CLOCK_SCHEMA_VERSION,
                virtual_time_ms=rollback.clock.virtual_time_ms,
                speed=rollback.clock.speed,
                playing=should_play,
            ),
            monotonic=self._monotonic,
        )
        self._revision = rollback.revision
        self._sequence = rollback.sequence
        self._domain_command_position = rollback.domain_command_position
        self._command_log_offset = rollback.command_log_offset
        self._event_chain_hash = rollback.event_chain_hash
        self._revealed = rollback.revealed
        self._journal_entries = [dict(entry) for entry in rollback.journal_entries]
        self._final_state_anchor_source_sequence = (
            rollback.final_state_anchor_source_sequence
        )
        self._final_state_anchor_bar_open_ms = rollback.final_state_anchor_bar_open_ms
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
        # Validate the restored deterministic state once on the exceptional
        # path without charging every successful mutation for checkpoint
        # materialization and a duplicate state hash.
        restored_state_hash = self._compute_state_hash()
        if restored_state_hash != rollback.expected_state_hash:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "lightweight rollback state hash does not match captured state",
                details={
                    "expected_state_hash": rollback.expected_state_hash,
                    "actual_state_hash": restored_state_hash,
                },
            )

    async def _commit_mutation(
        self,
        *,
        kind: str,
        command: ReplayCommand | None,
        result: CommandResult | None,
        error: ReplayDomainError | None,
        checkpoint: bytes | None,
        component_state: Mapping[str, object] | None = None,
        state_hash: str | None = None,
    ) -> None:
        pending_events = tuple(self._pending_events or ())
        if self._mutation_hook is not None:
            events = tuple(event for event, _ in pending_events)
            source_events = tuple(self._pending_source_events or ())
            components = (
                self._component_state()
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
                session_state=self._durable_state(
                    component_state=components,
                    state_hash=state_hash,
                ),
                checkpoint=checkpoint,
                events=events,
                source_events=source_events,
                component_state=persisted_components,
                command=command,
                result=result,
                error=error,
            )
            await self._mutation_hook(mutation)
        for event, mandatory in pending_events:
            self._publish_event(event, mandatory=mandatory)
        self._pending_events = None
        self._pending_source_events = None

    def _durable_state(
        self,
        *,
        component_state: Mapping[str, object] | None = None,
        state_hash: str | None = None,
    ) -> dict[str, object]:
        return {
            "state": self._state.value,
            "status_reason": self._status_reason,
            "revision": self._revision,
            "event_sequence": self._sequence,
            "source_sequence": self._source.cursor().source_sequence,
            "command_log_offset": self._command_log_offset,
            "state_hash": (
                self._compute_state_hash(component_state=component_state)
                if state_hash is None
                else state_hash
            ),
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
        if self.config.blind_mode:
            reason = "blind replay persistence failed"
            details: dict[str, object] = {"blind_redacted": True}
        elif isinstance(error, ReplayDomainError):
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

    def _restore_checkpoint_ring(self) -> None:
        selected = self._restore_checkpoint
        assert selected is not None
        candidates = list(reversed(self._retained_checkpoints))
        if all(encoded != selected for encoded, _is_initial in candidates):
            candidates.append((selected, False))

        valid: list[tuple[bytes, bool, int, int, str]] = []
        seen: set[bytes] = set()
        for encoded, marked_initial in candidates:
            if encoded in seen:
                continue
            seen.add(encoded)
            try:
                payload = self._checkpoint_codec.decode(encoded)
                if not self._checkpoint_matches_actor(payload):
                    continue
                virtual_time_ms = validate_timestamp_ms(
                    payload["virtual_time_ms"],
                    field_name="retained checkpoint virtual_time_ms",
                )
                source_sequence = validate_counter(
                    payload["source_sequence"],
                    field_name="retained checkpoint source_sequence",
                )
                state_hash = self._require_digest(
                    payload["state_hash"],
                    "retained checkpoint state_hash",
                )
            except (
                CheckpointError,
                ReplayDomainError,
                TypeError,
                ValueError,
                KeyError,
            ):
                continue
            valid.append(
                (
                    encoded,
                    marked_initial,
                    virtual_time_ms,
                    source_sequence,
                    state_hash,
                )
            )

        initial_index = next(
            (index for index, item in enumerate(valid) if item[1]),
            None,
        )
        if initial_index is None:
            initial_index = next(
                (index for index, item in enumerate(valid) if item[0] == selected),
                None,
            )
        if initial_index is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "restored replay checkpoint is absent from the retained ring",
            )

        self._checkpoints = CheckpointRing(max_recent=self._max_recent_checkpoints)
        initial = valid[initial_index]
        self._checkpoints.add(
            initial[0],
            virtual_time_ms=initial[2],
            source_sequence=initial[3],
            state_hash=initial[4],
            initial=True,
        )
        for index, item in enumerate(valid):
            if index == initial_index:
                continue
            self._checkpoints.add(
                item[0],
                virtual_time_ms=item[2],
                source_sequence=item[3],
                state_hash=item[4],
                initial=False,
            )

    def _checkpoint_due(self) -> bool:
        cursor = self._source.cursor()
        return (
            cursor.source_sequence - self._last_checkpoint_source_sequence
            >= self._checkpoint_event_interval
            or self._clock.virtual_time_ms - self._last_checkpoint_virtual_ms
            >= self._checkpoint_virtual_ms
        )

    @staticmethod
    def _review_checkpoint_required(
        before: Mapping[str, object],
        after: Mapping[str, object],
    ) -> bool:
        """Persist automatic domain transitions without checkpointing market ticks."""

        def append_only_tail(value: object) -> dict[str, object]:
            if not isinstance(value, (list, tuple)):
                return {"count": 0, "tail": None}
            return {
                "count": len(value),
                "tail": None if not value else value[-1],
            }

        def material(state: Mapping[str, object]) -> dict[str, object]:
            position = state.get("position")
            position_material: dict[str, object] = {}
            if isinstance(position, Mapping):
                for field in (
                    "side",
                    "quantity",
                    "entry_price",
                    "realized_pnl",
                ):
                    if field in position:
                        position_material[field] = position[field]
            ledger = state.get("ledger")
            ledger_material = (
                {
                    "tail_hash": ledger.get("tail_hash"),
                    "next_entry": ledger.get("next_entry"),
                }
                if isinstance(ledger, Mapping)
                else {}
            )
            return {
                "orders": state.get("orders", ()),
                "fills": append_only_tail(state.get("fills")),
                "ledger": ledger_material,
                "journal": append_only_tail(state.get("journal")),
                "position": position_material,
            }

        return canonical_sha256(material(before)) != canonical_sha256(material(after))

    def _maybe_checkpoint(self) -> None:
        if self._checkpoint_due():
            self._create_checkpoint(initial=False)

    def _checkpoint_payload(
        self,
        *,
        component_state: Mapping[str, object] | None = None,
        state_hash: str | None = None,
    ) -> dict[str, object]:
        components = (
            self._component_state()
            if component_state is None
            else dict(component_state)
        )
        resolved_state_hash = (
            self._compute_state_hash(component_state=components)
            if state_hash is None
            else state_hash
        )
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
            "state_hash": resolved_state_hash,
        }

    def _restore_payload(
        self,
        payload: Mapping[str, object],
        *,
        restore_public_position: bool,
        source_override: ReplayMarketSource | None = None,
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
        if source_override is None:
            source, chain = self._source_at_sequence(
                source_sequence,
                expected_chain=expected_chain,
            )
        else:
            source = source_override
            chain = expected_chain
            if canonical_sha256(source.snapshot_ref()) != self._snapshot_ref_hash:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "rollback source changed immutable identity",
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
        if any(
            int(entry["virtual_time_ms"]) > virtual_time for entry in journal_entries
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "checkpoint journal contains an entry from the future",
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
        self._invalidate_component_state()
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

    def _invalidate_component_state(self) -> None:
        self._component_state_cache = None
        self._component_state_revision += 1
        self._state_hash_cache_key = None
        self._state_hash_cache = None

    def _component_state(self) -> dict[str, object]:
        cached = self._component_state_cache
        if cached is None:
            cached = dict(self._reducer.snapshot())
            self._component_state_cache = cached
            self._metrics["component_snapshot_materializations"] = (
                int(self._metrics["component_snapshot_materializations"] or 0) + 1
            )
        return dict(cached)

    def _has_active_trading_path(self) -> bool:
        """Revalidate path dependencies inside the single-writer boundary."""

        state = self._component_state()
        terminal = {"FILLED", "CANCELED", "REJECTED", "EXPIRED"}
        orders = state.get("orders")
        if isinstance(orders, (list, tuple)) and any(
            isinstance(order, Mapping) and order.get("status") not in terminal
            for order in orders
        ):
            return True
        position = state.get("position")
        if not isinstance(position, Mapping):
            return False
        if position.get("position_mode") == "HEDGE":
            return any(
                isinstance(position.get(leg), Mapping)
                and position[leg].get("quantity") not in {None, "0", 0}
                for leg in ("long", "short")
            )
        return position.get("quantity") not in {None, "0", 0}

    def _compute_state_hash(
        self,
        *,
        component_state: Mapping[str, object] | None = None,
    ) -> str:
        cursor = self._cursor()
        cache_key = (
            self._component_state_revision,
            cursor.virtual_time_ms,
            cursor.source_sequence,
            cursor.last_base_bar_open_ms,
            cursor.last_trade_time_ms,
            cursor.last_agg_trade_id,
            cursor.at_end,
            self._event_chain_hash,
            self._domain_command_position,
            self._revealed,
        )
        if (
            component_state is None
            and self._state_hash_cache_key == cache_key
            and self._state_hash_cache is not None
        ):
            return self._state_hash_cache
        components = (
            self._component_state()
            if component_state is None
            else dict(component_state)
        )
        state_hash = canonical_sha256(
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
        if component_state is None:
            self._state_hash_cache_key = cache_key
            self._state_hash_cache = state_hash
        return state_hash

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
            last_trade_time_ms=source_cursor.last_trade_time_ms,
            last_agg_trade_id=source_cursor.last_agg_trade_id,
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
        component_state = self._component_state()
        # The component cache and state-hash cache share the same mutation
        # revision.  Passing a copied component mapping here deliberately
        # bypassed that cache and re-hashed the complete candle window for
        # every HTTP/WS snapshot request.
        snapshot = self._snapshot_value(materialize=False)
        public_config = self.config.to_dict()
        if self.config.blind_mode and not self._revealed:
            # The authoritative seed selects the hidden catalog window and is
            # therefore private until an irreversible reveal.  The actor still
            # persists and recovers the real config; only the public projection
            # uses the stable numeric redaction required by replay.v1 parsers.
            public_config["random_seed"] = 0
        return {
            "protocol": REPLAY_PROTOCOL,
            **snapshot.to_dict(),
            "status_reason": self._status_reason,
            "config": public_config,
            "components": component_state,
            "journal": [dict(entry) for entry in self._journal_entries],
            "revealed": self._revealed,
            "degraded_reason": self._degraded_reason,
        }

    def _report_value(self) -> Mapping[str, object]:
        build_report = getattr(self._reducer, "build_report", None)
        if not callable(build_report):
            return MappingProxyType({})
        build_from_snapshot = getattr(
            self._reducer,
            "build_report_from_snapshot",
            None,
        )
        report = (
            build_from_snapshot(self._component_state())
            if callable(build_from_snapshot)
            else build_report()
        )
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

    def _ensure_final_state_transport_anchor(self) -> None:
        if self._final_state_anchor_source_sequence is not None:
            return
        anchor = getattr(self._reducer, "final_state_transport_anchor", None)
        if not callable(anchor):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "replay reducer does not provide a final-state transport anchor",
            )
        bar_open_ms = anchor()
        if bar_open_ms is not None:
            bar_open_ms = validate_timestamp_ms(
                bar_open_ms,
                field_name="final_state_transport_anchor_open_ms",
            )
        self._final_state_anchor_source_sequence = self._source.cursor().source_sequence
        self._final_state_anchor_bar_open_ms = bar_open_ms

    def _emit_final_state_projection(self, reason: str, *, mandatory: bool) -> None:
        """Publish a compact atomic replacement after source events were hidden."""

        source_before = self._final_state_anchor_source_sequence
        if source_before is None:
            raise RuntimeError("final-state transport projection has no causal anchor")
        build_projection = getattr(
            self._reducer,
            "final_state_transport_projection",
            None,
        )
        if not callable(build_projection):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "replay reducer does not provide a final-state transport projection",
            )
        projection = build_projection(self._final_state_anchor_bar_open_ms)
        if not isinstance(projection, Mapping):
            raise TypeError("final-state transport projection must be an object")
        cursor = self._cursor_dict()
        source_to = validate_counter(
            cursor["source_sequence"],
            field_name="final_state_source_sequence_to",
        )
        if source_to < source_before:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "final-state transport source sequence moved backward",
            )
        source_from = source_before if source_to == source_before else source_before + 1
        self._status_reason = reason
        self._emit(
            ReplayEventType.FINAL_STATE,
            {
                "source_sequence_from": source_from,
                "source_sequence_to": source_to,
                "cursor": cursor,
                "state": self._state.value,
                "status_reason": reason,
                "speed": self._clock.speed,
                "controller_client_id": self._controller_client_id,
                "projection": dict(projection),
            },
            mandatory=mandatory,
        )
        self._final_state_anchor_source_sequence = None
        self._final_state_anchor_bar_open_ms = None

    def _emit_reset_snapshot(self, reason: str, *, mandatory: bool) -> None:
        """Publish one sequenced snapshot that atomically replaces client state.

        SEEK may move the source cursor and rendered bars backward.  A status
        frame cannot communicate that replacement and leaves future bars in a
        connected client.  Build the snapshot only after reserving its domain
        sequence so the envelope and nested snapshot describe one exact state.
        """

        self._status_reason = reason
        self._sequence += 1
        snapshot = self._public_snapshot_value()
        state_hash = snapshot["state_hash"]
        if not isinstance(state_hash, str):
            raise TypeError("public replay snapshot state_hash must be a string")
        event = ReplayEvent(
            type=ReplayEventType.SNAPSHOT,
            protocol=REPLAY_PROTOCOL,
            session_id=self.session_id,
            sequence=self._sequence,
            revision=self._revision,
            virtual_time_ms=self._clock.virtual_time_ms,
            state_hash=state_hash,
            data_epoch=self._data_epoch,
            data={"reset": True, "snapshot": snapshot},
        )
        if self._pending_events is not None:
            self._pending_events.append((event, mandatory))
            return
        self._publish_event(event, mandatory=mandatory)

    def _emit(
        self,
        event_type: ReplayEventType,
        data: Mapping[str, object],
        *,
        mandatory: bool,
        state_hash: str | None = None,
    ) -> None:
        self._sequence += 1
        event = ReplayEvent(
            type=event_type,
            protocol=REPLAY_PROTOCOL,
            session_id=self.session_id,
            sequence=self._sequence,
            revision=self._revision,
            virtual_time_ms=self._clock.virtual_time_ms,
            state_hash=(
                self._compute_state_hash() if state_hash is None else state_hash
            ),
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
        self._publish_projection_batches(batches)

    def _publish_projection_batches(
        self,
        batches: tuple[ProjectionBatch, ...],
    ) -> None:
        self._store_projection_batches(batches)
        for batch in batches:
            for token, subscriber in tuple(self._subscribers.items()):
                if batch.sequence_to < subscriber.next_sequence:
                    continue
                if batch.sequence_from != subscriber.next_sequence:
                    self._overflow_subscriber(token, subscriber)
                    continue
                try:
                    subscriber.queue.put_nowait(batch)
                    subscriber.next_sequence = batch.sequence_to + 1
                    self._metrics["subscriber_high_water"] = max(
                        int(self._metrics["subscriber_high_water"] or 0),
                        subscriber.queue.qsize(),
                    )
                except asyncio.QueueFull:
                    self._overflow_subscriber(token, subscriber)

    def _overflow_subscriber(
        self,
        token: int,
        subscriber: _SubscriberState,
    ) -> None:
        subscriber.overflow.set()
        self._subscribers.pop(token, None)
        self._metrics["subscriber_overflows"] = (
            int(self._metrics["subscriber_overflows"] or 0) + 1
        )

    def _store_projection_batches(self, batches: tuple[ProjectionBatch, ...]) -> None:
        for batch in batches:
            if batch.event_count > self._event_buffer_size:
                while self._projection_buffer:
                    self._evict_oldest_projection_batch()
                self._metrics["projection_buffer_oversize_drops"] = (
                    int(self._metrics["projection_buffer_oversize_drops"] or 0) + 1
                )
                continue
            while (
                self._projection_buffer
                and self._projection_buffer_domain_events + batch.event_count
                > self._event_buffer_size
            ):
                self._evict_oldest_projection_batch()
            self._projection_buffer.append(batch)
            self._projection_buffer_domain_events += batch.event_count

    def _evict_oldest_projection_batch(self) -> None:
        evicted = self._projection_buffer.popleft()
        self._projection_buffer_domain_events -= evicted.event_count
        if self._projection_buffer_domain_events < 0:
            raise RuntimeError("projection buffer domain-event accounting underflow")
        self._metrics["projection_buffer_evicted_domain_events"] = (
            int(self._metrics["projection_buffer_evicted_domain_events"] or 0)
            + evicted.event_count
        )
        self._metrics["projection_buffer_evictions"] = (
            int(self._metrics["projection_buffer_evictions"] or 0) + 1
        )

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
            "fork",
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
        return initial_source_chain_hash(self._data_epoch)

    @staticmethod
    def _next_chain_hash(previous: str, event: object, sequence: int) -> str:
        return next_source_chain_hash(previous, event, sequence)

    @staticmethod
    def _event_payload(event: object) -> dict[str, object]:
        return source_event_payload(event)

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

    def _projection_flush_delay(self) -> float | None:
        return self._coalescer.next_flush_delay(wall_time=self._read_wall())

    def _flush_due_projections(self) -> None:
        self._publish_projection_batches(
            self._coalescer.flush_due(wall_time=self._read_wall())
        )

    @staticmethod
    def _minimum_timeout(*values: float | None) -> float | None:
        available = [value for value in values if value is not None]
        return None if not available else min(available)

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
            if isinstance(request, _UnsubscribeRequest):
                # Actor finalization clears every subscriber, so queued cleanup
                # succeeds even when ordinary request futures fail closed.
                self._complete_unsubscribe(request.token)
                self._queue.task_done()
                continue
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
