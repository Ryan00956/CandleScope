"""Bounded static job scheduling with cancellation and exponential retry."""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .contracts import CoreContribution
from .errors import core_error


JobInvocation = Callable[
    [CoreContribution, dict[str, Any], bool, str], Awaitable[dict[str, Any]]
]


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class _Job:
    contribution: CoreContribution
    callback: JobInvocation
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    run_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    schedule_task: asyncio.Task[None] | None = None
    active_task: asyncio.Task[dict[str, Any]] | None = None
    run_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0
    last_started_at: str | None = None
    last_finished_at: str | None = None
    last_error: str | None = None
    last_result: dict[str, Any] | None = None


class PluginJobScheduler:
    def __init__(self) -> None:
        self._jobs: dict[str, _Job] = {}

    def register(self, contribution: CoreContribution, callback: JobInvocation) -> None:
        if contribution.kind != "job/1":
            raise ValueError("only job contributions can be registered")
        if contribution.full_id in self._jobs:
            raise core_error(
                "PLUGIN_JOB_CONFLICT",
                "job is already registered",
                plugin_id=contribution.plugin_id,
            )
        job = _Job(contribution, callback)
        self._jobs[contribution.full_id] = job
        if "schedule" in contribution.configuration:
            job.schedule_task = asyncio.create_task(
                self._schedule_loop(job),
                name=f"plugin-job-schedule:{contribution.full_id}",
            )

    async def _schedule_loop(self, job: _Job) -> None:
        config = job.contribution.configuration
        interval = config["schedule"]["intervalSeconds"]
        first_delay = 0.0 if config["runOnStartup"] else interval
        try:
            delay = first_delay
            while not job.stop_event.is_set():
                try:
                    await asyncio.wait_for(job.stop_event.wait(), timeout=delay)
                    return
                except TimeoutError:
                    pass
                try:
                    await self._run(job, user_action=False, reason="schedule")
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Failure is retained on the job; the next interval remains isolated.
                    pass
                delay = interval
        except asyncio.CancelledError:
            raise

    async def trigger(
        self,
        contribution_id: str,
        *,
        user_action: bool,
        reason: str = "user",
    ) -> dict[str, Any]:
        job = self._jobs.get(contribution_id)
        if job is None:
            raise core_error("PLUGIN_JOB_NOT_FOUND", "job is not registered")
        return await self._run(job, user_action=user_action, reason=reason)

    async def _run(
        self, job: _Job, *, user_action: bool, reason: str
    ) -> dict[str, Any]:
        if job.stop_event.is_set():
            raise core_error(
                "PLUGIN_JOB_DISABLED",
                "job was disabled before execution",
                plugin_id=job.contribution.plugin_id,
            )
        if job.run_lock.locked():
            raise core_error(
                "PLUGIN_JOB_ALREADY_RUNNING",
                "job does not allow overlapping executions",
                plugin_id=job.contribution.plugin_id,
            )
        config = job.contribution.configuration
        async with job.run_lock:
            run_id = f"job-{secrets.token_hex(16)}"
            job.last_started_at = _utc_now()
            job.run_count += 1
            last_error: Exception | None = None
            for attempt in range(1, config["maxAttempts"] + 1):
                if job.stop_event.is_set():
                    raise core_error(
                        "PLUGIN_JOB_DISABLED",
                        "job was disabled during retry backoff",
                        plugin_id=job.contribution.plugin_id,
                    )
                trace_id = f"{run_id}-attempt-{attempt}"
                payload = {
                    "runId": run_id,
                    "reason": reason,
                    "attempt": attempt,
                    "scheduledAt": job.last_started_at,
                }
                task = asyncio.create_task(
                    job.callback(job.contribution, payload, user_action, trace_id),
                    name=f"plugin-job-run:{job.contribution.full_id}:{run_id}",
                )
                job.active_task = task
                try:
                    result = await asyncio.wait_for(
                        task, timeout=config["timeoutSeconds"]
                    )
                    if job.stop_event.is_set():
                        raise core_error(
                            "PLUGIN_JOB_DISABLED",
                            "job completed after its registration was revoked",
                            plugin_id=job.contribution.plugin_id,
                        )
                    job.last_result = result
                    job.last_error = None
                    job.consecutive_failures = 0
                    job.last_finished_at = _utc_now()
                    return {
                        "runId": run_id,
                        "attempt": attempt,
                        "result": result,
                    }
                except asyncio.CancelledError:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    raise
                except Exception as exc:
                    last_error = exc
                    job.failure_count += 1
                    job.consecutive_failures += 1
                    job.last_error = type(exc).__name__
                    if attempt < config["maxAttempts"]:
                        backoff = min(
                            60.0,
                            config["backoffSeconds"] * (2 ** (attempt - 1)),
                        )
                        try:
                            await asyncio.wait_for(
                                job.stop_event.wait(), timeout=backoff
                            )
                            raise core_error(
                                "PLUGIN_JOB_DISABLED",
                                "job was disabled during retry backoff",
                                plugin_id=job.contribution.plugin_id,
                            )
                        except TimeoutError:
                            pass
                finally:
                    if job.active_task is task:
                        job.active_task = None
            job.last_finished_at = _utc_now()
            assert last_error is not None
            raise last_error

    async def unregister_plugin(self, plugin_id: str) -> int:
        selected = [
            key
            for key, job in self._jobs.items()
            if job.contribution.plugin_id == plugin_id
        ]
        await self._unregister(selected)
        return len(selected)

    async def stop(self) -> None:
        await self._unregister(list(self._jobs))

    async def _unregister(self, keys: list[str]) -> None:
        tasks: list[asyncio.Task[Any]] = []
        for key in keys:
            job = self._jobs.pop(key, None)
            if job is None:
                continue
            job.stop_event.set()
            for task in (job.schedule_task, job.active_task):
                if task is not None and not task.done():
                    task.cancel()
                    tasks.append(task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def snapshot(self) -> list[dict[str, Any]]:
        return [
            {
                "id": job.contribution.full_id,
                "pluginId": job.contribution.plugin_id,
                "scheduled": job.schedule_task is not None,
                "running": job.run_lock.locked(),
                "runCount": job.run_count,
                "failureCount": job.failure_count,
                "consecutiveFailures": job.consecutive_failures,
                "lastStartedAt": job.last_started_at,
                "lastFinishedAt": job.last_finished_at,
                "lastError": job.last_error,
            }
            for job in sorted(
                self._jobs.values(), key=lambda value: value.contribution.full_id
            )
        ]
