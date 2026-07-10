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
    revision_token: str
    start: int
    end: int
    task: asyncio.Task[dict[str, Any]]


class IndicatorRangeResultService:
    """Bounded result cache, revision registry and async singleflight owner."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        max_entries: int = 128,
        ttl_seconds: float = 180.0,
        server_epoch: str | None = None,
        revision_registry: SeriesRevisionRegistry | None = None,
    ) -> None:
        self.enabled = bool(enabled)
        self.max_entries = max(0, int(max_entries))
        self.ttl_seconds = max(0.0, float(ttl_seconds))
        self.revisions = revision_registry or SeriesRevisionRegistry(server_epoch=server_epoch)
        self._entries: list[_CacheEntry] = []
        self._lock = threading.RLock()
        self._flight_lock = asyncio.Lock()
        self._flights: list[_InFlight] = []
        self._bound_engines: dict[int, tuple[Any, Callable[[IndicatorEvent], None]]] = {}
        self._stats = {
            "hits": 0,
            "misses": 0,
            "puts": 0,
            "evictions": 0,
            "singleflightJoins": 0,
            "computes": 0,
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
        return revision

    def data_revision_for_series_key(self, series_key: str) -> dict[str, Any]:
        exchange, market_type, symbol, interval = series_key.split(":", 3)
        return self.data_revision_for_meta({
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
        })

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
                        _revision_retries=_revision_retries - 1,
                    )
                raise IndicatorRangeRevisionChangedError(
                    "K-line history changed repeatedly during indicator computation"
                )
            return computed, False, self.data_revision_for_meta(meta)

        identity = self.identity_from_meta(meta)
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
                    and item.start <= start
                    and item.end >= end
                    and item.task not in ignored_flights
                    and not item.task.done()
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
                    flight = _InFlight(identity, token, start, end, task)
                    self._flights.append(flight)
                    self._stats["computes"] += 1
                    task.add_done_callback(
                        lambda _task, current=flight: asyncio.create_task(self._drop_flight(current))
                    )
                else:
                    joined = True
                    self._stats["singleflightJoins"] += 1

            computed = await asyncio.shield(flight.task)
            if self.revision_token_for_meta(meta) != token:
                if _revision_retries > 0:
                    return await self.get_or_compute(
                        meta=meta,
                        start=start,
                        end=end,
                        compute=compute,
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
        coverage = event.detail.get("computedRange") if isinstance(event.detail, dict) else None
        if not isinstance(coverage, dict):
            coverage = event.detail.get("range") if isinstance(event.detail, dict) else None
        if not isinstance(coverage, dict):
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
        self.put_payload(meta, snapshot, start=start, end=end)

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
            return {
                "enabled": self.enabled,
                "serverEpoch": self.revisions.server_epoch,
                "entries": len(self._entries),
                "maxEntries": self.max_entries,
                "ttlSeconds": self.ttl_seconds,
                "series": self.revisions.diagnostics()["series"],
                "inFlight": len(self._flights),
                **self._stats,
            }

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


__all__ = ["IndicatorRangeResultService", "IndicatorRangeRevisionChangedError"]
