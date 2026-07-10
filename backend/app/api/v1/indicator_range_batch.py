"""Shared-bar execution for batched indicator history requests."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from app.api.v1.stream_indicator_payloads import (
    _compute_builtin_range_patch_from_bars,
    _compute_pyne_range_patch_from_bars,
    _indicator_warmup_bars,
    _query_indicator_compute_bars_async,
    _replace_range_from_snapshot,
)
from app.core import config
from app.core.executors import run_indicator, run_pyne_wait
from app.data_engine.interval_policy import parse_interval_ms
from app.indicator.range_result_service import IndicatorRangeResultService


@dataclass(frozen=True, slots=True)
class IndicatorRangeBatchJob:
    client_id: str
    meta: dict[str, Any]
    start: int
    end: int
    reason: str = "range"


def _job_target_bars(job: IndicatorRangeBatchJob) -> int:
    interval_ms = parse_interval_ms(job.meta["interval"])
    if interval_ms is None or interval_ms <= 0:
        raise ValueError(f"Unsupported interval: {job.meta['interval']}")
    return ((job.end - job.start) // max(interval_ms // 1000, 1)) + 1


def _job_warmup(job: IndicatorRangeBatchJob) -> int:
    params = job.meta.get("params") if isinstance(job.meta.get("params"), dict) else {}
    name = "PYNE" if job.meta.get("kind") == "script" else str(job.meta.get("name") or "")
    return _indicator_warmup_bars(name, params)


def _validate_jobs(jobs: list[IndicatorRangeBatchJob]) -> None:
    if not jobs:
        raise ValueError("Indicator range batch is empty")
    series = {
        IndicatorRangeResultService.series_key_from_meta(job.meta)
        for job in jobs
    }
    if len(series) != 1:
        raise ValueError("All indicator range batch items must use the same K-line series")
    for job in jobs:
        target_bars = _job_target_bars(job)
        if target_bars > 50_000:
            raise ValueError(f"Too many indicator bars: {target_bars} > 50000")
        if job.meta.get("kind") == "script":
            estimated = target_bars + _job_warmup(job)
            if estimated > max(int(config.PYNE_MAX_BARS), 1):
                raise ValueError(f"Too many Pyne bars: {estimated} > {config.PYNE_MAX_BARS}")


async def compute_indicator_range_batch_async(
    *,
    dm: Any,
    jobs: list[IndicatorRangeBatchJob],
    range_service: IndicatorRangeResultService,
    backfill_coordinator: Any | None = None,
) -> list[dict[str, Any] | BaseException]:
    """Compute a same-series batch with at most one shared K-line query.

    Cache hits do not touch K-line storage.  All misses share one lazy bars
    task using the union target range and maximum warmup requirement.
    """
    _validate_jobs(jobs)
    union_start = min(job.start for job in jobs)
    union_end = max(job.end for job in jobs)
    max_warmup = max(_job_warmup(job) for job in jobs)
    seed_meta = jobs[0].meta
    bars_tasks: dict[str, asyncio.Task[list[Any]]] = {}

    async def _shared_bars() -> list[Any]:
        revision_token = range_service.revision_token_for_meta(seed_meta)
        bars_task = bars_tasks.get(revision_token)
        if bars_task is None:
            bars_task = asyncio.create_task(
                _query_indicator_compute_bars_async(
                    dm,
                    seed_meta,
                    union_start,
                    union_end,
                    warmup_bars=max_warmup,
                    backfill_coordinator=backfill_coordinator,
                    wait_seconds=None,
                ),
                name=f"indicator-range-batch-bars:{union_start}-{union_end}",
            )
            bars_tasks[revision_token] = bars_task
        return await asyncio.shield(bars_task)

    async def _one(job: IndicatorRangeBatchJob) -> dict[str, Any]:
        target_bars = _job_target_bars(job)

        async def _compute() -> dict[str, Any]:
            bars = await _shared_bars()
            if job.meta.get("kind") == "script":
                return await run_pyne_wait(
                    _compute_pyne_range_patch_from_bars,
                    job.client_id,
                    job.meta,
                    job.start,
                    job.end,
                    bars,
                    job.reason,
                    target_bars,
                )
            return await run_indicator(
                _compute_builtin_range_patch_from_bars,
                job.client_id,
                job.meta,
                job.start,
                job.end,
                bars,
                job.reason,
                target_bars,
            )

        snapshot, cache_hit, data_revision = await range_service.get_or_compute(
            meta=job.meta,
            start=job.start,
            end=job.end,
            compute=_compute,
        )
        snapshot_range = snapshot.get("range") if isinstance(snapshot, dict) else None
        available_end = (
            int(snapshot_range.get("end", job.end))
            if isinstance(snapshot_range, dict)
            else job.end
        )
        payload = _replace_range_from_snapshot(
            snapshot,
            reason=job.reason,
            start_s=job.start,
            end_s=min(job.end, available_end),
        )
        payload["clientId"] = job.client_id
        payload["dataRevision"] = data_revision
        payload["cacheHit"] = cache_hit
        meta_payload = payload.get("meta")
        if not isinstance(meta_payload, dict):
            meta_payload = {}
            payload["meta"] = meta_payload
        meta_payload["dataRevision"] = data_revision
        return payload

    return list(await asyncio.gather(*(_one(job) for job in jobs), return_exceptions=True))


__all__ = ["IndicatorRangeBatchJob", "compute_indicator_range_batch_async"]
