"""Conservative automatic GC orchestration for DataManager caches."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.config import DATA_DIR, KLINES_DB_PATH
from app.core.executors import run_storage

from .gc import HARD_PROCESS_RSS_BYTES, execute_memory_gc_plan
from .maintenance import MaintenanceBusyError, MaintenanceUnavailableError
from .runtime_pressure import storage_file_snapshot

logger = logging.getLogger("data_manager.auto_gc")

DEFAULT_AUDIT_MAX_BYTES = 8 * 1024 * 1024
DEFAULT_AUDIT_BACKUP_COUNT = 3
_AUDIT_LOCK = threading.Lock()


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    logger.warning(
        "invalid boolean environment value for %s=%r; using default %s",
        name,
        value,
        default,
    )
    return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = float("nan")
    if math.isfinite(value) and minimum <= value <= maximum:
        return value
    logger.warning(
        "invalid numeric environment value for %s=%r; using default %s",
        name,
        raw,
        default,
    )
    return default


@dataclass(frozen=True, slots=True)
class AutoGcPolicy:
    """Safety limits for autonomous GC execution."""

    enabled: bool = True
    mode: str = "conservative"
    cooldown_ms: int = 60_000
    max_bytes_per_run: int = 32 * 1024 * 1024
    max_entries_per_run: int = 200
    min_final_evict_score: float = 70.0
    never_evict_accessed_within_ms: int = 2 * 60_000
    storage_batch_size: int = 1_000
    sqlite_auto_delete_enabled: bool = False
    sqlite_auto_vacuum: bool = False
    audit_path: Path = DATA_DIR / "cache_gc_audit.jsonl"
    audit_max_bytes: int = DEFAULT_AUDIT_MAX_BYTES
    audit_backup_count: int = DEFAULT_AUDIT_BACKUP_COUNT

    def __post_init__(self) -> None:
        if not 1 <= int(self.storage_batch_size) <= 1_000:
            raise ValueError("storage_batch_size must be between 1 and 1000 rows")
        if not (
            math.isfinite(self.min_final_evict_score)
            and 0 <= self.min_final_evict_score <= 1_000
        ):
            raise ValueError("min_final_evict_score must be finite and between 0 and 1000")
        if self.sqlite_auto_vacuum:
            raise ValueError(
                "automatic SQLite VACUUM is unsupported; use the explicit "
                "storage vacuum maintenance endpoint"
            )

    @classmethod
    def from_env(cls) -> "AutoGcPolicy":
        return cls(
            enabled=_env_bool("CANDLESCOPE_AUTO_GC_ENABLED", True),
            mode=os.getenv("CANDLESCOPE_AUTO_GC_MODE", "conservative").strip() or "conservative",
            cooldown_ms=max(10_000, _env_int("CANDLESCOPE_AUTO_GC_COOLDOWN_MS", 60_000)),
            max_bytes_per_run=max(1, _env_int("CANDLESCOPE_AUTO_GC_MAX_BYTES", 32 * 1024 * 1024)),
            max_entries_per_run=max(1, _env_int("CANDLESCOPE_AUTO_GC_MAX_ENTRIES", 200)),
            min_final_evict_score=_env_float(
                "CANDLESCOPE_AUTO_GC_MIN_SCORE",
                70.0,
                minimum=0,
                maximum=1_000,
            ),
            never_evict_accessed_within_ms=max(
                0,
                _env_int("CANDLESCOPE_AUTO_GC_NEVER_ACCESSED_MS", 2 * 60_000),
            ),
            storage_batch_size=min(
                1_000,
                max(1, _env_int("CANDLESCOPE_AUTO_GC_STORAGE_BATCH", 1_000)),
            ),
            sqlite_auto_delete_enabled=_env_bool(
                "CANDLESCOPE_AUTO_GC_STORAGE_DELETE_ENABLED",
                False,
            ),
            sqlite_auto_vacuum=_env_bool("CANDLESCOPE_AUTO_GC_SQLITE_VACUUM", False),
            audit_max_bytes=max(
                1,
                _env_int(
                    "CANDLESCOPE_AUTO_GC_AUDIT_MAX_BYTES",
                    DEFAULT_AUDIT_MAX_BYTES,
                ),
            ),
            audit_backup_count=max(
                0,
                _env_int(
                    "CANDLESCOPE_AUTO_GC_AUDIT_BACKUP_COUNT",
                    DEFAULT_AUDIT_BACKUP_COUNT,
                ),
            ),
        )

    @classmethod
    def from_mapping(cls, values: dict[str, Any] | None = None) -> "AutoGcPolicy":
        base = cls.from_env()
        values = values or {}
        if "never_evict_active_within_ms" in values:
            raise ValueError(
                "never_evict_active_within_ms is unsupported: the runtime does "
                "not publish an exact last-became-inactive timestamp"
            )
        return cls(
            enabled=bool(values.get("enabled", base.enabled)),
            mode=str(values.get("mode", base.mode) or "conservative"),
            cooldown_ms=max(10_000, int(values.get("cooldown_ms", base.cooldown_ms))),
            max_bytes_per_run=max(1, int(values.get("max_bytes_per_run", base.max_bytes_per_run))),
            max_entries_per_run=max(1, int(values.get("max_entries_per_run", base.max_entries_per_run))),
            min_final_evict_score=float(values.get("min_final_evict_score", base.min_final_evict_score)),
            never_evict_accessed_within_ms=max(
                0,
                int(values.get("never_evict_accessed_within_ms", base.never_evict_accessed_within_ms)),
            ),
            storage_batch_size=min(
                1_000,
                max(1, int(values.get("storage_batch_size", base.storage_batch_size))),
            ),
            sqlite_auto_delete_enabled=bool(
                values.get(
                    "sqlite_auto_delete_enabled",
                    base.sqlite_auto_delete_enabled,
                )
            ),
            sqlite_auto_vacuum=bool(values.get("sqlite_auto_vacuum", base.sqlite_auto_vacuum)),
            audit_path=Path(values.get("audit_path", base.audit_path)),
            audit_max_bytes=max(
                1,
                int(values.get("audit_max_bytes", base.audit_max_bytes)),
            ),
            audit_backup_count=max(
                0,
                int(values.get("audit_backup_count", base.audit_backup_count)),
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "cooldown_ms": self.cooldown_ms,
            "max_bytes_per_run": self.max_bytes_per_run,
            "max_entries_per_run": self.max_entries_per_run,
            "min_final_evict_score": self.min_final_evict_score,
            "never_evict_accessed_within_ms": self.never_evict_accessed_within_ms,
            "storage_batch_size": self.storage_batch_size,
            "sqlite_auto_delete_enabled": self.sqlite_auto_delete_enabled,
            "sqlite_auto_vacuum": self.sqlite_auto_vacuum,
            "sqlite_auto_vacuum_supported": False,
            "audit_path": str(self.audit_path),
            "audit_max_bytes": self.audit_max_bytes,
            "audit_backup_count": self.audit_backup_count,
        }


def _score(victim: dict[str, Any]) -> float:
    try:
        value = float((victim.get("scores") or {}).get("finalEvictScore", 0) or 0)
    except (TypeError, ValueError):
        return 0.0
    return value if math.isfinite(value) else 0.0


def _recently_accessed(victim: dict[str, Any], now_ms: int, policy: AutoGcPolicy) -> bool:
    last_access_ms = int(victim.get("last_access_ms") or victim.get("lastAccessMs") or 0)
    if last_access_ms <= 0:
        return False
    return now_ms - last_access_ms < policy.never_evict_accessed_within_ms


def _within_limits(selected: list[dict[str, Any]], victim: dict[str, Any], policy: AutoGcPolicy) -> bool:
    if len(selected) >= policy.max_entries_per_run:
        return False
    used = sum(
        int(item.get("would_free_estimated_bytes") or item.get("estimatedBytes") or item.get("estimated_bytes") or 0)
        for item in selected
    )
    next_bytes = int(
        victim.get("would_free_estimated_bytes") or victim.get("estimatedBytes") or victim.get("estimated_bytes") or 0
    )
    return used + next_bytes <= policy.max_bytes_per_run


def _selected_estimated_bytes(selected: list[dict[str, Any]]) -> int:
    return sum(
        int(
            item.get("would_free_estimated_bytes")
            or item.get("estimatedBytes")
            or item.get("estimated_bytes")
            or 0
        )
        for item in selected
    )


def _fit_storage_victim_to_remaining_bytes(
    victim: dict[str, Any],
    remaining_bytes: int,
) -> dict[str, Any] | None:
    """Return a partial storage victim that fits a hard byte ceiling."""
    delete_rows = int(victim.get("would_delete_rows", 0) or 0)
    estimated_bytes = int(victim.get("would_free_estimated_bytes", 0) or 0)
    if delete_rows <= 0 or estimated_bytes <= 0 or remaining_bytes <= 0:
        return None
    if estimated_bytes <= remaining_bytes:
        return victim

    rows = min(delete_rows, int(delete_rows * remaining_bytes / estimated_bytes))
    if rows <= 0:
        return None
    current_rows = int(victim.get("current_rows", delete_rows) or delete_rows)
    fitted = {
        **victim,
        "would_delete_rows": rows,
        "would_free_estimated_bytes": min(
            remaining_bytes,
            max(1, int(estimated_bytes * rows / delete_rows)),
        ),
        "keep_rows": max(0, current_rows - rows),
        "auto_truncated_to_hard_limit": True,
        "original_would_delete_rows": delete_rows,
        "original_would_free_estimated_bytes": estimated_bytes,
    }
    return fitted


def filter_auto_memory_plan(plan: dict[str, Any], policy: AutoGcPolicy) -> dict[str, Any]:
    """Keep only high-confidence memory victims from a smart dry-run plan."""
    now_ms = int(time.time() * 1000)
    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    pressure = plan.get("pressure") or {}
    runtime_memory = (plan.get("runtimePressure") or {}).get("processMemory") or {}
    required_bars = max(0, int(pressure.get("over_total_bars", 0) or 0))
    required_series = max(0, int(pressure.get("over_series", 0) or 0))
    rss_bytes = int(runtime_memory.get("rss_bytes", 0) or 0)
    rss_hard_pressure = (
        runtime_memory.get("available") is not False
        and rss_bytes >= HARD_PROCESS_RSS_BYTES
    )
    hard_pressure = bool(required_bars or required_series or rss_hard_pressure)

    victims = sorted(
        plan.get("victims", []) or [],
        key=lambda item: -_score(item),
    )
    for victim in victims:
        reason = ""
        targets_satisfied = bool(
            hard_pressure
            and selected
            and not rss_hard_pressure
            and sum(
                int(item.get("would_free_bars", 0) or 0)
                for item in selected
            ) >= required_bars
            and sum(
                1
                for item in selected
                if item.get("action") == "delete-series"
            ) >= required_series
        )
        if victim.get("active") or victim.get("subscribed"):
            reason = "active-or-subscribed"
        elif targets_satisfied:
            reason = "pressure-target-satisfied"
        elif not hard_pressure and _recently_accessed(victim, now_ms, policy):
            reason = "recently-accessed"
        elif not hard_pressure and _score(victim) < policy.min_final_evict_score:
            reason = "score-below-threshold"
        elif not _within_limits(selected, victim, policy):
            reason = "per-run-limit"

        if reason:
            skipped.append({"key": victim.get("key"), "reason": reason, "score": _score(victim)})
            continue
        selected.append(victim)

    would_free_bars = sum(int(item.get("would_free_bars", 0) or 0) for item in selected)
    would_free_bytes = sum(int(item.get("would_free_estimated_bytes", 0) or 0) for item in selected)
    return {
        **plan,
        "mode": "auto-plan",
        "autoPolicy": policy.to_dict(),
        "victims": selected,
        "autoSkipped": skipped,
        "hardPressure": {
            "active": hard_pressure,
            "required_bars": required_bars,
            "required_series": required_series,
            "rss_bytes": rss_bytes,
            "rss_threshold_bytes": HARD_PROCESS_RSS_BYTES,
            "rss_hard_pressure": rss_hard_pressure,
        },
        "would_remove_series": sum(1 for item in selected if item.get("action") == "delete-series"),
        "would_trim_series": sum(1 for item in selected if item.get("action") == "trim-series"),
        "would_free_bars": would_free_bars,
        "would_free_estimated_bytes": would_free_bytes,
    }


def _storage_level(plan: dict[str, Any]) -> str:
    return str((plan.get("watermarks") or {}).get("level") or "normal")


def filter_auto_storage_plan(plan: dict[str, Any], policy: AutoGcPolicy) -> dict[str, Any]:
    """Keep only high-confidence SQLite victims when watermarks require action."""
    level = _storage_level(plan)
    disk_free_critical = bool(
        (plan.get("watermarks") or {}).get("disk_free_critical")
    )
    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    victims = sorted(
        plan.get("series", []) or [],
        key=lambda item: -_score(item),
    )
    for victim in victims:
        flags = set(victim.get("risk_flags") or [])
        reason = ""
        selected_victim = victim
        if disk_free_critical:
            # DELETE first grows WAL, so it can worsen a critical free-space
            # incident before any checkpoint or compaction can reclaim bytes.
            reason = "disk-free-critical"
        elif level == "unconfigured":
            reason = "watermark-unconfigured"
        elif level not in {"high", "critical", "over_budget"}:
            reason = "watermark-normal"
        elif "active-or-subscribed" in flags:
            reason = "active-or-subscribed"
        elif "storage-intent" in flags:
            reason = "storage-intent"
        elif "custom-interval" in flags:
            reason = "custom-interval"
        else:
            remaining_bytes = max(
                0,
                policy.max_bytes_per_run - _selected_estimated_bytes(selected),
            )
            selected_victim = _fit_storage_victim_to_remaining_bytes(
                victim,
                remaining_bytes,
            )
            if selected_victim is None or not _within_limits(
                selected,
                selected_victim,
                policy,
            ):
                reason = "per-run-limit"

        if reason:
            skipped.append({"key": victim.get("key"), "reason": reason, "score": _score(victim)})
            continue
        selected.append(selected_victim)

    vacuum_recommended_now = int(
        plan.get("compaction_relief_bytes", 0)
        or (plan.get("watermarks") or {}).get("compaction_relief_bytes", 0)
        or 0
    ) > 0
    return {
        **plan,
        "mode": "auto-plan",
        "autoPolicy": policy.to_dict(),
        "series": selected,
        "autoSkipped": skipped,
        "victim_count": len(selected),
        "would_delete_rows": sum(int(item.get("would_delete_rows", 0) or 0) for item in selected),
        "would_free_estimated_bytes": sum(
            int(item.get("would_free_estimated_bytes", 0) or 0)
            for item in selected
        ),
        # Keep the planner's recommendation visible.  Automatic VACUUM remains
        # unsupported; this is a manual-action diagnostic, not authorization.
        "vacuum_recommended": bool(plan.get("vacuum_recommended")),
        "vacuum_recommended_now": vacuum_recommended_now,
        "vacuum_recommended_after_delete": bool(
            plan.get("vacuum_recommended") and selected
        ),
        "sqlite_auto_vacuum_supported": False,
    }


def _rotate_auto_gc_audit(path: Path, backup_count: int) -> None:
    if not path.exists():
        return
    if backup_count <= 0:
        path.unlink()
        return
    for index in range(backup_count, 1, -1):
        source = path.with_name(f"{path.name}.{index - 1}")
        if source.exists():
            source.replace(path.with_name(f"{path.name}.{index}"))
    path.replace(path.with_name(f"{path.name}.1"))


def append_auto_gc_audit(report: dict[str, Any], policy: AutoGcPolicy) -> None:
    """Append a compact JSONL audit record for autonomous GC decisions."""
    try:
        audit_path = Path(policy.audit_path)
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts_ms": int(time.time() * 1000),
            "mode": report.get("mode"),
            "status": report.get("status"),
            "policy": policy.to_dict(),
            "memory": {
                "removed_bars": (report.get("memory") or {}).get("removed_bars"),
                "removed_series": (report.get("memory") or {}).get("removed_series"),
                "skipped": len(((report.get("memory_plan") or {}).get("autoSkipped")) or []),
            },
            "storage": {
                "deleted_rows": (report.get("storage") or {}).get("deleted_rows"),
                "affected_series": (report.get("storage") or {}).get("affected_series"),
                "checkpoint_only": bool(
                    (report.get("storage") or {}).get("checkpoint_only")
                ),
                "skipped": len(((report.get("storage_plan") or {}).get("autoSkipped")) or []),
                "watermark": ((report.get("storage_plan") or {}).get("watermarks") or {}).get("level"),
            },
            "constraints": [
                str(item.get("reason") or "")
                for item in (report.get("constraints") or [])
                if item.get("reason")
            ],
        }
        payload = json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n"
        payload_bytes = len(payload.encode("utf-8"))
        with _AUDIT_LOCK:
            current_bytes = audit_path.stat().st_size if audit_path.exists() else 0
            if current_bytes > 0 and current_bytes + payload_bytes > policy.audit_max_bytes:
                _rotate_auto_gc_audit(audit_path, policy.audit_backup_count)
            with open(audit_path, "a", encoding="utf-8") as handle:
                handle.write(payload)
    except Exception as exc:
        logger.debug("auto GC audit append failed: %s", exc)


def _storage_path(data_manager: Any) -> Path:
    storage = getattr(getattr(data_manager, "query_engine", None), "storage", None)
    candidate = getattr(storage, "db_path", None) or getattr(storage, "_db_path", None)
    return Path(candidate or KLINES_DB_PATH)


async def run_auto_gc_once(data_manager: Any, policy: AutoGcPolicy | dict[str, Any] | None = None) -> dict[str, Any]:
    """Plan and execute one conservative automatic GC pass."""
    effective_policy = policy if isinstance(policy, AutoGcPolicy) else AutoGcPolicy.from_mapping(policy)
    started_at_ms = int(time.time() * 1000)
    if not effective_policy.enabled:
        return {
            "mode": "auto-gc",
            "status": "disabled",
            "policy": effective_policy.to_dict(),
            "started_at_ms": started_at_ms,
        }

    # Slow learned-heat/runtime probes are prefetched off-loop by the concrete
    # DataManager.  Its final cache/protection snapshot and conditional
    # execution remain adjacent on the event-loop thread.
    async_memory_planner = getattr(data_manager, "plan_memory_gc_async", None)
    if callable(async_memory_planner):
        memory_dry_run = await async_memory_planner()
    else:
        memory_dry_run = data_manager.plan_memory_gc()
    memory_plan = filter_auto_memory_plan(memory_dry_run, effective_policy)
    memory_result = execute_memory_gc_plan(
        data_manager,
        memory_plan,
    ) if memory_plan.get("victims") else {
        **memory_plan,
        "mode": "execute",
        "status": "ok",
        "removed_series": 0,
        "trimmed_series": 0,
        "removed_bars": 0,
        "removed_estimated_bytes": 0,
        "results": [],
    }
    constraints: list[dict[str, str]] = []
    memory_execution_status = str(
        memory_result.get("status") or "ok"
    ).strip().lower()
    if memory_execution_status in {"constrained", "stale"}:
        memory_reasons = [
            f"memory-execution-{str(result.get('status') or '').strip().lower()}"
            for result in (memory_result.get("results") or [])
            if str(result.get("status") or "").strip().lower()
            in {"protected-at-execute", "stale"}
        ]
        stale_reason = str(memory_result.get("stale_reason") or "").strip()
        if stale_reason:
            memory_reasons.append(stale_reason)
        if not memory_reasons:
            memory_reasons.append(f"memory-execution-{memory_execution_status}")
        constraints.extend(
            {"component": "memory", "reason": reason}
            for reason in dict.fromkeys(memory_reasons)
        )
    elif int(memory_result.get("unsupported_count", 0) or 0) > 0:
        constraints.append({
            "component": "memory",
            "reason": "memory-execution-unsupported",
        })
    memory_hard_pressure = bool(
        (memory_plan.get("hardPressure") or {}).get("active")
    )
    if memory_hard_pressure and not memory_plan.get("victims"):
        reason = "hard-memory-pressure-no-auto-eligible-victims"
        memory_result = {
            **memory_result,
            "status": "constrained",
            "reason": reason,
        }
        constraints.append({"component": "memory", "reason": reason})

    storage_result: dict[str, Any] | None = None
    storage_plan: dict[str, Any] | None = None
    checkpoint_only_requested = False
    try:
        file_snapshot = await run_storage(
            storage_file_snapshot,
            _storage_path(data_manager),
        )
        async_storage_planner = getattr(
            data_manager,
            "plan_storage_gc_async",
            None,
        )
        if callable(async_storage_planner):
            storage_dry_run = await async_storage_planner(
                file_snapshot=file_snapshot,
            )
        else:
            storage_dry_run = await run_storage(
                data_manager.plan_storage_gc,
                file_snapshot=file_snapshot,
            )
        storage_plan = filter_auto_storage_plan(storage_dry_run, effective_policy)
        storage_plan["storageFileSnapshot"] = file_snapshot
        if storage_plan.get("series") and effective_policy.sqlite_auto_delete_enabled:
            storage_result = await data_manager.maintenance.run_storage_gc(
                plan=storage_plan,
                batch_size=effective_policy.storage_batch_size,
            )
        elif storage_plan.get("checkpoint_recommended"):
            checkpoint_only_requested = True
            checkpoint_plan = {
                **storage_plan,
                "series": [],
                "victim_count": 0,
                "would_delete_rows": 0,
                "would_free_estimated_bytes": 0,
                "checkpoint_only": True,
            }
            storage_result = await data_manager.maintenance.run_storage_gc(
                plan=checkpoint_plan,
                batch_size=effective_policy.storage_batch_size,
            )
            storage_result = {
                **storage_result,
                "checkpoint_only": True,
            }
            if int(storage_result.get("deleted_rows", 0) or 0) != 0:
                logger.error("checkpoint-only GC unexpectedly reported row deletion")
                storage_result = {
                    **storage_result,
                    "status": "partial",
                    "error": "checkpoint-only-unexpected-row-deletion",
                }
            elif storage_plan.get("series") and not effective_policy.sqlite_auto_delete_enabled:
                storage_result = {
                    **storage_result,
                    "reason": "storage-auto-delete-disabled",
                    "row_delete_deferred": True,
                }
        else:
            skip_reason = (
                str(storage_plan.get("reason") or "storage-planner-unavailable")
                if storage_plan.get("available") is False
                else "storage-auto-delete-disabled"
                if storage_plan.get("series")
                else "manual-vacuum-required"
                if storage_plan.get("vacuum_recommended_now")
                else "no-auto-eligible-victims"
            )
            storage_result = {
                **storage_plan,
                "mode": "execute",
                "status": (
                    "blocked"
                    if storage_plan.get("available") is False
                    else "skipped"
                ),
                "reason": skip_reason,
                "deleted_rows": 0,
                "affected_series": 0,
                "results": [],
            }
    except (MaintenanceBusyError, MaintenanceUnavailableError) as exc:
        storage_result = {
            "mode": "execute",
            "status": "blocked",
            "reason": str(exc),
            "checkpoint_only": checkpoint_only_requested,
            "deleted_rows": 0,
            "affected_series": 0,
            "results": [],
        }
    except Exception as exc:
        logger.warning("auto storage GC failed: %s", exc)
        storage_result = {
            "mode": "execute",
            "status": "error",
            "error": str(exc),
            "checkpoint_only": checkpoint_only_requested,
            "deleted_rows": 0,
            "affected_series": 0,
            "results": [],
        }

    storage_has_explicit_error = bool((storage_result or {}).get("error"))
    if storage_plan is not None:
        storage_constraint_reasons: list[str] = []
        execution_revalidation = dict(
            (storage_result or {}).get("execution_revalidation") or {}
        )
        fresh_watermarks = dict(
            execution_revalidation.get("fresh_watermarks") or {}
        )
        if storage_plan.get("available") is False:
            storage_constraint_reasons.append(
                str(storage_plan.get("reason") or "storage-planner-unavailable")
            )
        if storage_plan.get("series") and not effective_policy.sqlite_auto_delete_enabled:
            storage_constraint_reasons.append("storage-auto-delete-disabled")
        if storage_plan.get("unable_to_reach_budget"):
            storage_constraint_reasons.append("storage-budget-unreachable")
        if (
            (storage_plan.get("watermarks") or {}).get("disk_free_critical")
            or fresh_watermarks.get("disk_free_critical")
        ):
            storage_constraint_reasons.append("disk-free-critical")
        for skipped in execution_revalidation.get("fresh_auto_skipped") or []:
            fresh_skip_reason = str(skipped.get("reason") or "")
            if fresh_skip_reason and fresh_skip_reason != "watermark-normal":
                storage_constraint_reasons.append(
                    f"execution-revalidation-{fresh_skip_reason}"
                )
        vacuum_needed_after_execution = bool(
            int((storage_result or {}).get("deleted_rows", 0) or 0) > 0
            and (
                storage_plan.get("vacuum_recommended_after_delete")
                or (storage_result or {}).get("vacuum_recommended")
            )
        )
        if storage_plan.get("vacuum_recommended_now") or vacuum_needed_after_execution:
            storage_constraint_reasons.append("manual-vacuum-required")
        storage_execution_status = str(
            (storage_result or {}).get("status") or "unknown"
        ).strip().lower()
        storage_execution_reason = str(
            (storage_result or {}).get("reason") or ""
        ).strip()
        if (
            storage_execution_reason
            and storage_execution_reason != "no-auto-eligible-victims"
        ):
            storage_constraint_reasons.append(storage_execution_reason)
        storage_stale_reason = str(
            (storage_result or {}).get("stale_reason") or ""
        ).strip()
        if storage_stale_reason:
            storage_constraint_reasons.append(storage_stale_reason)
        storage_execution_errors = (storage_result or {}).get("errors") or []
        if isinstance(storage_execution_errors, str):
            storage_execution_errors = [storage_execution_errors]
        if isinstance(storage_execution_errors, (list, tuple)):
            storage_has_explicit_error = storage_has_explicit_error or any(
                str(error).strip()
                for error in storage_execution_errors
            )
            storage_constraint_reasons.extend(
                str(error).strip()
                for error in storage_execution_errors
                if str(error).strip()
            )
        if storage_execution_status == "constrained":
            storage_constraint_reasons.append("storage-execution-constrained")
        elif storage_execution_status == "stale":
            if not storage_stale_reason:
                storage_constraint_reasons.append("storage-execution-stale")
        elif storage_execution_status not in {"ok", "skipped"}:
            storage_constraint_reasons.append(
                f"storage-execution-{storage_execution_status}"
            )
        for reason in dict.fromkeys(storage_constraint_reasons):
            constraints.append({"component": "storage", "reason": reason})

    report = {
        "mode": "auto-gc",
        "status": (
            "constrained"
            if (
                memory_result.get("status") in {
                    None,
                    "ok",
                    "constrained",
                    "stale",
                }
                and storage_result.get("status") in {
                    "ok",
                    "skipped",
                    "constrained",
                    "stale",
                }
                and not memory_result.get("error")
                and not storage_has_explicit_error
                and constraints
            )
            else "ok"
            if (
                memory_result.get("status") in {None, "ok"}
                and storage_result.get("status") in {"ok", "skipped"}
                and not memory_result.get("error")
                and not storage_has_explicit_error
            )
            else "partial"
        ),
        "started_at_ms": started_at_ms,
        "elapsed_ms": int(time.time() * 1000) - started_at_ms,
        "policy": effective_policy.to_dict(),
        "memory_plan": memory_plan,
        "memory": memory_result,
        "storage_plan": storage_plan,
        "storage": storage_result,
        "constraints": constraints,
    }
    await run_storage(append_auto_gc_audit, report, effective_policy)
    logger.info(
        "auto GC pass: memory_bars=%s storage_rows=%s",
        memory_result.get("removed_bars", 0),
        storage_result.get("deleted_rows", 0),
    )
    return report


def _publish_auto_gc_health(data_manager: Any, health: dict[str, Any]) -> None:
    setattr(data_manager, "_auto_gc_health", dict(health))


async def auto_gc_loop(data_manager: Any, policy: AutoGcPolicy | None = None) -> None:
    """Run conservative automatic GC until cancelled."""
    effective_policy = policy or AutoGcPolicy.from_env()
    health: dict[str, Any] = {
        "status": "running",
        "task_alive": True,
        "started_at_ms": int(time.time() * 1000),
        "last_started_at_ms": None,
        "last_finished_at_ms": None,
        "last_completed_at_ms": None,
        "last_success_at_ms": None,
        "last_constrained_at_ms": None,
        "last_constraint": None,
        "last_error": None,
        "consecutive_failures": 0,
        "total_runs": 0,
        "total_failures": 0,
        "total_constrained": 0,
    }
    _publish_auto_gc_health(data_manager, health)
    try:
        while True:
            await asyncio.sleep(effective_policy.cooldown_ms / 1000)
            health["last_started_at_ms"] = int(time.time() * 1000)
            health["status"] = "running-pass"
            _publish_auto_gc_health(data_manager, health)
            try:
                report = await run_auto_gc_once(data_manager, effective_policy)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                finished_at_ms = int(time.time() * 1000)
                logger.exception("automatic GC pass failed; scheduler will continue")
                health.update({
                    "status": "degraded",
                    "last_finished_at_ms": finished_at_ms,
                    "last_completed_at_ms": finished_at_ms,
                    "last_error": str(exc),
                    "last_constraint": None,
                    "consecutive_failures": int(health["consecutive_failures"]) + 1,
                    "total_runs": int(health["total_runs"]) + 1,
                    "total_failures": int(health["total_failures"]) + 1,
                })
                error_report = {
                    "mode": "auto-gc",
                    "status": "error",
                    "started_at_ms": health["last_started_at_ms"],
                    "elapsed_ms": max(
                        0,
                        finished_at_ms - int(health["last_started_at_ms"] or finished_at_ms),
                    ),
                    "error": str(exc),
                    "policy": effective_policy.to_dict(),
                }
                setattr(data_manager, "_auto_gc_last_report", error_report)
                try:
                    await run_storage(
                        append_auto_gc_audit,
                        error_report,
                        effective_policy,
                    )
                except Exception as audit_exc:
                    logger.warning(
                        "automatic GC failure audit could not be written: %s",
                        audit_exc,
                    )
                _publish_auto_gc_health(data_manager, health)
                continue

            finished_at_ms = int(time.time() * 1000)
            setattr(data_manager, "_auto_gc_last_report", report)
            if report.get("status") == "constrained":
                constraint_summary = "; ".join(
                    str(item.get("reason") or "")
                    for item in (report.get("constraints") or [])
                    if item.get("reason")
                ) or "automatic GC is constrained by safety policy"
                health.update({
                    "status": "constrained",
                    "last_finished_at_ms": finished_at_ms,
                    "last_completed_at_ms": finished_at_ms,
                    "last_constrained_at_ms": finished_at_ms,
                    "last_constraint": constraint_summary,
                    "last_error": None,
                    "consecutive_failures": 0,
                    "total_runs": int(health["total_runs"]) + 1,
                    "total_constrained": int(health["total_constrained"]) + 1,
                })
                _publish_auto_gc_health(data_manager, health)
                continue
            if report.get("status") not in {"ok", "disabled"}:
                storage_report = report.get("storage") or {}
                storage_errors = storage_report.get("errors") or []
                if isinstance(storage_errors, str):
                    storage_errors = [storage_errors]
                storage_error_summary = (
                    "; ".join(
                        str(error).strip()
                        for error in storage_errors
                        if str(error).strip()
                    )
                    if isinstance(storage_errors, (list, tuple))
                    else ""
                )
                report_error = str(
                    storage_report.get("error")
                    or storage_error_summary
                    or storage_report.get("stale_reason")
                    or storage_report.get("reason")
                    or (report.get("memory") or {}).get("error")
                    or "; ".join(
                        str(item.get("reason") or "")
                        for item in (report.get("constraints") or [])
                        if item.get("reason")
                    )
                    or f"auto GC pass returned {report.get('status') or 'unknown'}"
                )
                health.update({
                    "status": "degraded",
                    "last_finished_at_ms": finished_at_ms,
                    "last_completed_at_ms": finished_at_ms,
                    "last_error": report_error,
                    "last_constraint": None,
                    "consecutive_failures": int(health["consecutive_failures"]) + 1,
                    "total_runs": int(health["total_runs"]) + 1,
                    "total_failures": int(health["total_failures"]) + 1,
                })
                _publish_auto_gc_health(data_manager, health)
                continue
            health.update({
                "status": "running",
                "last_finished_at_ms": finished_at_ms,
                "last_completed_at_ms": finished_at_ms,
                "last_success_at_ms": finished_at_ms,
                "last_constraint": None,
                "last_error": None,
                "consecutive_failures": 0,
                "total_runs": int(health["total_runs"]) + 1,
            })
            _publish_auto_gc_health(data_manager, health)
    except asyncio.CancelledError:
        health["status"] = "stopping"
    finally:
        health["status"] = "stopped"
        health["task_alive"] = False
        health["stopped_at_ms"] = int(time.time() * 1000)
        _publish_auto_gc_health(data_manager, health)
