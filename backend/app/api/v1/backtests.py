"""Fail-closed HTTP control plane for BacktestRun / BacktestStudy."""

from __future__ import annotations

import base64
import os
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.backtest.errors import BacktestError
from app.backtest.reports import export_bundle
from app.backtest.runtime import BacktestRuntime
from app.backtest.service import BacktestService


router = APIRouter(prefix="/backtests", tags=["backtests"])


class RunCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strategy_revision_id: str = Field(min_length=1, max_length=128)
    dataset_id: str = Field(min_length=1, max_length=80)
    data_epoch: str = Field(min_length=8, max_length=80)
    snapshot_hash: str = Field(min_length=8, max_length=80)
    fidelity_mode: str
    source_event_kind: str | None = None
    start_time_ms: int
    end_time_ms: int
    warmup_bars: int = 0
    interval: str | None = Field(default=None, max_length=16)
    signal_clock: str | None = Field(default=None, max_length=40)
    signal_interval: str | None = Field(default=None, max_length=16)
    execution_clock: str | None = Field(default=None, max_length=40)
    bar_builder: str | None = Field(default=None, max_length=80)
    timezone: str | None = Field(default=None, max_length=40)
    parameters: dict[str, Any] = Field(default_factory=dict)
    strategy_source: str | None = Field(default=None, max_length=2_000)
    signal_trace_mode: str = Field(default="LEGACY_INLINE_V1", max_length=32)
    output_mode: str = Field(default="TARGET_POSITION", max_length=32)
    initial_balance: str = Field(default="10000", max_length=64)
    slippage_bps: str = Field(default="1", max_length=64)
    taker_fee_bps: str = Field(default="0", max_length=64)
    maker_fee_bps: str = Field(default="0", max_length=64)
    funding_rate: str = Field(default="0", max_length=64)
    funding_interval_hours: int = Field(default=8, ge=1, le=168)
    funding_mode: str = Field(default="OFF", max_length=32)
    leverage: str = Field(default="1", max_length=64)
    sizing_policy: str | None = Field(default=None, max_length=40)
    fixed_qty: str | None = Field(default=None, max_length=64)
    fixed_notional: str | None = Field(default=None, max_length=64)
    equity_percent: str | None = Field(default=None, max_length=64)
    risk_per_stop_percent: str | None = Field(default=None, max_length=64)
    stop_distance: str | None = Field(default=None, max_length=64)
    max_abs_position_qty: str | None = Field(default=None, max_length=64)
    max_notional: str | None = Field(default=None, max_length=64)
    max_leverage: str | None = Field(default=None, max_length=64)
    max_order_risk: str | None = Field(default=None, max_length=64)
    max_active_orders: int | None = Field(default=None, ge=1, le=10_000)
    max_cumulative_fees: str | None = Field(default=None, max_length=64)
    max_drawdown_percent: str | None = Field(default=None, max_length=64)
    daily_loss_limit: str | None = Field(default=None, max_length=64)
    cooldown_events: int = Field(default=0, ge=0, le=1_000_000)
    execution_model_revision: str | None = Field(default=None, max_length=48)
    participation_rate: str | None = Field(default=None, max_length=64)
    latency_ms: int = Field(default=0, ge=0, le=60_000)
    latency_events: int = Field(default=0, ge=0, le=100_000)
    order_end_policy: str = Field(default="CANCEL_AT_END", max_length=32)
    bar_path_scenario: str | None = Field(default=None, max_length=64)
    metrics_version: str | None = Field(default=None, max_length=48)
    risk_free_rate_annual: str = Field(default="0", max_length=64)
    sample_role: str = Field(default="IN_SAMPLE", max_length=32)
    exchange: str = Field(default="binance", min_length=1, max_length=40)
    market_type: str = Field(default="usdm", min_length=1, max_length=40)
    price_tick: str | None = Field(default=None, max_length=64)
    qty_step: str | None = Field(default=None, max_length=64)
    min_notional: str | None = Field(default=None, max_length=64)
    gap_policy: str = "REJECT"
    account_model: str = "LINEAR_PERP_ONE_WAY_V1"
    contract_data_mode: str = Field(default="LEGACY_FIXED_V1", max_length=40)
    study_id: str | None = None


class StudyCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    hypothesis: str = ""
    strategy_revision_id: str = Field(min_length=1, max_length=128)
    dataset_id: str | None = Field(default=None, max_length=80)
    data_epoch: str | None = Field(default=None, max_length=80)
    dataset_snapshot_hash: str | None = Field(default=None, max_length=80)
    interval: str | None = Field(default=None, max_length=16)
    start_ms: int
    end_ms: int
    train_ms: int
    test_ms: int
    step_ms: int | None = None
    purge_ms: int = 0
    embargo_ms: int = 0
    holdout_ms: int = 0
    parameter_space: dict[str, list[Any]] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)
    sampler: str = "grid"
    max_trials: int | None = None
    random_count: int | None = None
    seed: int | None = None
    candidate_budget: int | None = None
    total_run_budget: int | None = None
    objective: str = "SHARPE"
    constraints: dict[str, Any] = Field(default_factory=dict)
    tie_break: str | None = None
    study_protocol_revision: str | None = None
    selection_protocol_revision: str | None = None
    warmup_bars: int = 0
    initial_balance: str = Field(default="10000", max_length=64)
    slippage_bps: str = Field(default="1", max_length=64)
    taker_fee_bps: str = Field(default="0", max_length=64)
    maker_fee_bps: str = Field(default="0", max_length=64)
    gap_policy: str = "REJECT"
    account_model: str | None = None
    contract_data_mode: str | None = None
    funding_mode: str = "OFF"
    leverage: str = Field(default="1", max_length=64)
    execution_model_revision: str | None = None
    participation_rate: str = Field(default="0.1", max_length=64)
    metrics_version: str | None = None
    risk_free_rate_annual: str = Field(default="0", max_length=64)
    sizing_policy: str = "FIXED_QTY_V1"
    fixed_qty: str = Field(default="1", max_length=64)


class SnapshotPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: str = Field(min_length=1, max_length=80)
    data_epoch: str = Field(min_length=8, max_length=80)
    start_time_ms: int
    end_time_ms: int
    interval: str | None = Field(default=None, max_length=16)
    fidelity_mode: str = "BAR_APPROX"
    exchange: str = Field(default="binance", min_length=1, max_length=40)
    market_type: str = Field(default="usdm", min_length=1, max_length=40)
    contract_data_mode: str = Field(default="LEGACY_FIXED_V1", max_length=40)
    account_model: str = Field(default="LINEAR_PERP_ONE_WAY_V1", max_length=40)
    funding_mode: str = Field(default="OFF", max_length=32)


class StrategyRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    language: str
    base_revision_id: str | None = None
    source_text: str = Field(default="", max_length=100_000)
    parameter_schema: list[dict[str, Any]] = Field(default_factory=list)


class StrategyCopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)


class StrategySmokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: str = Field(min_length=1, max_length=80)
    snapshot_hash: str = Field(min_length=8, max_length=80)
    start_time_ms: int
    end_time_ms: int
    parameters: dict[str, Any] = Field(default_factory=dict)


class RunCloneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parameter: str = Field(min_length=1, max_length=128)
    value: Any


class ReviewBridgeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_time_ms: int
    end_time_ms: int


def _require_contract_snapshot(
    preview: dict[str, Any], contract_data_mode: str
) -> None:
    if contract_data_mode != "HISTORICAL_CONTRACT_V1":
        return
    contract = preview.get("quality", {}).get("contract_data", {})
    if contract.get("status") != "complete":
        raise BacktestError(
            "DATA_ROLE_COVERAGE_MISSING",
            "historical contract roles must be complete before Run",
            details={"contract_data": contract},
        )


def _service(request: Request) -> BacktestService:
    service = getattr(request.app.state, "backtest_service", None)
    if service is None:
        raise BacktestError("FLAG_DISABLED", "backtest control plane is not started")
    return service


def _runtime(request: Request) -> BacktestRuntime:
    runtime = getattr(request.app.state, "backtest_runtime", None)
    if runtime is None:
        raise BacktestError("FLAG_DISABLED", "backtest worker runtime is not started")
    return runtime


def _optional_runtime(request: Request) -> BacktestRuntime | None:
    runtime = getattr(request.app.state, "backtest_runtime", None)
    return runtime if isinstance(runtime, BacktestRuntime) else None


def _python_strategy_enabled() -> bool:
    return os.environ.get("BACKTEST_PYTHON_STRATEGY_ENABLED", "0").strip() == "1"


def _require_python_strategy() -> None:
    if not _python_strategy_enabled():
        raise BacktestError("FLAG_DISABLED", "Python strategy path is default-off")


def _error(exc: BacktestError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={
            "error": {"code": exc.code, "message": exc.message, "details": exc.details}
        },
    )


@router.get("/capabilities")
def capabilities(request: Request) -> dict[str, Any]:
    try:
        return _service(request).capabilities()
    except BacktestError as exc:
        return _error(exc)


@router.get("/strategy-revisions")
def list_strategy_revisions(
    request: Request, include_archived: bool = False
) -> dict[str, Any]:
    service = _service(request)
    return {
        "items": [
            service._revision_wire(item)
            for item in service.repository.list_strategy_revisions(
                include_archived=include_archived
            )
        ]
    }


@router.post("/strategy-revisions")
def create_strategy_revision(
    request: Request, payload: StrategyRevisionRequest
) -> dict[str, Any]:
    try:
        return _service(request).create_strategy_revision(payload.model_dump())
    except BacktestError as exc:
        return _error(exc)


@router.post("/strategy-revisions/{revision_id}/copy")
def copy_strategy_revision(
    request: Request, revision_id: str, payload: StrategyCopyRequest
) -> dict[str, Any]:
    try:
        return _service(request).copy_strategy_revision(revision_id, name=payload.name)
    except BacktestError as exc:
        return _error(exc)


@router.post("/strategy-revisions/{revision_id}/archive")
def archive_strategy_revision(request: Request, revision_id: str) -> dict[str, Any]:
    try:
        return _service(request).archive_strategy_revision(revision_id)
    except BacktestError as exc:
        return _error(exc)


class PythonBundleZipRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    zip_base64: str = Field(min_length=8, max_length=2_000_000)


class PythonRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bundle_id: str = Field(min_length=1, max_length=80)


@router.post("/strategy-bundles/inspect")
def inspect_python_strategy_bundle(
    request: Request, payload: PythonBundleZipRequest
) -> dict[str, Any]:
    try:
        _require_python_strategy()
        zip_bytes = base64.b64decode(payload.zip_base64)
        return _service(request).inspect_python_strategy_bundle(zip_bytes=zip_bytes)
    except BacktestError as exc:
        return _error(exc)


@router.post("/strategy-bundles")
def create_python_strategy_bundle(
    request: Request, payload: PythonBundleZipRequest
) -> dict[str, Any]:
    try:
        _require_python_strategy()
        zip_bytes = base64.b64decode(payload.zip_base64)
        return _service(request).create_python_strategy_bundle(zip_bytes=zip_bytes)
    except BacktestError as exc:
        return _error(exc)


@router.get("/strategy-bundles/{bundle_id}")
def get_python_strategy_bundle(request: Request, bundle_id: str) -> dict[str, Any]:
    try:
        _require_python_strategy()
        return _service(request).get_python_strategy_bundle(bundle_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/strategy-revisions/python")
def create_python_strategy_revision(
    request: Request, payload: PythonRevisionRequest
) -> dict[str, Any]:
    try:
        _require_python_strategy()
        return _service(request).create_python_strategy_revision(payload.bundle_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/strategy-revisions/{revision_id}/smoke")
def smoke_strategy_revision(
    request: Request, revision_id: str, payload: StrategySmokeRequest
) -> dict[str, Any]:
    try:
        return _service(request).smoke_strategy_revision(
            revision_id, payload.model_dump()
        )
    except BacktestError as exc:
        return _error(exc)


@router.get("/datasets")
def list_datasets(request: Request) -> dict[str, Any]:
    try:
        return {"datasets": _runtime(request).list_datasets()}
    except BacktestError as exc:
        return _error(exc)


@router.post("/datasets/snapshot")
def preview_snapshot(
    request: Request,
    payload: SnapshotPreviewRequest,
) -> dict[str, Any]:
    try:
        return _runtime(request).preview_snapshot(**payload.model_dump())
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs/validate")
def validate_run(request: Request, payload: RunCreateRequest) -> dict[str, Any]:
    try:
        validated = _service(request).validate_run(payload.model_dump())
        runtime = _optional_runtime(request)
        if runtime is not None:
            preview = runtime.preview_snapshot(
                dataset_id=payload.dataset_id,
                data_epoch=payload.data_epoch,
                start_time_ms=payload.start_time_ms,
                end_time_ms=payload.end_time_ms,
                interval=payload.interval,
                fidelity_mode=payload.fidelity_mode,
                exchange=payload.exchange,
                market_type=payload.market_type,
                contract_data_mode=payload.contract_data_mode,
                account_model=payload.account_model,
                funding_mode=payload.funding_mode,
            )
            _require_contract_snapshot(preview, payload.contract_data_mode)
            if (
                preview["snapshot_hash"] != payload.snapshot_hash
                or preview.get("data_epoch") != payload.data_epoch
            ):
                raise BacktestError(
                    "DATA_SNAPSHOT_MISMATCH",
                    "declared snapshot identity does not match the selected window",
                )
            validated["snapshot"] = preview
        return validated
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs")
def create_run(
    request: Request,
    payload: RunCreateRequest,
    x_idempotency_key: str = Header(alias="Idempotency-Key"),
) -> dict[str, Any]:
    try:
        runtime = _optional_runtime(request)
        if runtime is not None:
            preview = runtime.preview_snapshot(
                dataset_id=payload.dataset_id,
                data_epoch=payload.data_epoch,
                start_time_ms=payload.start_time_ms,
                end_time_ms=payload.end_time_ms,
                interval=payload.interval,
                fidelity_mode=payload.fidelity_mode,
                exchange=payload.exchange,
                market_type=payload.market_type,
                contract_data_mode=payload.contract_data_mode,
                account_model=payload.account_model,
                funding_mode=payload.funding_mode,
            )
            _require_contract_snapshot(preview, payload.contract_data_mode)
            if (
                preview["snapshot_hash"] != payload.snapshot_hash
                or preview.get("data_epoch") != payload.data_epoch
            ):
                raise BacktestError(
                    "DATA_SNAPSHOT_MISMATCH",
                    "declared snapshot identity does not match the selected window",
                )
        return _service(request).create_run(
            payload.model_dump(),
            idempotency_key=x_idempotency_key,
        )
    except BacktestError as exc:
        return _error(exc)


@router.get("/runs")
def list_runs(request: Request) -> dict[str, Any]:
    try:
        return {"runs": _service(request).list_runs()}
    except BacktestError as exc:
        return _error(exc)


@router.get("/runs/compare/pair")
def compare_run_pair(
    request: Request, left_run_id: str, right_run_id: str
) -> dict[str, Any]:
    try:
        return _service(request).compare_run_pair(left_run_id, right_run_id)
    except BacktestError as exc:
        return _error(exc)


@router.get("/runs/{run_id}")
def get_run(request: Request, run_id: str) -> dict[str, Any]:
    try:
        return _service(request).get_run(run_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs/{run_id}/cancel")
def cancel_run(request: Request, run_id: str) -> dict[str, Any]:
    try:
        return _service(request).cancel_run(run_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs/{run_id}/resume")
def resume_run(request: Request, run_id: str) -> dict[str, Any]:
    try:
        return _service(request).resume_failed_run(run_id)
    except BacktestError as exc:
        return _error(exc)


@router.get("/runs/{run_id}/report")
def get_report(request: Request, run_id: str) -> dict[str, Any]:
    try:
        return _service(request).get_report(run_id)
    except BacktestError as exc:
        return _error(exc)


@router.get("/runs/{run_id}/chart")
def get_chart(request: Request, run_id: str) -> dict[str, Any]:
    try:
        return _runtime(request).chart_data(run_id)
    except BacktestError as exc:
        return _error(exc)


@router.get("/runs/{run_id}/signal-trace")
def get_signal_trace(
    request: Request, run_id: str, after: int = 0, limit: int = 200
) -> dict[str, Any]:
    try:
        return _service(request).get_signal_trace(run_id, after=after, limit=limit)
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs/{run_id}/clone")
def clone_run(
    request: Request,
    run_id: str,
    payload: RunCloneRequest,
    x_idempotency_key: str = Header(alias="Idempotency-Key"),
) -> dict[str, Any]:
    try:
        return _service(request).clone_run_parameter(
            run_id,
            parameter=payload.parameter,
            value=payload.value,
            idempotency_key=x_idempotency_key,
        )
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs/{run_id}/review-bridge")
async def create_review_bridge(
    request: Request, run_id: str, payload: ReviewBridgeRequest
) -> dict[str, Any]:
    try:
        bridge = _service(request).create_review_bridge(run_id, payload.model_dump())
        replay_service = getattr(request.app.state, "replay_service", None)
        training = getattr(replay_service, "training", None)
        if training is None:
            _service(request).repository.delete_review_bridge(str(bridge["bridgeId"]))
            raise BacktestError(
                "REPLAY_TRAINING_UNAVAILABLE",
                "Replay TrainingRun runtime is unavailable; start replay before creating the bridge",
            )
        try:
            from app.replay.training.models import TrainingRunSetupRequest

            window_ms = payload.end_time_ms - payload.start_time_ms
            setup = TrainingRunSetupRequest.from_dict(
                {
                    "protocol": "replay.v3",
                    "name": f"Backtest blind review {run_id[-8:]}",
                    "source_kind": "BAR",
                    "start_mode": "MANUAL",
                    "settlement_asset": "USDT",
                    "requested_start_ms": payload.start_time_ms,
                    "indicator_warmup_bars": 24,
                    "visible_history_lookback": {
                        "mode": "DURATION",
                        "duration_ms": min(window_ms, 86_400_000),
                    },
                    "forward_cache_ms": window_ms,
                    "random_seed": None,
                    "initial_equity": "10000",
                    "max_leverage": "3",
                    "maker_fee_bps": "0",
                    "taker_fee_bps": "0",
                    "market_slippage_bps": "0",
                    "integrity_mode": "CHALLENGE",
                    "time_disclosure_policy": "HIDE_ALL",
                    "book_mode": "OFF",
                    "margin_mode": "CROSS",
                    "position_mode": "ONE_WAY",
                    "funding_mode": "OFF",
                    "account_data_mode": "APPROX_PROXY",
                    "fixed_funding_rate": None,
                    "funding_interval_ms": None,
                    "allow_rule_changes": False,
                    "allowed_mutations": [],
                    "market_selection_hint": None,
                }
            )
            training_run = await training.create_empty_run(setup)
            training_run_id = str(training_run["run_id"])
            bound = _service(request).bind_review_bridge_training_run(
                str(bridge["bridgeId"]), training_run_id
            )
        except Exception as exc:
            _service(request).repository.delete_review_bridge(str(bridge["bridgeId"]))
            raise BacktestError(
                "REPLAY_TRAINING_UNAVAILABLE",
                f"TrainingRun creation failed: {type(exc).__name__}",
            ) from exc
        return {**bound, "trainingRun": training_run}
    except BacktestError as exc:
        return _error(exc)


@router.get("/review-bridges/{bridge_id}")
def get_review_bridge(request: Request, bridge_id: str) -> dict[str, Any]:
    try:
        return _service(request).get_review_bridge(bridge_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/review-bridges/{bridge_id}/reveal")
async def reveal_review_bridge(request: Request, bridge_id: str) -> dict[str, Any]:
    try:
        service = _service(request)
        bridge = service.get_review_bridge(bridge_id)
        if bridge["state"] == "REVEALED":
            return bridge
        training_run_id = str(bridge.get("trainingRunId") or "")
        replay_service = getattr(request.app.state, "replay_service", None)
        training = getattr(replay_service, "training", None)
        if training is None or not training_run_id:
            raise BacktestError(
                "REPLAY_TRAINING_UNAVAILABLE",
                "bound Replay TrainingRun runtime is unavailable",
            )
        training_run = await training.get_run(training_run_id)
        if str(training_run.get("state")) != "ENDED":
            raise BacktestError(
                "IDENTITY_MUTATION",
                "complete the blind TrainingRun before revealing strategy orders",
            )
        human_results = await training.training_results(training_run_id, limit=2_000)
        if human_results.get("truncated"):
            raise BacktestError(
                "BUDGET_EXCEEDED",
                "blind review has more than 2000 trades; narrow the immutable review window",
            )
        return service.reveal_review_bridge(
            bridge_id,
            training_run_id=training_run_id,
            training_state=str(training_run["state"]),
            human_results=human_results,
        )
    except BacktestError as exc:
        return _error(exc)
    except Exception as exc:
        return _error(
            BacktestError(
                "REPLAY_TRAINING_UNAVAILABLE",
                f"TrainingRun reveal failed: {type(exc).__name__}",
            )
        )


@router.get("/runs/{run_id}/export")
def export_run(request: Request, run_id: str) -> dict[str, Any]:
    try:
        service = _service(request)
        return export_bundle(service.get_run(run_id), service.get_report(run_id))
    except BacktestError as exc:
        return _error(exc)
    except ValueError as exc:
        return _error(BacktestError("HASH_MISMATCH", str(exc)))


@router.post("/studies")
def create_study(request: Request, payload: StudyCreateRequest) -> dict[str, Any]:
    try:
        return _service(request).create_study(payload.model_dump())
    except BacktestError as exc:
        return _error(exc)


@router.get("/studies/{study_id}")
def get_study(request: Request, study_id: str) -> dict[str, Any]:
    try:
        return _service(request).get_study(study_id)
    except BacktestError as exc:
        return _error(exc)


@router.get("/studies")
def list_studies(request: Request) -> dict[str, Any]:
    try:
        return {"studies": _service(request).list_studies()}
    except BacktestError as exc:
        return _error(exc)


@router.get("/studies/{study_id}/compare")
def compare_study(request: Request, study_id: str) -> dict[str, Any]:
    try:
        return _service(request).compare_study(study_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/studies/{study_id}/start")
def start_study(request: Request, study_id: str) -> dict[str, Any]:
    try:
        return _service(request).start_study(study_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/studies/{study_id}/cancel")
def cancel_study(request: Request, study_id: str) -> dict[str, Any]:
    try:
        return _service(request).cancel_study(study_id)
    except BacktestError as exc:
        return _error(exc)


@router.post("/studies/{study_id}/reveal-holdout")
def reveal_study_holdout(request: Request, study_id: str) -> dict[str, Any]:
    try:
        return _service(request).reveal_study_holdout(study_id)
    except BacktestError as exc:
        return _error(exc)
