"""Process-local ownership for derived K-line materialization.

Query-time reconstruction and repair reconciliation can discover the same
custom target concurrently.  This registry gives one covering range ownership
of aggregation persistence while overlapping work either joins that owner or
waits until it can proceed without racing the same SQLite target.
"""
from __future__ import annotations

import threading
from concurrent.futures import Future
from dataclasses import dataclass


MaterializationSeries = tuple[str, str, str, str]


@dataclass(frozen=True, slots=True)
class MaterializationOutcome:
    owner: str
    rows_written: int
    rows_covered: int
    start_ms: int
    end_ms: int
    success: bool
    error: str | None = None


@dataclass(slots=True)
class _MaterializationEntry:
    series: MaterializationSeries
    start_ms: int
    end_ms: int
    owner: str
    future: Future[MaterializationOutcome]
    finished: bool = False


class MaterializationLease:
    """Owner/join handle returned by :class:`CustomMaterializationRegistry`."""

    def __init__(
        self,
        registry: CustomMaterializationRegistry,
        entry: _MaterializationEntry,
        *,
        is_owner: bool,
    ) -> None:
        self._registry = registry
        self._entry = entry
        self.is_owner = is_owner

    @property
    def owner(self) -> str:
        return self._entry.owner

    @property
    def future(self) -> Future[MaterializationOutcome]:
        return self._entry.future

    def wait(self) -> MaterializationOutcome:
        return self._entry.future.result()

    def complete(
        self,
        rows_written: int,
        *,
        rows_covered: int | None = None,
    ) -> MaterializationOutcome:
        normalized_written = max(0, int(rows_written))
        outcome = MaterializationOutcome(
            owner=self._entry.owner,
            rows_written=normalized_written,
            rows_covered=max(
                0,
                normalized_written
                if rows_covered is None
                else int(rows_covered),
            ),
            start_ms=self._entry.start_ms,
            end_ms=self._entry.end_ms,
            success=True,
        )
        self._registry._finish(self._entry, outcome)
        return outcome

    def fail(self, error: BaseException | str) -> MaterializationOutcome:
        outcome = MaterializationOutcome(
            owner=self._entry.owner,
            rows_written=0,
            rows_covered=0,
            start_ms=self._entry.start_ms,
            end_ms=self._entry.end_ms,
            success=False,
            error=str(error),
        )
        self._registry._finish(self._entry, outcome)
        return outcome


class CustomMaterializationRegistry:
    """Serialize overlapping target writes and join covering in-flight work."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: list[_MaterializationEntry] = []

    @staticmethod
    def series_key(
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
    ) -> MaterializationSeries:
        return (
            exchange.strip().lower(),
            market_type.strip().lower(),
            symbol.strip().upper(),
            interval.strip(),
        )

    def claim(
        self,
        *,
        series: MaterializationSeries,
        start_ms: int,
        end_ms: int,
        owner: str,
    ) -> MaterializationLease:
        """Claim a range, joining a covering owner and waiting on partial overlap."""
        while True:
            lease, wait_for = self.claim_nowait(
                series=series,
                start_ms=start_ms,
                end_ms=end_ms,
                owner=owner,
            )
            if lease is not None:
                return lease
            # Partial overlaps are serialized, but cannot safely join because
            # neither range proves complete coverage of the other.
            assert wait_for is not None
            wait_for.result()

    def claim_nowait(
        self,
        *,
        series: MaterializationSeries,
        start_ms: int,
        end_ms: int,
        owner: str,
    ) -> tuple[
        MaterializationLease | None,
        Future[MaterializationOutcome] | None,
    ]:
        """Claim immediately or return the partial-overlap future to await."""
        normalized_start = min(int(start_ms), int(end_ms))
        normalized_end = max(int(start_ms), int(end_ms))
        with self._lock:
            covering = next((
                entry
                for entry in self._entries
                if entry.series == series
                and entry.start_ms <= normalized_start
                and entry.end_ms >= normalized_end
            ), None)
            if covering is not None:
                return MaterializationLease(self, covering, is_owner=False), None

            overlapping = next((
                entry
                for entry in self._entries
                if entry.series == series
                and entry.start_ms <= normalized_end
                and entry.end_ms >= normalized_start
            ), None)
            if overlapping is not None:
                return None, overlapping.future

            entry = _MaterializationEntry(
                series=series,
                start_ms=normalized_start,
                end_ms=normalized_end,
                owner=owner,
                future=Future(),
            )
            self._entries.append(entry)
            return MaterializationLease(self, entry, is_owner=True), None

    def _finish(
        self,
        entry: _MaterializationEntry,
        outcome: MaterializationOutcome,
    ) -> None:
        with self._lock:
            if entry.finished:
                return
            entry.finished = True
            if entry in self._entries:
                self._entries.remove(entry)
        # Publish only after the finished owner is no longer claimable.  A
        # synchronous waiter wakes immediately from Future.set_result(); if
        # the entry were still registered it could repeatedly rejoin the same
        # already-failed flight instead of becoming the successor owner.
        if not entry.future.done():
            entry.future.set_result(outcome)


custom_materialization_registry = CustomMaterializationRegistry()


__all__ = [
    "CustomMaterializationRegistry",
    "MaterializationLease",
    "MaterializationOutcome",
    "MaterializationSeries",
    "custom_materialization_registry",
]
