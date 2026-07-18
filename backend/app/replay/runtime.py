"""Feature-gated lifecycle owner for the persistent replay service."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Callable

from app.core.config import REPLAY_SETTINGS, ReplaySettings
from app.data_engine.storage.raw_trade_archive import RawAggTradeArchive

from .service import ReplayService
from .storage import ReplaySQLiteStore


class ReplayStartupError(RuntimeError):
    """Replay was enabled but its independent runtime could not start safely."""


@dataclass(slots=True)
class ReplayRuntime:
    """Own replay startup/shutdown without coupling replay to DataManager."""

    settings: ReplaySettings
    service: ReplayService | None = None

    @property
    def enabled(self) -> bool:
        return self.settings.enabled

    async def shutdown(self, *, step_timeout: float = 5.0) -> None:
        service = self.service
        if service is None:
            return
        await service.shutdown(step_timeout=step_timeout)
        self.service = None

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
) -> ReplayRuntime:
    """Start replay only when enabled; disabled mode has no DB or task side effect."""

    runtime = ReplayRuntime(settings=settings)
    if not settings.enabled:
        return runtime

    factory = store_factory or ReplaySQLiteStore
    store: ReplaySQLiteStore | None = None
    try:
        store = await asyncio.to_thread(factory, str(settings.db_path))
        service_kwargs: dict[str, object] = {
            "settings": settings,
            "store": store,
        }
        if raw_trade_archive is not None:
            service_kwargs["raw_trade_archive"] = raw_trade_archive
        service = service_factory(**service_kwargs)
        await service.start()
    except asyncio.CancelledError:
        if store is not None:
            await store.close()
        raise
    except Exception as exc:
        if store is not None:
            await store.close()
        raise ReplayStartupError("enabled replay runtime failed to initialize") from exc
    runtime.service = service
    return runtime


__all__ = ["ReplayRuntime", "ReplayStartupError", "start_replay_runtime"]
