"""Pure historical request planner."""
from __future__ import annotations

import time

from app.data_engine.history.calendar import (
    AlwaysOpenCalendar,
    TradingCalendar,
    latest_closed_expected_open_ms,
)
from app.data_engine.history.models import (
    BoundaryReason,
    HistoryAvailability,
    HistoryDisposition,
    HistoryExclusion,
    HistoryPlan,
    HistoryRequest,
    TimeBound,
    TimeRange,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


class HistoryRequestPlanner:
    """Intersect requests with lifetime, provider and calendar constraints."""

    def __init__(self, calendar: TradingCalendar | None = None) -> None:
        self.calendar = calendar or AlwaysOpenCalendar()

    def plan(
        self,
        request: HistoryRequest,
        availability: HistoryAvailability | None = None,
        *,
        now_ms: int | None = None,
        calendar: TradingCalendar | None = None,
    ) -> HistoryPlan:
        availability = availability or HistoryAvailability()
        current_ms = _now_ms() if now_ms is None else int(now_ms)
        selected_calendar = calendar or self.calendar
        requested = request.time_range

        if availability.disposition is HistoryDisposition.RETRYABLE:
            reason = availability.status_reason or BoundaryReason.TEMPORARY_UNAVAILABLE
            exclusion = HistoryExclusion(
                requested,
                HistoryDisposition.RETRYABLE,
                reason,
            )
            return HistoryPlan(
                request=request,
                disposition=HistoryDisposition.RETRYABLE,
                exclusions=(exclusion,),
                retryable=True,
                retry_at_ms=availability.retry_at_ms,
                calendar_id=selected_calendar.calendar_id,
            )

        if availability.disposition is HistoryDisposition.TERMINAL:
            reason = availability.status_reason or BoundaryReason.SOURCE_EXHAUSTED
            exclusion = HistoryExclusion(
                requested,
                HistoryDisposition.TERMINAL,
                reason,
            )
            return HistoryPlan(
                request=request,
                disposition=HistoryDisposition.TERMINAL,
                exclusions=(exclusion,),
                terminal=True,
                calendar_id=selected_calendar.calendar_id,
            )

        unknown = availability.disposition is HistoryDisposition.UNKNOWN
        lower_bounds: list[TimeBound] = []
        upper_bounds: list[TimeBound] = []
        for bound, target in (
            (availability.data_start, lower_bounds),
            (availability.upstream_start, lower_bounds),
            (availability.data_end, upper_bounds),
            (availability.upstream_end, upper_bounds),
        ):
            if bound is None:
                continue
            if not bound.is_active(now_ms=current_ms, revision=availability.revision or None):
                unknown = True
                continue
            if not bound.confirmed:
                unknown = True
                continue
            if bound.retryable:
                return HistoryPlan(
                    request=request,
                    disposition=HistoryDisposition.RETRYABLE,
                    exclusions=(HistoryExclusion(
                        requested,
                        HistoryDisposition.RETRYABLE,
                        bound.reason,
                        bound,
                    ),),
                    retryable=True,
                    retry_at_ms=bound.revalidate_at_ms,
                    calendar_id=selected_calendar.calendar_id,
                )
            target.append(bound)

        if availability.rolling_retention_ms is not None:
            lower_bounds.append(TimeBound(
                current_ms - availability.rolling_retention_ms,
                BoundaryReason.PROVIDER_RETENTION,
                revision=availability.revision,
                dynamic=True,
            ))

        lower_bound = max(lower_bounds, key=lambda item: item.value_ms, default=None)
        upper_bound = min(upper_bounds, key=lambda item: item.value_ms, default=None)
        effective_start = requested.start_ms
        effective_end = requested.end_ms
        exclusions: list[HistoryExclusion] = []

        if lower_bound is not None and effective_start < lower_bound.value_ms:
            excluded_end = min(effective_end, lower_bound.value_ms - 1)
            if effective_start <= excluded_end:
                exclusions.append(HistoryExclusion(
                    TimeRange(effective_start, excluded_end),
                    HistoryDisposition.TERMINAL,
                    lower_bound.reason,
                    lower_bound,
                ))
            effective_start = max(effective_start, lower_bound.value_ms)

        if upper_bound is not None and effective_end > upper_bound.value_ms:
            excluded_start = max(effective_start, upper_bound.value_ms + 1)
            if excluded_start <= effective_end:
                exclusions.append(HistoryExclusion(
                    TimeRange(excluded_start, effective_end),
                    HistoryDisposition.TERMINAL,
                    upper_bound.reason,
                    upper_bound,
                ))
            effective_end = min(effective_end, upper_bound.value_ms)

        # K-line history contains finalized bars only.  A request may use a
        # wall-clock or another interval's right edge, either of which can land
        # inside the target interval's forming bucket.  Keep that dynamic tail
        # out of expected/fetch work without turning it into a durable terminal
        # series boundary.
        if request.series.channel == "kline":
            requested_end_open_ms = selected_calendar.last_expected_open(
                effective_start,
                effective_end,
                request.interval,
            )
            last_closed_ms = latest_closed_expected_open_ms(
                selected_calendar,
                current_ms,
                request.interval,
                requested_end_ms=requested_end_open_ms,
            )
            if requested_end_open_ms is not None:
                # All later planner/calendar work is expressed in target-bar
                # opens.  Retaining a wall-clock close here would make the
                # already-selected bar look followed by a pseudo
                # market-closed millisecond range.
                effective_end = requested_end_open_ms
            if (
                requested_end_open_ms is not None
                and (last_closed_ms is None or requested_end_open_ms > last_closed_ms)
            ):
                # A full-day wall-clock edge (for example 23:59:59.999) has
                # the same target open as that just-closed daily bar.  Only
                # exclude from the first genuinely forming target bucket;
                # comparing raw timestamps would incorrectly defer the
                # already-closed candle until the following day.
                excluded_start = max(effective_start, requested_end_open_ms)
                if excluded_start <= effective_end:
                    tail_has_expected_open = bool(selected_calendar.open_segments(
                        excluded_start,
                        effective_end,
                        request.interval,
                    ))
                    tail_reason = (
                        BoundaryReason.FORMING_BAR
                        if tail_has_expected_open
                        else BoundaryReason.MARKET_CLOSED
                    )
                    forming_bound = TimeBound(
                        (
                            last_closed_ms
                            if last_closed_ms is not None
                            else requested_end_open_ms
                        ),
                        tail_reason,
                        revision=availability.revision,
                        dynamic=True,
                    )
                    exclusions.append(HistoryExclusion(
                        TimeRange(excluded_start, effective_end),
                        HistoryDisposition.NOT_EXPECTED,
                        tail_reason,
                        forming_bound,
                    ))
                effective_end = (
                    min(effective_end, last_closed_ms)
                    if last_closed_ms is not None
                    else effective_start - 1
                )

        if effective_start > effective_end:
            if not exclusions:
                deciding_bound = lower_bound or upper_bound
                exclusions.append(HistoryExclusion(
                    requested,
                    HistoryDisposition.TERMINAL,
                    deciding_bound.reason if deciding_bound else BoundaryReason.AVAILABILITY_UNKNOWN,
                    deciding_bound,
                ))
            terminal = any(
                item.disposition is HistoryDisposition.TERMINAL
                for item in exclusions
            )
            return HistoryPlan(
                request=request,
                disposition=(
                    HistoryDisposition.TERMINAL
                    if terminal
                    else HistoryDisposition.NOT_EXPECTED
                ),
                exclusions=tuple(exclusions),
                terminal=terminal,
                unknown=unknown,
                calendar_id=selected_calendar.calendar_id,
            )

        effective = TimeRange(effective_start, effective_end)
        raw_segments = selected_calendar.open_segments(
            effective.start_ms,
            effective.end_ms,
            request.interval,
        )
        segments = self._normalise_segments(raw_segments, effective)
        exclusions.extend(self._closed_ranges(effective, segments))

        if not segments:
            return HistoryPlan(
                request=request,
                disposition=(
                    HistoryDisposition.UNKNOWN if unknown else HistoryDisposition.NOT_EXPECTED
                ),
                exclusions=tuple(sorted(exclusions, key=lambda item: item.time_range.start_ms)),
                effective_range=effective,
                terminal=False,
                unknown=unknown,
                calendar_id=selected_calendar.calendar_id,
            )

        disposition = HistoryDisposition.UNKNOWN if unknown else HistoryDisposition.FETCH
        return HistoryPlan(
            request=request,
            disposition=disposition,
            fetch_ranges=segments,
            exclusions=tuple(sorted(exclusions, key=lambda item: item.time_range.start_ms)),
            effective_range=effective,
            terminal=False,
            unknown=unknown,
            calendar_id=selected_calendar.calendar_id,
        )

    @staticmethod
    def fail_closed(
        request: HistoryRequest,
        *,
        reason: BoundaryReason = BoundaryReason.CALENDAR_UNKNOWN,
        calendar_id: str | None = None,
    ) -> HistoryPlan:
        """Return an explicit unknown plan with no fetch ranges."""
        return HistoryPlan(
            request=request,
            disposition=HistoryDisposition.UNKNOWN,
            exclusions=(HistoryExclusion(
                request.time_range,
                HistoryDisposition.UNKNOWN,
                reason,
            ),),
            unknown=True,
            calendar_id=calendar_id,
        )

    @staticmethod
    def _normalise_segments(
        segments: tuple[TimeRange, ...],
        effective: TimeRange,
    ) -> tuple[TimeRange, ...]:
        clipped = [
            intersection
            for segment in segments
            if (intersection := segment.intersection(effective)) is not None
        ]
        if not clipped:
            return ()
        clipped.sort()
        merged: list[TimeRange] = [clipped[0]]
        for segment in clipped[1:]:
            previous = merged[-1]
            if segment.start_ms <= previous.end_ms:
                merged[-1] = TimeRange(previous.start_ms, max(previous.end_ms, segment.end_ms))
            else:
                merged.append(segment)
        return tuple(merged)

    @staticmethod
    def _closed_ranges(
        effective: TimeRange,
        segments: tuple[TimeRange, ...],
    ) -> tuple[HistoryExclusion, ...]:
        if not segments:
            return (HistoryExclusion(
                effective,
                HistoryDisposition.NOT_EXPECTED,
                BoundaryReason.MARKET_CLOSED,
            ),)
        result: list[HistoryExclusion] = []
        cursor = effective.start_ms
        for segment in segments:
            if cursor < segment.start_ms:
                result.append(HistoryExclusion(
                    TimeRange(cursor, segment.start_ms - 1),
                    HistoryDisposition.NOT_EXPECTED,
                    BoundaryReason.MARKET_CLOSED,
                ))
            cursor = max(cursor, segment.end_ms + 1)
        if cursor <= effective.end_ms:
            result.append(HistoryExclusion(
                TimeRange(cursor, effective.end_ms),
                HistoryDisposition.NOT_EXPECTED,
                BoundaryReason.MARKET_CLOSED,
            ))
        return tuple(result)
