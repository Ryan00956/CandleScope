from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .errors import BacktestError

ENGINE_VERSION = "backtest.engine.control-plane.v1"
SCHEMA_VERSION = "backtest.schema.v1"


class RunState(str, Enum):
    DRAFT = "DRAFT"
    VALIDATING = "VALIDATING"
    QUEUED = "QUEUED"
    PREPARING = "PREPARING"
    RUNNING = "RUNNING"
    PAUSING = "PAUSING"
    PAUSED = "PAUSED"
    COMPLETING = "COMPLETING"
    COMPLETED = "COMPLETED"
    CANCELLING = "CANCELLING"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"


TRANSITIONS: dict[RunState, frozenset[RunState]] = {
    RunState.DRAFT: frozenset({RunState.VALIDATING, RunState.CANCELLED}),
    RunState.VALIDATING: frozenset({RunState.QUEUED, RunState.FAILED, RunState.DRAFT}),
    RunState.QUEUED: frozenset({RunState.PREPARING, RunState.CANCELLING}),
    RunState.PREPARING: frozenset(
        {RunState.RUNNING, RunState.FAILED, RunState.CANCELLING}
    ),
    RunState.RUNNING: frozenset(
        {RunState.PAUSING, RunState.COMPLETING, RunState.CANCELLING, RunState.FAILED}
    ),
    RunState.PAUSING: frozenset({RunState.PAUSED, RunState.FAILED}),
    RunState.PAUSED: frozenset({RunState.RUNNING, RunState.CANCELLING}),
    RunState.COMPLETING: frozenset({RunState.COMPLETED, RunState.FAILED}),
    RunState.CANCELLING: frozenset({RunState.CANCELLED, RunState.FAILED}),
    RunState.COMPLETED: frozenset(),
    RunState.CANCELLED: frozenset(),
    RunState.FAILED: frozenset(),
}


def transition(current: RunState, target: RunState) -> RunState:
    if target not in TRANSITIONS[current]:
        raise BacktestError(
            "IDENTITY_MUTATION",
            f"illegal state transition {current.value} -> {target.value}",
        )
    return target


@dataclass(frozen=True, slots=True)
class RunIdentity:
    strategy_revision_id: str
    dataset_id: str
    data_epoch: str
    snapshot_hash: str
    fidelity_mode: str
    source_event_kind: str
    start_time_ms: int
    end_time_ms: int
    warmup_bars: int
    parameters_json: str
    account_model: str
    execution_json: str = "{}"
    engine_version: str = ENGINE_VERSION


@dataclass(slots=True)
class BacktestRun:
    run_id: str
    identity: RunIdentity
    config_hash: str
    state: RunState
    idempotency_key: str
    study_id: str | None = None
    warning_code: str | None = None
    failure_code: str | None = None
    generation: int = 1
    created_at_ms: int = 0
    updated_at_ms: int = 0


@dataclass(slots=True)
class BacktestStudy:
    study_id: str
    name: str
    hypothesis: str
    strategy_revision_id: str
    config_hash: str
    state: str
    created_at_ms: int
    labels: list[str] = field(default_factory=list)
