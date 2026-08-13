"""Feature-gated lifecycle owner for the persistent replay service."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from collections.abc import Mapping
from typing import Callable, TypeVar

from app.core.config import REPLAY_SETTINGS, ReplaySettings
from app.data_engine.storage.raw_trade_archive import (
    DisabledRawAggTradeArchive,
    ParquetRawAggTradeArchive,
    RawAggTradeArchive,
)

from .history_archive import ReplayHistoryArchiveRuntimeLease
from .remote_trade_archive import RemoteRawAggTradeArchive
from .service import ReplayService
from .storage import ReplaySQLiteStore


_STARTUP_CLEANUP_STEP_TIMEOUT_SECONDS = 5.0
_TaskResult = TypeVar("_TaskResult")


class ReplayStartupError(RuntimeError):
    """Replay was enabled but its independent runtime could not start safely."""


@dataclass(slots=True)
class ReplayRuntime:
    """Own replay startup/shutdown without coupling replay to DataManager."""

    settings: ReplaySettings
    service: ReplayService | None = None
    archive_lease: ReplayHistoryArchiveRuntimeLease | None = None

    @property
    def enabled(self) -> bool:
        return self.settings.enabled

    async def shutdown(self, *, step_timeout: float = 5.0) -> None:
        service = self.service
        if service is None:
            if self.archive_lease is not None:
                self.archive_lease.release()
                self.archive_lease = None
            return
        shutdown_task = asyncio.create_task(
            service.shutdown(step_timeout=step_timeout),
            name="replay-runtime-shutdown",
        )
        try:
            await asyncio.shield(shutdown_task)
        except asyncio.CancelledError:
            try:
                await _await_task_uninterruptibly(shutdown_task)
            except BaseException:
                # Preserve the service reference when cleanup itself failed so
                # the owner can retry shutdown.  Cancellation remains the
                # externally observable lifecycle result.
                pass
            else:
                self.service = None
                if self.archive_lease is not None:
                    self.archive_lease.release()
                    self.archive_lease = None
            raise
        self.service = None
        if self.archive_lease is not None:
            self.archive_lease.release()
            self.archive_lease = None

    def diagnostics(self, *, redact_paths: bool = False) -> dict[str, object]:
        if self.service is None:
            return {
                "enabled": self.settings.enabled,
                "available": False,
                "reason": "REPLAY_DISABLED" if not self.settings.enabled else "STOPPED",
                "sessions": {},
            }
        return self.service.diagnostics(redact_paths=redact_paths)


async def start_replay_runtime(
    settings: ReplaySettings = REPLAY_SETTINGS,
    *,
    store_factory: Callable[[str], ReplaySQLiteStore] | None = None,
    service_factory: Callable[..., ReplayService] = ReplayService,
    raw_trade_archive: RawAggTradeArchive | None = None,
    instrument_metadata_resolver: (
        Callable[[str, str, str], Mapping[str, object] | None] | None
    ) = None,
) -> ReplayRuntime:
    """Start replay only when enabled; disabled mode has no DB or task side effect."""

    runtime = ReplayRuntime(settings=settings)
    if not settings.enabled:
        return runtime

    factory = store_factory or ReplaySQLiteStore
    store: ReplaySQLiteStore | None = None
    service: ReplayService | None = None
    archive_lease: ReplayHistoryArchiveRuntimeLease | None = None
    try:
        archive_lease = ReplayHistoryArchiveRuntimeLease(
            settings.replay_history_archive_dir
        )
        archive_lease.acquire()
        store_task = asyncio.create_task(
            asyncio.to_thread(factory, str(settings.db_path)),
            name="replay-store-open",
        )
        try:
            store = await asyncio.shield(store_task)
        except asyncio.CancelledError:
            # Store construction runs in a thread and can finish after its
            # caller is cancelled.  Resolve the owned task and close the handle
            # before propagating cancellation so SQLite/WAL files are not left
            # open without a runtime owner.
            try:
                orphaned_store = await _await_task_uninterruptibly(store_task)
            except BaseException:
                pass
            else:
                await _close_store_uninterruptibly(orphaned_store)
            raise
        service_kwargs: dict[str, object] = {
            "settings": settings,
            "store": store,
        }
        if instrument_metadata_resolver is not None:
            service_kwargs["instrument_metadata_resolver"] = (
                instrument_metadata_resolver
            )
        if raw_trade_archive is None:
            raw_trade_archive = (
                (
                    RemoteRawAggTradeArchive(
                        settings.replay_agg_trade_archive_dir,
                        settings.replay_agg_trade_origin_uri,
                        refresh_seconds=(
                            settings.replay_history_catalog_refresh_seconds
                        ),
                        download_timeout_seconds=(
                            settings.replay_history_download_timeout_seconds
                        ),
                        page_rows=settings.trade_page_rows,
                    )
                    if settings.replay_agg_trade_origin_uri is not None
                    else ParquetRawAggTradeArchive(
                        settings.replay_agg_trade_archive_dir,
                        read_only=True,
                    )
                )
                if settings.replay_agg_trade_enabled
                else DisabledRawAggTradeArchive()
            )
        if raw_trade_archive is not None:
            service_kwargs["raw_trade_archive"] = raw_trade_archive
        service = service_factory(**service_kwargs)
        await service.start()
    except asyncio.CancelledError:
        await _cleanup_partial_start(service=service, store=store)
        if archive_lease is not None:
            archive_lease.release()
        raise
    except Exception as exc:
        await _cleanup_partial_start(service=service, store=store)
        if archive_lease is not None:
            archive_lease.release()
        raise ReplayStartupError("enabled replay runtime failed to initialize") from exc
    runtime.service = service
    runtime.archive_lease = archive_lease
    return runtime


async def _await_task_uninterruptibly(
    task: asyncio.Task[_TaskResult],
) -> _TaskResult:
    """Resolve an owned startup/cleanup task despite repeated cancellation."""

    while True:
        if task.done():
            return task.result()
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done():
                return task.result()


async def _close_store_uninterruptibly(store: ReplaySQLiteStore) -> None:
    close_task = asyncio.create_task(store.close(), name="replay-store-close")
    try:
        await _await_task_uninterruptibly(close_task)
    except BaseException:
        # Startup still has no safe runtime to publish.  Preserve the original
        # cancellation/startup failure after making the bounded close attempt.
        pass


async def _cleanup_partial_start(
    *,
    service: ReplayService | None,
    store: ReplaySQLiteStore | None,
) -> None:
    if service is not None:
        shutdown_task = asyncio.create_task(
            service.shutdown(step_timeout=_STARTUP_CLEANUP_STEP_TIMEOUT_SECONDS),
            name="replay-partial-start-shutdown",
        )
        try:
            await _await_task_uninterruptibly(shutdown_task)
        except BaseException:
            pass
    if store is not None and not store.closed:
        await _close_store_uninterruptibly(store)


__all__ = ["ReplayRuntime", "ReplayStartupError", "start_replay_runtime"]
