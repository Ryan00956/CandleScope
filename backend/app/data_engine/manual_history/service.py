"""Native-target manual history job runner.

Phase 4 runs one native series to an exact seal.  Derived/custom materialization
and ZIP acceleration arrive in later phases.  Create still does not open the
HTTP write path by default.
"""

from __future__ import annotations

import asyncio
import logging
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
    ) -> None:
        self.repository = repository
        self.planner = planner or ManualHistoryPlanner()
        self.data_manager = data_manager
        self.coordinator = coordinator
        self.storage = storage or KlinesRepoAdapter()
        self._fetch_native = fetch_native
        self._verify_range = verify_range or self.storage.verify_contiguous_range
        self.enabled = bool(enabled)
        self._runner_task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._active = asyncio.Lock()

    async def start(self) -> None:
        if self._runner_task is not None:
            return
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
            for target in targets:
                if target.state is JobTargetState.READY:
                    ready += 1
                    continue
                if target.source_interval != target.canonical_interval:
                    self.repository.cas_job_target_state(
                        job_id,
                        target.symbol,
                        target.canonical_interval,
                        from_state=target.state,
                        to_state=JobTargetState.FAILED,
                        last_error="derived_not_supported_in_phase4",
                    )
                    failed += 1
                    continue
                try:
                    await self._run_native_target(collection, job, target)
                    ready += 1
                except Exception as exc:
                    logger.warning("manual history target failed: %s", exc)
                    current = self.repository.list_job_targets(job_id)
                    current_target = next(
                        item for item in current
                        if item.symbol == target.symbol
                        and item.canonical_interval == target.canonical_interval
                    )
                    if current_target.state not in {
                        JobTargetState.FAILED,
                        JobTargetState.CANCELLED,
                        JobTargetState.READY,
                    }:
                        self.repository.cas_job_target_state(
                            job_id,
                            target.symbol,
                            target.canonical_interval,
                            from_state=current_target.state,
                            to_state=JobTargetState.FAILED,
                            last_error=str(exc),
                        )
                    failed += 1
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
        await self._fetch(
            exchange=collection.exchange,
            market_type=collection.market_type,
            symbol=target.symbol,
            interval=target.canonical_interval,
            target=target,
            collection=collection,
            job=job,
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
        sealed_end = int(target.initial_end_open_ms)
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
    ) -> int:
        collection_target = next(
            item for item in self.repository.list_collection_targets(collection.collection_id)
            if item.symbol == symbol and item.canonical_interval == interval
        )
        if self._fetch_native is not None:
            return int(
                await self._fetch_native(
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                    start_ms=collection_target.effective_start_ms,
                    end_ms=target.initial_end_open_ms,
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
            start_ms=collection_target.effective_start_ms,
            end_ms=target.initial_end_open_ms,
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


