"""Canonical manual-history states and records.

String values are frozen to the SQLite CHECK contracts.  API/service layers
must import these enums instead of scattering status literals.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, TypeVar

from app.data_engine.data_manager.models import SeriesKey

E = TypeVar("E", bound=Enum)


class CollectionStatus(str, Enum):
    BUILDING = "BUILDING"
    ACTIVE = "ACTIVE"
    PARTIAL = "PARTIAL"
    RELEASED = "RELEASED"


class TargetStatus(str, Enum):
    PENDING = "PENDING"
    BUILDING = "BUILDING"
    READY = "READY"
    FAILED = "FAILED"
    RELEASED = "RELEASED"


class JobState(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SEALING = "SEALING"
    SUCCEEDED = "SUCCEEDED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    BLOCKED_STORAGE = "BLOCKED_STORAGE"
    CANCELLING = "CANCELLING"
    CANCELLED = "CANCELLED"


class JobTargetState(str, Enum):
    QUEUED = "QUEUED"
    FETCHING = "FETCHING"
    MATERIALIZING = "MATERIALIZING"
    VERIFYING = "VERIFYING"
    READY = "READY"
    FAILED = "FAILED"
    BLOCKED_STORAGE = "BLOCKED_STORAGE"
    CANCELLED = "CANCELLED"


class RouteKind(str, Enum):
    NATIVE = "NATIVE"
    DERIVED = "DERIVED"


class ProtectionOwnerKind(str, Enum):
    JOB = "JOB"
    COLLECTION = "COLLECTION"


class ProtectionKind(str, Enum):
    TRANSIENT = "TRANSIENT"
    DURABLE = "DURABLE"


class ProtectionState(str, Enum):
    ACTIVE = "ACTIVE"
    RELEASED = "RELEASED"


ALLOWED_JOB_TRANSITIONS: dict[JobState, frozenset[JobState]] = {
    JobState.QUEUED: frozenset({
        JobState.RUNNING,
        JobState.CANCELLING,
        JobState.BLOCKED_STORAGE,
    }),
    JobState.RUNNING: frozenset({
        JobState.SEALING,
        JobState.BLOCKED_STORAGE,
        JobState.CANCELLING,
        JobState.FAILED,
        JobState.PARTIAL,
        JobState.QUEUED,
    }),
    JobState.SEALING: frozenset({
        JobState.SUCCEEDED,
        JobState.PARTIAL,
        JobState.FAILED,
        JobState.BLOCKED_STORAGE,
        JobState.CANCELLING,
        JobState.QUEUED,
    }),
    JobState.BLOCKED_STORAGE: frozenset({JobState.QUEUED, JobState.CANCELLING}),
    JobState.CANCELLING: frozenset({JobState.CANCELLED, JobState.PARTIAL}),
    JobState.SUCCEEDED: frozenset(),
    JobState.PARTIAL: frozenset(),
    JobState.FAILED: frozenset(),
    JobState.CANCELLED: frozenset(),
}

ALLOWED_JOB_TARGET_TRANSITIONS: dict[JobTargetState, frozenset[JobTargetState]] = {
    JobTargetState.QUEUED: frozenset({
        JobTargetState.FETCHING,
        JobTargetState.MATERIALIZING,
        JobTargetState.CANCELLED,
        JobTargetState.BLOCKED_STORAGE,
        JobTargetState.FAILED,
        JobTargetState.VERIFYING,
    }),
    JobTargetState.FETCHING: frozenset({
        JobTargetState.MATERIALIZING,
        JobTargetState.VERIFYING,
        JobTargetState.READY,
        JobTargetState.FAILED,
        JobTargetState.BLOCKED_STORAGE,
        JobTargetState.CANCELLED,
    }),
    JobTargetState.MATERIALIZING: frozenset({
        JobTargetState.VERIFYING,
        JobTargetState.FAILED,
        JobTargetState.BLOCKED_STORAGE,
        JobTargetState.CANCELLED,
    }),
    JobTargetState.VERIFYING: frozenset({
        JobTargetState.READY,
        JobTargetState.FAILED,
        JobTargetState.BLOCKED_STORAGE,
        JobTargetState.CANCELLED,
    }),
    JobTargetState.BLOCKED_STORAGE: frozenset({
        JobTargetState.QUEUED,
        JobTargetState.FETCHING,
        JobTargetState.CANCELLED,
        JobTargetState.FAILED,
    }),
    JobTargetState.READY: frozenset(),
    JobTargetState.FAILED: frozenset(),
    JobTargetState.CANCELLED: frozenset(),
}

RECOVERABLE_JOB_STATES: frozenset[JobState] = frozenset({
    JobState.QUEUED,
    JobState.RUNNING,
    JobState.SEALING,
    JobState.BLOCKED_STORAGE,
    JobState.CANCELLING,
})


class ManualHistoryError(RuntimeError):
    """Base error for the manual-history repository."""


class ManualHistoryNotFound(ManualHistoryError):
    """A collection, job, or target does not exist."""


class ManualHistoryIllegalTransition(ManualHistoryError):
    """A compare-and-set state change is not allowed."""

    def __init__(
        self,
        *,
        entity: str,
        current: str,
        expected: str | None = None,
        requested: str | None = None,
    ) -> None:
        self.entity = entity
        self.current = current
        self.expected = expected
        self.requested = requested
        super().__init__(
            f"illegal {entity} transition current={current} "
            f"expected={expected} requested={requested}"
        )


class ManualHistoryIdempotencyConflict(ManualHistoryError):
    """The same idempotency key was reused with a different request hash."""

    def __init__(self, *, idempotency_key: str, existing_job_id: str) -> None:
        self.idempotency_key = idempotency_key
        self.existing_job_id = existing_job_id
        super().__init__(
            f"idempotency_conflict key={idempotency_key} job={existing_job_id}"
        )


@dataclass(frozen=True, slots=True)
class ManualHistoryTargetSpec:
    symbol: str
    requested_interval: str
    canonical_interval: str
    route_kind: RouteKind
    source_interval: str
    effective_start_ms: int
    initial_end_open_ms: int
    estimated_rows: int | None = None
    expected_rows: int | None = None
    boundary_reason: str | None = None


@dataclass(frozen=True, slots=True)
class ManualHistorySourceProtectionSpec:
    symbol: str
    interval: str
    protected_start_ms: int


@dataclass(frozen=True, slots=True)
class ManualHistoryCreateSpec:
    collection_id: str
    job_id: str
    exchange: str
    market_type: str
    requested_start_ms: int
    idempotency_key: str
    request_hash: str
    plan_hash: str
    targets: tuple[ManualHistoryTargetSpec, ...]
    estimated_db_bytes: int | None = None
    estimated_temp_bytes: int | None = None
    reserved_bytes: int | None = None
    extra_source_protections: tuple[ManualHistorySourceProtectionSpec, ...] = ()
    stage: str = "queued"


@dataclass(frozen=True, slots=True)
class ManualHistoryCollectionRecord:
    collection_id: str
    exchange: str
    market_type: str
    requested_start_ms: int
    status: CollectionStatus
    created_at_ms: int
    updated_at_ms: int
    released_at_ms: int | None
    revision: int


@dataclass(frozen=True, slots=True)
class ManualHistoryCollectionTargetRecord:
    collection_id: str
    exchange: str
    market_type: str
    symbol: str
    requested_interval: str
    canonical_interval: str
    route_kind: RouteKind
    source_interval: str
    effective_start_ms: int
    continuous_end_ms: int | None
    status: TargetStatus
    expected_rows: int | None
    verified_rows: int | None
    verified_at_ms: int | None
    boundary_reason: str | None
    last_error: str | None
    updated_at_ms: int


@dataclass(frozen=True, slots=True)
class ManualHistoryJobRecord:
    job_id: str
    collection_id: str
    idempotency_key: str
    request_hash: str
    plan_hash: str
    state: JobState
    stage: str
    cancel_requested: bool
    total_targets: int
    ready_targets: int
    failed_targets: int
    estimated_db_bytes: int | None
    estimated_temp_bytes: int | None
    reserved_bytes: int | None
    recovery_count: int
    revision: int
    created_at_ms: int
    started_at_ms: int | None
    finished_at_ms: int | None
    updated_at_ms: int
    last_error: str | None


@dataclass(frozen=True, slots=True)
class ManualHistoryJobTargetRecord:
    job_id: str
    collection_id: str
    symbol: str
    canonical_interval: str
    source_interval: str
    state: JobTargetState
    initial_end_open_ms: int
    sealed_end_open_ms: int | None
    backfill_request_id: str | None
    attempt: int
    estimated_rows: int | None
    written_rows: int
    verified_rows: int | None
    last_error: str | None
    updated_at_ms: int


@dataclass(frozen=True, slots=True)
class ManualHistoryProtectionRecord:
    protection_id: str
    owner_kind: ProtectionOwnerKind
    owner_id: str
    protection_kind: ProtectionKind
    exchange: str
    market_type: str
    symbol: str
    interval: str
    protected_start_ms: int
    state: ProtectionState
    created_at_ms: int
    updated_at_ms: int
    released_at_ms: int | None


@dataclass(frozen=True, slots=True)
class StorageProtectionFloor:
    key: SeriesKey
    protected_start_ms: int
    owner_count: int
    transient_owner_count: int
    durable_owner_count: int
    owner_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ManualHistoryCreateResult:
    collection: ManualHistoryCollectionRecord
    job: ManualHistoryJobRecord
    collection_targets: tuple[ManualHistoryCollectionTargetRecord, ...]
    job_targets: tuple[ManualHistoryJobTargetRecord, ...]
    protections: tuple[ManualHistoryProtectionRecord, ...]
    reused_existing: bool


def parse_enum(enum_cls: type[E], value: Any, *, field_name: str) -> E:
    """Parse a stored enum value and fail closed on unknown/corrupt rows."""

    if isinstance(value, enum_cls):
        return value
    raw = str(value or "").strip()
    try:
        return enum_cls(raw)
    except ValueError as exc:
        raise ManualHistoryError(
            f"corrupt {field_name}: {raw!r}"
        ) from exc
