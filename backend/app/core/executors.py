"""Dedicated executors for blocking work owned by async request paths."""
from __future__ import annotations

import asyncio
import functools
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Lock
from typing import Any, TypeVar

from app.core import config

T = TypeVar("T")


@dataclass(slots=True)
class _ExecutorStats:
    name: str
    max_workers: int
    submitted: int = 0
    started: int = 0
    completed: int = 0
    failed: int = 0
    active: int = 0
    total_queue_wait_ms: float = 0.0
    max_queue_wait_ms: float = 0.0
    total_run_ms: float = 0.0
    max_run_ms: float = 0.0
    _lock: Lock = field(default_factory=Lock)

    def mark_submitted(self) -> float:
        with self._lock:
            self.submitted += 1
        return time.perf_counter()

    def mark_started(self, submitted_at: float) -> float:
        now = time.perf_counter()
        wait_ms = (now - submitted_at) * 1000
        with self._lock:
            self.started += 1
            self.active += 1
            self.total_queue_wait_ms += wait_ms
            self.max_queue_wait_ms = max(self.max_queue_wait_ms, wait_ms)
        return now

    def mark_finished(self, started_at: float, *, failed: bool) -> None:
        run_ms = (time.perf_counter() - started_at) * 1000
        with self._lock:
            self.active = max(0, self.active - 1)
            self.completed += 1
            self.total_run_ms += run_ms
            self.max_run_ms = max(self.max_run_ms, run_ms)
            if failed:
                self.failed += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            pending = max(0, self.submitted - self.started)
            avg_queue_wait = (
                self.total_queue_wait_ms / self.started
                if self.started
                else 0.0
            )
            avg_run = self.total_run_ms / self.completed if self.completed else 0.0
            return {
                "name": self.name,
                "max_workers": self.max_workers,
                "submitted": self.submitted,
                "started": self.started,
                "completed": self.completed,
                "failed": self.failed,
                "active": self.active,
                "pending": pending,
                "avg_queue_wait_ms": round(avg_queue_wait, 2),
                "max_queue_wait_ms": round(self.max_queue_wait_ms, 2),
                "avg_run_ms": round(avg_run, 2),
                "max_run_ms": round(self.max_run_ms, 2),
            }


def _worker_count(value: int, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


_indicator_workers = _worker_count(config.INDICATOR_THREAD_WORKERS, 2)
_pyne_wait_workers = _worker_count(config.PYNE_HTTP_THREAD_WORKERS, 2)
_storage_workers = _worker_count(config.STORAGE_THREAD_WORKERS, 4)

_indicator_executor = ThreadPoolExecutor(
    max_workers=_indicator_workers,
    thread_name_prefix="indicator",
)
_pyne_wait_executor = ThreadPoolExecutor(
    max_workers=_pyne_wait_workers,
    thread_name_prefix="pyne-wait",
)
_storage_executor = ThreadPoolExecutor(
    max_workers=_storage_workers,
    thread_name_prefix="storage",
)
_stats: dict[str, _ExecutorStats] = {
    "indicator": _ExecutorStats("indicator", _indicator_workers),
    "pyne_wait": _ExecutorStats("pyne_wait", _pyne_wait_workers),
    "storage": _ExecutorStats("storage", _storage_workers),
}


async def _run(
    stats_name: str,
    executor: ThreadPoolExecutor,
    func: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    loop = asyncio.get_running_loop()
    bound = functools.partial(func, *args, **kwargs)
    stats = _stats[stats_name]
    submitted_at = stats.mark_submitted()

    def _call() -> T:
        started_at = stats.mark_started(submitted_at)
        failed = False
        try:
            return bound()
        except Exception:
            failed = True
            raise
        finally:
            stats.mark_finished(started_at, failed=failed)

    return await loop.run_in_executor(executor, _call)


async def run_indicator(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    return await _run("indicator", _indicator_executor, func, *args, **kwargs)


async def run_pyne_wait(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    return await _run("pyne_wait", _pyne_wait_executor, func, *args, **kwargs)


async def run_storage(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    return await _run("storage", _storage_executor, func, *args, **kwargs)


def executors_snapshot() -> dict[str, Any]:
    return {name: stats.snapshot() for name, stats in sorted(_stats.items())}
