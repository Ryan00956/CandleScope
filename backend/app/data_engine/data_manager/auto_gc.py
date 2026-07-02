"""Conservative automatic GC orchestration for DataManager caches."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.config import DATA_DIR
from app.core.executors import run_storage

from .gc import execute_memory_gc_plan
from .maintenance import MaintenanceBusyError, MaintenanceUnavailableError

logger = logging.getLogger("data_manager.auto_gc")


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
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
    never_evict_active_within_ms: int = 10 * 60_000
    never_evict_accessed_within_ms: int = 2 * 60_000
    storage_batch_size: int = 2_000
    sqlite_auto_vacuum: bool = False
    audit_path: Path = DATA_DIR / "cache_gc_audit.jsonl"

    @classmethod
    def from_env(cls) -> "AutoGcPolicy":
        return cls(
            enabled=_env_bool("CANDLESCOPE_AUTO_GC_ENABLED", True),
            mode=os.getenv("CANDLESCOPE_AUTO_GC_MODE", "conservative").strip() or "conservative",
            cooldown_ms=max(10_000, _env_int("CANDLESCOPE_AUTO_GC_COOLDOWN_MS", 60_000)),
            max_bytes_per_run=max(1, _env_int("CANDLESCOPE_AUTO_GC_MAX_BYTES", 32 * 1024 * 1024)),
            max_entries_per_run=max(1, _env_int("CANDLESCOPE_AUTO_GC_MAX_ENTRIES", 200)),
            min_final_evict_score=float(os.getenv("CANDLESCOPE_AUTO_GC_MIN_SCORE", "70")),
            never_evict_active_within_ms=max(
                0,
                _env_int("CANDLESCOPE_AUTO_GC_NEVER_ACTIVE_MS", 10 * 60_000),
            ),
            never_evict_accessed_within_ms=max(
                0,
                _env_int("CANDLESCOPE_AUTO_GC_NEVER_ACCESSED_MS", 2 * 60_000),
            ),
            storage_batch_size=max(1, _env_int("CANDLESCOPE_AUTO_GC_STORAGE_BATCH", 2_000)),
            sqlite_auto_vacuum=_env_bool("CANDLESCOPE_AUTO_GC_SQLITE_VACUUM", False),
        )

    @classmethod
    def from_mapping(cls, values: dict[str, Any] | None = None) -> "AutoGcPolicy":
        base = cls.from_env()
        values = values or {}
        return cls(
            enabled=bool(values.get("enabled", base.enabled)),
            mode=str(values.get("mode", base.mode) or "conservative"),
            cooldown_ms=max(10_000, int(values.get("cooldown_ms", base.cooldown_ms))),
            max_bytes_per_run=max(1, int(values.get("max_bytes_per_run", base.max_bytes_per_run))),
            max_entries_per_run=max(1, int(values.get("max_entries_per_run", base.max_entries_per_run))),
            min_final_evict_score=float(values.get("min_final_evict_score", base.min_final_evict_score)),
            never_evict_active_within_ms=max(
                0,
                int(values.get("never_evict_active_within_ms", base.never_evict_active_within_ms)),
            ),
            never_evict_accessed_within_ms=max(
                0,
                int(values.get("never_evict_accessed_within_ms", base.never_evict_accessed_within_ms)),
            ),
            storage_batch_size=max(1, int(values.get("storage_batch_size", base.storage_batch_size))),
            sqlite_auto_vacuum=bool(values.get("sqlite_auto_vacuum", base.sqlite_auto_vacuum)),
            audit_path=Path(values.get("audit_path", base.audit_path)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "cooldown_ms": self.cooldown_ms,
            "max_bytes_per_run": self.max_bytes_per_run,
            "max_entries_per_run": self.max_entries_per_run,
            "min_final_evict_score": self.min_final_evict_score,
            "never_evict_active_within_ms": self.never_evict_active_within_ms,
            "never_evict_accessed_within_ms": self.never_evict_accessed_within_ms,
            "storage_batch_size": self.storage_batch_size,
            "sqlite_auto_vacuum": self.sqlite_auto_vacuum,
            "audit_path": str(self.audit_path),
        }


def _score(victim: dict[str, Any]) -> float:
    return float((victim.get("scores") or {}).get("finalEvictScore", 0) or 0)


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
    return used + next_bytes <= policy.max_bytes_per_run or not selected


def filter_auto_memory_plan(plan: dict[str, Any], policy: AutoGcPolicy) -> dict[str, Any]:
    """Keep only high-confidence memory victims from a smart dry-run plan."""
    now_ms = int(time.time() * 1000)
    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for victim in plan.get("victims", []) or []:
        reason = ""
        if victim.get("active") or victim.get("subscribed"):
            reason = "active-or-subscribed"
        elif _recently_accessed(victim, now_ms, policy):
            reason = "recently-accessed"
        elif _score(victim) < policy.min_final_evict_score:
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
    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for victim in plan.get("series", []) or []:
        flags = set(victim.get("risk_flags") or [])
        reason = ""
        if level == "unconfigured":
            reason = "watermark-unconfigured"
        elif level not in {"high", "critical", "over_budget"}:
            reason = "watermark-normal"
        elif "active-or-subscribed" in flags:
            reason = "active-or-subscribed"
        elif "storage-intent" in flags:
            reason = "storage-intent"
        elif "custom-interval" in flags:
            reason = "custom-interval"
        elif _score(victim) < policy.min_final_evict_score:
            reason = "score-below-threshold"
        elif not _within_limits(selected, victim, policy):
            reason = "per-run-limit"

        if reason:
            skipped.append({"key": victim.get("key"), "reason": reason, "score": _score(victim)})
            continue
        selected.append(victim)

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
        "vacuum_recommended": False,
    }


def append_auto_gc_audit(report: dict[str, Any], policy: AutoGcPolicy) -> None:
    """Append a compact JSONL audit record for autonomous GC decisions."""
    try:
        policy.audit_path.parent.mkdir(parents=True, exist_ok=True)
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
                "skipped": len(((report.get("storage_plan") or {}).get("autoSkipped")) or []),
                "watermark": ((report.get("storage_plan") or {}).get("watermarks") or {}).get("level"),
            },
        }
        with open(policy.audit_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n")
    except Exception as exc:
        logger.debug("auto GC audit append failed: %s", exc)


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

    memory_dry_run = await run_storage(data_manager.plan_memory_gc)
    memory_plan = filter_auto_memory_plan(memory_dry_run, effective_policy)
    memory_result = await run_storage(
        execute_memory_gc_plan,
        data_manager,
        memory_plan,
    ) if memory_plan.get("victims") else {
        **memory_plan,
        "mode": "execute",
        "removed_series": 0,
        "trimmed_series": 0,
        "removed_bars": 0,
        "removed_estimated_bytes": 0,
        "results": [],
    }

    storage_result: dict[str, Any] | None = None
    storage_plan: dict[str, Any] | None = None
    try:
        storage_dry_run = await run_storage(data_manager.plan_storage_gc)
        storage_plan = filter_auto_storage_plan(storage_dry_run, effective_policy)
        if storage_plan.get("series"):
            storage_result = await data_manager.maintenance.run_storage_gc(
                plan=storage_plan,
                batch_size=effective_policy.storage_batch_size,
            )
        else:
            storage_result = {
                **storage_plan,
                "mode": "execute",
                "status": "skipped",
                "deleted_rows": 0,
                "affected_series": 0,
                "results": [],
            }
    except (MaintenanceBusyError, MaintenanceUnavailableError) as exc:
        storage_result = {
            "mode": "execute",
            "status": "skipped",
            "reason": str(exc),
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
            "deleted_rows": 0,
            "affected_series": 0,
            "results": [],
        }

    report = {
        "mode": "auto-gc",
        "status": "ok" if storage_result.get("status") != "error" else "partial",
        "started_at_ms": started_at_ms,
        "elapsed_ms": int(time.time() * 1000) - started_at_ms,
        "policy": effective_policy.to_dict(),
        "memory_plan": memory_plan,
        "memory": memory_result,
        "storage_plan": storage_plan,
        "storage": storage_result,
    }
    await run_storage(append_auto_gc_audit, report, effective_policy)
    logger.info(
        "auto GC pass: memory_bars=%s storage_rows=%s",
        memory_result.get("removed_bars", 0),
        storage_result.get("deleted_rows", 0),
    )
    return report


async def auto_gc_loop(data_manager: Any, policy: AutoGcPolicy | None = None) -> None:
    """Run conservative automatic GC until cancelled."""
    effective_policy = policy or AutoGcPolicy.from_env()
    try:
        while True:
            await asyncio.sleep(effective_policy.cooldown_ms / 1000)
            report = await run_auto_gc_once(data_manager, effective_policy)
            setattr(data_manager, "_auto_gc_last_report", report)
    except asyncio.CancelledError:
        pass
