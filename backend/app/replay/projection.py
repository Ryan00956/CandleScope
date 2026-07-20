"""Rate-bounded projection batching that never rewrites domain sequence."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from .constants import REPLAY_PROTOCOL, ReplayEventType
from .models import ReplayEvent


_UNMERGEABLE = object()
_PROJECTION_FIELDS = {
    "bar_update",
    "orders",
    "fills",
    "warnings",
    "position",
    "account",
}


@dataclass(frozen=True, slots=True)
class ProjectionBatch:
    sequence_from: int
    sequence_to: int
    latest_event: ReplayEvent
    mandatory: bool

    @property
    def event_count(self) -> int:
        return self.sequence_to - self.sequence_from + 1

    @property
    def sequence(self) -> int:
        """Expose the terminal domain sequence for queue consumers."""

        return self.sequence_to

    def to_wire_dict(self) -> dict[str, object]:
        """Serialize a replay.v1 frame, adding a range only when coalesced."""

        payload = self.latest_event.to_dict()
        if self.event_count > 1:
            payload["sequence_from"] = self.sequence_from
            payload["sequence_to"] = self.sequence_to
        return payload


@dataclass(slots=True)
class _PendingProjection:
    """Mutable, actor-owned accumulator materialized only when a frame is sent."""

    sequence_from: int
    latest_event: ReplayEvent
    projection: dict[str, object] | None = None
    bar_updates: list[dict[str, object]] | None = None
    orders: list[object] | None = None
    fills: list[object] | None = None
    warnings: list[object] | None = None

    @property
    def event_count(self) -> int:
        return self.latest_event.sequence - self.sequence_from + 1

    def merge(self, latest: ReplayEvent) -> bool:
        _validate_shared_identity(self.latest_event, latest)
        if self.projection is None:
            previous = _projection_parts(self.latest_event)
            if previous is None:
                return False
        else:
            previous = None
        incoming = _projection_parts(latest)
        if incoming is None:
            return False

        if previous is not None:
            self.projection, bar_updates, orders, fills, warnings = previous
            self.bar_updates = bar_updates
            self.orders = orders
            self.fills = fills
            self.warnings = warnings

        assert self.bar_updates is not None
        assert self.orders is not None
        assert self.fills is not None
        assert self.warnings is not None
        projection, bar_updates, orders, fills, warnings = incoming
        for update in bar_updates:
            _append_compacted_update(self.bar_updates, update)
        self.orders.extend(orders)
        self.fills.extend(fills)
        self.warnings.extend(warnings)
        self.projection = projection
        self.latest_event = latest
        return True

    def to_batch(self) -> ProjectionBatch:
        latest = self.latest_event
        if self.projection is None:
            materialized = latest
        else:
            assert self.bar_updates is not None
            assert self.orders is not None
            assert self.fills is not None
            assert self.warnings is not None
            projection = dict(self.projection)
            projection["bar_update"] = _materialize_bar_updates(self.bar_updates)
            projection["orders"] = self.orders
            projection["fills"] = self.fills
            projection["warnings"] = self.warnings
            data = dict(latest.data)
            data["projection"] = projection
            materialized = ReplayEvent(
                type=latest.type,
                protocol=latest.protocol,
                session_id=latest.session_id,
                sequence=latest.sequence,
                revision=latest.revision,
                virtual_time_ms=latest.virtual_time_ms,
                state_hash=latest.state_hash,
                data_epoch=latest.data_epoch,
                data=data,
            )
        return ProjectionBatch(
            sequence_from=self.sequence_from,
            sequence_to=latest.sequence,
            latest_event=materialized,
            mandatory=False,
        )


class ProjectionCoalescer:
    def __init__(self, *, max_fps: int, max_pending_events: int = 10_000) -> None:
        if isinstance(max_fps, bool) or not isinstance(max_fps, int) or max_fps < 1:
            raise ValueError("max_fps must be a positive integer")
        if (
            isinstance(max_pending_events, bool)
            or not isinstance(max_pending_events, int)
            or max_pending_events < 1
        ):
            raise ValueError("max_pending_events must be a positive integer")
        self._max_fps = max_fps
        self._max_pending_events = max_pending_events
        self._minimum_interval = 1.0 / max_fps
        self._last_ordinary_emit_wall: float | None = None
        self._last_offer_wall: float | None = None
        self._pending: _PendingProjection | None = None
        self._metrics = {
            "domain_events": 0,
            "ordinary_emitted": 0,
            "ordinary_coalesced": 0,
            "mandatory_emitted": 0,
            "flushes": 0,
            "capacity_forced_flushes": 0,
        }

    def offer(
        self,
        event: ReplayEvent,
        *,
        wall_time: float,
        mandatory: bool = False,
    ) -> tuple[ProjectionBatch, ...]:
        if not isinstance(event, ReplayEvent):
            raise TypeError("event must be ReplayEvent")
        wall = self._validate_wall_time(wall_time)
        if self._last_offer_wall is not None and wall < self._last_offer_wall:
            raise ValueError("projection wall_time cannot move backward")
        self._last_offer_wall = wall
        self._metrics["domain_events"] += 1
        emitted: list[ProjectionBatch] = []
        if mandatory:
            emitted.extend(self.flush())
            emitted.append(
                ProjectionBatch(
                    sequence_from=event.sequence,
                    sequence_to=event.sequence,
                    latest_event=event,
                    mandatory=True,
                )
            )
            self._metrics["mandatory_emitted"] += 1
            return tuple(emitted)

        due = (
            self._last_ordinary_emit_wall is None
            or wall - self._last_ordinary_emit_wall >= self._minimum_interval
        )
        if self._pending is None and due:
            emitted.append(
                ProjectionBatch(
                    sequence_from=event.sequence,
                    sequence_to=event.sequence,
                    latest_event=event,
                    mandatory=False,
                )
            )
            self._last_ordinary_emit_wall = wall
            self._metrics["ordinary_emitted"] += 1
            return tuple(emitted)

        if self._pending is None:
            self._pending = _PendingProjection(
                sequence_from=event.sequence,
                latest_event=event,
            )
        else:
            if not self._pending.merge(event):
                # An ordinary payload that is not semantically replaceable
                # must never inherit the previous range: doing so would claim
                # delivery of a frame whose payload was silently discarded.
                previous = self._pending.to_batch()
                self._pending = None
                emitted.extend(
                    (
                        previous,
                        ProjectionBatch(
                            sequence_from=event.sequence,
                            sequence_to=event.sequence,
                            latest_event=event,
                            mandatory=False,
                        ),
                    )
                )
                self._last_ordinary_emit_wall = wall
                self._metrics["ordinary_emitted"] += 2
                return tuple(emitted)
            self._metrics["ordinary_coalesced"] += 1
        if due:
            pending = self._pending.to_batch()
            assert pending is not None
            self._pending = None
            self._last_ordinary_emit_wall = wall
            self._metrics["ordinary_emitted"] += 1
            return (pending,)
        if self._pending.event_count >= self._max_pending_events:
            pending = self._pending.to_batch()
            self._pending = None
            self._last_ordinary_emit_wall = wall
            self._metrics["ordinary_emitted"] += 1
            self._metrics["capacity_forced_flushes"] += 1
            return (pending,)
        return ()

    def flush(self, *, wall_time: float | None = None) -> tuple[ProjectionBatch, ...]:
        if wall_time is not None:
            wall = self._validate_wall_time(wall_time)
            if self._last_offer_wall is not None and wall < self._last_offer_wall:
                raise ValueError("projection wall_time cannot move backward")
            self._last_offer_wall = wall
        if self._pending is None:
            return ()
        pending = self._pending.to_batch()
        self._pending = None
        if self._last_offer_wall is not None:
            self._last_ordinary_emit_wall = self._last_offer_wall
        self._metrics["ordinary_emitted"] += 1
        self._metrics["flushes"] += 1
        return (pending,)

    def flush_due(self, *, wall_time: float) -> tuple[ProjectionBatch, ...]:
        wall = self._validate_wall_time(wall_time)
        if self._last_offer_wall is not None and wall < self._last_offer_wall:
            raise ValueError("projection wall_time cannot move backward")
        if self._pending is None:
            return ()
        if self.next_flush_delay(wall_time=wall) > 0:
            return ()
        self._last_offer_wall = wall
        return self.flush()

    def next_flush_delay(self, *, wall_time: float) -> float | None:
        wall = self._validate_wall_time(wall_time)
        if self._pending is None:
            return None
        baseline = self._last_ordinary_emit_wall
        if baseline is None:
            return 0.0
        return max(0.0, baseline + self._minimum_interval - wall)

    def diagnostics(self) -> dict[str, int]:
        return {
            **self._metrics,
            "max_fps": self._max_fps,
            "pending": int(self._pending is not None),
            "pending_events": (
                0 if self._pending is None else self._pending.event_count
            ),
            "max_pending_events": self._max_pending_events,
        }

    @staticmethod
    def _validate_wall_time(value: float) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("wall_time must be a number")
        wall = float(value)
        if not math.isfinite(wall):
            raise ValueError("wall_time must be finite")
        return wall


def _validate_shared_identity(previous: ReplayEvent, latest: ReplayEvent) -> None:
    if (
        previous.protocol != REPLAY_PROTOCOL
        or latest.protocol != REPLAY_PROTOCOL
        or previous.session_id != latest.session_id
        or previous.data_epoch != latest.data_epoch
    ):
        raise ValueError("projection events do not share one replay identity")


def _projection_parts(
    event: ReplayEvent,
) -> tuple[
    dict[str, object],
    list[dict[str, object]],
    list[object],
    list[object],
    list[object],
] | None:
    if event.type is not ReplayEventType.DELTA:
        return None
    projection = event.data.get("projection")
    if not isinstance(projection, Mapping) or not _PROJECTION_FIELDS.issubset(
        projection
    ):
        return None
    bar_updates: list[dict[str, object]] = []
    bar_update = projection.get("bar_update")
    if bar_update is not None:
        if not isinstance(bar_update, Mapping) or not _collect_bar_update(
            bar_update,
            bar_updates,
        ):
            return None
    arrays: list[list[object]] = []
    for field_name in ("orders", "fills", "warnings"):
        value = projection.get(field_name)
        if not isinstance(value, (list, tuple)):
            return None
        arrays.append(list(value))
    return dict(projection), bar_updates, arrays[0], arrays[1], arrays[2]


def _materialize_bar_updates(updates: list[dict[str, object]]) -> object:
    if not updates:
        return None
    if len(updates) == 1:
        return updates[0]
    return {"action": "batch", "updates": updates}


def _merge_ordinary_events(
    previous: ReplayEvent,
    latest: ReplayEvent,
) -> ReplayEvent | None:
    """Merge replaceable DELTA projections without dropping structural bars.

    Actor-side classification keeps fills, changed orders, and warnings out of
    this path.  This helper still concatenates those arrays defensively so a
    future caller cannot silently discard them.
    """

    pending = _PendingProjection(
        sequence_from=previous.sequence,
        latest_event=previous,
    )
    if not pending.merge(latest):
        return None
    return pending.to_batch().latest_event


def _merge_projection(
    previous: Mapping[str, object],
    latest: Mapping[str, object],
) -> dict[str, object] | None:
    if not _PROJECTION_FIELDS.issubset(previous) or not _PROJECTION_FIELDS.issubset(
        latest
    ):
        return None
    merged = dict(latest)
    merged_bar_update = _merge_bar_updates(
        previous.get("bar_update"),
        latest.get("bar_update"),
    )
    if merged_bar_update is _UNMERGEABLE:
        return None
    merged["bar_update"] = merged_bar_update
    for field_name in ("orders", "fills", "warnings"):
        before = previous.get(field_name)
        after = latest.get(field_name)
        if not isinstance(before, (list, tuple)) or not isinstance(
            after,
            (list, tuple),
        ):
            return None
        merged[field_name] = [*before, *after]
    return merged


def _merge_bar_updates(previous: object, latest: object) -> object:
    updates: list[dict[str, object]] = []
    for candidate in (previous, latest):
        if candidate is None:
            continue
        if not isinstance(candidate, Mapping):
            return _UNMERGEABLE
        if not _collect_bar_update(candidate, updates):
            return _UNMERGEABLE
    return _materialize_bar_updates(updates)


def _collect_bar_update(
    candidate: Mapping[str, object],
    updates: list[dict[str, object]],
) -> bool:
    action = candidate.get("action")
    if action == "batch":
        nested = candidate.get("updates")
        if not isinstance(nested, (list, tuple)):
            return False
        for update in nested:
            if not isinstance(update, Mapping) or not _collect_bar_update(
                update,
                updates,
            ):
                return False
        return True
    if action not in {"append", "tick"}:
        return False
    bar = candidate.get("bar")
    if not isinstance(bar, Mapping):
        return False
    open_time_ms = bar.get("open_time_ms")
    if isinstance(open_time_ms, bool) or not isinstance(open_time_ms, int):
        return False
    _append_compacted_update(updates, dict(candidate))
    return True


def _append_compacted_update(
    updates: list[dict[str, object]],
    candidate: dict[str, object],
) -> None:
    """Keep structural appends and only replace redundant same-bar ticks."""

    if candidate.get("action") == "tick" and updates:
        previous = updates[-1]
        previous_bar = previous.get("bar")
        candidate_bar = candidate.get("bar")
        if (
            previous.get("action") == "tick"
            and isinstance(previous_bar, Mapping)
            and isinstance(candidate_bar, Mapping)
            and previous_bar.get("open_time_ms") == candidate_bar.get("open_time_ms")
        ):
            updates[-1] = candidate
            return
    updates.append(candidate)
