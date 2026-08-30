"""Plan-first manual continuous-history download API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import (
    HISTORY_ARCHIVE_ENABLED,
    MANUAL_HISTORY_ACTIVE_JOB_CONCURRENCY,
    MANUAL_HISTORY_DOWNLOAD_ENABLED,
    MANUAL_HISTORY_MAX_TARGETS,
    MANUAL_HISTORY_TARGET_CONCURRENCY,
    OKX_HISTORY_ARCHIVE_ENABLED,
)
from app.data_engine.manual_history.planner import ManualHistoryPlanner
from app.data_engine.manual_history.models import (
    ManualHistoryIdempotencyConflict,
    ManualHistoryIllegalTransition,
    ManualHistoryNotFound,
)
from app.data_engine.storage.klines_repo import get_bounds
from app.data_engine.data_manager.runtime_pressure import (
    disk_pressure_snapshot,
    storage_file_snapshot,
)
from app.core.config import KLINES_DB_PATH

router = APIRouter(
    prefix="/settings/storage/manual-downloads",
    tags=["settings", "manual-history"],
)

FEATURE_FLAG_DISABLED = "feature_flag_disabled"
RUNTIME_UNAVAILABLE = "runtime_unavailable"


class ManualHistoryPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    exchange: str
    market_type: str
    symbols: list[str] = Field(min_length=1, max_length=64)
    intervals: list[str] = Field(min_length=1, max_length=32)
    start_ms: int = Field(ge=0)


class ManualHistoryCreateRequest(ManualHistoryPlanRequest):
    plan_hash: str = Field(
        min_length=71,
        max_length=71,
        pattern=r"^sha256:[0-9a-f]{64}$",
    )
    idempotency_key: str = Field(min_length=8, max_length=128)


def manual_history_capabilities_payload() -> dict[str, Any]:
    """Return the shipped capabilities body from live process config."""

    enabled = bool(MANUAL_HISTORY_DOWNLOAD_ENABLED)
    return {
        "status": "ok",
        "enabled": enabled,
        "reason": None if enabled else FEATURE_FLAG_DISABLED,
        "job_runner_available": bool(MANUAL_HISTORY_DOWNLOAD_ENABLED),
        "archive": {
            "enabled": bool(HISTORY_ARCHIVE_ENABLED),
            "okx_enabled": bool(OKX_HISTORY_ARCHIVE_ENABLED),
        },
        "limits": {
            "max_targets": int(MANUAL_HISTORY_MAX_TARGETS),
            "active_job_concurrency": int(MANUAL_HISTORY_ACTIVE_JOB_CONCURRENCY),
            "target_concurrency": int(MANUAL_HISTORY_TARGET_CONCURRENCY),
        },
    }


def _reject_write(*, enabled: bool) -> None:
    reason = FEATURE_FLAG_DISABLED if not enabled else RUNTIME_UNAVAILABLE
    raise HTTPException(
        status_code=403,
        detail={
            "status": "error",
            "reason": reason,
            "message": (
                "manual history download is disabled"
                if reason == FEATURE_FLAG_DISABLED
                else "manual history download runtime is unavailable"
            ),
        },
    )


def _require_write_enabled() -> None:
    """Fail closed before FastAPI validates a write request body.

    A flag-off rollback must be observable as 403 even when an old client sends
    the pre-plan request shape. Route dependencies are resolved before body
    model validation, so disabled deployments do not leak a misleading 422.
    """

    if not bool(MANUAL_HISTORY_DOWNLOAD_ENABLED):
        _reject_write(enabled=False)


def _build_planner(
    *,
    feature_enabled: bool,
    request: Request | None = None,
) -> ManualHistoryPlanner:
    def _disk() -> dict[str, Any]:
        files = storage_file_snapshot(KLINES_DB_PATH)
        disk = disk_pressure_snapshot(KLINES_DB_PATH)
        return {
            "physical_size_bytes": files.get("physical_size_bytes"),
            "free_bytes": disk.get("free_bytes"),
        }

    sqlite_budget_bytes = None
    reserved_bytes = 0
    if request is not None:
        runtime = getattr(request.app.state, "data_engine_runtime", None)
        data_manager = getattr(request.app.state, "data_manager", None)
        if data_manager is None and runtime is not None:
            data_manager = getattr(runtime, "data_manager", None)
        retention_snapshot = getattr(data_manager, "retention_snapshot", None)
        if callable(retention_snapshot):
            sqlite_budget_bytes = retention_snapshot().get("sqlite_budget_bytes")
        service = getattr(runtime, "manual_history_service", None)
        repository = getattr(service, "repository", None)
        list_recoverable = getattr(repository, "list_recoverable_jobs", None)
        if callable(list_recoverable):
            reserved_bytes = sum(
                max(0, int(job.reserved_bytes or 0))
                for job in list_recoverable()
            )

    return ManualHistoryPlanner(
        get_bounds=get_bounds,
        disk_snapshot=_disk,
        sqlite_budget_bytes=sqlite_budget_bytes,
        reserved_bytes=reserved_bytes,
        feature_enabled=feature_enabled,
        archive_enabled=HISTORY_ARCHIVE_ENABLED,
        max_targets=MANUAL_HISTORY_MAX_TARGETS,
    )


@router.get("/capabilities")
async def get_manual_history_capabilities() -> dict[str, Any]:
    """Advertise whether the write feature is enabled.  Always read-only."""

    return manual_history_capabilities_payload()


@router.post("/plan")
async def plan_manual_history_download(
    body: ManualHistoryPlanRequest,
    request: Request,
) -> dict[str, Any]:
    """Expand targets and storage risk without creating jobs or protections."""

    planner = _build_planner(
        feature_enabled=bool(MANUAL_HISTORY_DOWNLOAD_ENABLED),
        request=request,
    )
    return planner.plan(
        exchange=body.exchange,
        market_type=body.market_type,
        symbols=body.symbols,
        intervals=body.intervals,
        start_ms=body.start_ms,
    )


def _service(request: Request) -> Any:
    runtime = getattr(request.app.state, "data_engine_runtime", None)
    service = getattr(runtime, "manual_history_service", None) if runtime is not None else None
    return service


def _job_payload(job: Any, *, targets: Any = None) -> dict[str, Any]:
    payload = {
        "job_id": job.job_id,
        "collection_id": job.collection_id,
        "state": job.state.value,
        "stage": job.stage,
        "revision": job.revision,
        "ready_targets": job.ready_targets,
        "failed_targets": job.failed_targets,
        "total_targets": job.total_targets,
        "cancel_requested": job.cancel_requested,
        "last_error": job.last_error,
        "plan_hash": job.plan_hash,
    }
    if targets is not None:
        payload["targets"] = [
            {
                "symbol": item.symbol,
                "canonical_interval": item.canonical_interval,
                "state": item.state.value,
                "sealed_end_open_ms": item.sealed_end_open_ms,
                "last_error": item.last_error,
            }
            for item in targets
        ]
    return payload


@router.post("", status_code=202, dependencies=[Depends(_require_write_enabled)])
@router.post("/", status_code=202, dependencies=[Depends(_require_write_enabled)])
async def create_manual_history_download(
    body: ManualHistoryCreateRequest,
    request: Request,
) -> dict[str, Any]:
    """Create a job from a previously computed plan hash."""

    service = _service(request)
    if service is None:
        _reject_write(enabled=True)
    existing = service.repository.get_job_by_idempotency_key(body.idempotency_key)
    if existing is not None:
        if existing.request_hash != body.plan_hash:
            raise HTTPException(
                status_code=409,
                detail={
                    "status": "error",
                    "reason": "idempotency_conflict",
                    "existing_job_id": existing.job_id,
                },
            )
        return {
            "status": "accepted",
            "job": _job_payload(
                existing,
                targets=service.repository.list_job_targets(existing.job_id),
            ),
            "reused_existing": True,
        }
    planner = _build_planner(feature_enabled=True, request=request)
    plan = planner.plan(
        exchange=body.exchange,
        market_type=body.market_type,
        symbols=body.symbols,
        intervals=body.intervals,
        start_ms=body.start_ms,
    )
    if plan.get("plan_hash") != body.plan_hash:
        raise HTTPException(
            status_code=409,
            detail={"status": "error", "reason": "plan_stale", "plan": plan},
        )
    if not plan.get("can_start"):
        raise HTTPException(
            status_code=409,
            detail={
                "status": "error",
                "reason": (plan.get("blocking_reasons") or ["cannot_start"])[0],
                "plan": plan,
            },
        )
    try:
        created = service.create_from_plan(plan, idempotency_key=body.idempotency_key)
    except ManualHistoryIdempotencyConflict as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "status": "error",
                "reason": "idempotency_conflict",
                "existing_job_id": exc.existing_job_id,
            },
        ) from exc
    return {
        "status": "accepted",
        "job": _job_payload(created.job, targets=created.job_targets),
        "reused_existing": created.reused_existing,
    }


@router.get("")
@router.get("/")
async def list_manual_history_jobs(
    request: Request,
    limit: int = 50,
    cursor: str | None = None,
) -> dict[str, Any]:
    service = _service(request)
    if service is None:
        return {"status": "ok", "jobs": []}
    try:
        jobs = service.repository.list_jobs(limit=limit, cursor=cursor)
    except ManualHistoryNotFound as exc:
        raise HTTPException(
            status_code=400,
            detail={"status": "error", "reason": "invalid_cursor"},
        ) from exc
    return {
        "status": "ok",
        "jobs": [_job_payload(job) for job in jobs],
        "next_cursor": jobs[-1].job_id if len(jobs) >= max(1, min(limit, 200)) else None,
    }


@router.get("/collections")
async def list_manual_history_collections(request: Request) -> dict[str, Any]:
    service = _service(request)
    if service is None:
        return {"status": "ok", "collections": []}
    collections = service.repository.list_collections()
    return {
        "status": "ok",
        "collections": [
            {
                "collection_id": item.collection_id,
                "status": item.status.value,
                "exchange": item.exchange,
                "market_type": item.market_type,
                "requested_start_ms": item.requested_start_ms,
                "revision": item.revision,
                "targets": [
                    {
                        "symbol": target.symbol,
                        "canonical_interval": target.canonical_interval,
                        "source_interval": target.source_interval,
                        "effective_start_ms": target.effective_start_ms,
                        "continuous_end_ms": target.continuous_end_ms,
                        "status": target.status.value,
                    }
                    for target in service.repository.list_collection_targets(
                        item.collection_id
                    )
                ],
            }
            for item in collections
        ],
    }


@router.post(
    "/collections/{collection_id}/release",
    dependencies=[Depends(_require_write_enabled)],
)
async def release_manual_history_collection(
    collection_id: str,
    request: Request,
) -> dict[str, Any]:
    service = _service(request)
    if service is None:
        _reject_write(enabled=True)
    try:
        released = service.release_collection(collection_id)
    except ManualHistoryNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail={"status": "error", "reason": "collection_not_found"},
        ) from exc
    return {
        "status": "ok",
        "collection_id": released.collection_id,
        "state": released.status.value,
        "klines_deleted": False,
    }


@router.get("/{job_id}")
async def get_manual_history_job(job_id: str, request: Request) -> dict[str, Any]:
    service = _service(request)
    if service is None:
        raise HTTPException(
            status_code=404,
            detail={"status": "error", "reason": "job_not_found"},
        )
    try:
        job = service.repository.get_job(job_id)
    except ManualHistoryNotFound:
        raise HTTPException(
            status_code=404,
            detail={"status": "error", "reason": "job_not_found"},
        ) from None
    return {
        "status": "ok",
        "job": _job_payload(job, targets=service.repository.list_job_targets(job_id)),
    }


@router.post("/{job_id}/cancel", dependencies=[Depends(_require_write_enabled)])
async def cancel_manual_history_job(job_id: str, request: Request) -> dict[str, Any]:
    service = _service(request)
    if service is None:
        _reject_write(enabled=True)
    try:
        job = await service.cancel_job(job_id)
    except ManualHistoryNotFound:
        raise HTTPException(
            status_code=404,
            detail={"status": "error", "reason": "job_not_found"},
        ) from None
    except ManualHistoryIllegalTransition as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "status": "error",
                "reason": "illegal_transition",
                "current": exc.current,
            },
        ) from exc
    return {"status": "ok", "job": _job_payload(job)}
