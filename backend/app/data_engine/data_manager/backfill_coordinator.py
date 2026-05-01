"""Backfill request coordination for DataManager."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.data_engine.interval_policy import parse_interval_ms
from .models import BarData, DataEvent, DataEventType, SeriesKey

logger = logging.getLogger("data_manager.backfill_coordinator")


class BackfillEngineLike(Protocol):
    """Minimal engine contract used by BackfillCoordinator."""

    async def run(self, **kwargs: Any) -> Any:
        ...


class BackfillStorageLike(Protocol):
    """Minimal storage contract used by BackfillCoordinator."""

    def get_bounds(self, *args: Any, **kwargs: Any) -> dict:
        ...

    def query_bars(self, **kwargs: Any) -> list[dict]:
        ...


BarsBackfilledCallback = Callable[..., Awaitable[None]]
EventEmitter = Callable[[DataEvent], Awaitable[None]]


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
    verified_contiguous: bool | None = None
    remaining_missing_bars: int | None = None
    error: str | None = None


@dataclass(slots=True)
class ScanReport:
    scanned: int = 0
    repaired: int = 0
    queued: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "repaired": self.repaired,
            "queued": self.queued,
            "failed": self.failed,
            "errors": list(self.errors),
        }


@dataclass(slots=True)
class _SeriesState:
    current: RepairRequest | None = None
    pending: RepairRequest | None = None
    task: asyncio.Task | None = None


class GapLedgerLike(Protocol):
    """Optional persistent state sink for gap lifecycle transitions."""

    def upsert_detected(self, request: RepairRequest, *, status: str = "queued") -> None:
        ...

    def mark_started(self, request: RepairRequest, *, attempt: int) -> None:
        ...

    def mark_retry_wait(
        self,
        request: RepairRequest,
        *,
        attempt: int,
        error: str | None,
        next_retry_at: int,
    ) -> None:
        ...

    def mark_verifying(self, request: RepairRequest) -> None:
        ...

    def mark_resolved(
        self,
        request: RepairRequest,
        *,
        status: str,
        missing_count: int | None = None,
        error: str | None = None,
    ) -> None:
        ...

    def get_status(self, request: RepairRequest) -> dict[str, Any] | None:
        ...


class BackfillCoordinator:
    """Serializes backfill work and owns cache reload after repair."""

    def __init__(
        self,
        *,
        storage: BackfillStorageLike,
        bars_backfilled: BarsBackfilledCallback,
        emit_event: EventEmitter,
        engine: BackfillEngineLike | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        max_retries: int = 3,
        base_delay_seconds: float = 5.0,
        gap_ledger: GapLedgerLike | None = None,
    ) -> None:
        self._storage = storage
        self._bars_backfilled = bars_backfilled
        self._emit_event = emit_event
        self._engine = engine
        self._loop = loop
        self._max_retries = max(1, max_retries)
        self._base_delay_seconds = base_delay_seconds
        self._gap_ledger = gap_ledger

        self._series: dict[tuple[str, str, str, str], _SeriesState] = {}
        self._futures: dict[str, asyncio.Future[RepairOutcome]] = {}
        self._outcomes: dict[str, RepairOutcome] = {}
        self._shutdown = False

        self._submitted = 0
        self._deduped = 0
        self._merged = 0

    def set_engine(self, engine: BackfillEngineLike) -> None:
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

    async def audit_storage_gaps(
        self,
        targets: list[tuple[str, str, str]],
        intervals: tuple[str, ...],
        *,
        scan_limit: int = 50_000,
        max_gaps: int = 100,
        repair: bool = True,
    ) -> ScanReport:
        """Scan tracked series for stored interior gaps and optionally queue repairs."""
        return await self.audit_storage_series(
            (
                (exchange, market_type, symbol, interval)
                for exchange, market_type, symbol in targets
                for interval in intervals
            ),
            scan_limit=scan_limit,
            max_gaps=max_gaps,
            repair=repair,
        )

    async def audit_storage_series(
        self,
        series: Iterable[tuple[str, str, str, str]],
        *,
        scan_limit: int = 50_000,
        max_gaps: int = 100,
        repair: bool = True,
    ) -> ScanReport:
        """Scan exact stored/active series and optionally queue gap repairs."""
        report = ScanReport()
        scanner = getattr(self._storage, "scan_gaps", None)
        if not callable(scanner):
            report.errors.append("storage does not support gap scanning")
            return report

        queued = 0
        seen_series: set[tuple[str, str, str, str]] = set()
        for raw_exchange, raw_market_type, raw_symbol, raw_interval in series:
            exchange = str(raw_exchange or "binance").strip().lower()
            market_type = str(raw_market_type or "spot").strip().lower()
            symbol = str(raw_symbol or "").strip().upper()
            interval = str(raw_interval or "").strip()
            if not symbol or not interval:
                continue
            series_key = (exchange, market_type, symbol, interval)
            if series_key in seen_series:
                continue
            seen_series.add(series_key)

            if self._shutdown:
                return report
            if queued >= max_gaps:
                return report
            try:
                scan = await asyncio.to_thread(
                    scanner,
                    symbol=symbol,
                    interval=interval,
                    exchange=exchange,
                    market_type=market_type,
                    limit=scan_limit,
                )
                report.scanned += 1
                for gap in scan.get("gaps", []):
                    if queued >= max_gaps:
                        return report
                    request = RepairRequest(
                        symbol=symbol,
                        interval=interval,
                        start_ms=int(gap["start_ms"]),
                        end_ms=int(gap["end_ms"]),
                        exchange=exchange,
                        market_type=market_type,
                        reason="background_gap_audit",
                        metadata={
                            "origin": "background_gap_audit",
                            "gap_type": gap.get("reason", "unknown"),
                            "priority": 80,
                        },
                    )
                    if self._should_skip_audited_gap(request):
                        continue
                    if repair:
                        self.request(request)
                        queued += 1
                        report.queued += 1
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
                    "Background gap audit failed for %s:%s:%s@%s: %s",
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
            "gap_ledger_open": self._ledger_open_snapshot(),
            "recent_outcomes": {
                request_id: {
                    "status": self._status_value(outcome.status),
                    "attempts": outcome.attempts,
                    "bars_loaded": outcome.bars_loaded,
                    "verified_contiguous": outcome.verified_contiguous,
                    "remaining_missing_bars": outcome.remaining_missing_bars,
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
                self._ledger_upsert_detected(request)
                state.pending = request
                return request.request_id, self._future_for(request)

            state.pending = state.pending.merged_with(request)
            self._ledger_upsert_detected(state.pending)
            self._merged += 1
            return state.pending.request_id, self._future_for(state.pending)

        self._ledger_upsert_detected(request)
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
                self._ledger_mark_started(request, attempt=attempt)
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
                    delay = self._backoff(attempt)
                    self._ledger_mark_retry_wait(
                        request,
                        attempt=attempt,
                        error="; ".join(report.errors) if report.errors else None,
                        delay_seconds=delay,
                    )
                    await asyncio.sleep(delay)
                    continue

                bars_loaded = 0
                verification: dict[str, Any] = {
                    "verified_contiguous": None,
                    "remaining_missing_bars": None,
                }
                if not self._is_failed(report.status):
                    self._ledger_mark_verifying(request)
                    verification = await self._verify_request_range(request)
                    self._ledger_mark_verified(request, report, verification)
                    bars_loaded = await self._load_backfilled_to_cache(
                        request,
                        report,
                        verification,
                    )
                    await self._emit_completion_if_needed(
                        request,
                        report,
                        bars_loaded,
                        verification,
                    )

                if self._is_failed(report.status):
                    await self._emit_failed(request, report)
                    self._ledger_mark_failed(
                        request,
                        "; ".join(report.errors) if report.errors else None,
                    )

                return RepairOutcome(
                    request=request,
                    status=report.status,
                    report=report,
                    attempts=attempt,
                    bars_loaded=bars_loaded,
                    verified_contiguous=verification.get("verified_contiguous"),
                    remaining_missing_bars=verification.get("remaining_missing_bars"),
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
                    delay = self._backoff(attempt)
                    self._ledger_mark_retry_wait(
                        request,
                        attempt=attempt,
                        error=last_error,
                        delay_seconds=delay,
                    )
                    await asyncio.sleep(delay)

        await self._emit_failed(request, report, last_error)
        self._ledger_mark_failed(request, last_error)
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
        verification: dict[str, Any] | None = None,
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

            await self._bars_backfilled(
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
                    "request_start_ms": request.start_ms,
                    "request_end_ms": request.end_ms,
                    "verified_contiguous": (
                        verification or {}
                    ).get("verified_contiguous"),
                    "remaining_missing_bars": (
                        verification or {}
                    ).get("remaining_missing_bars"),
                },
            )
            total_loaded += len(bars)

        return total_loaded

    async def _emit_completion_if_needed(
        self,
        request: RepairRequest,
        report: Any,
        bars_loaded: int,
        verification: dict[str, Any] | None = None,
    ) -> None:
        if bars_loaded > 0:
            return
        await self._emit_event(DataEvent(
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
                "range_start_ms": request.start_ms,
                "range_end_ms": request.end_ms,
                "request_start_ms": request.start_ms,
                "request_end_ms": request.end_ms,
                "verified_contiguous": (
                    verification or {}
                ).get("verified_contiguous"),
                "remaining_missing_bars": (
                    verification or {}
                ).get("remaining_missing_bars"),
            },
        ))

    async def _emit_failed(
        self,
        request: RepairRequest,
        report: Any | None = None,
        error: str | None = None,
    ) -> None:
        await self._emit_event(DataEvent(
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

    async def _verify_request_range(self, request: RepairRequest) -> dict[str, Any]:
        query_bars = getattr(self._storage, "query_bars", None)
        if not callable(query_bars):
            return {
                "verified_contiguous": None,
                "remaining_missing_bars": None,
            }

        interval_ms = parse_interval_ms(request.interval)
        if interval_ms is None or interval_ms <= 0 or request.start_ms > request.end_ms:
            return {
                "verified_contiguous": None,
                "remaining_missing_bars": None,
            }

        try:
            rows = await asyncio.to_thread(
                query_bars,
                symbol=request.symbol,
                interval=request.interval,
                start_ms=request.start_ms,
                end_ms=request.end_ms,
                order="ASC",
                exchange=request.exchange,
                market_type=request.market_type,
            )
        except Exception as exc:
            logger.warning(
                "Backfill verification query failed for %s:%s:%s@%s %d-%d: %s",
                request.exchange,
                request.market_type,
                request.symbol,
                request.interval,
                request.start_ms,
                request.end_ms,
                exc,
            )
            return {
                "verified_contiguous": None,
                "remaining_missing_bars": None,
            }

        actual = {int(row["open_time"]) for row in rows}
        expected = 0
        missing = 0
        current = int(request.start_ms)
        while current <= request.end_ms:
            expected += 1
            if current not in actual:
                missing += 1
            current += interval_ms

        return {
            "verified_contiguous": missing == 0,
            "remaining_missing_bars": missing,
            "expected_bars": expected,
            "actual_bars": len(actual),
        }

    def _ledger_upsert_detected(self, request: RepairRequest) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.upsert_detected(request, status="queued")
        except Exception:
            logger.exception("Gap ledger upsert failed for %s", request.request_id)

    def _ledger_mark_started(self, request: RepairRequest, *, attempt: int) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_started(request, attempt=attempt)
        except Exception:
            logger.exception("Gap ledger start update failed for %s", request.request_id)

    def _ledger_mark_retry_wait(
        self,
        request: RepairRequest,
        *,
        attempt: int,
        error: str | None,
        delay_seconds: float,
    ) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_retry_wait(
                request,
                attempt=attempt,
                error=error,
                next_retry_at=int(time.time() * 1000 + delay_seconds * 1000),
            )
        except Exception:
            logger.exception("Gap ledger retry update failed for %s", request.request_id)

    def _ledger_mark_verifying(self, request: RepairRequest) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_verifying(request)
        except Exception:
            logger.exception("Gap ledger verifying update failed for %s", request.request_id)

    def _ledger_mark_verified(
        self,
        request: RepairRequest,
        report: Any,
        verification: dict[str, Any],
    ) -> None:
        if self._gap_ledger is None:
            return
        remaining = verification.get("remaining_missing_bars")
        if verification.get("verified_contiguous") is True:
            status = "filled"
            if remaining is None:
                remaining = 0
        elif self._total_bars_written(report) <= 0:
            status = "source_empty"
        else:
            status = "partial"

        try:
            self._gap_ledger.mark_resolved(
                request,
                status=status,
                missing_count=remaining,
                error=None,
            )
        except Exception:
            logger.exception("Gap ledger verified update failed for %s", request.request_id)

    def _ledger_mark_failed(self, request: RepairRequest, error: str | None) -> None:
        if self._gap_ledger is None:
            return
        try:
            self._gap_ledger.mark_resolved(
                request,
                status="failed",
                error=error,
            )
        except Exception:
            logger.exception("Gap ledger failure update failed for %s", request.request_id)

    def _should_skip_audited_gap(self, request: RepairRequest) -> bool:
        if self._gap_ledger is None:
            return False
        get_status = getattr(self._gap_ledger, "get_status", None)
        if not callable(get_status):
            return False
        try:
            status = get_status(request)
        except Exception:
            logger.exception("Gap ledger status lookup failed for %s", request.request_id)
            return False
        if not status:
            return False
        if status.get("status") != "source_empty":
            return False
        next_retry_at = status.get("next_retry_at")
        if next_retry_at is None:
            return True
        return int(next_retry_at) > int(time.time() * 1000)

    def _ledger_open_snapshot(self) -> list[dict[str, Any]]:
        if self._gap_ledger is None:
            return []
        list_open = getattr(self._gap_ledger, "list_open", None)
        if not callable(list_open):
            return []
        try:
            return list_open(limit=50)
        except Exception:
            logger.exception("Gap ledger open snapshot failed")
            return []

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
