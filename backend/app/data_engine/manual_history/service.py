"""Native-target manual history job runner.

Phase 4 runs one native series to an exact seal.  Derived/custom materialization
and ZIP acceleration arrive in later phases.  Create still does not open the
HTTP write path by default.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from app.data_engine.manual_history.models import (
    JobState,
    JobTargetState,
    ManualHistoryCreateSpec,
    ManualHistoryTargetSpec,
    RouteKind,
)
from app.data_engine.manual_history.planner import ManualHistoryPlanner
from app.data_engine.manual_history.repository import ManualHistoryRepository
from app.data_engine.storage.klines_repo import KlinesRepoAdapter

logger = logging.getLogger("candlescope.manual_history")

FetchNative = Callable[..., Awaitable[int]]
VerifyRange = Callable[..., dict[str, Any]]


class ManualHistoryService:
    def __init__(
        self,
        *,
        repository: ManualHistoryRepository,
        planner: ManualHistoryPlanner | None = None,
        data_manager: Any | None = None,
        coordinator: Any | None = None,
        storage: KlinesRepoAdapter | None = None,
        fetch_native: FetchNative | None = None,
        verify_range: VerifyRange | None = None,
        enabled: bool = False,
        clock_ms: Callable[[], int] | None = None,
    ) -> None:
        self.repository = repository
        self.planner = planner or ManualHistoryPlanner()
        self.data_manager = data_manager
        self.coordinator = coordinator
        self.storage = storage or KlinesRepoAdapter()
        self._fetch_native = fetch_native
        self._verify_range = verify_range or self.storage.verify_contiguous_range
        self.enabled = bool(enabled)
        self._clock_ms = clock_ms
        self._disk_free_bytes: Callable[[], int | None] | None = None
        self._runner_task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._active = asyncio.Lock()

    def _now_ms(self) -> int:
        if self._clock_ms is not None:
            return int(self._clock_ms())
        return int(time.time() * 1000)

    def _seal_end_open_ms(self, interval: str, *, fallback: int) -> int:
        from app.data_engine.interval_policy import last_closed_bar_open_ms

        closed = last_closed_bar_open_ms(self._now_ms(), interval)
        if closed is None:
            return int(fallback)
        return max(int(fallback), int(closed))

    def recover_jobs(self) -> tuple[Any, ...]:
        recovered = []
        for job in self.repository.list_recoverable_jobs():
            if job.state in {JobState.RUNNING, JobState.SEALING}:
                self.repository.increment_recovery_count(job.job_id)
                recovered.append(
                    self.repository.cas_job_state(
                        job.job_id,
                        from_state=job.state,
                        to_state=JobState.QUEUED,
                        stage="recovered",
                    )
                )
            else:
                recovered.append(job)
        return tuple(recovered)

    def cancel_job(self, job_id: str) -> Any:
        job = self.repository.get_job(job_id)
        if job.state in {
            JobState.SUCCEEDED,
            JobState.FAILED,
            JobState.CANCELLED,
            JobState.PARTIAL,
        }:
            return job
        if job.state is not JobState.CANCELLING:
            job = self.repository.cas_job_state(
                job_id,
                from_state=job.state,
                to_state=JobState.CANCELLING,
                stage="cancelling",
            )
        ready = 0
        for target in self.repository.list_job_targets(job_id):
            if target.state is JobTargetState.READY:
                ready += 1
                continue
            if target.state is JobTargetState.CANCELLED:
                continue
            try:
                self.repository.cas_job_target_state(
                    job_id,
                    target.symbol,
                    target.canonical_interval,
                    from_state=target.state,
                    to_state=JobTargetState.CANCELLED,
                    last_error="cancelled",
                )
            except Exception:
                continue
        final = JobState.PARTIAL if ready else JobState.CANCELLED
        return self.repository.cas_job_state(
            job_id,
            from_state=JobState.CANCELLING,
            to_state=final,
            stage="done",
        )

    async def start(self) -> None:
        if self._runner_task is not None:
            return
        self.recover_jobs()
        self._stop.clear()
        self._runner_task = asyncio.create_task(self._run_loop(), name="manual-history-runner")

    async def stop(self) -> None:
        self._stop.set()
        task = self._runner_task
        self._runner_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    def create_from_plan(
        self,
        plan: dict[str, Any],
        *,
        idempotency_key: str,
        collection_id: str | None = None,
        job_id: str | None = None,
    ) -> Any:
        if not plan.get("can_start"):
            raise ValueError("plan cannot start: " + ",".join(plan.get("blocking_reasons") or []))
        selection = plan["selection"]
        targets = []
        for item in plan["targets"]:
            if item.get("error"):
                raise ValueError(item["error"])
            targets.append(
                ManualHistoryTargetSpec(
                    symbol=item["symbol"],
                    requested_interval=item["requested_interval"],
                    canonical_interval=item["canonical_interval"],
                    route_kind=RouteKind(item["route_kind"]),
                    source_interval=item["source_interval"],
                    effective_start_ms=int(item["effective_start_ms"]),
                    initial_end_open_ms=int(item["initial_end_open_ms"]),
                    estimated_rows=item.get("estimated_target_rows"),
                    expected_rows=item.get("estimated_target_rows"),
                    boundary_reason=item.get("boundary_reason"),
                )
            )
        spec = ManualHistoryCreateSpec(
            collection_id=collection_id or f"col:{uuid.uuid4()}",
            job_id=job_id or f"job:{uuid.uuid4()}",
            exchange=selection["exchange"],
            market_type=selection["market_type"],
            requested_start_ms=int(selection["requested_start_ms"]),
            idempotency_key=idempotency_key,
            request_hash=str(plan["plan_hash"]),
            plan_hash=str(plan["plan_hash"]),
            targets=tuple(targets),
            estimated_db_bytes=(plan.get("storage") or {}).get("estimated_db_growth_bytes"),
            estimated_temp_bytes=(plan.get("storage") or {}).get("estimated_temp_bytes"),
        )
        created = self.repository.create_collection_and_job(spec)
        reload = getattr(self.data_manager, "reload_durable_protections", None)
        if callable(reload):
            reload()
        return created

    async def run_job(self, job_id: str) -> Any:
        async with self._active:
            job = self.repository.get_job(job_id)
            if job.cancel_requested:
                return self.cancel_job(job_id)
            free = None if self._disk_free_bytes is None else self._disk_free_bytes()
            if free is not None and int(free) <= 0:
                if job.state is JobState.QUEUED:
                    return self.repository.cas_job_state(
                        job_id,
                        from_state=JobState.QUEUED,
                        to_state=JobState.BLOCKED_STORAGE,
                        stage="blocked_storage",
                        last_error="disk_critical",
                    )
                if job.state is JobState.RUNNING:
                    return self.repository.cas_job_state(
                        job_id,
                        from_state=JobState.RUNNING,
                        to_state=JobState.BLOCKED_STORAGE,
                        stage="blocked_storage",
                        last_error="disk_critical",
                    )
            if job.state is JobState.QUEUED:
                job = self.repository.cas_job_state(
                    job_id,
                    from_state=JobState.QUEUED,
                    to_state=JobState.RUNNING,
                    stage="fetching",
                )
            collection = self.repository.get_collection(job.collection_id)
            targets = self.repository.list_job_targets(job_id)
            ready = 0
            failed = 0
            groups: dict[tuple[str, str], list[Any]] = {}
            for target in targets:
                if target.state is JobTargetState.READY:
                    ready += 1
                    continue
                groups.setdefault((target.symbol, target.source_interval), []).append(target)
            for (symbol, source_interval), group in groups.items():
                native = [
                    item for item in group
                    if item.canonical_interval == source_interval
                ]
                derived = [
                    item for item in group
                    if item.canonical_interval != source_interval
                ]
                try:
                    if native:
                        await self._run_native_target(collection, job, native[0])
                        ready += 1
                    elif derived:
                        await self._fetch_source_group(
                            collection, job, derived[0], source_interval=source_interval
                        )
                    for target in derived:
                        try:
                            await self._run_derived_target(collection, job, target)
                            ready += 1
                        except Exception as exc:
                            failed += self._fail_target(job_id, target, exc)
                            logger.warning("manual history derived target failed: %s", exc)
                except Exception as exc:
                    logger.warning("manual history source group failed: %s", exc)
                    for target in group:
                        if target.state is JobTargetState.READY:
                            continue
                        failed += self._fail_target(job_id, target, exc)
            if failed and ready:
                return self.repository.cas_job_state(
                    job_id,
                    from_state=JobState.RUNNING,
                    to_state=JobState.PARTIAL,
                    stage="done",
                )
            if failed:
                return self.repository.cas_job_state(
                    job_id,
                    from_state=JobState.RUNNING,
                    to_state=JobState.FAILED,
                    stage="done",
                    last_error="no targets ready",
                )
            sealing = self.repository.cas_job_state(
                job_id,
                from_state=JobState.RUNNING,
                to_state=JobState.SEALING,
                stage="sealing",
            )
            return self.repository.cas_job_state(
                sealing.job_id,
                from_state=JobState.SEALING,
                to_state=JobState.SUCCEEDED,
                stage="done",
            )

    def _fail_target(self, job_id: str, target: Any, exc: Exception) -> int:
        current = self.repository.list_job_targets(job_id)
        current_target = next(
            item for item in current
            if item.symbol == target.symbol
            and item.canonical_interval == target.canonical_interval
        )
        if current_target.state in {
            JobTargetState.FAILED,
            JobTargetState.CANCELLED,
            JobTargetState.READY,
        }:
            return 0 if current_target.state is JobTargetState.READY else 1
        self.repository.cas_job_target_state(
            job_id,
            target.symbol,
            target.canonical_interval,
            from_state=current_target.state,
            to_state=JobTargetState.FAILED,
            last_error=str(exc),
        )
        return 1

    async def _fetch_source_group(
        self,
        collection: Any,
        job: Any,
        sample_target: Any,
        *,
        source_interval: str,
    ) -> None:
        job_row = self.repository.get_job(job.job_id)
        if job_row.cancel_requested:
            raise RuntimeError("cancel_requested")
        collection_targets = self.repository.list_collection_targets(collection.collection_id)
        matching = [
            item for item in collection_targets
            if item.symbol == sample_target.symbol
            and item.source_interval == source_interval
        ]
        start_ms = min(item.effective_start_ms for item in matching)
        planned_end = max(
            target.initial_end_open_ms
            for target in self.repository.list_job_targets(job.job_id)
            if target.symbol == sample_target.symbol
            and target.source_interval == source_interval
        )
        end_ms = self._seal_end_open_ms(source_interval, fallback=int(planned_end))
        await self._fetch(
            exchange=collection.exchange,
            market_type=collection.market_type,
            symbol=sample_target.symbol,
            interval=source_interval,
            target=sample_target,
            collection=collection,
            job=job,
            start_ms=start_ms,
            end_ms=end_ms,
        )

    async def _run_derived_target(self, collection: Any, job: Any, target: Any) -> None:
        from app.data_engine.manual_history.materializer import materialize_closed_target_bars
        from app.data_engine.storage.klines_repo import query_klines, upsert_klines

        collection_target = next(
            item for item in self.repository.list_collection_targets(collection.collection_id)
            if item.symbol == target.symbol
            and item.canonical_interval == target.canonical_interval
        )
        self.repository.cas_job_target_state(
            job.job_id,
            target.symbol,
            target.canonical_interval,
            from_state=target.state,
            to_state=JobTargetState.MATERIALIZING,
        )
        from app.data_engine.interval_policy import parse_interval_ms

        sealed_end = self._seal_end_open_ms(
            target.canonical_interval,
            fallback=int(target.initial_end_open_ms),
        )
        target_width = parse_interval_ms(target.canonical_interval) or 0
        source_width = parse_interval_ms(target.source_interval) or 0
        source_end_ms = int(sealed_end) + max(0, target_width - source_width)
        components = query_klines(
            target.symbol,
            target.source_interval,
            start_ms=collection_target.effective_start_ms,
            end_ms=source_end_ms,
            exchange=collection.exchange,
            market_type=collection.market_type,
        )
        rebuilt = materialize_closed_target_bars(
            components,
            target_interval=target.canonical_interval,
            source_interval=target.source_interval,
            now_ms=self._now_ms(),
        )
        if rebuilt:
            upsert_klines(
                target.symbol,
                target.canonical_interval,
                rebuilt,
                source=collection.exchange,
                exchange=collection.exchange,
                market_type=collection.market_type,
            )
        self.repository.cas_job_target_state(
            job.job_id,
            target.symbol,
            target.canonical_interval,
            from_state=JobTargetState.MATERIALIZING,
            to_state=JobTargetState.VERIFYING,
        )
        verification = self._verify_range(
            target.symbol,
            target.canonical_interval,
            collection_target.effective_start_ms,
            sealed_end,
            exchange=collection.exchange,
            market_type=collection.market_type,
        )
        if verification.get("verified_contiguous") is not True:
            raise RuntimeError(
                f"continuity_failed expected={verification.get('expected_open_time')} "
                f"actual={verification.get('actual_open_time')}"
            )
        self.repository.seal_target(
            job.job_id,
            target.symbol,
            target.canonical_interval,
            sealed_end_open_ms=sealed_end,
            verified_rows=int(
                verification.get("expected_count") or verification.get("actual_count") or 0
            ),
        )
        reload = getattr(self.data_manager, "reload_durable_protections", None)
        if callable(reload):
            reload()

    async def _run_native_target(self, collection: Any, job: Any, target: Any) -> None:
        job_row = self.repository.get_job(job.job_id)
        if job_row.cancel_requested:
            raise RuntimeError("cancel_requested")
        self.repository.cas_job_target_state(
            job.job_id,
            target.symbol,
            target.canonical_interval,
            from_state=target.state,
            to_state=JobTargetState.FETCHING,
        )
        from app.data_engine.interval_policy import parse_interval_ms

        fetch_end = self._seal_end_open_ms(
            target.canonical_interval,
            fallback=int(target.initial_end_open_ms),
        )
        await self._fetch(
            exchange=collection.exchange,
            market_type=collection.market_type,
            symbol=target.symbol,
            interval=target.canonical_interval,
            target=target,
            collection=collection,
            job=job,
            end_ms=fetch_end,
        )
        sealed_end = self._seal_end_open_ms(
            target.canonical_interval,
            fallback=fetch_end,
        )
        if sealed_end > fetch_end:
            step = parse_interval_ms(target.canonical_interval) or 1
            await self._fetch(
                exchange=collection.exchange,
                market_type=collection.market_type,
                symbol=target.symbol,
                interval=target.canonical_interval,
                target=target,
                collection=collection,
                job=job,
                start_ms=fetch_end + step,
                end_ms=sealed_end,
            )
        self.repository.cas_job_target_state(
            job.job_id,
            target.symbol,
            target.canonical_interval,
            from_state=JobTargetState.FETCHING,
            to_state=JobTargetState.VERIFYING,
        )
        collection_target = next(
            item for item in self.repository.list_collection_targets(collection.collection_id)
            if item.symbol == target.symbol
            and item.canonical_interval == target.canonical_interval
        )
        verification = self._verify_range(
            target.symbol,
            target.canonical_interval,
            collection_target.effective_start_ms,
            sealed_end,
            exchange=collection.exchange,
            market_type=collection.market_type,
        )
        if verification.get("verified_contiguous") is not True:
            raise RuntimeError(
                f"continuity_failed expected={verification.get('expected_open_time')} "
                f"actual={verification.get('actual_open_time')}"
            )
        verified_rows = int(verification.get("expected_count") or verification.get("actual_count") or 0)
        self.repository.seal_target(
            job.job_id,
            target.symbol,
            target.canonical_interval,
            sealed_end_open_ms=sealed_end,
            verified_rows=verified_rows,
        )
        reload = getattr(self.data_manager, "reload_durable_protections", None)
        if callable(reload):
            reload()

    async def _fetch(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        target: Any,
        collection: Any,
        job: Any,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> int:
        collection_target = next(
            (
                item for item in self.repository.list_collection_targets(collection.collection_id)
                if item.symbol == symbol and item.canonical_interval == interval
            ),
            None,
        )
        resolved_start = start_ms
        resolved_end = end_ms
        if collection_target is not None:
            if resolved_start is None:
                resolved_start = collection_target.effective_start_ms
            if resolved_end is None:
                resolved_end = self._seal_end_open_ms(
                    interval,
                    fallback=int(target.initial_end_open_ms),
                )
        if resolved_start is None:
            resolved_start = int(getattr(target, "initial_end_open_ms", 0))
        if resolved_end is None:
            resolved_end = self._seal_end_open_ms(
                interval,
                fallback=int(target.initial_end_open_ms),
            )
        if self._fetch_native is not None:
            return int(
                await self._fetch_native(
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                    start_ms=int(resolved_start),
                    end_ms=int(resolved_end),
                    job_id=job.job_id,
                    collection_id=collection.collection_id,
                )
                or 0
            )
        coordinator = self.coordinator
        if coordinator is None:
            return 0
        from app.data_engine.data_manager.backfill_coordinator import RepairRequest

        request = RepairRequest(
            symbol=symbol,
            interval=interval,
            start_ms=int(resolved_start),
            end_ms=int(resolved_end),
            exchange=exchange,
            market_type=market_type,
            reason="manual_history_download",
            requester="manual_history_download",
            metadata={
                "origin": "data_workbench",
                "manual_job_id": job.job_id,
                "manual_collection_id": collection.collection_id,
                "archive_explicit_demand": True,
                "requires_trusted_finality": True,
            },
        )
        await coordinator.request_and_wait(request)
        return 0

    async def _run_loop(self) -> None:
        while not self._stop.is_set():
            recoverable = self.repository.list_recoverable_jobs()
            queued = [job for job in recoverable if job.state is JobState.QUEUED]
            if queued:
                await self.run_job(queued[0].job_id)
                continue
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=0.2)
            except asyncio.TimeoutError:
                continue


