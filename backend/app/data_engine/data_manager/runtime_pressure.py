"""Runtime pressure probes used by cache GC dry-runs."""

from __future__ import annotations

import ctypes
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def process_memory_snapshot() -> dict[str, Any]:
    """Return best-effort process memory pressure without optional deps."""
    if sys.platform == "win32":
        snapshot = _windows_process_memory()
        if snapshot.get("available"):
            return snapshot
    return _posix_process_memory()


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


def storage_file_snapshot(path: str | Path) -> dict[str, Any]:
    """Return one coherent best-effort snapshot of a SQLite file set.

    Physical file bytes, WAL bytes, and SQLite's logical page usage are kept
    separate on purpose.  A normal ``DELETE`` can increase freelist pages
    without shrinking the main database file, while a WAL checkpoint can
    reclaim WAL bytes without deleting any logical rows.
    """
    db_path = Path(path)
    wal_path = Path(f"{db_path}-wal")
    shm_path = Path(f"{db_path}-shm")
    db_size = _safe_file_size(db_path)
    wal_size = _safe_file_size(wal_path)
    shm_size = _safe_file_size(shm_path)
    page_size = 0
    page_count = 0
    freelist_count = 0
    page_metrics_available = False
    page_metrics_error: str | None = None
    owner_attribution_available = False
    owner_attribution_error: str | None = None
    klines_managed_bytes = 0
    unmanaged_bytes = 0
    attributed_bytes = 0
    managed_objects: list[str] = []
    data_version_before = 0
    data_version_after = 0

    if db_path.exists():
        try:
            uri = f"{db_path.resolve().as_uri()}?mode=ro"
            with sqlite3.connect(uri, uri=True, timeout=2.0) as conn:
                conn.execute("PRAGMA query_only=ON")
                data_version_before = int(
                    conn.execute("PRAGMA data_version").fetchone()[0] or 0
                )
                conn.execute("BEGIN")
                page_size = int(conn.execute("PRAGMA page_size").fetchone()[0] or 0)
                page_count = int(conn.execute("PRAGMA page_count").fetchone()[0] or 0)
                freelist_count = int(
                    conn.execute("PRAGMA freelist_count").fetchone()[0] or 0
                )
                page_metrics_available = page_size > 0
                try:
                    managed_objects = sorted(
                        {
                            str(row[0])
                            for row in conn.execute(
                                "SELECT name FROM sqlite_schema "
                                "WHERE name = 'klines' "
                                "OR (type = 'index' AND tbl_name = 'klines')"
                            )
                            if row[0]
                        }
                    )
                    page_owners = [
                        (str(row[0]), int(row[1] or 0))
                        for row in conn.execute(
                            "SELECT name, SUM(pgsize) FROM dbstat GROUP BY name"
                        )
                    ]
                    attributed_bytes = sum(size for _, size in page_owners)
                    managed_names = set(managed_objects)
                    klines_managed_bytes = sum(
                        size for name, size in page_owners if name in managed_names
                    )
                    owner_attribution_available = True
                except sqlite3.Error as exc:
                    owner_attribution_error = str(exc)
                conn.rollback()
                data_version_after = int(
                    conn.execute("PRAGMA data_version").fetchone()[0] or 0
                )
        except (OSError, sqlite3.Error, TypeError, ValueError) as exc:
            page_metrics_error = str(exc)

    db_size_after = _safe_file_size(db_path)
    wal_size_after = _safe_file_size(wal_path)
    shm_size_after = _safe_file_size(shm_path)
    file_set_stable = (db_size, wal_size, shm_size) == (
        db_size_after,
        wal_size_after,
        shm_size_after,
    ) and data_version_before == data_version_after
    db_size = db_size_after
    wal_size = wal_size_after
    shm_size = shm_size_after
    physical_size = db_size + wal_size
    allocated = page_count * page_size if page_metrics_available else 0
    logical_used = (
        max(0, page_count - freelist_count) * page_size if page_metrics_available else 0
    )
    reclaimable = max(0, freelist_count) * page_size if page_metrics_available else 0
    unmanaged_bytes = (
        max(0, logical_used - klines_managed_bytes)
        if owner_attribution_available
        else 0
    )
    # A checkpoint can grow the main DB when the WAL contains newly allocated
    # pages.  Compare the current file set with SQLite's logical page count
    # instead of assuming the whole WAL is reclaimable.
    checkpoint_reclaimable = (
        max(0, physical_size - allocated) if page_metrics_available else 0
    )
    return {
        "captured_at_ms": int(time.time() * 1000),
        "path": str(db_path),
        "exists": db_path.exists(),
        "file_set_stable": file_set_stable,
        "data_version_before": data_version_before,
        "data_version_after": data_version_after,
        "db_size_bytes": db_size,
        "wal_size_bytes": wal_size,
        "shm_size_bytes": shm_size,
        # Physical retention pressure excludes SHM.  SHM is transient shared
        # memory bookkeeping and is still reported via total_size_bytes for
        # compatibility with existing diagnostics.
        "physical_size_bytes": physical_size,
        "total_size_bytes": physical_size + shm_size,
        "page_metrics_available": page_metrics_available,
        "page_size_bytes": page_size,
        "page_count": page_count,
        "freelist_count": freelist_count,
        "logical_allocated_bytes": allocated,
        "logical_used_bytes": logical_used,
        "reclaimable_bytes": reclaimable,
        "owner_attribution_available": owner_attribution_available,
        "owner_attribution_error": owner_attribution_error,
        "klines_managed_objects": managed_objects,
        "klines_managed_bytes": klines_managed_bytes,
        "unmanaged_bytes": unmanaged_bytes,
        "dbstat_attributed_bytes": attributed_bytes,
        "dbstat_unattributed_bytes": (
            max(0, logical_used - attributed_bytes)
            if owner_attribution_available
            else 0
        ),
        "post_checkpoint_db_estimate_bytes": allocated,
        "checkpoint_reclaimable_available": page_metrics_available,
        "checkpoint_reclaimable_bytes": checkpoint_reclaimable,
        "compacted_db_estimate_bytes": logical_used,
        "page_metrics_error": page_metrics_error,
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
    db_size = int(files.get("db_size_bytes", 0) or 0)
    wal_size = int(files.get("wal_size_bytes", 0) or 0)
    shm_size = int(files.get("shm_size_bytes", 0) or 0)
    physical_size = int(files.get("physical_size_bytes", db_size + wal_size) or 0)
    # Older callers only supplied total_size_bytes.  Preserve compatibility
    # without treating SHM as logically reclaimable data when component sizes
    # are available.
    if physical_size <= 0 and not (db_size or wal_size):
        physical_size = int(files.get("total_size_bytes", 0) or 0)
    reclaimable = int(files.get("reclaimable_bytes", 0) or 0)
    logical_used = int(files.get("logical_used_bytes", 0) or 0)
    logical_allocated = int(files.get("logical_allocated_bytes", 0) or 0)
    page_metrics_available = bool(files.get("page_metrics_available", False))
    file_set_stable = bool(files.get("file_set_stable", True))
    checkpoint_reclaimable_available = bool(
        files.get("checkpoint_reclaimable_available", page_metrics_available)
    )
    checkpoint_reclaimable = int(
        files.get(
            "checkpoint_reclaimable_bytes",
            max(0, physical_size - logical_allocated) if page_metrics_available else 0,
        )
        or 0
    )
    owner_attribution_available = bool(files.get("owner_attribution_available", False))
    klines_managed = int(files.get("klines_managed_bytes", 0) or 0)
    unmanaged = int(files.get("unmanaged_bytes", 0) or 0)
    compacted_db = int(
        files.get(
            "compacted_db_estimate_bytes",
            logical_used if page_metrics_available else max(0, db_size - reclaimable),
        )
        or 0
    )
    budget = int(sqlite_budget_bytes or 0)
    sqlite_target = int(budget * sqlite_bytes_target_ratio) if budget > 0 else 0
    sqlite_high = int(budget * sqlite_bytes_high_ratio) if budget > 0 else 0
    sqlite_critical = int(budget * sqlite_bytes_critical_ratio) if budget > 0 else 0
    free_ratio = float(disk.get("free_ratio", 1) if disk.get("available") else 1)
    budget_usage_ratio = physical_size / budget if budget > 0 else 0
    over_budget_bytes = max(0, physical_size - budget) if budget > 0 else 0
    level = "unconfigured"
    if budget <= 0:
        level = "unconfigured"
    elif physical_size >= budget:
        level = "over_budget"
    elif sqlite_critical and physical_size >= sqlite_critical:
        level = "critical"
    elif sqlite_high and physical_size >= sqlite_high:
        level = "high"
    else:
        level = "normal"
    required_physical_relief = (
        max(0, physical_size - sqlite_target)
        if budget > 0 and level in {"high", "critical", "over_budget"}
        else 0
    )
    relief_planning_available = required_physical_relief <= 0 or (
        file_set_stable and page_metrics_available and checkpoint_reclaimable_available
    )
    checkpoint_relief = (
        min(required_physical_relief, max(0, checkpoint_reclaimable))
        if relief_planning_available
        else 0
    )
    remaining_after_checkpoint = max(0, required_physical_relief - checkpoint_relief)
    compaction_relief = (
        min(remaining_after_checkpoint, max(0, reclaimable))
        if relief_planning_available
        else 0
    )
    required_logical_relief = (
        max(0, remaining_after_checkpoint - compaction_relief)
        if relief_planning_available
        else 0
    )
    planning_blocked_reason = None
    if not relief_planning_available:
        planning_blocked_reason = (
            "sqlite-file-set-changed-during-snapshot"
            if not file_set_stable
            else "sqlite-page-metrics-unavailable"
        )
    klines_relief_insufficient = bool(
        required_logical_relief > 0
        and owner_attribution_available
        and required_logical_relief > klines_managed
    )
    # Compatibility name retained for existing diagnostics.  The decision is
    # based on reachability, not on a simple unmanaged/managed majority: Kline
    # GC is allowed whenever its owned bytes can satisfy the required relief.
    unmanaged_pressure_dominant = klines_relief_insufficient
    klines_budget_planning_available = bool(
        relief_planning_available
        and (
            required_logical_relief <= 0
            or (owner_attribution_available and not klines_relief_insufficient)
        )
    )
    required_klines_relief = (
        min(required_logical_relief, max(0, klines_managed))
        if klines_budget_planning_available
        else 0
    )
    owner_relief_gap = max(
        0,
        required_logical_relief - required_klines_relief,
    )
    owner_planning_blocked_reason = None
    if required_logical_relief > 0 and not owner_attribution_available:
        owner_planning_blocked_reason = "sqlite-owner-attribution-unavailable"
    elif klines_relief_insufficient:
        owner_planning_blocked_reason = "insufficient-klines-owned-bytes-for-target"
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
        "sqlite_total_bytes": physical_size,
        "sqlite_physical_bytes": physical_size,
        "sqlite_db_file_bytes": db_size,
        "sqlite_wal_bytes": wal_size,
        "sqlite_shm_bytes": shm_size,
        "sqlite_logical_used_bytes": logical_used,
        "sqlite_logical_allocated_bytes": logical_allocated,
        "sqlite_reclaimable_bytes": reclaimable,
        "owner_attribution_available": owner_attribution_available,
        "klines_managed_bytes": klines_managed,
        "unmanaged_bytes": unmanaged,
        "sqlite_compacted_db_estimate_bytes": compacted_db,
        "target_bytes": sqlite_target,
        "budget_usage_ratio": budget_usage_ratio,
        "over_budget_bytes": over_budget_bytes,
        "disk_free_ratio": free_ratio,
        "disk_free_critical": free_ratio <= disk_free_critical_ratio,
        "required_physical_relief_bytes": required_physical_relief,
        "file_set_stable": file_set_stable,
        "relief_planning_available": relief_planning_available,
        "planning_blocked_reason": planning_blocked_reason,
        "checkpoint_reclaimable_available": checkpoint_reclaimable_available,
        "checkpoint_reclaimable_bytes": checkpoint_reclaimable,
        "checkpoint_relief_bytes": checkpoint_relief,
        "checkpoint_relief_unknown_bytes": (
            min(required_physical_relief, max(0, wal_size))
            if not relief_planning_available
            else 0
        ),
        "compaction_relief_bytes": compaction_relief,
        "required_logical_relief_bytes": required_logical_relief,
        "klines_budget_planning_available": klines_budget_planning_available,
        "owner_planning_blocked_reason": owner_planning_blocked_reason,
        "unmanaged_pressure_dominant": unmanaged_pressure_dominant,
        "klines_relief_insufficient": klines_relief_insufficient,
        "required_klines_relief_bytes": required_klines_relief,
        "owner_relief_gap_bytes": owner_relief_gap,
        "checkpoint_first": required_physical_relief > 0 and wal_size > 0,
        "physical_compaction_pending": (
            compaction_relief > 0 or required_logical_relief > 0
        ),
        "level": level,
    }


def _safe_file_size(path: Path) -> int:
    try:
        return int(path.stat().st_size) if path.exists() else 0
    except OSError:
        return 0


def _posix_process_memory() -> dict[str, Any]:
    """Return current RSS on POSIX hosts; never substitute a peak RSS value."""
    errors: list[str] = []
    if sys.platform.startswith("linux"):
        try:
            fields = Path("/proc/self/statm").read_text(encoding="ascii").split()
            resident_pages = int(fields[1])
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            rss_bytes = resident_pages * page_size
            if rss_bytes > 0:
                return {
                    "available": True,
                    "source": "linux./proc/self/statm",
                    "rss_bytes": rss_bytes,
                }
            errors.append("/proc/self/statm returned zero RSS")
        except (IndexError, OSError, TypeError, ValueError) as exc:
            errors.append(f"/proc/self/statm: {exc}")

    # macOS and other POSIX hosts expose current resident size through ps.
    # Keep this as a bounded fallback rather than feeding ru_maxrss (a lifetime
    # peak) into the automatic GC hard-pressure decision.
    try:
        result = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(os.getpid())],
            check=True,
            capture_output=True,
            text=True,
            timeout=1.0,
        )
        rss_kib = int(result.stdout.strip().split()[0])
        rss_bytes = rss_kib * 1024
        if rss_bytes > 0:
            return {
                "available": True,
                "source": "posix.ps-rss",
                "rss_bytes": rss_bytes,
            }
        errors.append("ps returned zero RSS")
    except (
        IndexError,
        OSError,
        subprocess.SubprocessError,
        TypeError,
        ValueError,
    ) as exc:
        errors.append(f"ps: {exc}")

    peak_rss_bytes = 0
    try:
        import resource

        peak_value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        peak_rss_bytes = peak_value if sys.platform == "darwin" else peak_value * 1024
    except (ImportError, OSError, TypeError, ValueError) as exc:
        errors.append(f"resource.ru_maxrss: {exc}")
    return {
        "available": False,
        "source": "unavailable",
        "error": "; ".join(errors) or "process memory probe unavailable",
        "peak_rss_bytes": max(0, peak_rss_bytes),
    }


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
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        get_current_process = ctypes.WINFUNCTYPE(
            ctypes.c_void_p,
            use_last_error=True,
        )(("GetCurrentProcess", kernel32))
        get_process_memory_info = ctypes.WINFUNCTYPE(
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
            ctypes.c_ulong,
            use_last_error=True,
        )(("GetProcessMemoryInfo", psapi))
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        handle = get_current_process()
        ok = get_process_memory_info(
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
