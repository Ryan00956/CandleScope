"""Immutable BAR dataset reader implementing the shared source contract."""

from __future__ import annotations

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    parse_interval_ms,
)

from ..dataset import (
    BAR_DATASET_SCHEMA_VERSION,
    BarDatasetRef,
    BarDatasetSnapshot,
    ReplayBar,
)
from ..errors import ReplayDomainError, ReplayErrorCode
from .base import SourceCursor


class BarReplaySource:
    def __init__(self, snapshot: BarDatasetSnapshot) -> None:
        if not isinstance(snapshot, BarDatasetSnapshot):
            raise TypeError("snapshot must be BarDatasetSnapshot")
        self._validate_snapshot(snapshot)
        self._snapshot = snapshot
        self._warmup_rows = snapshot.warmup_rows
        self._rows = snapshot.replay_rows
        self._index = 0

    def snapshot_ref(self) -> BarDatasetRef:
        return self._snapshot.snapshot_ref()

    def peek(self) -> ReplayBar | None:
        if self._index >= len(self._rows):
            return None
        return self._rows[self._index]

    def warmup_rows(self) -> tuple[ReplayBar, ...]:
        return self._warmup_rows

    def revealed_replay_rows(self) -> tuple[ReplayBar, ...]:
        return self._rows[: self._index]

    def revealed_rows(self) -> tuple[ReplayBar, ...]:
        return self._warmup_rows + self.revealed_replay_rows()

    def remaining_count(self) -> int:
        return len(self._rows) - self._index

    def next(self) -> ReplayBar | None:
        event = self.peek()
        if event is None:
            return None
        self._index += 1
        return event

    def advance_until(self, target_time_ms: int) -> tuple[ReplayBar, ...]:
        if isinstance(target_time_ms, bool) or not isinstance(target_time_ms, int):
            raise TypeError("target_time_ms must be an integer")
        if target_time_ms < 0:
            raise ValueError("target_time_ms cannot be negative")
        events: list[ReplayBar] = []
        while (
            event := self.peek()
        ) is not None and event.close_time_ms <= target_time_ms:
            consumed = self.next()
            if consumed is not None:
                events.append(consumed)
        return tuple(events)

    def cursor(self) -> SourceCursor:
        previous = self._rows[self._index - 1] if self._index > 0 else None
        return SourceCursor(
            source_sequence=self._index,
            last_event_time_ms=(
                previous.close_time_ms if previous is not None else None
            ),
            last_base_bar_open_ms=(
                previous.open_time_ms if previous is not None else None
            ),
            at_end=self.exhausted(),
        )

    def exhausted(self) -> bool:
        return self._index >= len(self._rows)

    @staticmethod
    def _validate_snapshot(snapshot: BarDatasetSnapshot) -> None:
        if snapshot.schema_version != BAR_DATASET_SCHEMA_VERSION:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR source snapshot schema is incompatible",
            )
        interval_ms = parse_interval_ms(snapshot.interval)
        if interval_ms is None or interval_ms <= 0:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "BAR source interval is unsupported",
            )
        rows = snapshot.rows
        replay_index = snapshot.replay_start_index
        if (
            not rows
            or snapshot.warmup_bars != replay_index
            or replay_index < 0
            or replay_index >= len(rows)
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR source warmup/replay boundary is invalid",
            )
        provenance = snapshot.provenance
        if (
            provenance.identity != snapshot.identity
            or provenance.interval != snapshot.interval
            or provenance.row_count != len(rows)
            or provenance.first_open_ms != rows[0].open_time_ms
            or provenance.last_open_ms != rows[-1].open_time_ms
            or provenance.gap_count != 0
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR source provenance does not match snapshot rows",
            )
        if (
            rows[replay_index].open_time_ms != snapshot.replay_start_ms
            or rows[-1].open_time_ms != snapshot.replay_end_open_ms
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR source replay boundary does not match snapshot rows",
            )
        expected_open_ms = rows[0].open_time_ms
        for index, row in enumerate(rows):
            if not isinstance(row, ReplayBar):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "BAR source contains a non-ReplayBar row",
                )
            if row.open_time_ms != expected_open_ms:
                code = (
                    ReplayErrorCode.DATASET_MISMATCH
                    if row.open_time_ms <= expected_open_ms
                    else ReplayErrorCode.DATA_GAP
                )
                raise ReplayDomainError(
                    code,
                    "BAR source open times are not strictly contiguous",
                    details={
                        "row_index": index,
                        "expected_open_ms": expected_open_ms,
                        "actual_open_ms": row.open_time_ms,
                    },
                )
            next_open_ms = compute_bucket_end_ms(
                row.open_time_ms,
                interval_ms,
                interval=snapshot.interval,
            )
            if row.close_time_ms != next_open_ms - 1:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "BAR source row is not a fully closed base interval",
                    details={"row_index": index},
                )
            if (
                compute_bucket_start_ms(
                    row.open_time_ms,
                    interval_ms,
                    interval=snapshot.interval,
                )
                != row.open_time_ms
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "BAR source row is not aligned to its base interval",
                    details={"row_index": index},
                )
            if index < replay_index and row.open_time_ms >= snapshot.replay_start_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "BAR source warmup row crosses replay start",
                )
            if index >= replay_index and row.open_time_ms < snapshot.replay_start_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "BAR source replay row precedes replay start",
                )
            expected_open_ms = next_open_ms
