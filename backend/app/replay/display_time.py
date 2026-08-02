"""Server-owned mapping from exchange buckets to the public replay timeline.

Blind replay keeps event order and elapsed time but must never expose the real
calendar.  Coarse candles still have to use the exchange's native bucket
boundaries.  This mapper gives each native source bucket an ordinal public
bucket without returning the actual anchor to the browser.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
    parse_monthly_count,
)


def _month_ordinal(timestamp_ms: int) -> int:
    value = datetime.fromtimestamp(timestamp_ms / 1_000, tz=timezone.utc)
    return value.year * 12 + value.month - 1


def _month_open_ms(ordinal: int) -> int:
    year, zero_based_month = divmod(ordinal, 12)
    return int(
        datetime(
            year,
            zero_based_month + 1,
            1,
            tzinfo=timezone.utc,
        ).timestamp()
        * 1_000
    )


@dataclass(frozen=True, slots=True)
class SourceBucketTimeMapper:
    """Map native exchange buckets onto canonical, synthetic public slots."""

    interval: str
    interval_ms: int
    actual_anchor_ms: int
    public_anchor_ms: int
    monthly_count: int | None
    source_bucket_anchor_ms: int

    @classmethod
    def create(
        cls,
        *,
        interval: str,
        actual_replay_start_ms: int,
        public_replay_start_ms: int,
        source_bucket_anchor_ms: int | None = None,
    ) -> "SourceBucketTimeMapper":
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms < 1:
            raise ValueError("display interval is invalid")
        monthly_count = (
            parse_monthly_count(interval) if is_monthly_interval(interval) else None
        )
        if source_bucket_anchor_ms is None:
            actual_anchor_ms = compute_bucket_start_ms(
                actual_replay_start_ms,
                interval_ms,
                interval=interval,
            )
            resolved_source_anchor_ms = compute_bucket_start_ms(
                0,
                interval_ms,
                interval=interval,
            )
        else:
            if isinstance(source_bucket_anchor_ms, bool) or not isinstance(
                source_bucket_anchor_ms, int
            ):
                raise ValueError("source bucket anchor is invalid")
            resolved_source_anchor_ms = source_bucket_anchor_ms
            if monthly_count is None:
                actual_anchor_ms = (
                    resolved_source_anchor_ms
                    + (
                        (actual_replay_start_ms - resolved_source_anchor_ms)
                        // interval_ms
                    )
                    * interval_ms
                )
            else:
                if (
                    compute_bucket_start_ms(
                        resolved_source_anchor_ms,
                        interval_ms,
                        interval=interval,
                    )
                    != resolved_source_anchor_ms
                ):
                    raise ValueError("source month anchor is not interval aligned")
                source_month = _month_ordinal(resolved_source_anchor_ms)
                actual_month = _month_ordinal(actual_replay_start_ms)
                actual_anchor_ms = _month_open_ms(
                    source_month
                    + ((actual_month - source_month) // monthly_count) * monthly_count
                )
        source_phase_ms = actual_replay_start_ms - actual_anchor_ms
        public_reference_ms = public_replay_start_ms - source_phase_ms
        if public_reference_ms < 0:
            raise ValueError("public replay origin cannot represent source buckets")
        public_anchor_ms = compute_bucket_start_ms(
            public_reference_ms,
            interval_ms,
            interval=interval,
        )
        if monthly_count is not None:
            # Calendar months have unequal lengths.  One complete public bucket
            # of slack keeps every ordinal projection causal even when the real
            # and synthetic calendars have different leap-month patterns.
            public_anchor_ms = compute_bucket_start_ms(
                public_anchor_ms - 1,
                interval_ms,
                interval=interval,
            )
        return cls(
            interval=interval,
            interval_ms=interval_ms,
            actual_anchor_ms=actual_anchor_ms,
            public_anchor_ms=public_anchor_ms,
            monthly_count=monthly_count,
            source_bucket_anchor_ms=resolved_source_anchor_ms,
        )

    def actual_bucket_ordinal(self, actual_bucket_open_ms: int) -> int:
        actual_open = self.actual_containing_bucket_open(actual_bucket_open_ms)
        if actual_open != actual_bucket_open_ms:
            raise ValueError("actual bucket open is not interval aligned")
        if self.monthly_count is None:
            distance_ms = actual_open - self.actual_anchor_ms
            if distance_ms % self.interval_ms:
                raise ValueError("actual bucket is outside the source bucket grid")
            return distance_ms // self.interval_ms
        distance_months = _month_ordinal(actual_open) - _month_ordinal(
            self.actual_anchor_ms
        )
        if distance_months % self.monthly_count:
            raise ValueError("actual month bucket is outside the source bucket grid")
        return distance_months // self.monthly_count

    def public_bucket_ordinal(self, public_bucket_open_ms: int) -> int:
        public_open = compute_bucket_start_ms(
            public_bucket_open_ms,
            self.interval_ms,
            interval=self.interval,
        )
        if public_open != public_bucket_open_ms:
            raise ValueError("public bucket open is not interval aligned")
        if self.monthly_count is None:
            distance_ms = public_open - self.public_anchor_ms
            if distance_ms % self.interval_ms:
                raise ValueError("public bucket is outside the projected grid")
            return distance_ms // self.interval_ms
        distance_months = _month_ordinal(public_open) - _month_ordinal(
            self.public_anchor_ms
        )
        if distance_months % self.monthly_count:
            raise ValueError("public month bucket is outside the projected grid")
        return distance_months // self.monthly_count

    def actual_bucket_open(self, ordinal: int) -> int:
        if self.monthly_count is None:
            return self.actual_anchor_ms + ordinal * self.interval_ms
        return _month_open_ms(
            _month_ordinal(self.actual_anchor_ms) + ordinal * self.monthly_count
        )

    def actual_containing_bucket_open(self, timestamp_ms: int) -> int:
        if self.monthly_count is None:
            return (
                self.actual_anchor_ms
                + ((timestamp_ms - self.actual_anchor_ms) // self.interval_ms)
                * self.interval_ms
            )
        anchor_month = _month_ordinal(self.actual_anchor_ms)
        timestamp_month = _month_ordinal(timestamp_ms)
        return _month_open_ms(
            anchor_month
            + ((timestamp_month - anchor_month) // self.monthly_count)
            * self.monthly_count
        )

    def public_bucket_open(self, ordinal: int) -> int:
        if self.monthly_count is None:
            return self.public_anchor_ms + ordinal * self.interval_ms
        return _month_open_ms(
            _month_ordinal(self.public_anchor_ms) + ordinal * self.monthly_count
        )

    def public_from_actual(self, actual_bucket_open_ms: int) -> int:
        return self.public_bucket_open(
            self.actual_bucket_ordinal(actual_bucket_open_ms)
        )

    def actual_from_public(self, public_bucket_open_ms: int) -> int:
        return self.actual_bucket_open(
            self.public_bucket_ordinal(public_bucket_open_ms)
        )

    def actual_bucket_end(self, actual_bucket_open_ms: int) -> int:
        return compute_bucket_end_ms(
            actual_bucket_open_ms,
            self.interval_ms,
            interval=self.interval,
        )

    def public_bucket_end(self, public_bucket_open_ms: int) -> int:
        return compute_bucket_end_ms(
            public_bucket_open_ms,
            self.interval_ms,
            interval=self.interval,
        )


__all__ = ["SourceBucketTimeMapper"]
