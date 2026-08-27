"""Manual continuous history download API.

Phase 0 exposes only the capabilities probe and keeps every write path closed.
Create/plan/cancel/release land in later phases after GC protection exists.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.core.config import (
    HISTORY_ARCHIVE_ENABLED,
    MANUAL_HISTORY_ACTIVE_JOB_CONCURRENCY,
    MANUAL_HISTORY_DOWNLOAD_ENABLED,
    MANUAL_HISTORY_MAX_TARGETS,
    MANUAL_HISTORY_TARGET_CONCURRENCY,
    OKX_HISTORY_ARCHIVE_ENABLED,
)

router = APIRouter(
    prefix="/settings/storage/manual-downloads",
    tags=["settings", "manual-history"],
)

FEATURE_FLAG_DISABLED = "feature_flag_disabled"
WRITE_PATH_NOT_OPEN = "write_path_not_open"


def manual_history_capabilities_payload() -> dict[str, Any]:
    """Return the shipped capabilities body from live process config."""

    enabled = bool(MANUAL_HISTORY_DOWNLOAD_ENABLED)
    return {
        "status": "ok",
        "enabled": enabled,
        "reason": None if enabled else FEATURE_FLAG_DISABLED,
        # Phase 0 has no ManualHistoryService runner.  Later phases flip this
        # when the job runner is actually constructed.
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


@router.get("/capabilities")
async def get_manual_history_capabilities() -> dict[str, Any]:
    """Advertise whether the write feature is enabled.  Always read-only."""

    return manual_history_capabilities_payload()


@router.post("")
@router.post("/")
async def create_manual_history_download() -> dict[str, Any]:
    """Phase 0 write gate: reject create until later phases open it."""

    payload = manual_history_capabilities_payload()
    _reject_write(enabled=bool(payload["enabled"]))
    raise AssertionError("manual history create must remain closed in Phase 0")
