"""Deterministic base-bar schedule with explicitly verified market halts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
)

from ..canonical import canonical_sha256
from ..errors import ReplayDomainError, ReplayErrorCode
from ..market_halts import ReplayBarHalt


BAR_SCHEDULE_SCHEMA_VERSION = "replay-bar-schedule.v1"
VERIFIED_HALT_GAP_POLICY = "verified_market_halts_v2"


@dataclass(frozen=True, slots=True)
class ScheduledBarSegment:
    start_open_ms: int
    end_open_ms: int
    count: int


class ReplayBarSchedule:
    """Expected BAR opens after subtracting only pinned halt intervals."""

    def __init__(
        self,
        base_interval: str,
        verified_halts: Iterable[ReplayBarHalt] = (),
    ) -> None:
        interval_ms = parse_interval_ms(base_interval)
        if interval_ms is None or interval_ms <= 0:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "BAR schedule interval is unsupported",
            )
        halts = tuple(verified_halts)
        if any(not isinstance(halt, ReplayBarHalt) for halt in halts):
            raise TypeError("verified_halts must contain ReplayBarHalt values")
        if halts and is_monthly_interval(base_interval):
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "verified market halts require a fixed BAR interval",
            )
        if halts != tuple(sorted(halts)):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "verified BAR halts must be sorted",
            )
        for index, halt in enumerate(halts):
            if (
                compute_bucket_start_ms(
                    halt.start_open_ms,
                    interval_ms,
                    interval=base_interval,
                )
                != halt.start_open_ms
                or compute_bucket_start_ms(
                    halt.resume_ms,
                    interval_ms,
                    interval=base_interval,
                )
                != halt.resume_ms
                or halt.end_open_ms + interval_ms != halt.resume_ms
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "verified BAR halt is not aligned to the base interval",
                    details={"halt_id": halt.halt_id},
                )
            if index and halt.start_open_ms <= halts[index - 1].end_open_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "verified BAR halt ranges overlap",
                )
        self.base_interval = base_interval
        self.interval_ms = interval_ms
        self.verified_halts = halts
        self.gap_policy = VERIFIED_HALT_GAP_POLICY if halts else "reject"
        self.fingerprint = canonical_sha256(
            {
                "schema_version": BAR_SCHEDULE_SCHEMA_VERSION,
                "base_interval": base_interval,
                "verified_halts": [halt.to_dict() for halt in halts],
            }
        )

    @property
    def has_verified_halts(self) -> bool:
        return bool(self.verified_halts)

    def natural_next_open(self, open_time_ms: int) -> int:
        return compute_bucket_end_ms(
            open_time_ms,
            self.interval_ms,
            interval=self.base_interval,
        )

    def is_expected_open(self, open_time_ms: int) -> bool:
        if (
            compute_bucket_start_ms(
                open_time_ms,
                self.interval_ms,
                interval=self.base_interval,
            )
            != open_time_ms
        ):
            return False
        return not any(
            halt.start_open_ms <= open_time_ms <= halt.end_open_ms
            for halt in self.verified_halts
        )

    def next_expected_at_or_after(self, open_time_ms: int) -> int:
        candidate = open_time_ms
        while True:
            containing = next(
                (
                    halt
                    for halt in self.verified_halts
                    if halt.start_open_ms <= candidate <= halt.end_open_ms
                ),
                None,
            )
            if containing is None:
                return candidate
            candidate = containing.resume_ms

    def next_expected_open(self, open_time_ms: int) -> int:
        return self.next_expected_at_or_after(self.natural_next_open(open_time_ms))

    def nth_expected_open(self, start_open_ms: int, offset: int) -> int:
        if isinstance(offset, bool) or not isinstance(offset, int):
            raise TypeError("offset must be an integer")
        if offset < 0:
            raise ValueError("offset cannot be negative")
        cursor = self.next_expected_at_or_after(start_open_ms)
        if cursor != start_open_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR sequence starts inside a verified halt",
            )
        if not self.verified_halts:
            if not is_monthly_interval(self.base_interval):
                return cursor + offset * self.interval_ms
            for _ in range(offset):
                cursor = self.natural_next_open(cursor)
            return cursor

        remaining = offset
        for halt in self.verified_halts:
            if halt.end_open_ms < cursor:
                continue
            if halt.start_open_ms <= cursor:
                cursor = halt.resume_ms
                continue
            available = (halt.start_open_ms - cursor) // self.interval_ms
            if remaining < available:
                return cursor + remaining * self.interval_ms
            remaining -= available
            cursor = halt.resume_ms
        return cursor + remaining * self.interval_ms

    def expected_count(self, start_ms: int, end_ms: int) -> int:
        """Count expected opens in the aligned half-open interval."""

        if start_ms >= end_ms:
            return 0
        if not is_monthly_interval(self.base_interval):
            duration_ms = end_ms - start_ms
            if duration_ms % self.interval_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_INTERVAL,
                    "BAR schedule range cannot be tiled by the base interval",
                )
            total = duration_ms // self.interval_ms
            for halt in self.verified_halts:
                overlap_start = max(start_ms, halt.start_open_ms)
                overlap_end = min(end_ms, halt.resume_ms)
                if overlap_start < overlap_end:
                    total -= (overlap_end - overlap_start) // self.interval_ms
            return total

        count = 0
        cursor = start_ms
        while cursor < end_ms:
            cursor = self.natural_next_open(cursor)
            if cursor > end_ms:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_INTERVAL,
                    "calendar BAR schedule range cannot be tiled exactly",
                )
            count += 1
            if count > 1_200:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_INTERVAL,
                    "calendar interval ratio exceeds the supported bound",
                )
        return count

    def expected_bounds(
        self,
        start_ms: int,
        end_ms: int,
    ) -> tuple[int, int | None, int | None]:
        count = self.expected_count(start_ms, end_ms)
        if count == 0:
            return 0, None, None
        first = self.next_expected_at_or_after(start_ms)
        last = self.nth_expected_open(first, count - 1)
        if first < start_ms or last >= end_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "verified BAR schedule escaped its requested bucket",
            )
        return count, first, last

    def segments(
        self,
        start_open_ms: int,
        terminal_open_ms: int,
    ) -> tuple[ScheduledBarSegment, ...]:
        if terminal_open_ms < start_open_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR schedule terminal precedes its start",
            )
        if not self.is_expected_open(start_open_ms) or not self.is_expected_open(
            terminal_open_ms
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR schedule boundary falls inside a verified halt",
            )
        segments: list[ScheduledBarSegment] = []
        cursor = start_open_ms
        for halt in self.verified_halts:
            if halt.end_open_ms < cursor:
                continue
            if halt.start_open_ms > terminal_open_ms:
                break
            segment_end = halt.start_open_ms - self.interval_ms
            if cursor <= segment_end:
                segments.append(self._segment(cursor, segment_end))
            cursor = max(cursor, halt.resume_ms)
        if cursor <= terminal_open_ms:
            segments.append(self._segment(cursor, terminal_open_ms))
        if not segments:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR schedule contains no replayable rows",
            )
        return tuple(segments)

    def _segment(self, start_ms: int, end_ms: int) -> ScheduledBarSegment:
        duration_ms = end_ms - start_ms
        if duration_ms % self.interval_ms:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR schedule segment is not interval-aligned",
            )
        return ScheduledBarSegment(
            start_open_ms=start_ms,
            end_open_ms=end_ms,
            count=duration_ms // self.interval_ms + 1,
        )
