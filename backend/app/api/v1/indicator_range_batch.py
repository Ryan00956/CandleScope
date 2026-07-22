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
    _validate_builtin_compute_bars,
    _validated_builtin_warmup_bars,
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
        if job.meta.get("kind") == "script":
            estimated = target_bars + _job_warmup(job)
            if estimated > max(int(config.PYNE_MAX_BARS), 1):
                raise ValueError(f"Too many Pyne bars: {estimated} > {config.PYNE_MAX_BARS}")
        else:
            params = (
                job.meta.get("params")
                if isinstance(job.meta.get("params"), dict)
                else {}
            )
            _validated_builtin_warmup_bars(
                str(job.meta.get("name") or ""),
                params,
                target_bars,
            )

    union_start = min(job.start for job in jobs)
    union_end = max(job.end for job in jobs)
    interval_ms = parse_interval_ms(jobs[0].meta["interval"])
    assert interval_ms is not None and interval_ms > 0
    union_target_bars = (
        (union_end - union_start) // max(interval_ms // 1000, 1)
    ) + 1
    max_shared_warmup = max(_job_warmup(job) for job in jobs)
    builtin_jobs = [job for job in jobs if job.meta.get("kind") != "script"]
    if builtin_jobs:
        _validate_builtin_compute_bars(
            union_target_bars,
            max_shared_warmup,
        )
    script_jobs = [job for job in jobs if job.meta.get("kind") == "script"]
    if script_jobs:
        estimated = union_target_bars + max_shared_warmup
        if estimated > max(int(config.PYNE_MAX_BARS), 1):
            raise ValueError(f"Too many Pyne bars: {estimated} > {config.PYNE_MAX_BARS}")


async def compute_indicator_range_batch_async(
    *,
    dm: Any,
    jobs: list[IndicatorRangeBatchJob],
    range_service: IndicatorRangeResultService,
    backfill_coordinator: Any | None = None,
    request_owner_id: str | None = None,
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

    async def _query_segment(
        segment_start: int,
        segment_end: int,
        segment_warmup: int,
    ) -> list[Any]:
        return await _query_indicator_compute_bars_async(
            dm,
            seed_meta,
            segment_start,
            segment_end,
            warmup_bars=segment_warmup,
            backfill_coordinator=backfill_coordinator,
            wait_seconds=None,
        )

    async def _shared_bars() -> list[Any]:
        async def _query() -> list[Any]:
            return await _query_segment(union_start, union_end, max_warmup)

        return await range_service.get_or_query_bars(
            meta=seed_meta,
            start=union_start,
            end=union_end,
            warmup_bars=max_warmup,
            query=_query,
            query_segment=_query_segment,
            query_owner_id=request_owner_id,
        )

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
            request_owner_id=request_owner_id,
        )
        snapshot_range = snapshot.get("range") if isinstance(snapshot, dict) else None
        available_start = (
            int(snapshot_range.get("start", job.start))
            if isinstance(snapshot_range, dict)
            else job.start
        )
        available_end = (
            int(snapshot_range.get("end", job.end))
            if isinstance(snapshot_range, dict)
            else job.end
        )
        payload = _replace_range_from_snapshot(
            snapshot,
            reason=job.reason,
            start_s=max(job.start, available_start),
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
