"""Application-scoped indicator range/result reuse.

The service is intentionally independent from the HTTP and WebSocket
transports.  Both transports publish snapshots into the same bounded cache,
while HTTP callers share in-flight computations and slice a covering cached
snapshot instead of constructing another temporary indicator engine.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from app.core import config
from app.data_engine.interval_policy import is_monthly_interval, parse_interval_ms
from app.data_engine.kline_quality import incoming_source_can_replace
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.serialization import build_indicator_snapshot_payload
from app.indicator.series_revision import SeriesRevisionRegistry


class IndicatorRangeRevisionChangedError(RuntimeError):
    """Closed-history revision changed repeatedly during a range compute."""


@dataclass(slots=True)
class _CacheEntry:
    identity: str
    series_key: str
    revision_token: str
    start: int
    end: int
    payload: dict[str, Any]
    created_at: float
    last_access: float


@dataclass(slots=True)
class _InFlight:
    identity: str
    series_key: str
    revision_token: str
    request_owner_id: str | None
    start: int
    end: int
    task: asyncio.Task[dict[str, Any]]
    waiters: int = 0


@dataclass(slots=True)
class _BarsCacheEntry:
    series_key: str
    revision_token: str
    start: int
    end: int
    warmup_bars: int
    bars: list[Any]
    created_at: float
    last_access: float


@dataclass(slots=True)
class _BarsInFlight:
    series_key: str
    revision_token: str
    query_owner_id: str | None
    start: int
    end: int
    warmup_bars: int
    task: asyncio.Task[list[Any]]
    waiters: int = 0


class IndicatorRangeResultService:
    """Bounded result cache, revision registry and async singleflight owner."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        max_entries: int = 128,
        ttl_seconds: float = 180.0,
        bars_cache_max_entries: int = 8,
        bars_cache_ttl_seconds: float = 2.0,
        server_epoch: str | None = None,
        revision_registry: SeriesRevisionRegistry | None = None,
    ) -> None:
        self.enabled = bool(enabled)
        self.max_entries = max(0, int(max_entries))
        self.ttl_seconds = max(0.0, float(ttl_seconds))
        self.bars_cache_max_entries = max(0, int(bars_cache_max_entries))
        self.bars_cache_ttl_seconds = max(0.0, float(bars_cache_ttl_seconds))
        self.revisions = revision_registry or SeriesRevisionRegistry(server_epoch=server_epoch)
        self._entries: list[_CacheEntry] = []
        self._lock = threading.RLock()
        self._flight_lock = asyncio.Lock()
        self._flights: list[_InFlight] = []
        self._bars_entries: list[_BarsCacheEntry] = []
        self._bars_flight_lock = asyncio.Lock()
        self._bars_flights: list[_BarsInFlight] = []
        self._bound_engines: dict[int, tuple[Any, Callable[[IndicatorEvent], None]]] = {}
        self._stats = {
            "hits": 0,
            "misses": 0,
            "puts": 0,
            "evictions": 0,
            "singleflightJoins": 0,
            "computes": 0,
            "cancelledOrphanComputes": 0,
            "barsHits": 0,
            "barsMisses": 0,
            "barsPuts": 0,
            "barsEvictions": 0,
            "barsSingleflightJoins": 0,
            "barsQueries": 0,
            "barsDeltaQueries": 0,
            "barsDeltaRowsReused": 0,
            "barsRevisionRebases": 0,
            "cancelledOrphanBarsQueries": 0,
        }

    @classmethod
    def from_config(
        cls,
        *,
        revision_registry: SeriesRevisionRegistry | None = None,
    ) -> "IndicatorRangeResultService":
        return cls(
            enabled=config.INDICATOR_RANGE_CACHE_ENABLED,
            max_entries=config.INDICATOR_RANGE_CACHE_MAX_ENTRIES,
            ttl_seconds=config.INDICATOR_RANGE_CACHE_TTL_SECONDS,
            bars_cache_max_entries=config.INDICATOR_BARS_CACHE_MAX_ENTRIES,
            bars_cache_ttl_seconds=config.INDICATOR_BARS_CACHE_TTL_SECONDS,
            revision_registry=revision_registry,
        )

    # ------------------------------------------------------------------
    # Stable keys and revisions
    # ------------------------------------------------------------------

    @staticmethod
    def series_key_from_meta(meta: dict[str, Any]) -> str:
        return ":".join((
            str(meta.get("exchange") or "binance").lower().strip(),
            str(meta.get("market_type") or meta.get("marketType") or "spot").lower().strip(),
            str(meta.get("symbol") or "").upper().strip(),
            str(meta.get("interval") or "").strip(),
        ))

    @staticmethod
    def series_key_from_indicator_key(key: Any) -> str:
        return ":".join((
            str(key.exchange).lower().strip(),
            str(key.market_type).lower().strip(),
            str(key.symbol).upper().strip(),
            str(key.interval).strip(),
        ))

    @classmethod
    def identity_from_meta(cls, meta: dict[str, Any]) -> str:
        if meta.get("kind") != "script" and meta.get("indicatorId"):
            return str(meta["indicatorId"])
        params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
        raw = json.dumps({
            "series": cls.series_key_from_meta(meta),
            "kind": meta.get("kind") or "builtin",
            "name": str(meta.get("name") or "").upper().strip(),
            "scriptHash": meta.get("scriptHash") or "",
            "codeHash": meta.get("codeHash") or "",
            "params": params,
            "securityMode": meta.get("securityMode") or "",
        }, sort_keys=True, separators=(",", ":"), default=str)
        return f"range:{hashlib.sha256(raw.encode()).hexdigest()}"

    def revision_token_for_meta(self, meta: dict[str, Any]) -> str:
        return self.revisions.correction_token(
            str(meta.get("symbol") or ""),
            str(meta.get("interval") or ""),
            exchange=str(meta.get("exchange") or "binance"),
            market_type=str(meta.get("market_type") or meta.get("marketType") or "spot"),
        )

    def data_revision_for_meta(self, meta: dict[str, Any]) -> dict[str, Any]:
        payload = self.revisions.snapshot(
            str(meta.get("symbol") or ""),
            str(meta.get("interval") or ""),
            exchange=str(meta.get("exchange") or "binance"),
            market_type=str(meta.get("market_type") or meta.get("marketType") or "spot"),
        )
        payload["revisionToken"] = (
            f"{payload['serverEpoch']}:{payload['correctionRevision']}"
        )
        return payload

    def note_closed(self, *, series_key: str, closed_through: int) -> None:
        exchange, market_type, symbol, interval = series_key.split(":", 3)
        self.revisions.observe_closed(
            symbol,
            interval,
            int(closed_through or 0),
            exchange=exchange,
            market_type=market_type,
        )

    def note_correction(
        self,
        *,
        series_key: str,
        start: int | None = None,
        end: int | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        """Advance one series revision and invalidate its derived snapshots."""
        exchange, market_type, symbol, interval = series_key.split(":", 3)
        previous_token = self.revisions.correction_token(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        revision = self.revisions.record_correction(
            symbol,
            interval,
            int(start or 0),
            int(end if end is not None else start or 0),
            exchange=exchange,
            market_type=market_type,
            event_id=event_id,
        )
        revision["revisionToken"] = (
            f"{revision['serverEpoch']}:{revision['correctionRevision']}"
        )
        if revision["revisionToken"] != previous_token:
            with self._lock:
                before = len(self._entries)
                self._entries = [entry for entry in self._entries if entry.series_key != series_key]
                self._stats["evictions"] += before - len(self._entries)
                retained_bars: list[_BarsCacheEntry] = []
                bars_evicted = 0
                bars_rebased = 0
                dirty_start = int(start or 0)
                dirty_end = int(end if end is not None else start or 0)
                for entry in self._bars_entries:
                    if entry.series_key != series_key:
                        retained_bars.append(entry)
                        continue
                    rebased = self._rebase_bars_entry_after_correction(
                        entry,
                        revision_token=revision["revisionToken"],
                        dirty_start=min(dirty_start, dirty_end),
                        dirty_end=max(dirty_start, dirty_end),
                    )
                    if rebased is None:
                        bars_evicted += 1
                    else:
                        retained_bars.append(rebased)
                        bars_rebased += 1
                self._bars_entries = retained_bars
                self._stats["barsEvictions"] += bars_evicted
                self._stats["barsRevisionRebases"] += bars_rebased
        return revision

    def data_revision_for_series_key(self, series_key: str) -> dict[str, Any]:
        exchange, market_type, symbol, interval = series_key.split(":", 3)
        return self.data_revision_for_meta({
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
        })

    def resident_series_intervals(
        self,
        symbol: str,
        *,
        market_type: str = "spot",
        exchange: str = "binance",
    ) -> tuple[str, ...]:
        """Return bounded cached or in-flight intervals for one market."""
        prefix = (
            f"{str(exchange).lower().strip()}:"
            f"{str(market_type).lower().strip()}:"
            f"{str(symbol).upper().strip()}:"
        )
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            self._prune_bars_locked(now)
            series_keys = {
                entry.series_key for entry in self._entries
            } | {
                entry.series_key for entry in self._bars_entries
            }
        # In-flight lists are event-loop owned.  Taking a synchronous snapshot
        # here cannot interleave with their mutation and avoids expanding the
        # correction bridge into asynchronous cache introspection.
        series_keys.update(
            flight.series_key for flight in tuple(self._flights)
        )
        series_keys.update(
            flight.series_key for flight in tuple(self._bars_flights)
        )
        return tuple(sorted({
            series_key[len(prefix):]
            for series_key in series_keys
            if series_key.startswith(prefix)
        }))

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------

    def _prune_locked(self, now: float) -> None:
        if self.ttl_seconds <= 0:
            expired = len(self._entries)
            self._entries.clear()
            self._stats["evictions"] += expired
            return
        cutoff = now - self.ttl_seconds
        kept = [entry for entry in self._entries if entry.last_access >= cutoff]
        self._stats["evictions"] += len(self._entries) - len(kept)
        self._entries = kept
        if self.max_entries <= 0:
            self._stats["evictions"] += len(self._entries)
            self._entries.clear()
            return
        if len(self._entries) > self.max_entries:
            self._entries.sort(key=lambda entry: entry.last_access, reverse=True)
            self._stats["evictions"] += len(self._entries) - self.max_entries
            del self._entries[self.max_entries:]

    def lookup_snapshot(
        self,
        meta: dict[str, Any],
        start: int,
        end: int,
        *,
        revision_token: str | None = None,
        count_stats: bool = True,
    ) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        identity = self.identity_from_meta(meta)
        token = revision_token or self.revision_token_for_meta(meta)
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            candidates = [
                entry for entry in self._entries
                if entry.identity == identity
                and entry.revision_token == token
                and entry.start <= start
                and entry.end >= end
            ]
            if not candidates:
                if count_stats:
                    self._stats["misses"] += 1
                return None
            entry = min(candidates, key=lambda item: item.end - item.start)
            entry.last_access = now
            if count_stats:
                self._stats["hits"] += 1
            return copy.deepcopy(entry.payload)

    def put_payload(
        self,
        meta: dict[str, Any],
        payload: dict[str, Any],
        *,
        start: int,
        end: int,
        revision_token: str | None = None,
    ) -> bool:
        if not self.enabled or self.max_entries <= 0 or end < start:
            return False
        identity = self.identity_from_meta(meta)
        series_key = self.series_key_from_meta(meta)
        token = revision_token or self.revision_token_for_meta(meta)
        if token != self.revision_token_for_meta(meta):
            return False
        now = time.monotonic()
        canonical = copy.deepcopy(payload)
        canonical["clientId"] = "__indicator_range_cache__"
        canonical["type"] = "indicator.snapshot"
        canonical.pop("reason", None)
        canonical["range"] = {"start": int(start), "end": int(end)}
        with self._lock:
            if token != self.revision_token_for_meta(meta):
                return False
            self._entries = [
                entry for entry in self._entries
                if not (
                    entry.identity == identity
                    and entry.revision_token == token
                    and entry.start == int(start)
                    and entry.end == int(end)
                )
            ]
            self._entries.append(_CacheEntry(
                identity=identity,
                series_key=series_key,
                revision_token=token,
                start=int(start),
                end=int(end),
                payload=canonical,
                created_at=now,
                last_access=now,
            ))
            self._stats["puts"] += 1
            self._prune_locked(now)
        self.note_closed(series_key=series_key, closed_through=int(end))
        return True

    async def get_or_compute(
        self,
        *,
        meta: dict[str, Any],
        start: int,
        end: int,
        compute: Callable[[], Awaitable[dict[str, Any]]],
        request_owner_id: str | None = None,
        _revision_retries: int = 1,
    ) -> tuple[dict[str, Any], bool, dict[str, Any]]:
        """Return a covering snapshot or share one covering in-flight compute."""
        token = self.revision_token_for_meta(meta)
        data_revision = self.data_revision_for_meta(meta)
        hit = self.lookup_snapshot(meta, start, end, revision_token=token)
        if hit is not None:
            if self.revision_token_for_meta(meta) != token:
                if _revision_retries > 0:
                    return await self.get_or_compute(
                        meta=meta,
                        start=start,
                        end=end,
                        compute=compute,
                        request_owner_id=request_owner_id,
                        _revision_retries=_revision_retries - 1,
                    )
                raise IndicatorRangeRevisionChangedError(
                    "K-line history changed while reading the indicator range cache"
                )
            return hit, True, data_revision
        if not self.enabled:
            computed = await compute()
            if self.revision_token_for_meta(meta) != token:
                if _revision_retries > 0:
                    return await self.get_or_compute(
                        meta=meta,
                        start=start,
                        end=end,
                        compute=compute,
                        request_owner_id=request_owner_id,
                        _revision_retries=_revision_retries - 1,
                    )
                raise IndicatorRangeRevisionChangedError(
                    "K-line history changed repeatedly during indicator computation"
                )
            return computed, False, self.data_revision_for_meta(meta)

        identity = self.identity_from_meta(meta)
        series_key = self.series_key_from_meta(meta)
        ignored_flights: set[asyncio.Task[dict[str, Any]]] = set()
        while True:
            joined = False
            async with self._flight_lock:
                hit = self.lookup_snapshot(
                    meta, start, end, revision_token=token, count_stats=False,
                )
                if hit is not None:
                    self._stats["hits"] += 1
                    return hit, True, data_revision
                flight = next((
                    item for item in self._flights
                    if item.identity == identity
                    and item.revision_token == token
                    and item.request_owner_id == request_owner_id
                    and item.start <= start
                    and item.end >= end
                    and item.task not in ignored_flights
                    and not item.task.done()
                    and not item.task.cancelling()
                ), None)
                if flight is None:
                    task = asyncio.create_task(
                        self._compute_and_cache(
                            meta=meta,
                            start=start,
                            end=end,
                            revision_token=token,
                            compute=compute,
                        ),
                        name=f"indicator-range:{identity[-20:]}:{start}-{end}",
                    )
                    flight = _InFlight(
                        identity,
                        series_key,
                        token,
                        request_owner_id,
                        start,
                        end,
                        task,
                        waiters=1,
                    )
                    self._flights.append(flight)
                    self._stats["computes"] += 1
                    task.add_done_callback(
                        lambda _task, current=flight: asyncio.create_task(self._drop_flight(current))
                    )
                else:
                    joined = True
                    flight.waiters += 1
                    self._stats["singleflightJoins"] += 1

            try:
                computed = await asyncio.shield(flight.task)
            finally:
                await self._release_flight_waiter(flight)
            if self.revision_token_for_meta(meta) != token:
                if _revision_retries > 0:
                    return await self.get_or_compute(
                        meta=meta,
                        start=start,
                        end=end,
                        compute=compute,
                        request_owner_id=request_owner_id,
                        _revision_retries=_revision_retries - 1,
                    )
                raise IndicatorRangeRevisionChangedError(
                    "K-line history changed repeatedly during indicator computation"
                )
            hit = self.lookup_snapshot(
                meta, start, end, revision_token=token, count_stats=False,
            )
            if hit is not None:
                return hit, joined, self.data_revision_for_meta(meta)
            if not joined:
                return copy.deepcopy(computed), False, self.data_revision_for_meta(meta)

            # The joined flight was selected by its requested bounds, but its
            # actual payload covered less data.  It cannot satisfy this caller;
            # retry against the caller's own compute closure instead of
            # returning a partial or non-overlapping payload.
            ignored_flights.add(flight.task)

    async def _compute_and_cache(
        self,
        *,
        meta: dict[str, Any],
        start: int,
        end: int,
        revision_token: str,
        compute: Callable[[], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        payload = await compute()
        actual_range = payload.get("range") if isinstance(payload, dict) else None
        actual_start = int(actual_range.get("start", start)) if isinstance(actual_range, dict) else start
        actual_end = int(actual_range.get("end", end)) if isinstance(actual_range, dict) else end
        self.put_payload(
            meta,
            payload,
            start=actual_start,
            end=actual_end,
            revision_token=revision_token,
        )
        return payload

    async def _drop_flight(self, flight: _InFlight) -> None:
        async with self._flight_lock:
            try:
                self._flights.remove(flight)
            except ValueError:
                pass

    async def _release_flight_waiter(self, flight: _InFlight) -> None:
        """Release one HTTP/WS waiter and cancel work nobody can consume.

        The task itself remains shielded so cancelling one joined request never
        cancels another request's computation.  Cancellation reaches the
        physical computation only after the final waiter has gone away.
        """
        async with self._flight_lock:
            flight.waiters = max(0, flight.waiters - 1)
            if flight.waiters or flight.task.done():
                return
            try:
                self._flights.remove(flight)
            except ValueError:
                pass
            flight.task.cancel()
            self._stats["cancelledOrphanComputes"] += 1

    # ------------------------------------------------------------------
    # Same-series K-line query reuse
    # ------------------------------------------------------------------

    @classmethod
    def _rebase_bars_entry_after_correction(
        cls,
        entry: _BarsCacheEntry,
        *,
        revision_token: str,
        dirty_start: int,
        dirty_end: int,
    ) -> _BarsCacheEntry | None:
        """Carry only a correction-disjoint contiguous side to a new revision.

        Leftward history growth advances the series correction token even
        though the already-rendered newer suffix did not change.  Throwing
        that suffix away makes every indicator request re-read the complete,
        progressively larger custom-interval window.  Keep the safe side of
        the dirty range, but fail closed for an interior split: one cache entry
        must never claim continuity across bars that may have been amended.
        """
        interval = entry.series_key.rsplit(":", 1)[-1]
        if (
            dirty_start <= 0
            or dirty_end <= 0
            or not entry.bars
            or is_monthly_interval(interval)
        ):
            return None

        if dirty_end < entry.start:
            # The correction is in the cached warmup prefix.  Drop it and any
            # still older rows so the retained target suffix stays contiguous.
            retained = [bar for bar in entry.bars if int(bar.time) > dirty_end]
            next_start = entry.start
            next_end = entry.end
        elif dirty_start > entry.end:
            retained = [bar for bar in entry.bars if int(bar.time) < dirty_start]
            next_start = entry.start
            next_end = entry.end
        elif dirty_start <= entry.start and dirty_end < entry.end:
            retained = [bar for bar in entry.bars if int(bar.time) > dirty_end]
            target_times = [
                int(bar.time)
                for bar in retained
                if entry.start <= int(bar.time) <= entry.end
            ]
            if not target_times:
                return None
            next_start = min(target_times)
            next_end = max(target_times)
        elif dirty_start > entry.start and dirty_end >= entry.end:
            retained = [bar for bar in entry.bars if int(bar.time) < dirty_start]
            target_times = [
                int(bar.time)
                for bar in retained
                if entry.start <= int(bar.time) <= entry.end
            ]
            if not target_times:
                return None
            next_start = min(target_times)
            next_end = max(target_times)
        else:
            # A correction strictly inside the target would split it into two
            # disjoint pieces.  Evict instead of hiding that hole.
            return None

        if (
            not retained
            or not cls._bars_are_strictly_contiguous(retained, interval=interval)
        ):
            return None
        available_warmup = sum(
            1 for bar in retained if int(bar.time) < next_start
        )
        return _BarsCacheEntry(
            series_key=entry.series_key,
            revision_token=revision_token,
            start=next_start,
            end=next_end,
            warmup_bars=available_warmup,
            bars=list(retained),
            created_at=entry.created_at,
            last_access=entry.last_access,
        )

    def _prune_bars_locked(self, now: float) -> None:
        if self.bars_cache_ttl_seconds <= 0:
            expired = len(self._bars_entries)
            self._bars_entries.clear()
            self._stats["barsEvictions"] += expired
            return
        cutoff = now - self.bars_cache_ttl_seconds
        kept = [entry for entry in self._bars_entries if entry.last_access >= cutoff]
        self._stats["barsEvictions"] += len(self._bars_entries) - len(kept)
        self._bars_entries = kept
        if self.bars_cache_max_entries <= 0:
            self._stats["barsEvictions"] += len(self._bars_entries)
            self._bars_entries.clear()
            return
        if len(self._bars_entries) > self.bars_cache_max_entries:
            self._bars_entries.sort(key=lambda entry: entry.last_access, reverse=True)
            self._stats["barsEvictions"] += (
                len(self._bars_entries) - self.bars_cache_max_entries
            )
            del self._bars_entries[self.bars_cache_max_entries:]

    def _lookup_bars(
        self,
        *,
        series_key: str,
        revision_token: str,
        start: int,
        end: int,
        warmup_bars: int,
        count_stats: bool = True,
    ) -> list[Any] | None:
        now = time.monotonic()
        with self._lock:
            self._prune_bars_locked(now)
            candidates = [
                entry for entry in self._bars_entries
                if entry.series_key == series_key
                and entry.revision_token == revision_token
                and entry.start <= start
                and entry.end >= end
                and entry.warmup_bars >= warmup_bars
            ]
            if not candidates:
                if count_stats:
                    self._stats["barsMisses"] += 1
                return None
            entry = min(
                candidates,
                key=lambda item: (item.end - item.start, item.warmup_bars),
            )
            entry.last_access = now
            if count_stats:
                self._stats["barsHits"] += 1
            # BarData is treated as immutable throughout indicator execution;
            # return a shallow container copy so consumers cannot resize the
            # cached list itself.
            return list(entry.bars)

    def _lookup_left_expansion_seed(
        self,
        *,
        series_key: str,
        revision_token: str,
        start: int,
        end: int,
    ) -> _BarsCacheEntry | None:
        """Return a newer contiguous suffix that can seed a left expansion."""
        interval = series_key.rsplit(":", 1)[-1]
        if is_monthly_interval(interval):
            return None
        now = time.monotonic()
        with self._lock:
            self._prune_bars_locked(now)
            candidates = [
                entry for entry in self._bars_entries
                if entry.series_key == series_key
                and entry.revision_token == revision_token
                and entry.start >= start
                and entry.start <= end
                and entry.end >= end
                and self._bars_are_strictly_contiguous(
                    entry.bars,
                    interval=interval,
                )
            ]
            if not candidates:
                return None
            # The earliest suffix minimizes the physical prefix still needed.
            entry = min(candidates, key=lambda item: item.start)
            entry.last_access = now
            return _BarsCacheEntry(
                series_key=entry.series_key,
                revision_token=entry.revision_token,
                start=entry.start,
                end=entry.end,
                warmup_bars=entry.warmup_bars,
                bars=list(entry.bars),
                created_at=entry.created_at,
                last_access=entry.last_access,
            )

    def _put_bars(
        self,
        *,
        series_key: str,
        revision_token: str,
        requested_start: int,
        requested_end: int,
        requested_warmup_bars: int,
        bars: list[Any],
    ) -> None:
        interval = series_key.rsplit(":", 1)[-1]
        if (
            not self.enabled
            or self.bars_cache_max_entries <= 0
            or not bars
            or not self._bars_are_strictly_contiguous(bars, interval=interval)
        ):
            return
        try:
            target_times = [
                int(bar.time)
                for bar in bars
                if requested_start <= int(bar.time) <= requested_end
            ]
        except (AttributeError, TypeError, ValueError):
            return
        if not target_times:
            return
        actual_start = min(target_times)
        actual_end = max(target_times)
        available_warmup = min(
            max(0, int(requested_warmup_bars)),
            sum(1 for bar in bars if int(bar.time) < actual_start),
        )
        meta = self.data_revision_for_series_key(series_key)
        if meta["revisionToken"] != revision_token:
            return
        now = time.monotonic()
        with self._lock:
            if self.data_revision_for_series_key(series_key)["revisionToken"] != revision_token:
                return
            self._bars_entries = [
                entry for entry in self._bars_entries
                if not (
                    entry.series_key == series_key
                    and entry.revision_token == revision_token
                    and (
                        (
                            entry.start == actual_start
                            and entry.end == actual_end
                            and entry.warmup_bars == available_warmup
                        )
                        or (
                            actual_start <= entry.start
                            and actual_end >= entry.end
                            and available_warmup >= entry.warmup_bars
                        )
                    )
                )
            ]
            self._bars_entries.append(_BarsCacheEntry(
                series_key=series_key,
                revision_token=revision_token,
                start=actual_start,
                end=actual_end,
                warmup_bars=available_warmup,
                bars=list(bars),
                created_at=now,
                last_access=now,
            ))
            self._stats["barsPuts"] += 1
            self._prune_bars_locked(now)

    @staticmethod
    def _merge_bars(
        earlier: list[Any],
        later: list[Any],
        *,
        start: int,
        end: int,
        warmup_bars: int,
        interval: str,
    ) -> list[Any]:
        """Merge a newly queried prefix with a cached suffix by provenance."""
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            return list(earlier)
        step_seconds = max(1, interval_ms // 1000)
        lower_bound = max(0, int(start) - max(0, int(warmup_bars)) * step_seconds)
        selected: dict[int, Any] = {}
        for bar in [*later, *earlier]:
            try:
                bar_time = int(bar.time)
            except (AttributeError, TypeError, ValueError):
                continue
            if bar_time < lower_bound or bar_time > int(end):
                continue
            existing = selected.get(bar_time)
            if existing is None or incoming_source_can_replace(
                getattr(existing, "source", None),
                getattr(bar, "source", None),
            ):
                selected[bar_time] = bar
        return [selected[item] for item in sorted(selected)]

    @staticmethod
    def _bars_are_strictly_contiguous(
        bars: list[Any],
        *,
        interval: str,
    ) -> bool:
        if not bars or is_monthly_interval(interval):
            return False
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0 or interval_ms % 1000 != 0:
            return False
        expected_step = interval_ms // 1000
        try:
            times = [int(bar.time) for bar in bars]
        except (AttributeError, TypeError, ValueError):
            return False
        return all(
            current - previous == expected_step
            for previous, current in zip(times, times[1:], strict=False)
        )

    @classmethod
    def _bars_cover_request(
        cls,
        bars: list[Any],
        *,
        start: int,
        end: int,
        warmup_bars: int,
        interval: str,
    ) -> bool:
        if not cls._bars_are_strictly_contiguous(bars, interval=interval):
            return False
        try:
            target_times = [
                int(bar.time)
                for bar in bars
                if start <= int(bar.time) <= end
            ]
        except (AttributeError, TypeError, ValueError):
            return False
        if not target_times:
            return False
        actual_start = min(target_times)
        actual_end = max(target_times)
        if actual_start > start or actual_end < end:
            return False
        available_warmup = sum(1 for bar in bars if int(bar.time) < actual_start)
        return available_warmup >= warmup_bars

    async def get_or_query_bars(
        self,
        *,
        meta: dict[str, Any],
        start: int,
        end: int,
        warmup_bars: int,
        query: Callable[[], Awaitable[list[Any]]],
        query_segment: Callable[[int, int, int], Awaitable[list[Any]]] | None = None,
        query_owner_id: str | None = None,
        _revision_retries: int = 1,
    ) -> list[Any]:
        """Return revision-matching covering bars or share one physical query.

        Only completed queries enter the short-lived cache.  A cancelled
        waiter cannot cancel a shared query; the query is cancelled once its
        final waiter leaves.
        """
        if not self.enabled:
            return list(await query())

        series_key = self.series_key_from_meta(meta)
        token = self.revision_token_for_meta(meta)
        warmup = max(0, int(warmup_bars))
        hit = self._lookup_bars(
            series_key=series_key,
            revision_token=token,
            start=int(start),
            end=int(end),
            warmup_bars=warmup,
        )
        if hit is not None:
            return hit

        ignored_flights: set[asyncio.Task[list[Any]]] = set()
        while True:
            joined = False
            async with self._bars_flight_lock:
                hit = self._lookup_bars(
                    series_key=series_key,
                    revision_token=token,
                    start=int(start),
                    end=int(end),
                    warmup_bars=warmup,
                    count_stats=False,
                )
                if hit is not None:
                    self._stats["barsHits"] += 1
                    return hit
                flight = next((
                    item for item in self._bars_flights
                    if item.series_key == series_key
                    and item.revision_token == token
                    and item.query_owner_id == query_owner_id
                    and item.start <= start
                    and item.end >= end
                    and item.warmup_bars >= warmup
                    and item.task not in ignored_flights
                    and not item.task.done()
                    and not item.task.cancelling()
                ), None)
                if flight is None:
                    query_for_task = query
                    expansion_seed = (
                        self._lookup_left_expansion_seed(
                            series_key=series_key,
                            revision_token=token,
                            start=int(start),
                            end=int(end),
                        )
                        if query_segment is not None
                        else None
                    )
                    if expansion_seed is not None:
                        interval = str(meta.get("interval") or "")
                        interval_ms = parse_interval_ms(interval)
                        if interval_ms is not None and interval_ms > 0:
                            step_seconds = max(1, interval_ms // 1000)
                            segment_end = (
                                expansion_seed.start - step_seconds
                                if expansion_seed.start > int(start)
                                else int(start)
                            )

                            async def _query_left_delta(
                                *,
                                _segment_end: int = segment_end,
                                _seed: _BarsCacheEntry = expansion_seed,
                            ) -> list[Any]:
                                assert query_segment is not None
                                prefix = await query_segment(
                                    int(start),
                                    _segment_end,
                                    warmup,
                                )
                                return self._merge_bars(
                                    list(prefix),
                                    _seed.bars,
                                    start=int(start),
                                    end=int(end),
                                    warmup_bars=warmup,
                                    interval=interval,
                                )

                            query_for_task = _query_left_delta
                            self._stats["barsDeltaQueries"] += 1
                            self._stats["barsDeltaRowsReused"] += len(
                                expansion_seed.bars
                            )
                    task = asyncio.create_task(
                        self._query_and_cache_bars(
                            series_key=series_key,
                            revision_token=token,
                            start=int(start),
                            end=int(end),
                            warmup_bars=warmup,
                            query=query_for_task,
                        ),
                        name=f"indicator-bars:{series_key}:{start}-{end}",
                    )
                    flight = _BarsInFlight(
                        series_key,
                        token,
                        query_owner_id,
                        int(start),
                        int(end),
                        warmup,
                        task,
                        waiters=1,
                    )
                    self._bars_flights.append(flight)
                    self._stats["barsQueries"] += 1
                    task.add_done_callback(
                        lambda _task, current=flight: asyncio.create_task(
                            self._drop_bars_flight(current)
                        )
                    )
                else:
                    joined = True
                    flight.waiters += 1
                    self._stats["barsSingleflightJoins"] += 1

            try:
                bars = await asyncio.shield(flight.task)
            finally:
                await self._release_bars_flight_waiter(flight)

            if self.revision_token_for_meta(meta) != token:
                if _revision_retries > 0:
                    return await self.get_or_query_bars(
                        meta=meta,
                        start=start,
                        end=end,
                        warmup_bars=warmup,
                        query=query,
                        query_segment=query_segment,
                        query_owner_id=query_owner_id,
                        _revision_retries=_revision_retries - 1,
                    )
                raise IndicatorRangeRevisionChangedError(
                    "K-line history changed repeatedly during indicator bars query"
                )

            hit = self._lookup_bars(
                series_key=series_key,
                revision_token=token,
                start=int(start),
                end=int(end),
                warmup_bars=warmup,
                count_stats=False,
            )
            if hit is not None:
                return hit
            if self._bars_cover_request(
                bars,
                start=int(start),
                end=int(end),
                warmup_bars=warmup,
                interval=str(meta.get("interval") or ""),
            ):
                return list(bars)
            if not joined:
                return list(bars)
            # A covering requested flight can still return a partial physical
            # range.  Do not treat that unfinished coverage as complete.
            ignored_flights.add(flight.task)

    async def _query_and_cache_bars(
        self,
        *,
        series_key: str,
        revision_token: str,
        start: int,
        end: int,
        warmup_bars: int,
        query: Callable[[], Awaitable[list[Any]]],
    ) -> list[Any]:
        bars = list(await query())
        self._put_bars(
            series_key=series_key,
            revision_token=revision_token,
            requested_start=start,
            requested_end=end,
            requested_warmup_bars=warmup_bars,
            bars=bars,
        )
        return bars

    async def _drop_bars_flight(self, flight: _BarsInFlight) -> None:
        async with self._bars_flight_lock:
            try:
                self._bars_flights.remove(flight)
            except ValueError:
                pass

    async def _release_bars_flight_waiter(self, flight: _BarsInFlight) -> None:
        async with self._bars_flight_lock:
            flight.waiters = max(0, flight.waiters - 1)
            if flight.waiters or flight.task.done():
                return
            try:
                self._bars_flights.remove(flight)
            except ValueError:
                pass
            flight.task.cancel()
            self._stats["cancelledOrphanBarsQueries"] += 1

    # ------------------------------------------------------------------
    # IndicatorEngine bridge
    # ------------------------------------------------------------------

    def bind_engine(self, engine: Any) -> None:
        if id(engine) in self._bound_engines:
            return

        def _listener(event: IndicatorEvent) -> None:
            self._on_engine_event(event)

        engine.add_listener(_listener)
        setattr(engine, "indicator_range_service", self)
        self._bound_engines[id(engine)] = (engine, _listener)

    def unbind_all(self) -> None:
        for engine, listener in list(self._bound_engines.values()):
            try:
                engine.remove_listener(listener)
            except Exception:
                pass
            if getattr(engine, "indicator_range_service", None) is self:
                try:
                    delattr(engine, "indicator_range_service")
                except AttributeError:
                    pass
        self._bound_engines.clear()

    def _on_engine_event(self, event: IndicatorEvent) -> None:
        series_key = self.series_key_from_indicator_key(event.key)
        if event.event_type == IndicatorEventType.INDICATOR_UPDATED:
            self.note_closed(series_key=series_key, closed_through=event.bar_timestamp)
            return
        if event.event_type not in {
            IndicatorEventType.INSTANCE_INITIALIZED,
            IndicatorEventType.INDICATOR_RECOMPUTED,
        } or event.full_result is None:
            return
        detail = event.detail if isinstance(event.detail, dict) else {}
        coverage = detail.get("computedRange")
        if not isinstance(coverage, dict):
            # ``detail.range`` may describe newly supplied seed bars rather
            # than the bars actually represented by a reused warm instance.
            # Without an explicit computedRange, the serialized result hull is
            # the only safe cache boundary and must not be widened.
            coverage = self._result_time_range(event.full_result)
        if not isinstance(coverage, dict):
            return
        try:
            start = int(coverage["start"])
            end = int(coverage["end"])
        except (KeyError, TypeError, ValueError):
            return
        meta = {
            "kind": "builtin",
            "exchange": event.key.exchange,
            "market_type": event.key.market_type,
            "symbol": event.key.symbol,
            "interval": event.key.interval,
            "name": event.key.indicator_name,
            "params": dict(event.key.params),
            "indicatorId": event.key.uid,
        }
        revision_token: str | None = None
        if "dataRevision" in detail:
            data_revision = detail.get("dataRevision")
            if not isinstance(data_revision, dict):
                return
            revision_token = str(data_revision.get("revisionToken") or "").strip()
            if not revision_token:
                return
            if revision_token != self.revision_token_for_meta(meta):
                return
        snapshot = build_indicator_snapshot_payload(
            client_id="__indicator_range_cache__",
            indicator_id=event.key.uid,
            exchange=event.key.exchange,
            symbol=event.key.symbol,
            interval=event.key.interval,
            market_type=event.key.market_type,
            name=event.key.indicator_name,
            params=dict(event.key.params),
            result=event.full_result,
        )
        self.put_payload(
            meta,
            snapshot,
            start=start,
            end=end,
            revision_token=revision_token,
        )

    @staticmethod
    def _result_time_range(result: Any) -> dict[str, int] | None:
        times: list[int] = []
        for output in getattr(result, "outputs", {}).values():
            for point in getattr(output, "data", []):
                try:
                    times.append(int(point.timestamp))
                except (TypeError, ValueError):
                    continue
        if not times:
            return None
        return {"start": min(times), "end": max(times)}

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            self._prune_bars_locked(now)
            return {
                "enabled": self.enabled,
                "serverEpoch": self.revisions.server_epoch,
                "entries": len(self._entries),
                "maxEntries": self.max_entries,
                "ttlSeconds": self.ttl_seconds,
                "barsEntries": len(self._bars_entries),
                "barsMaxEntries": self.bars_cache_max_entries,
                "barsTtlSeconds": self.bars_cache_ttl_seconds,
                "barsInFlight": len(self._bars_flights),
                "series": self.revisions.diagnostics()["series"],
                "inFlight": len(self._flights),
                **self._stats,
            }

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bars_entries.clear()


__all__ = ["IndicatorRangeResultService", "IndicatorRangeRevisionChangedError"]
