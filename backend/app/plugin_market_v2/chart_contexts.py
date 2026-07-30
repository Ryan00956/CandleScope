"""Host-owned active chart context registry for Plugin Platform v2."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from candlescope_plugin_sdk.platform_v2 import (
    CHART_CONTEXT_V1,
    ChartContextReadRequest,
    ChartContextSnapshot,
    MarketContext,
    MarketSeries,
    PlatformContractError,
)

from .errors import market_error


@dataclass(frozen=True, slots=True)
class _ChartContextRecord:
    chart_id: str
    revision: int
    active: bool
    context: MarketContext | None
    series: MarketSeries | None
    updated_at_ms: int
    updated_monotonic: float


class ChartContextRegistry:
    """Tracks trusted frontend chart identity without exposing chart internals."""

    def __init__(
        self,
        *,
        ttl_seconds: float = 15.0,
        clock: Callable[[], float] = time.monotonic,
        wall_clock_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        if not 2.0 <= ttl_seconds <= 300.0:
            raise ValueError("chart context ttl_seconds is outside the supported range")
        self._ttl_seconds = float(ttl_seconds)
        self._clock = clock
        self._wall_clock_ms = wall_clock_ms
        self._records: dict[str, _ChartContextRecord] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _parse(
        chart_id: Any,
        active: Any,
        context: Any,
        series: Any,
    ) -> tuple[str, bool, MarketContext | None, MarketSeries | None]:
        try:
            parsed_chart_id = ChartContextReadRequest(chart_id=chart_id).chart_id
            if not isinstance(active, bool):
                raise PlatformContractError(
                    "INVALID_CONTRACT",
                    "chartContext.active must be a boolean",
                    "chartContext.active",
                )
            if active:
                parsed_context = MarketContext.from_wire(context)
                parsed_series = MarketSeries.from_wire(series)
                if parsed_context.mode != "live":
                    raise PlatformContractError(
                        "INVALID_CONTRACT",
                        "chartContext only supports live mode",
                        "chartContext.context.mode",
                    )
            else:
                if context is not None or series is not None:
                    raise PlatformContractError(
                        "INVALID_CONTRACT",
                        "inactive chartContext must use null context and series",
                        "chartContext",
                    )
                parsed_context = None
                parsed_series = None
        except PlatformContractError as exc:
            raise market_error(
                "CHART_CONTEXT_PARAMS_INVALID",
                exc.message,
                details={"path": exc.path} if exc.path else {},
            ) from exc
        return parsed_chart_id, active, parsed_context, parsed_series

    def update(
        self,
        *,
        chart_id: Any,
        active: Any,
        context: Any,
        series: Any,
    ) -> tuple[dict[str, Any], bool]:
        parsed_chart_id, parsed_active, parsed_context, parsed_series = self._parse(
            chart_id,
            active,
            context,
            series,
        )
        now = self._clock()
        updated_at_ms = self._wall_clock_ms()
        with self._lock:
            previous = self._records.get(parsed_chart_id)
            changed = (
                previous is None
                or previous.active != parsed_active
                or previous.context != parsed_context
                or previous.series != parsed_series
            )
            revision = 1 if previous is None else previous.revision + int(changed)
            record = _ChartContextRecord(
                chart_id=parsed_chart_id,
                revision=revision,
                active=parsed_active,
                context=parsed_context,
                series=parsed_series,
                updated_at_ms=updated_at_ms,
                updated_monotonic=now,
            )
            self._records[parsed_chart_id] = record
        return self._snapshot(record, now=now).to_wire(), changed

    def read(self, chart_id: Any) -> ChartContextSnapshot:
        try:
            parsed_chart_id = ChartContextReadRequest(chart_id=chart_id).chart_id
        except PlatformContractError as exc:
            raise market_error(
                "CHART_CONTEXT_PARAMS_INVALID",
                exc.message,
                details={"path": exc.path} if exc.path else {},
            ) from exc
        now = self._clock()
        with self._lock:
            record = self._records.get(parsed_chart_id)
        if record is None:
            return ChartContextSnapshot(
                chart_id=parsed_chart_id,
                revision=0,
                active=False,
                context=None,
                series=None,
                updated_at_ms=None,
            )
        return self._snapshot(record, now=now)

    def _snapshot(
        self,
        record: _ChartContextRecord,
        *,
        now: float,
    ) -> ChartContextSnapshot:
        fresh = now - record.updated_monotonic <= self._ttl_seconds
        active = record.active and fresh
        return ChartContextSnapshot(
            schema_version=CHART_CONTEXT_V1,
            chart_id=record.chart_id,
            revision=record.revision,
            active=active,
            context=record.context if active else None,
            series=record.series if active else None,
            updated_at_ms=record.updated_at_ms,
        )

    def matches(
        self,
        *,
        chart_id: str,
        chart_revision: int,
        context: MarketContext,
        series: MarketSeries,
    ) -> bool:
        snapshot = self.read(chart_id)
        return bool(
            snapshot.active
            and snapshot.revision == chart_revision
            and snapshot.context == context
            and snapshot.series == series
        )

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            chart_ids = sorted(self._records)
        return {
            "active": sum(self.read(chart_id).active for chart_id in chart_ids),
            "ttlSeconds": self._ttl_seconds,
            "charts": [self.read(chart_id).to_wire() for chart_id in chart_ids],
        }


__all__ = ["ChartContextRegistry"]
