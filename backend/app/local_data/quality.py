"""Fail-closed BAR quality: gap position, duplicate, reorder, revision drift."""

from __future__ import annotations

from typing import Iterable, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent


def reject_revision_drift(*, expected_epoch: str, actual_epoch: str) -> None:
    if expected_epoch != actual_epoch:
        raise MarketDatasetError(
            "dataset revision drifted during snapshot",
            code="DATA_SNAPSHOT_MISMATCH",
        )


def reject_gap_positions(
    events: Iterable[MarketEvent],
    *,
    interval_ms: int,
    expected_start_ms: int | None = None,
    expected_end_ms: int | None = None,
) -> None:
    previous: MarketEvent | None = None
    first: MarketEvent | None = None
    last: MarketEvent | None = None
    for event in events:
        if event.role != "BARS":
            continue
        if first is None:
            first = event
        last = event
        open_ms = int(event.payload.get("open_time_ms") or event.event_time_ms)
        if previous is not None:
            prev_open = int(
                previous.payload.get("open_time_ms") or previous.event_time_ms
            )
            if open_ms == prev_open:
                raise MarketDatasetError(
                    "duplicate bar open time", code="DATA_QUALITY_FAILED"
                )
            if open_ms < prev_open:
                raise MarketDatasetError(
                    "bar time went backwards", code="DATA_GAP_REJECTED"
                )
            if interval_ms > 0 and open_ms - prev_open != interval_ms:
                where = "mid"
                raise MarketDatasetError(
                    f"{where} bar gap", code="DATA_GAP_REJECTED"
                )
        previous = event
    if first is None:
        raise MarketDatasetError("BAR snapshot is empty", code="DATA_QUALITY_FAILED")
    first_open = int(first.payload.get("open_time_ms") or first.event_time_ms)
    last_open = int(last.payload.get("open_time_ms") or last.event_time_ms) if last else first_open
    if expected_start_ms is not None and first_open > expected_start_ms:
        raise MarketDatasetError("head bar gap", code="DATA_GAP_REJECTED")
    if expected_end_ms is not None and last_open + interval_ms < expected_end_ms:
        raise MarketDatasetError("tail bar gap", code="DATA_GAP_REJECTED")


def catalog_quality(manifest: Mapping[str, object]) -> dict[str, object]:
    return {
        "source": manifest.get("source") or "local_dataset",
        "checksum": manifest.get("sqlite_sha256") or manifest.get("data_epoch"),
        "coverage": {
            "rows": manifest.get("rows"),
            "first_open_ms": manifest.get("first_open_ms"),
            "last_open_ms": manifest.get("last_open_ms"),
        },
        "gap": {"excluded_range_count": manifest.get("excluded_range_count", 0)},
        "revision": manifest.get("data_epoch"),
    }
