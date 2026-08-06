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

from app.core import config
from app.core.config import KLINES_DB_PATH
from app.core.executors import executors_snapshot


BACKEND_CAPACITY_SCHEMA_VERSION = "candlescope.backend.capacity/1"
_MAX_CAPACITY_DETAIL_LIMIT = 100


def _detail_window(offset: int, limit: int) -> tuple[int, int]:
    return max(0, int(offset)), min(_MAX_CAPACITY_DETAIL_LIMIT, max(0, int(limit)))


def _page_list(value: Any, *, offset: int, limit: int) -> tuple[list[Any], int]:
    items = value if isinstance(value, list) else []
    return items[offset:offset + limit], len(items)


def _page_mapping(value: Any, *, offset: int, limit: int) -> tuple[dict[str, Any], int]:
    mapping = value if isinstance(value, dict) else {}
    ordered = sorted(mapping.items(), key=lambda item: str(item[0]))
    return dict(ordered[offset:offset + limit]), len(ordered)


def _event_bus_summary(event_bus: dict[str, Any]) -> dict[str, Any]:
    callback_lag = event_bus.get("callback_lag")
    queue_lag = event_bus.get("queue_lag")
    callback_lag = callback_lag if isinstance(callback_lag, dict) else {}
    queue_lag = queue_lag if isinstance(queue_lag, dict) else {}

    def _queue_totals(lag: dict[str, Any]) -> tuple[int, int, int]:
        snapshots = [value for value in lag.values() if isinstance(value, dict)]
        depths = [max(0, int(value.get("queue_size", 0))) for value in snapshots]
        capacities = [
            max(0, int(value.get("queue_max_size", 0))) for value in snapshots
        ]
        return sum(depths), sum(capacities), max(depths, default=0)

    callback_depth, callback_capacity, callback_max_depth = _queue_totals(callback_lag)
    iterator_depth, iterator_capacity, iterator_max_depth = _queue_totals(queue_lag)
    return {
        "callbackSubscriptions": int(event_bus.get("callback_subscriptions", 0)),
        "queueSubscriptions": int(event_bus.get("queue_subscriptions", 0)),
        "middlewareCount": int(event_bus.get("middleware_count", 0)),
        "eventsEmitted": int(event_bus.get("events_emitted", 0)),
        "eventsDropped": int(event_bus.get("events_dropped", 0)),
        "callbackErrors": int(event_bus.get("callback_errors", 0)),
        "callbackQueuesObserved": len(callback_lag),
        "callbackQueueDepth": callback_depth,
        "callbackQueueCapacity": callback_capacity,
        "callbackQueueMaxDepth": callback_max_depth,
        "iteratorQueuesObserved": len(queue_lag),
        "iteratorQueueDepth": iterator_depth,
        "iteratorQueueCapacity": iterator_capacity,
        "iteratorQueueMaxDepth": iterator_max_depth,
    }


def _backfill_summary(snapshot: dict[str, Any] | None) -> dict[str, Any]:
    source = snapshot or {}
    return {
        key: value
        for key, value in source.items()
        if key not in {
            "active",
            "pending",
            "deferred",
            "buckets",
            "scheduler_buckets",
            "coverage",
            "recent_outcomes",
        }
    }


def _indicator_summary(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(snapshot, dict):
        return None
    return {key: value for key, value in snapshot.items() if key != "instances"}


def _process_memory_summary(runtime_pressure: Any) -> dict[str, Any] | None:
    if not isinstance(runtime_pressure, dict):
        return None
    source = runtime_pressure.get("processMemory")
    if not isinstance(source, dict):
        return None
    return {
        "available": source.get("available") is True,
        "source": source.get("source"),
        "rssBytes": int(source.get("rss_bytes", 0) or 0),
        "peakRssBytes": int(source.get("peak_rss_bytes", 0) or 0),
        # GetProcessMemoryInfo.PagefileUsage is the process commit/private-bytes
        # measurement used by the Windows release gate.
        "privateBytes": int(source.get("pagefile_bytes", 0) or 0),
        **({"error": str(source["error"])} if source.get("error") else {}),
    }


def _ingestion_summary(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(snapshot, dict):
        return None
    ingress = snapshot.get("ingress")
    if not isinstance(ingress, dict):
        return {key: value for key, value in snapshot.items() if key != "ingress"}
    transport = ingress.get("transport")
    transport_summary = None
    if isinstance(transport, dict):
        rate_limits = transport.get("exchange_rate_limits")
        transport_summary = {
            **{
                key: value
                for key, value in transport.items()
                if key != "exchange_rate_limits"
            },
            "exchange_rate_limit_count": len(rate_limits)
            if isinstance(rate_limits, dict) else 0,
        }
    return {
        **{key: value for key, value in snapshot.items() if key != "ingress"},
        "ingress": {
            "pipelineCount": len(ingress.get("pipelines", {}))
            if isinstance(ingress.get("pipelines"), dict) else 0,
            "shared_ws": {
                key: value
                for key, value in (ingress.get("shared_ws") or {}).items()
                if key != "hubs"
            } if isinstance(ingress.get("shared_ws"), dict) else None,
            "transport": transport_summary,
        },
    }


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
    detail_offset: int = 0,
    detail_limit: int = 20,
    event_loop_after_sequence: int | None = None,
) -> dict[str, Any]:
    """Compose a stable capacity snapshot from application-owned runtimes."""

    generated_at_ms = int(time.time() * 1000)
    safe_offset, safe_limit = _detail_window(detail_offset, detail_limit)
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
    stream_page, stream_total = _page_list(
        streams,
        offset=safe_offset,
        limit=safe_limit,
    )
    direct_by_key = (
        event_bus.get("direct_subscriptions_by_key", {})
        if isinstance(event_bus, dict)
        else {}
    )
    direct_by_key = direct_by_key if isinstance(direct_by_key, dict) else {}
    direct_page, direct_total = _page_mapping(
        direct_by_key,
        offset=safe_offset,
        limit=safe_limit,
    )
    lease_snapshot = (manager_snapshot or {}).get("stream_leases") or {}
    lease_page_is_prepared = False
    lease_snapshot_method = getattr(data_manager, "stream_lease_snapshot", None)
    if callable(lease_snapshot_method):
        try:
            lease_snapshot = lease_snapshot_method(
                offset=safe_offset,
                limit=safe_limit,
            )
            lease_page_is_prepared = True
        except Exception as exc:
            errors.append({"component": "stream_leases", "error": str(exc)})
    if not isinstance(lease_snapshot, dict):
        lease_snapshot = {}
    if lease_page_is_prepared:
        lease_series = lease_snapshot.get("series")
        lease_series = lease_series if isinstance(lease_series, list) else []
        lease_series_total = int(
            lease_snapshot.get("detail_total", len(lease_series))
        )
    else:
        lease_series, lease_series_total = _page_list(
            lease_snapshot.get("series"),
            offset=safe_offset,
            limit=safe_limit,
        )
    runtime_pressure = (manager_snapshot or {}).get("runtimePressure") or {}

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
        if lag_monitor is not None and callable(getattr(lag_monitor, "snapshot", None)):
            try:
                event_loop_lag = lag_monitor.snapshot(
                    after_sequence=event_loop_after_sequence,
                )
            except TypeError:
                # Compatibility for test doubles and older embedders whose
                # snapshot surface predates sequence-window diagnostics.
                event_loop_lag = lag_monitor.snapshot()
        else:
            event_loop_lag = None
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
    active_page, active_total = _page_list(
        (backfill_snapshot or {}).get("active"),
        offset=safe_offset,
        limit=safe_limit,
    )
    pending_page, pending_total = _page_list(
        (backfill_snapshot or {}).get("pending"),
        offset=safe_offset,
        limit=safe_limit,
    )
    deferred_page, deferred_total = _page_list(
        (backfill_snapshot or {}).get("deferred"),
        offset=safe_offset,
        limit=safe_limit,
    )
    indicator_instances, indicator_instance_total = _page_list(
        (indicator_engine or {}).get("instances"),
        offset=safe_offset,
        limit=safe_limit,
    )
    pipelines = ingress.get("pipelines") if isinstance(ingress, dict) else {}
    pipeline_page, pipeline_total = _page_mapping(
        pipelines,
        offset=safe_offset,
        limit=safe_limit,
    )
    batch_registry = getattr(state, "kline_batch_registry", None)
    try:
        batch_snapshot = (
            batch_registry.snapshot(offset=safe_offset, limit=safe_limit)
            if batch_registry is not None
            and callable(getattr(batch_registry, "snapshot", None))
            else {
                "enabled": bool(config.KLINE_BATCH_STREAM_ENABLED),
                "websocket_connections": 0,
                "logical_clients": 0,
                "logical_series": 0,
                "logical_subscriptions": 0,
                "outbox_depth": 0,
            }
        )
    except Exception as exc:
        batch_snapshot = None
        errors.append({"component": "kline_batch", "error": str(exc)})

    return {
        "schemaVersion": BACKEND_CAPACITY_SCHEMA_VERSION,
        "generatedAtMs": generated_at_ms,
        "readOnly": True,
        "ok": not errors,
        "errors": errors,
        "detail": {
            "offset": safe_offset,
            "limit": safe_limit,
            "maxLimit": _MAX_CAPACITY_DETAIL_LIMIT,
        },
        "limits": {
            "backfillCoordinatorMaxConcurrency": int(
                config.BACKFILL_COORDINATOR_MAX_CONCURRENCY
            ),
            "klineBatchEnabled": bool(config.KLINE_BATCH_STREAM_ENABLED),
            "klineBatchMaxSeriesPerClient": int(config.KLINE_BATCH_MAX_SERIES_PER_CLIENT),
            "klineBatchMaxIntervalsPerSeries": int(config.KLINE_BATCH_MAX_INTERVALS_PER_SERIES),
            "klineBatchMaxTotalSubscriptions": int(config.KLINE_BATCH_MAX_TOTAL_SUBSCRIPTIONS),
            "klineBatchOutboxSize": int(config.KLINE_BATCH_OUTBOX_SIZE),
            "klineAppMaxActiveSeries": int(config.KLINE_APP_MAX_ACTIVE_SERIES),
            "indicatorAppMaxActiveTargets": int(config.INDICATOR_APP_MAX_ACTIVE_TARGETS),
            "upstreamMaxDescriptorsPerShard": int(
                config.KLINE_UPSTREAM_MAX_DESCRIPTORS_PER_SHARD
            ),
        },
        "database": database,
        "dataManager": {
            "activeSeries": len(streams),
            "leasedSeries": int(lease_snapshot.get("series_count", len(streams))),
            "streamLeases": int(lease_snapshot.get("consumer_claims", sum(
                int(value) for value in direct_by_key.values()
                if isinstance(value, (int, float))
            ))),
            "uniqueLeaseConsumers": int(lease_snapshot.get("unique_consumers", 0)),
            "logicalSubscribers": int(event_bus.get("callback_subscriptions", 0))
            + int(event_bus.get("queue_subscriptions", 0)),
            "cacheSeries": int(cache.get("total_series", 0)),
            "cacheBars": int(cache.get("total_bars", 0)),
            "directSubscriptionSeries": direct_total,
            "directSubscriptionsBySeries": direct_page,
            "streamDetailTotal": stream_total,
            "streams": stream_page,
            "leaseDetailTotal": int(
                lease_snapshot.get("detail_total", lease_series_total)
            ),
            "leaseSeries": lease_series,
            "eventBus": _event_bus_summary(event_bus),
        },
        "klineBatch": batch_snapshot,
        "backfill": {
            "activeRequests": active_backfills,
            "pendingRequests": pending_backfills,
            "runningChunks": int((backfill_snapshot or {}).get("running_chunks", 0)),
            "readyChunks": int((backfill_snapshot or {}).get("ready_chunks", 0)),
            "summary": _backfill_summary(backfill_snapshot),
            "detail": {
                "active": active_page,
                "activeTotal": active_total,
                "pending": pending_page,
                "pendingTotal": pending_total,
                "deferred": deferred_page,
                "deferredTotal": deferred_total,
            },
        },
        "executors": executors_snapshot(),
        "indicators": {
            "activeInstances": int((indicator_engine or {}).get("instance_count", 0)),
            "streamSubscriptions": int((indicator_engine or {}).get("stream_count", 0)),
            "maxActiveTargets": int(config.INDICATOR_APP_MAX_ACTIVE_TARGETS),
            "engine": _indicator_summary(indicator_engine),
            "instanceDetailTotal": indicator_instance_total,
            "instances": indicator_instances,
            "rangeCache": indicator_range,
            "runtimeRouting": indicator_runtime,
        },
        "exchange": {
            "physicalWebSockets": shared_physical + dedicated_physical,
            "sharedPhysicalWebSockets": shared_physical,
            "dedicatedPhysicalWebSockets": dedicated_physical,
            "ingestion": _ingestion_summary(ingestion_factory_snapshot),
            "pipelineDetailTotal": pipeline_total,
            "pipelines": pipeline_page,
        },
        "runtime": {
            "eventLoopLag": event_loop_lag,
            "processMemory": _process_memory_summary(runtime_pressure),
        },
    }


__all__ = ["BACKEND_CAPACITY_SCHEMA_VERSION", "build_capacity_snapshot"]
