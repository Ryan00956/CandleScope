"""Backfill request coordination for DataManager."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.data_engine.interval_policy import parse_interval_ms
from .models import BarData, DataEvent, DataEventType, SeriesKey

logger = logging.getLogger("data_manager.backfill_coordinator")


@dataclass(slots=True)
class RepairRequest:
    """A single requested historical repair range."""

    symbol: str
    interval: str
    start_ms: int
    end_ms: int
    exchange: str = "binance"
    market_type: str = "spot"
    reason: str = "query_gap"
    metadata: dict[str, Any] = field(default_factory=dict)
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    @property
    def series_key(self) -> tuple[str, str, str, str]:
        return (
            self.exchange.lower().strip(),
            self.market_type.lower().strip(),
            self.symbol.upper().strip(),
            self.interval,
        )

    def merged_with(self, other: RepairRequest) -> RepairRequest:
        """Return a range that covers both requests for the same series."""
        metadata = {**self.metadata, **other.metadata}
        metadata.setdefault("merged_request_ids", [])
        metadata["merged_request_ids"] = [
            *metadata["merged_request_ids"],
            self.request_id,
            other.request_id,
        ]
        return RepairRequest(
            symbol=self.symbol,
            interval=self.interval,
            start_ms=min(self.start_ms, other.start_ms),
            end_ms=max(self.end_ms, other.end_ms),
            exchange=self.exchange,
            market_type=self.market_type,
            reason=f"{self.reason}+{other.reason}",
            metadata=metadata,
            request_id=self.request_id,
        )


@dataclass(slots=True)
class RepairOutcome:
    request: RepairRequest
    status: Any
    report: Any | None = None
    attempts: int = 0
    bars_loaded: int = 0
    error: str | None = None


@dataclass(slots=True)
class ScanReport:
    scanned: int = 0
    repaired: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "repaired": self.repaired,
            "failed": self.failed,
            "errors": list(self.errors),
        }


@dataclass(slots=True)
class _SeriesState:
    current: RepairRequest | None = None
    pending: RepairRequest | None = None
    task: asyncio.Task | None = None


class BackfillCoordinator:
    """Serializes backfill work and owns cache reload after repair."""

    def __init__(
        self,
        *,
        data_manager: Any,
        storage: Any,
        engine: Any | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        max_retries: int = 3,
        base_delay_seconds: float = 5.0,
    ) -> None:
        self._dm = data_manager
        self._storage = storage
        self._engine = engine
        self._loop = loop
        self._max_retries = max(1, max_retries)
        self._base_delay_seconds = base_delay_seconds

        self._series: dict[tuple[str, str, str, str], _SeriesState] = {}
        self._futures: dict[str, asyncio.Future[RepairOutcome]] = {}
        self._outcomes: dict[str, RepairOutcome] = {}
        self._shutdown = False

        self._submitted = 0
        self._deduped = 0
        self._merged = 0

    def set_engine(self, engine: Any) -> None:
        self._engine = engine

    def trigger(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Synchronous QueryEngine-compatible callback."""
        self.request(RepairRequest(
            symbol=symbol,
            interval=interval,
            start_ms=int(start_ms),
            end_ms=int(end_ms),
            exchange=exchange,
            market_type=market_type,
        ))

    def request(self, request: RepairRequest) -> str:
        """Submit a repair request and return its request id."""
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                raise RuntimeError("BackfillCoordinator requires an event loop")

        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None

        if running_loop is self._loop:
            return self._request_in_loop(request)[0]

        self._loop.call_soon_threadsafe(self._request_in_loop, request)
        return request.request_id

    async def request_and_wait(self, request: RepairRequest) -> RepairOutcome:
        request_id, future = self._request_in_loop(request)
        return await future

    async def startup_scan(
        self,
        targets: list[tuple[str, str, str]],
        intervals: tuple[str, ...],
        *,
        delay_seconds: float = 5.0,
    ) -> ScanReport:
        """Scan configured startup targets and repair stale tails."""
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)

        report = ScanReport()
        now_ms = int(time.time() * 1000)

        for exchange, market_type, symbol in targets:
            for interval in intervals:
                if self._shutdown:
                    return report
                try:
                    bounds = self._storage.get_bounds(
                        symbol,
                        interval,
                        exchange=exchange,
                        market_type=market_type,
                    )
                    latest = bounds.get("latest_open_time")
                    if not latest:
                        continue

                    interval_ms = parse_interval_ms(interval) or 60_000
                    if now_ms - int(latest) <= interval_ms * 3:
                        continue

                    report.scanned += 1
                    outcome = await self.request_and_wait(RepairRequest(
                        symbol=symbol,
                        interval=interval,
                        start_ms=int(latest),
                        end_ms=now_ms,
                        exchange=exchange,
                        market_type=market_type,
                        reason="startup_gap_scan",
                    ))
                    if self._is_failed(outcome.status):
                        report.failed += 1
                        if outcome.error:
                            report.errors.append(outcome.error)
                    else:
                        report.repaired += 1
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    report.failed += 1
                    report.errors.append(
                        f"{exchange}:{market_type}:{symbol}@{interval}: {exc}"
                    )
                    logger.warning(
                        "Startup gap scan failed for %s:%s:%s@%s: %s",
                        exchange,
                        market_type,
                        symbol,
                        interval,
                        exc,
                    )

        return report

    async def shutdown(self) -> None:
        """Cancel active and pending repairs."""
        self._shutdown = True
        tasks = [
            state.task
            for state in self._series.values()
            if state.task is not None and not state.task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def snapshot(self) -> dict:
        active = [
            ":".join(series)
            for series, state in self._series.items()
            if state.task is not None and not state.task.done()
        ]
        pending = [
            ":".join(series)
            for series, state in self._series.items()
            if state.pending is not None
        ]
        return {
            "submitted": self._submitted,
            "deduped": self._deduped,
            "merged": self._merged,
            "active": active,
            "pending": pending,
            "recent_outcomes": {
                request_id: {
                    "status": self._status_value(outcome.status),
                    "attempts": outcome.attempts,
                    "bars_loaded": outcome.bars_loaded,
                    "error": outcome.error,
                }
                for request_id, outcome in list(self._outcomes.items())[-20:]
            },
        }

    def _request_in_loop(
        self,
        request: RepairRequest,
    ) -> tuple[str, asyncio.Future[RepairOutcome]]:
        if self._shutdown:
            raise RuntimeError("BackfillCoordinator is shut down")

        self._submitted += 1
        series_key = request.series_key
        state = self._series.setdefault(series_key, _SeriesState())

        if state.current is not None:
            if self._covers(state.current, request):
                self._deduped += 1
                return state.current.request_id, self._future_for(state.current)

            if state.pending is None:
                state.pending = request
                return request.request_id, self._future_for(request)

            state.pending = state.pending.merged_with(request)
            self._merged += 1
            return state.pending.request_id, self._future_for(state.pending)

        state.current = request
        future = self._future_for(request)
        state.task = asyncio.create_task(
            self._run_series(series_key, state),
            name=f"backfill:{request.exchange}:{request.market_type}:{request.symbol}@{request.interval}",
        )
        return request.request_id, future

    def _future_for(self, request: RepairRequest) -> asyncio.Future[RepairOutcome]:
        future = self._futures.get(request.request_id)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            self._futures[request.request_id] = future
        return future

    async def _run_series(
        self,
        series_key: tuple[str, str, str, str],
        state: _SeriesState,
    ) -> None:
        try:
            while state.current is not None and not self._shutdown:
                request = state.current
                try:
                    outcome = await self._run_with_retries(request)
                except asyncio.CancelledError:
                    outcome = RepairOutcome(
                        request=request,
                        status="failed",
                        error="cancelled",
                    )
                    self._complete(request, outcome)
                    raise
                self._complete(request, outcome)
                state.current = state.pending
                state.pending = None
        finally:
            state.task = None
            if state.current is None and state.pending is None:
                self._series.pop(series_key, None)

    async def _run_with_retries(self, request: RepairRequest) -> RepairOutcome:
        if self._engine is None:
            return RepairOutcome(
                request=request,
                status="failed",
                error="BackfillEngine is not configured",
            )

        last_error: str | None = None
        report: Any | None = None

        for attempt in range(1, self._max_retries + 1):
            try:
                report = await self._engine.run(
                    symbol=request.symbol,
                    intervals=[request.interval],
                    range_start_ms=request.start_ms,
                    range_end_ms=request.end_ms,
                    exchange=request.exchange,
                    market_type=request.market_type,
                    metadata={
                        **request.metadata,
                        "reason": request.reason,
                        "request_id": request.request_id,
                    },
                )
                if self._is_failed(report.status) and attempt < self._max_retries:
                    await asyncio.sleep(self._backoff(attempt))
                    continue

                bars_loaded = 0
                if not self._is_failed(report.status):
                    bars_loaded = await self._load_backfilled_to_cache(request, report)
                    await self._emit_completion_if_needed(request, report, bars_loaded)

                if self._is_failed(report.status):
                    await self._emit_failed(request, report)

                return RepairOutcome(
                    request=request,
                    status=report.status,
                    report=report,
                    attempts=attempt,
                    bars_loaded=bars_loaded,
                    error="; ".join(report.errors) if report.errors else None,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last_error = str(exc)
                logger.error(
                    "Backfill task error for %s@%s attempt %d/%d: %s",
                    request.symbol,
                    request.interval,
                    attempt,
                    self._max_retries,
                    exc,
                    exc_info=True,
                )
                if attempt < self._max_retries:
                    await asyncio.sleep(self._backoff(attempt))

        await self._emit_failed(request, report, last_error)
        return RepairOutcome(
            request=request,
            status="failed",
            report=report,
            attempts=self._max_retries,
            error=last_error,
        )

    async def _load_backfilled_to_cache(
        self,
        request: RepairRequest,
        report: Any,
    ) -> int:
        if self._total_bars_written(report) <= 0:
            return 0

        total_loaded = 0
        for written_range in self._written_ranges_for_request(request, report):
            rows = await asyncio.to_thread(
                self._storage.query_bars,
                symbol=written_range["symbol"],
                interval=written_range["interval"],
                start_ms=written_range["start_ms"],
                end_ms=written_range["end_ms"],
                order="ASC",
                exchange=written_range["exchange"],
                market_type=written_range["market_type"],
            )
            bars = [BarData.from_storage_row(row) for row in rows]

            if not bars:
                continue

            await self._dm.on_bars_backfilled(
                written_range["symbol"],
                written_range["interval"],
                bars,
                exchange=written_range["exchange"],
                market_type=written_range["market_type"],
                event_detail={
                    "request_id": request.request_id,
                    "status": self._status_value(report.status),
                    "range_start_ms": written_range["start_ms"],
                    "range_end_ms": written_range["end_ms"],
                },
            )
            total_loaded += len(bars)

        return total_loaded

    async def _emit_completion_if_needed(
        self,
        request: RepairRequest,
        report: Any,
        bars_loaded: int,
    ) -> None:
        if bars_loaded > 0:
            return
        await self._dm.event_bus.emit(DataEvent(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=SeriesKey(
                request.symbol,
                request.interval,
                exchange=request.exchange,
                market_type=request.market_type,
            ),
            detail={
                "request_id": request.request_id,
                "status": self._status_value(report.status),
                "bars_count": 0,
            },
        ))

    async def _emit_failed(
        self,
        request: RepairRequest,
        report: Any | None = None,
        error: str | None = None,
    ) -> None:
        await self._dm.event_bus.emit(DataEvent(
            event_type=DataEventType.BACKFILL_FAILED,
            key=SeriesKey(
                request.symbol,
                request.interval,
                exchange=request.exchange,
                market_type=request.market_type,
            ),
            detail={
                "request_id": request.request_id,
                "status": self._status_value(report.status) if report is not None else "failed",
                "errors": report.errors if report is not None else ([error] if error else []),
            },
        ))

    def _complete(self, request: RepairRequest, outcome: RepairOutcome) -> None:
        self._outcomes[request.request_id] = outcome
        future = self._futures.pop(request.request_id, None)
        if future is not None and not future.done():
            future.set_result(outcome)

    @staticmethod
    def _total_bars_written(report: Any) -> int:
        reconcile_result = getattr(report, "reconcile_result", None)
        if reconcile_result is None:
            return 0
        return int(getattr(reconcile_result, "bars_written", 0) or 0) + int(
            getattr(reconcile_result, "custom_bars_written", 0) or 0
        )

    def _written_ranges_for_request(
        self,
        request: RepairRequest,
        report: Any,
    ) -> list[dict[str, Any]]:
        raw_ranges = self._raw_written_ranges(report)
        ranges = [
            written_range
            for raw in raw_ranges
            if (written_range := self._normalize_written_range(raw)) is not None
            and written_range["exchange"] == request.exchange.lower().strip()
            and written_range["market_type"] == request.market_type.lower().strip()
            and written_range["symbol"] == request.symbol.upper().strip()
            and written_range["interval"] == request.interval
        ]
        if ranges:
            return ranges
        return [{
            "exchange": request.exchange.lower().strip(),
            "market_type": request.market_type.lower().strip(),
            "symbol": request.symbol.upper().strip(),
            "interval": request.interval,
            "start_ms": request.start_ms,
            "end_ms": request.end_ms,
        }]

    @staticmethod
    def _raw_written_ranges(report: Any) -> list[Any]:
        report_ranges = getattr(report, "written_ranges", None)
        if report_ranges:
            return list(report_ranges)
        reconcile_result = getattr(report, "reconcile_result", None)
        reconcile_ranges = (
            getattr(reconcile_result, "written_ranges", None)
            if reconcile_result is not None
            else None
        )
        return list(reconcile_ranges or [])

    @classmethod
    def _normalize_written_range(cls, raw: Any) -> dict[str, Any] | None:
        start_ms = cls._range_value(raw, "start_ms")
        end_ms = cls._range_value(raw, "end_ms")
        if start_ms is None or end_ms is None:
            return None
        return {
            "exchange": str(cls._range_value(raw, "exchange", "binance")).lower().strip(),
            "market_type": str(cls._range_value(raw, "market_type", "spot")).lower().strip(),
            "symbol": str(cls._range_value(raw, "symbol", "")).upper().strip(),
            "interval": cls._range_value(raw, "interval", ""),
            "start_ms": int(start_ms),
            "end_ms": int(end_ms),
        }

    @staticmethod
    def _range_value(raw: Any, key: str, default: Any = None) -> Any:
        if isinstance(raw, dict):
            return raw.get(key, default)
        return getattr(raw, key, default)

    def _backoff(self, attempt: int) -> float:
        return self._base_delay_seconds * (3 ** (attempt - 1))

    @staticmethod
    def _covers(existing: RepairRequest, new: RepairRequest) -> bool:
        return existing.start_ms <= new.start_ms and existing.end_ms >= new.end_ms

    @staticmethod
    def _status_value(status: Any) -> str:
        return getattr(status, "value", str(status))

    @classmethod
    def _is_failed(cls, status: Any) -> bool:
        return cls._status_value(status) == "failed"
