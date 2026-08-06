"""Read-only multi-chart capacity diagnostics.

The capacity view intentionally composes existing component snapshots instead
of introducing a second lifecycle owner.  It may inspect the configured K-line
SQLite database through a read-only connection, but never creates, checkpoints,
or mutates database state.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from app.core.config import KLINES_DB_PATH
from app.core.executors import executors_snapshot


BACKEND_CAPACITY_SCHEMA_VERSION = "candlescope.backend.capacity/1"


def _component_snapshot(component: Any) -> dict[str, Any] | None:
    if component is None:
        return None
    snapshot = getattr(component, "snapshot", None)
    if not callable(snapshot):
        return None
    value = snapshot()
    return value if isinstance(value, dict) else None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _database_snapshot(path: Path, *, include_hash: bool) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    result: dict[str, Any] = {
        "path": str(resolved),
        "exists": resolved.exists(),
        "state": "missing",
        "sizeBytes": resolved.stat().st_size if resolved.exists() else 0,
        "rowCount": 0,
        "seriesCount": 0,
        "earliestOpenTimeMs": None,
        "latestOpenTimeMs": None,
        "sha256": None,
        "hashConsistency": "not_requested",
        "files": [],
    }
    if not resolved.exists():
        return result

    try:
        uri = f"{resolved.as_uri()}?mode=ro"
        with sqlite3.connect(uri, uri=True, timeout=5) as connection:
            connection.execute("PRAGMA query_only = ON")
            row = connection.execute(
                "SELECT COUNT(*), COUNT(DISTINCT exchange || ':' || market_type || ':' || symbol || ':' || interval), "
                "MIN(open_time), MAX(open_time) FROM klines"
            ).fetchone()
        if row is not None:
            result.update({
                "rowCount": int(row[0] or 0),
                "seriesCount": int(row[1] or 0),
                "earliestOpenTimeMs": int(row[2]) if row[2] is not None else None,
                "latestOpenTimeMs": int(row[3]) if row[3] is not None else None,
            })
        result["state"] = "warm" if result["rowCount"] else "empty"
    except (sqlite3.Error, OSError) as exc:
        result["state"] = "unreadable"
        result["error"] = str(exc)

    if not include_hash:
        return result

    file_snapshots: list[dict[str, Any]] = []
    for candidate in (resolved, Path(f"{resolved}-wal"), Path(f"{resolved}-shm")):
        if not candidate.exists():
            continue
        try:
            file_snapshots.append({
                "name": candidate.name,
                "sizeBytes": candidate.stat().st_size,
                "sha256": _sha256_file(candidate),
            })
        except OSError as exc:
            file_snapshots.append({"name": candidate.name, "error": str(exc)})
    canonical = json.dumps(file_snapshots, sort_keys=True, separators=(",", ":"))
    result["files"] = file_snapshots
    result["sha256"] = f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"
    result["hashConsistency"] = (
        "live_sqlite_file_set" if any(item["name"].endswith("-wal") for item in file_snapshots)
        else "single_file_snapshot"
    )
    return result


def _dedicated_upstream_websockets(ingress: dict[str, Any] | None) -> int:
    if not isinstance(ingress, dict):
        return 0
    pipelines = ingress.get("pipelines")
    if not isinstance(pipelines, dict):
        return 0
    total = 0
    for pipeline in pipelines.values():
        if not isinstance(pipeline, dict):
            continue
        feed = pipeline.get("feed_control")
        if not isinstance(feed, dict) or feed.get("mode") != "websocket":
            continue
        session = feed.get("session")
        if not isinstance(session, dict):
            continue
        if session.get("layer") == "L2_SharedSession":
            continue
        if session.get("health") == "connected":
            total += 1
    return total


async def build_capacity_snapshot(
    state: Any,
    *,
    include_database_hash: bool = False,
) -> dict[str, Any]:
    """Compose a stable capacity snapshot from application-owned runtimes."""

    generated_at_ms = int(time.time() * 1000)
    errors: list[dict[str, str]] = []

    data_manager = getattr(state, "data_manager", None)
    try:
        manager_snapshot = _component_snapshot(data_manager)
    except Exception as exc:  # diagnostics isolate component failures
        manager_snapshot = None
        errors.append({"component": "data_manager", "error": str(exc)})

    runtime = getattr(state, "data_engine_runtime", None)
    backfill = getattr(runtime, "backfill_coordinator", None)
    try:
        if backfill is not None and callable(getattr(backfill, "snapshot_async", None)):
            backfill_snapshot = await backfill.snapshot_async()
        else:
            backfill_snapshot = _component_snapshot(backfill)
    except Exception as exc:
        backfill_snapshot = None
        errors.append({"component": "backfill", "error": str(exc)})

    ingestion_factory = getattr(runtime, "ingestion_factory", None)
    try:
        ingestion_factory_snapshot = _component_snapshot(ingestion_factory)
    except Exception as exc:
        ingestion_factory_snapshot = None
        errors.append({"component": "exchange_ingestion", "error": str(exc)})

    try:
        indicator_engine = _component_snapshot(getattr(state, "indicator_engine", None))
    except Exception as exc:
        indicator_engine = None
        errors.append({"component": "indicator_engine", "error": str(exc)})
    try:
        indicator_range = _component_snapshot(
            getattr(state, "indicator_range_service", None)
        )
    except Exception as exc:
        indicator_range = None
        errors.append({"component": "indicator_range", "error": str(exc)})
    try:
        indicator_runtime = _component_snapshot(
            getattr(state, "indicator_runtime_service", None)
        )
    except Exception as exc:
        indicator_runtime = None
        errors.append({"component": "indicator_runtime", "error": str(exc)})

    coordinator = (manager_snapshot or {}).get("coordinator") or {}
    event_bus = (manager_snapshot or {}).get("event_bus") or {}
    cache = (manager_snapshot or {}).get("cache") or {}
    streams = coordinator.get("streams") if isinstance(coordinator, dict) else []
    streams = streams if isinstance(streams, list) else []
    direct_by_key = (
        event_bus.get("direct_subscriptions_by_key", {})
        if isinstance(event_bus, dict)
        else {}
    )
    direct_by_key = direct_by_key if isinstance(direct_by_key, dict) else {}

    ingress = (
        ingestion_factory_snapshot.get("ingress")
        if isinstance(ingestion_factory_snapshot, dict)
        else None
    )
    shared_ws = ingress.get("shared_ws") if isinstance(ingress, dict) else None
    shared_physical = (
        int(shared_ws.get("physical_websockets", 0))
        if isinstance(shared_ws, dict)
        else 0
    )
    dedicated_physical = _dedicated_upstream_websockets(ingress)

    lag_monitor = getattr(state, "event_loop_lag_monitor", None)
    try:
        event_loop_lag = _component_snapshot(lag_monitor)
    except Exception as exc:
        event_loop_lag = None
        errors.append({"component": "event_loop_lag", "error": str(exc)})

    database = await asyncio.to_thread(
        _database_snapshot,
        Path(KLINES_DB_PATH),
        include_hash=include_database_hash,
    )

    active_backfills = (
        len(backfill_snapshot.get("active", []))
        if isinstance(backfill_snapshot, dict)
        and isinstance(backfill_snapshot.get("active"), list)
        else 0
    )
    pending_backfills = (
        len(backfill_snapshot.get("pending", []))
        if isinstance(backfill_snapshot, dict)
        and isinstance(backfill_snapshot.get("pending"), list)
        else 0
    )

    return {
        "schemaVersion": BACKEND_CAPACITY_SCHEMA_VERSION,
        "generatedAtMs": generated_at_ms,
        "readOnly": True,
        "ok": not errors,
        "errors": errors,
        "database": database,
        "dataManager": {
            "activeSeries": len(streams),
            "streamLeases": sum(
                int(value) for value in direct_by_key.values()
                if isinstance(value, (int, float))
            ),
            "logicalSubscribers": int(event_bus.get("callback_subscriptions", 0))
            + int(event_bus.get("queue_subscriptions", 0)),
            "cacheSeries": int(cache.get("total_series", 0)),
            "cacheBars": int(cache.get("total_bars", 0)),
            "directSubscriptionsBySeries": direct_by_key,
            "streams": streams,
            "eventBus": event_bus,
        },
        "backfill": {
            "activeRequests": active_backfills,
            "pendingRequests": pending_backfills,
            "runningChunks": int((backfill_snapshot or {}).get("running_chunks", 0)),
            "readyChunks": int((backfill_snapshot or {}).get("ready_chunks", 0)),
            "snapshot": backfill_snapshot,
        },
        "executors": executors_snapshot(),
        "indicators": {
            "activeInstances": int((indicator_engine or {}).get("instance_count", 0)),
            "streamSubscriptions": int((indicator_engine or {}).get("stream_count", 0)),
            "engine": indicator_engine,
            "rangeCache": indicator_range,
            "runtimeRouting": indicator_runtime,
        },
        "exchange": {
            "physicalWebSockets": shared_physical + dedicated_physical,
            "sharedPhysicalWebSockets": shared_physical,
            "dedicatedPhysicalWebSockets": dedicated_physical,
            "ingestion": ingestion_factory_snapshot,
        },
        "runtime": {
            "eventLoopLag": event_loop_lag,
        },
    }


__all__ = ["BACKEND_CAPACITY_SCHEMA_VERSION", "build_capacity_snapshot"]
