"""Runtime pressure probes used by cache GC dry-runs."""
from __future__ import annotations

import ctypes
import os
import shutil
import sys
from pathlib import Path
from typing import Any


def process_memory_snapshot() -> dict[str, Any]:
    """Return best-effort process memory pressure without optional deps."""
    if sys.platform == "win32":
        snapshot = _windows_process_memory()
        if snapshot.get("available"):
            return snapshot
    try:
        rss_bytes = int(getattr(os, "getpid", lambda: 0)() and _unix_rss_bytes())
    except Exception as exc:
        return {
            "available": False,
            "source": "unavailable",
            "error": str(exc),
        }
    if rss_bytes <= 0:
        return {
            "available": False,
            "source": "unavailable",
            "error": "process memory probe unavailable",
        }
    return {
        "available": True,
        "source": "resource.ru_maxrss",
        "rss_bytes": rss_bytes,
    }


def disk_pressure_snapshot(path: str | Path) -> dict[str, Any]:
    """Return disk usage for the filesystem containing *path*."""
    target = Path(path)
    probe = target if target.exists() else target.parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError as exc:
        return {
            "available": False,
            "source": "shutil.disk_usage",
            "path": str(probe),
            "error": str(exc),
        }
    used = int(usage.used)
    total = int(usage.total)
    free = int(usage.free)
    used_ratio = used / total if total > 0 else 0
    free_ratio = free / total if total > 0 else 0
    return {
        "available": True,
        "source": "shutil.disk_usage",
        "path": str(probe),
        "total_bytes": total,
        "used_bytes": used,
        "free_bytes": free,
        "used_ratio": used_ratio,
        "free_ratio": free_ratio,
    }


def build_storage_watermarks(
    *,
    storage_files: dict[str, Any] | None = None,
    disk: dict[str, Any] | None = None,
    sqlite_budget_bytes: int | None = None,
    sqlite_bytes_target_ratio: float = 0.80,
    sqlite_bytes_high_ratio: float = 0.85,
    sqlite_bytes_critical_ratio: float = 0.95,
    disk_free_critical_ratio: float = 0.10,
) -> dict[str, Any]:
    """Build budget-based high/critical watermarks for SQLite GC dry-run scoring."""
    files = storage_files or {}
    disk = disk or {}
    total_size = int(files.get("total_size_bytes", 0) or 0)
    budget = int(sqlite_budget_bytes or 0)
    sqlite_target = int(budget * sqlite_bytes_target_ratio) if budget > 0 else 0
    sqlite_high = int(budget * sqlite_bytes_high_ratio) if budget > 0 else 0
    sqlite_critical = int(budget * sqlite_bytes_critical_ratio) if budget > 0 else 0
    free_ratio = float(disk.get("free_ratio", 1) if disk.get("available") else 1)
    budget_usage_ratio = total_size / budget if budget > 0 else 0
    over_budget_bytes = max(0, total_size - budget) if budget > 0 else 0
    level = "unconfigured"
    if budget <= 0:
        level = "unconfigured"
    elif total_size >= budget:
        level = "over_budget"
    elif sqlite_critical and total_size >= sqlite_critical:
        level = "critical"
    elif sqlite_high and total_size >= sqlite_high:
        level = "high"
    else:
        level = "normal"
    return {
        "sqlite_budget_bytes": budget,
        "budget_bytes": budget,
        "sqlite_bytes_target_ratio": sqlite_bytes_target_ratio,
        "sqlite_bytes_high_ratio": sqlite_bytes_high_ratio,
        "sqlite_bytes_critical_ratio": sqlite_bytes_critical_ratio,
        "disk_free_critical_ratio": disk_free_critical_ratio,
        "sqlite_bytes_target": sqlite_target,
        "sqlite_bytes_high": sqlite_high,
        "sqlite_bytes_critical": sqlite_critical,
        "sqlite_total_bytes": total_size,
        "target_bytes": sqlite_target,
        "budget_usage_ratio": budget_usage_ratio,
        "over_budget_bytes": over_budget_bytes,
        "disk_free_ratio": free_ratio,
        "disk_free_critical": free_ratio <= disk_free_critical_ratio,
        "level": level,
    }


def _unix_rss_bytes() -> int:
    import resource

    value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    # Linux reports KB, macOS reports bytes. This app is mostly Windows/Linux.
    return value * 1024 if value < 10 * 1024 * 1024 else value


def _windows_process_memory() -> dict[str, Any]:
    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    try:
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(
            handle,
            ctypes.byref(counters),
            counters.cb,
        )
        if not ok:
            raise OSError("GetProcessMemoryInfo failed")
        return {
            "available": True,
            "source": "windows.GetProcessMemoryInfo",
            "rss_bytes": int(counters.WorkingSetSize),
            "peak_rss_bytes": int(counters.PeakWorkingSetSize),
            "pagefile_bytes": int(counters.PagefileUsage),
        }
    except Exception as exc:
        return {
            "available": False,
            "source": "windows.GetProcessMemoryInfo",
            "error": str(exc),
        }
