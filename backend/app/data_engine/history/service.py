"""Shared façade for calendar lookup, boundary evidence and planning."""
from __future__ import annotations

from app.data_engine.history.calendar import CalendarRegistry
from app.data_engine.history.models import (
    BoundaryReason,
    BoundarySide,
    BoundaryState,
    HistoryAvailability,
    HistoryPlan,
    HistoryRequest,
    HistorySeriesKey,
    StoredHistoryBoundary,
    TimeBound,
)
from app.data_engine.history.planner import HistoryRequestPlanner
from app.data_engine.history.repository import HistoryBoundaryRepository


class HistoryAvailabilityService:
    """Single entry point intended for query, backfill and indicator layers."""

    def __init__(
        self,
        *,
        calendars: CalendarRegistry | None = None,
        boundaries: HistoryBoundaryRepository | None = None,
    ) -> None:
        self.calendars = calendars or CalendarRegistry()
        self.boundaries = boundaries

    def resolve_availability(
        self,
        key: HistorySeriesKey,
        availability: HistoryAvailability | None = None,
        *,
        now_ms: int | None = None,
    ) -> HistoryAvailability:
        base = availability or HistoryAvailability()
        if self.boundaries is None:
            return base
        return self.boundaries.load_availability(
            key,
            base,
            now_ms=now_ms,
            revision=base.revision or None,
        )

    def plan(
        self,
        request: HistoryRequest,
        availability: HistoryAvailability | None = None,
        *,
        now_ms: int | None = None,
        calendar_id: str | None = None,
    ) -> HistoryPlan:
        resolved = self.resolve_availability(
            request.series,
            availability,
            now_ms=now_ms,
        )
        selected_id = calendar_id or resolved.calendar_id
        calendar = self.calendars.get(selected_id)
        if calendar is None:
            return HistoryRequestPlanner.fail_closed(
                request,
                reason=BoundaryReason.CALENDAR_UNKNOWN,
                calendar_id=selected_id,
            )
        return HistoryRequestPlanner(calendar).plan(
            request,
            resolved,
            now_ms=now_ms,
        )

    def get_boundary(
        self,
        key: HistorySeriesKey,
        side: BoundarySide | str,
        *,
        now_ms: int | None = None,
        revision: str | None = None,
        include_stale: bool = False,
    ) -> StoredHistoryBoundary | None:
        if self.boundaries is None:
            return None
        return self.boundaries.get(
            key,
            side,
            now_ms=now_ms,
            revision=revision,
            include_stale=include_stale,
        )

    def record_boundary(
        self,
        key: HistorySeriesKey,
        side: BoundarySide | str,
        *,
        value_ms: int,
        reason: BoundaryReason | str,
        state: BoundaryState | str = BoundaryState.CANDIDATE,
        retryable: bool = False,
        revision: str = "",
        revalidate_at_ms: int | None = None,
        observed_at_ms: int | None = None,
        promote_after: int | None = None,
    ) -> StoredHistoryBoundary:
        """Record evidence and optionally promote repeated candidates.

        ``promote_after`` deliberately defaults to ``None`` so a single empty
        provider response can never become a permanent boundary by accident.
        """
        if self.boundaries is None:
            raise RuntimeError("history boundary repository is not configured")
        bound = TimeBound(
            value_ms=value_ms,
            reason=BoundaryReason(reason),
            state=BoundaryState(state),
            retryable=retryable,
            revision=revision,
            revalidate_at_ms=revalidate_at_ms,
        )
        record = self.boundaries.upsert(
            key,
            side,
            bound,
            observed_at_ms=observed_at_ms,
        )
        if (
            promote_after is not None
            and promote_after > 0
            and record.bound.state is BoundaryState.CANDIDATE
            and record.evidence_count >= promote_after
        ):
            promoted = self.boundaries.confirm(
                key,
                side,
                observed_at_ms=observed_at_ms,
            )
            assert promoted is not None
            return promoted
        return record
