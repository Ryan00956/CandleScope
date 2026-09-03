"""Revision metadata for closed K-line series used by indicator caches.

Realtime previews are deliberately excluded.  A normal closed-bar append only
advances ``closedThrough`` while historical amendments/backfills advance the
``correctionRevision`` and retain a bounded dirty-range journal so reconnecting
clients can invalidate only data that may have changed.
"""
from __future__ import annotations

from app.data_engine.series_identity import (
    KlineSeriesIdentity,
    resolve_kline_series_identity,
)

import threading
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any


def _series_tuple(
    symbol: str,
    interval: str,
    *,
    exchange: str = "binance",
    market_type: str = "spot",
    series_identity: KlineSeriesIdentity | None = None,
) -> tuple[str, ...]:
    routed = (
        str(exchange or "binance").strip().lower(),
        str(market_type or "spot").strip().lower(),
        str(symbol or "").strip().upper(),
        str(interval or "").strip(),
    )
    identity = resolve_kline_series_identity(exchange, series_identity)
    return (
        routed
        if identity.is_legacy_default_for(exchange)
        else (*routed, *identity.storage_values)
    )


@dataclass(slots=True)
class _RevisionState:
    correction_revision: int = 0
    closed_through: int = 0
    # (revision, dirty_start_s, dirty_end_s)
    journal: deque[tuple[int, int, int]] = field(default_factory=deque)


class SeriesRevisionRegistry:
    """Process-local authoritative revision registry for indicator history.

    ``serverEpoch`` makes process restarts explicit.  The registry is derived
    metadata, so it intentionally is not persisted with K-lines.
    """

    def __init__(
        self,
        *,
        server_epoch: str | None = None,
        journal_limit: int = 256,
        event_dedup_limit: int = 1024,
    ) -> None:
        self.server_epoch = str(server_epoch or uuid.uuid4().hex)
        self._journal_limit = max(1, int(journal_limit))
        self._event_dedup_limit = max(1, int(event_dedup_limit))
        self._states: dict[tuple[str, ...], _RevisionState] = {}
        self._seen_events: OrderedDict[str, None] = OrderedDict()
        self._lock = threading.RLock()

    def observe_closed(
        self,
        symbol: str,
        interval: str,
        closed_through: int,
        *,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> dict[str, Any]:
        key = _series_tuple(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )
        with self._lock:
            state = self._states.setdefault(key, _RevisionState())
            state.closed_through = max(state.closed_through, int(closed_through or 0))
            return self._snapshot_locked(state)

    def record_correction(
        self,
        symbol: str,
        interval: str,
        start: int,
        end: int | None = None,
        *,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        key = _series_tuple(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )
        start_s = int(start or 0)
        end_s = max(start_s, int(end if end is not None else start_s))
        with self._lock:
            if event_id and self._event_seen_locked(repr((key, str(event_id)))):
                state = self._states.setdefault(key, _RevisionState())
                return self._snapshot_locked(state)

            state = self._states.setdefault(key, _RevisionState())
            state.correction_revision += 1
            state.closed_through = max(state.closed_through, end_s)
            state.journal.append((state.correction_revision, start_s, end_s))
            while len(state.journal) > self._journal_limit:
                state.journal.popleft()
            return self._snapshot_locked(state, dirty_range={"start": start_s, "end": end_s})

    def snapshot(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
        since_correction_revision: int | None = None,
    ) -> dict[str, Any]:
        key = _series_tuple(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )
        with self._lock:
            state = self._states.setdefault(key, _RevisionState())
            if since_correction_revision is None:
                return self._snapshot_locked(state)

            since = int(since_correction_revision)
            current = state.correction_revision
            if since == current:
                return self._snapshot_locked(state)
            if since < 0 or since > current:
                return self._snapshot_locked(state, history_invalid=True)

            required_first = since + 1
            if not state.journal or state.journal[0][0] > required_first:
                return self._snapshot_locked(state, history_invalid=True)
            dirty = [item for item in state.journal if item[0] > since]
            if not dirty or dirty[0][0] != required_first or dirty[-1][0] != current:
                return self._snapshot_locked(state, history_invalid=True)
            return self._snapshot_locked(
                state,
                dirty_range={
                    "start": min(item[1] for item in dirty),
                    "end": max(item[2] for item in dirty),
                },
            )

    def correction_token(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> str:
        snapshot = self.snapshot(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )
        return f"{snapshot['serverEpoch']}:{snapshot['correctionRevision']}"

    def diagnostics(self) -> dict[str, Any]:
        with self._lock:
            return {
                "serverEpoch": self.server_epoch,
                "series": len(self._states),
                "trackedCorrectionEvents": len(self._seen_events),
            }

    def _event_seen_locked(self, event_id: str) -> bool:
        if event_id in self._seen_events:
            self._seen_events.move_to_end(event_id)
            return True
        self._seen_events[event_id] = None
        while len(self._seen_events) > self._event_dedup_limit:
            self._seen_events.popitem(last=False)
        return False

    def _snapshot_locked(
        self,
        state: _RevisionState,
        *,
        dirty_range: dict[str, int] | None = None,
        history_invalid: bool = False,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "serverEpoch": self.server_epoch,
            "correctionRevision": state.correction_revision,
            "closedThrough": state.closed_through,
        }
        if dirty_range is not None:
            payload["dirtyRange"] = dirty_range
        if history_invalid:
            payload["historyInvalid"] = True
        return payload


__all__ = ["SeriesRevisionRegistry"]
