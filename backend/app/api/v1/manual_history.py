"""Manual continuous history download API.

Phase 3 adds the read-only plan probe.  Create/cancel/release stay closed
until later phases open them after GC protection exists.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
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
WRITE_PATH_NOT_OPEN = "write_path_not_open"


class ManualHistoryPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    exchange: str
    market_type: str
    symbols: list[str] = Field(min_length=1)
    intervals: list[str] = Field(min_length=1)
    start_ms: int = Field(ge=0)


def manual_history_capabilities_payload() -> dict[str, Any]:
    """Return the shipped capabilities body from live process config."""

    enabled = bool(MANUAL_HISTORY_DOWNLOAD_ENABLED)
    return {
        "status": "ok",
        "enabled": enabled,
        "reason": None if enabled else FEATURE_FLAG_DISABLED,
        "job_runner_available": False,
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
    reason = FEATURE_FLAG_DISABLED if not enabled else WRITE_PATH_NOT_OPEN
    raise HTTPException(
        status_code=403,
        detail={
            "status": "error",
            "reason": reason,
            "message": (
                "manual history download is disabled"
                if reason == FEATURE_FLAG_DISABLED
                else "manual history download write path is not open"
            ),
        },
    )


def _build_planner(*, feature_enabled: bool) -> ManualHistoryPlanner:
    def _disk() -> dict[str, Any]:
        files = storage_file_snapshot(KLINES_DB_PATH)
        disk = disk_pressure_snapshot(KLINES_DB_PATH)
        return {
            "physical_size_bytes": files.get("physical_size_bytes"),
            "free_bytes": disk.get("free_bytes"),
        }

    return ManualHistoryPlanner(
        get_bounds=get_bounds,
        disk_snapshot=_disk,
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

    del request
    planner = _build_planner(feature_enabled=bool(MANUAL_HISTORY_DOWNLOAD_ENABLED))
    return planner.plan(
        exchange=body.exchange,
        market_type=body.market_type,
        symbols=body.symbols,
        intervals=body.intervals,
        start_ms=body.start_ms,
    )


@router.post("")
@router.post("/")
async def create_manual_history_download() -> dict[str, Any]:
    """Write gate: reject create until later phases open it."""

    payload = manual_history_capabilities_payload()
    _reject_write(enabled=bool(payload["enabled"]))
    raise AssertionError("manual history create must remain closed")
