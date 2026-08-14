"""Fail-closed HTTP control plane for BacktestRun / BacktestStudy."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.backtest.errors import BacktestError
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
    parameters: dict[str, Any] = Field(default_factory=dict)
    account_model: str = "LINEAR_PERP_ONE_WAY_V1"
    study_id: str | None = None


class StudyCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    hypothesis: str = ""
    strategy_revision_id: str = Field(min_length=1, max_length=128)
    parameters: dict[str, Any] = Field(default_factory=dict)


def _service(request: Request) -> BacktestService:
    service = getattr(request.app.state, "backtest_service", None)
    if service is None:
        raise BacktestError("FLAG_DISABLED", "backtest control plane is not started")
    return service


def _error(exc: BacktestError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
    )


@router.get("/capabilities")
def capabilities(request: Request) -> dict[str, Any]:
    try:
        return _service(request).capabilities()
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs/validate")
def validate_run(request: Request, payload: RunCreateRequest) -> dict[str, Any]:
    try:
        return _service(request).validate_run(payload.model_dump())
    except BacktestError as exc:
        return _error(exc)


@router.post("/runs")
def create_run(
    request: Request,
    payload: RunCreateRequest,
    x_idempotency_key: str = Header(alias="Idempotency-Key"),
) -> dict[str, Any]:
    try:
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
