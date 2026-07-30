"""Bounded admission for speculative related-interval history warming."""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Hashable


@dataclass(frozen=True, slots=True)
class RelatedWarmupSubmission:
    """One target whose accepted range may be retained for a short TTL."""

    key: tuple[Hashable, ...]
    submit: Callable[[], bool]


@dataclass(slots=True)
class _PendingWarmup:
    generation: int
    prepare: Callable[[], Iterable[RelatedWarmupSubmission]]
    is_current: Callable[[], bool]
    foreground_busy: Callable[[], bool]
    foreground_idle_seconds: Callable[[], float] | None
    idle_since: float | None
    dwell_seconds: float
    handle: asyncio.TimerHandle | None = None


class RelatedIntervalWarmupScheduler:
    """Debounce, fence and TTL-dedupe speculative warmup submissions.

    The scheduler owns only admission.  Accepted work remains owned by the
    BackfillCoordinator, including exact exchange-budget deferral and physical
    active/pending singleflight.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = 300.0,
        dwell_seconds: float = 1.0,
        busy_recheck_seconds: float = 0.25,
        max_entries: int = 512,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._dwell_seconds = max(0.0, float(dwell_seconds))
        self._busy_recheck_seconds = max(0.01, float(busy_recheck_seconds))
        self._max_entries = max(1, int(max_entries))
        self._now = now
        self._pending: OrderedDict[tuple[Hashable, ...], _PendingWarmup] = OrderedDict()
        self._accepted_until: OrderedDict[tuple[Hashable, ...], float] = OrderedDict()
        self._sequence = 0
        self._metrics = {
            "scheduled": 0,
            "singleflight_joined": 0,
            "generation_dropped": 0,
            "foreground_deferred": 0,
            "ttl_hits": 0,
            "submitted": 0,
            "submit_failed": 0,
            "evicted": 0,
        }

    def schedule(
        self,
        group_key: tuple[Hashable, ...],
        *,
        prepare: Callable[[], Iterable[RelatedWarmupSubmission]],
        is_current: Callable[[], bool] = lambda: True,
        foreground_busy: Callable[[], bool] = lambda: False,
        foreground_idle_seconds: Callable[[], float] | None = None,
        dwell_seconds: float | None = None,
    ) -> bool:
        """Schedule or replace one pending group and return whether admitted."""

        loop = asyncio.get_running_loop()
        now = self._now()
        self._prune(now)
        normalized_key = tuple(group_key)
        previous = self._pending.pop(normalized_key, None)
        if previous is not None:
            if previous.handle is not None:
                previous.handle.cancel()
            self._metrics["singleflight_joined"] += 1

        self._sequence += 1
        pending = _PendingWarmup(
            generation=self._sequence,
            prepare=prepare,
            is_current=is_current,
            foreground_busy=foreground_busy,
            foreground_idle_seconds=foreground_idle_seconds,
            idle_since=now,
            dwell_seconds=max(
                0.0,
                self._dwell_seconds if dwell_seconds is None else float(dwell_seconds),
            ),
        )
        self._pending[normalized_key] = pending
        self._metrics["scheduled"] += 1
        self._trim_pending()
        self._arm(loop, normalized_key, pending, pending.dwell_seconds)
        return True

    def cancel(self) -> None:
        for pending in self._pending.values():
            if pending.handle is not None:
                pending.handle.cancel()
        self._pending.clear()
        self._accepted_until.clear()

    def snapshot(self) -> dict[str, int]:
        return {
            **self._metrics,
            "pending": len(self._pending),
            "ttl_entries": len(self._accepted_until),
        }

    def _arm(
        self,
        loop: asyncio.AbstractEventLoop,
        group_key: tuple[Hashable, ...],
        pending: _PendingWarmup,
        delay: float,
    ) -> None:
        pending.handle = loop.call_later(
            max(0.0, float(delay)),
            self._run,
            loop,
            group_key,
            pending.generation,
        )

    def _run(
        self,
        loop: asyncio.AbstractEventLoop,
        group_key: tuple[Hashable, ...],
        generation: int,
    ) -> None:
        pending = self._pending.get(group_key)
        if pending is None or pending.generation != generation:
            return
        pending.handle = None
        now = self._now()

        try:
            current = bool(pending.is_current())
        except Exception:
            current = False
        if not current:
            self._pending.pop(group_key, None)
            self._metrics["generation_dropped"] += 1
            return

        try:
            foreground_busy = bool(pending.foreground_busy())
        except Exception:
            foreground_busy = True
        if foreground_busy:
            pending.idle_since = None
            self._metrics["foreground_deferred"] += 1
            self._arm(loop, group_key, pending, self._busy_recheck_seconds)
            return

        external_idle: float | None = None
        if pending.foreground_idle_seconds is not None:
            try:
                external_idle = max(
                    0.0,
                    float(pending.foreground_idle_seconds()),
                )
            except Exception:
                external_idle = 0.0
        if pending.idle_since is None:
            pending.idle_since = now - min(
                pending.dwell_seconds,
                external_idle if external_idle is not None else 0.0,
            )
        quiet_for = max(0.0, now - pending.idle_since)
        if external_idle is not None:
            quiet_for = min(quiet_for, external_idle)
        if quiet_for < pending.dwell_seconds:
            self._arm(loop, group_key, pending, pending.dwell_seconds - quiet_for)
            return

        self._pending.pop(group_key, None)
        self._prune(now)
        try:
            submissions = tuple(pending.prepare())
        except Exception:
            self._metrics["submit_failed"] += 1
            return

        for submission in submissions:
            try:
                current = bool(pending.is_current())
            except Exception:
                current = False
            if not current:
                self._metrics["generation_dropped"] += 1
                break
            key = tuple(submission.key)
            if self._accepted_until.get(key, 0.0) > now:
                self._accepted_until.move_to_end(key)
                self._metrics["ttl_hits"] += 1
                continue
            try:
                accepted = submission.submit() is not False
            except Exception:
                accepted = False
            if not accepted:
                self._metrics["submit_failed"] += 1
                continue
            self._metrics["submitted"] += 1
            if self._ttl_seconds > 0:
                self._accepted_until[key] = now + self._ttl_seconds
                self._accepted_until.move_to_end(key)
                self._trim_ttl()

    def _prune(self, now: float) -> None:
        expired = [
            key for key, expires_at in self._accepted_until.items()
            if expires_at <= now
        ]
        for key in expired:
            self._accepted_until.pop(key, None)

    def _trim_pending(self) -> None:
        while len(self._pending) > self._max_entries:
            _key, pending = self._pending.popitem(last=False)
            if pending.handle is not None:
                pending.handle.cancel()
            self._metrics["evicted"] += 1

    def _trim_ttl(self) -> None:
        while len(self._accepted_until) > self._max_entries:
            self._accepted_until.popitem(last=False)
            self._metrics["evicted"] += 1
