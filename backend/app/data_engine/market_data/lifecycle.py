"""Small keyed single-flight primitive for market-service lifecycle work."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Hashable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Coroutine, Generic, TypeVar


_KeyT = TypeVar("_KeyT", bound=Hashable)


@dataclass(slots=True)
class _LockEntry:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0


class KeyedAsyncLockPool(Generic[_KeyT]):
    """Serialize one identity without retaining idle locks indefinitely.

    The short guard protects only the lock table.  Waiting for an identity lock
    happens after the guard is released, so unrelated identities never queue
    behind network or storage work belonging to another stream.
    """

    def __init__(self) -> None:
        self._guard = asyncio.Lock()
        self._entries: dict[_KeyT, _LockEntry] = {}

    @property
    def active_keys(self) -> int:
        return len(self._entries)

    @asynccontextmanager
    async def hold(self, key: _KeyT) -> AsyncIterator[None]:
        async with self._guard:
            entry = self._entries.get(key)
            if entry is None:
                entry = _LockEntry()
                self._entries[key] = entry
            entry.users += 1
        try:
            async with entry.lock:
                yield
        finally:
            async with self._guard:
                entry.users -= 1
                if entry.users == 0 and not entry.lock.locked():
                    self._entries.pop(key, None)


async def drain_cancellation_safe_cleanup(
    cleanup: Coroutine[Any, Any, Any],
    *,
    name: str,
) -> bool:
    """Finish one bounded cleanup even if its caller is being cancelled.

    Start paths use this only after reserving lifecycle state.  The cleanup
    runs in its own task so caller cancellation cannot strand a live transport
    between creation and publication.  The return value tells non-exception
    paths to restore the caller's cancellation after cleanup completes.
    """

    task = asyncio.create_task(cleanup, name=name)
    caller_cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            caller_cancelled = caller_cancelled or bool(
                current is not None and current.cancelling()
            )
        except BaseException:
            break
    if task.done() and not task.cancelled():
        try:
            task.result()
        except BaseException:
            # Service-specific cleanup records its own degradation state.  Do
            # not replace the start failure/cancellation that triggered it.
            pass
    return caller_cancelled


__all__ = ["KeyedAsyncLockPool", "drain_cancellation_safe_cleanup"]
