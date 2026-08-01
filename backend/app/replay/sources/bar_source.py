"""Immutable BAR dataset reader implementing the shared source contract."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from types import MappingProxyType

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


PAGED_BAR_SOURCE_SCHEMA_VERSION = "replay-paged-bar-source.v1"


class _PagedBarArchive:
    """Shared immutable-revision pages used by isolated source cursors."""

    def __init__(
        self,
        snapshot: BarDatasetSnapshot,
        *,
        terminal_open_ms: int,
        page_rows: int,
        page_loader: Callable[[int, int, int], tuple[ReplayBar, ...]],
    ) -> None:
        interval_ms = parse_interval_ms(snapshot.interval)
        if interval_ms is None or interval_ms <= 0:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "paged BAR source interval is unsupported",
            )
        if isinstance(terminal_open_ms, bool) or not isinstance(terminal_open_ms, int):
            raise TypeError("terminal_open_ms must be an integer")
        if terminal_open_ms < snapshot.replay_end_open_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "paged BAR terminal precedes the initial forward cache",
            )
        if (
            compute_bucket_start_ms(
                terminal_open_ms,
                interval_ms,
                interval=snapshot.interval,
            )
            != terminal_open_ms
            or (terminal_open_ms - snapshot.replay_start_ms) % interval_ms != 0
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "paged BAR terminal is not aligned to the frozen source",
            )
        if isinstance(page_rows, bool) or not isinstance(page_rows, int):
            raise TypeError("page_rows must be an integer")
        if page_rows < 1:
            raise ValueError("page_rows must be positive")
        if not callable(page_loader):
            raise TypeError("page_loader must be callable")
        self.snapshot = snapshot
        self.interval_ms = interval_ms
        self.terminal_open_ms = terminal_open_ms
        self.page_rows = page_rows
        self.page_loader = page_loader
        self.initial_rows = snapshot.replay_rows
        self.total_rows = (
            (terminal_open_ms - snapshot.replay_start_ms) // interval_ms + 1
        )
        self._pages: dict[int, tuple[ReplayBar, ...]] = {}

    def row_at(self, index: int) -> ReplayBar | None:
        if index < 0 or index >= self.total_rows:
            return None
        if index < len(self.initial_rows):
            return self.initial_rows[index]
        page_start = len(self.initial_rows) + (
            (index - len(self.initial_rows)) // self.page_rows
        ) * self.page_rows
        page = self._pages.get(page_start)
        if page is None:
            remaining = self.total_rows - page_start
            expected_count = min(self.page_rows, remaining)
            start_open_ms = (
                self.snapshot.replay_start_ms + page_start * self.interval_ms
            )
            end_open_ms = start_open_ms + (expected_count - 1) * self.interval_ms
            page = self.page_loader(start_open_ms, end_open_ms, expected_count)
            if not isinstance(page, tuple) or len(page) != expected_count:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "paged BAR loader did not return the committed source range",
                    details={
                        "expected_count": expected_count,
                        "actual_count": len(page) if isinstance(page, tuple) else None,
                    },
                )
            expected_open_ms = start_open_ms
            for row in page:
                if not isinstance(row, ReplayBar) or row.open_time_ms != expected_open_ms:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "paged BAR loader changed the committed source order",
                    )
                expected_close_ms = compute_bucket_end_ms(
                    expected_open_ms,
                    self.interval_ms,
                    interval=self.snapshot.interval,
                ) - 1
                if row.close_time_ms != expected_close_ms:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_INCOMPLETE,
                        "paged BAR loader returned an unclosed source row",
                    )
                expected_open_ms += self.interval_ms
            self._pages[page_start] = page
        return page[index - page_start]


class PagedBarReplaySource:
    """BAR source whose forward cache is not the logical replay horizon.

    The initial immutable snapshot remains the eagerly prepared cache.  Later
    pages are read from the same immutable archive revision through
    ``page_loader``.  The source identity is fixed up front, so page loading
    does not change checkpoints, forks, or the no-lookahead data epoch.
    """

    def __init__(
        self,
        snapshot: BarDatasetSnapshot,
        *,
        terminal_open_ms: int,
        source_revision: str,
        source_fingerprint: str,
        page_rows: int,
        page_loader: Callable[[int, int, int], tuple[ReplayBar, ...]],
    ) -> None:
        if not isinstance(snapshot, BarDatasetSnapshot):
            raise TypeError("snapshot must be BarDatasetSnapshot")
        BarReplaySource._validate_snapshot(snapshot)
        for field_name, value in (
            ("source_revision", source_revision),
            ("source_fingerprint", source_fingerprint),
        ):
            if (
                not isinstance(value, str)
                or len(value) != 71
                or not value.startswith("sha256:")
            ):
                raise ValueError(f"{field_name} must be a canonical SHA-256 digest")
            try:
                int(value[7:], 16)
            except ValueError as exc:
                raise ValueError(
                    f"{field_name} must be a canonical SHA-256 digest"
                ) from exc
        self._archive = _PagedBarArchive(
            snapshot,
            terminal_open_ms=terminal_open_ms,
            page_rows=page_rows,
            page_loader=page_loader,
        )
        initial_ref = snapshot.snapshot_ref().to_dict()
        self._snapshot_ref: Mapping[str, object] = MappingProxyType(
            {
                "schema_version": PAGED_BAR_SOURCE_SCHEMA_VERSION,
                "data_epoch": snapshot.data_epoch,
                "initial_snapshot_ref": initial_ref,
                "source_revision": source_revision,
                "source_fingerprint": source_fingerprint,
                "terminal_open_ms": terminal_open_ms,
                "page_rows": page_rows,
            }
        )
        self._index = 0

    @classmethod
    def _from_archive(
        cls,
        archive: _PagedBarArchive,
        snapshot_ref: Mapping[str, object],
        index: int,
    ) -> PagedBarReplaySource:
        source = object.__new__(cls)
        source._archive = archive
        source._snapshot_ref = snapshot_ref
        source._index = index
        return source

    def snapshot_ref(self) -> Mapping[str, object]:
        return self._snapshot_ref

    def fork(self) -> PagedBarReplaySource:
        return self._from_archive(self._archive, self._snapshot_ref, self._index)

    def fork_at_sequence(
        self,
        source_sequence: int,
        *,
        last_event_time_ms: int | None,
    ) -> PagedBarReplaySource:
        if isinstance(source_sequence, bool) or not isinstance(source_sequence, int):
            raise TypeError("source_sequence must be an integer")
        if source_sequence < 0 or source_sequence > self._archive.total_rows:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR checkpoint source sequence exceeds the committed archive range",
            )
        expected_last_time = (
            None
            if source_sequence == 0
            else self._archive.snapshot.replay_start_ms
            + source_sequence * self._archive.interval_ms
            - 1
        )
        if last_event_time_ms != expected_last_time:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR checkpoint source time does not match its sequence",
            )
        return self._from_archive(
            self._archive,
            self._snapshot_ref,
            source_sequence,
        )

    def peek(self) -> ReplayBar | None:
        return self._archive.row_at(self._index)

    def next(self) -> ReplayBar | None:
        event = self.peek()
        if event is not None:
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
        previous_open_ms = (
            None
            if self._index == 0
            else self._archive.snapshot.replay_start_ms
            + (self._index - 1) * self._archive.interval_ms
        )
        return SourceCursor(
            source_sequence=self._index,
            last_event_time_ms=(
                None
                if previous_open_ms is None
                else previous_open_ms + self._archive.interval_ms - 1
            ),
            last_base_bar_open_ms=previous_open_ms,
            at_end=self.exhausted(),
        )

    def exhausted(self) -> bool:
        return self._index >= self._archive.total_rows

    def remaining_count(self) -> int:
        return self._archive.total_rows - self._index


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

    def fork(self) -> BarReplaySource:
        """Return an O(1) isolated cursor over the same immutable snapshot."""

        forked = object.__new__(BarReplaySource)
        forked._snapshot = self._snapshot
        forked._warmup_rows = self._warmup_rows
        forked._rows = self._rows
        forked._index = self._index
        return forked

    def fork_at_sequence(
        self,
        source_sequence: int,
        *,
        last_event_time_ms: int | None,
    ) -> BarReplaySource:
        """Position an isolated cursor without replaying an immutable BAR prefix."""

        if isinstance(source_sequence, bool) or not isinstance(source_sequence, int):
            raise TypeError("source_sequence must be an integer")
        if source_sequence < 0 or source_sequence > len(self._rows):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR checkpoint source sequence exceeds the frozen dataset",
            )
        expected_last_time = (
            None
            if source_sequence == 0
            else self._rows[source_sequence - 1].close_time_ms
        )
        if last_event_time_ms != expected_last_time:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR checkpoint source time does not match its sequence",
            )
        forked = self.fork()
        forked._index = source_sequence
        return forked

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
