"""Fail-closed HTTP control plane for BacktestRun / BacktestStudy."""

from __future__ import annotations

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
    output_mode: str = Field(default="TARGET_POSITION", max_length=32)
    initial_balance: str = Field(default="10000", max_length=64)
    slippage_bps: str = Field(default="1", max_length=64)
    taker_fee_bps: str = Field(default="0", max_length=64)
    maker_fee_bps: str = Field(default="0", max_length=64)
    funding_rate: str = Field(default="0", max_length=64)
    funding_interval_hours: int = Field(default=8, ge=1, le=168)
    funding_mode: str = Field(default="OFF", max_length=32)
    leverage: str = Field(default="1", max_length=64)
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
    interval: str | None = Field(default=None, max_length=16)
    start_ms: int
    end_ms: int
    train_ms: int
    test_ms: int
    step_ms: int | None = None
    parameter_space: dict[str, list[Any]] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)
    sampler: str = "grid"
    max_trials: int | None = None
    random_count: int | None = None
    seed: int | None = None
    warmup_bars: int = 0
    initial_balance: str = Field(default="10000", max_length=64)
    slippage_bps: str = Field(default="1", max_length=64)
    taker_fee_bps: str = Field(default="0", max_length=64)
    gap_policy: str = "REJECT"


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
