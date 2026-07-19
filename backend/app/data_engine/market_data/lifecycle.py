"""Small keyed single-flight primitive for market-service lifecycle work."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Hashable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Generic, TypeVar


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


__all__ = ["KeyedAsyncLockPool"]
