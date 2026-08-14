"""Trade-tape ordering and fail-closed quality checks."""

from __future__ import annotations

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent


def trade_sort_key(event: MarketEvent) -> tuple[int, int, str]:
    payload = event.payload
    return (
        int(event.event_time_ms),
        int(payload.get("source_sequence") or event.sequence),
        str(payload.get("tie_break") or ""),
    )


def assert_trade_stream(events: tuple[MarketEvent, ...]) -> str:
    if not events:
        raise MarketDatasetError("trade tape is empty", code="DATA_QUALITY_FAILED")
    kinds = {str(event.payload.get("source_event_kind") or "") for event in events}
    if kinds == {"RAW_TRADE"}:
        source_kind = "RAW_TRADE"
    elif kinds == {"AGG_TRADE"}:
        source_kind = "AGG_TRADE"
    else:
        raise MarketDatasetError(
            f"trade tape mixes source kinds {sorted(kinds)}",
            code="FIDELITY_MISLABEL",
        )
    previous: MarketEvent | None = None
    for event in events:
        if event.role != "TRADES":
            raise MarketDatasetError(
                "trade kernel only accepts TRADES events",
                code="FIDELITY_UNSUPPORTED",
            )
        if previous is not None:
            if trade_sort_key(event) <= trade_sort_key(previous):
                raise MarketDatasetError(
                    "trade events are not strictly ordered",
                    code="DATA_QUALITY_FAILED",
                )
            prev_seq = int(previous.payload.get("source_sequence") or previous.sequence)
            cur_seq = int(event.payload.get("source_sequence") or event.sequence)
            if cur_seq <= prev_seq:
                raise MarketDatasetError(
                    "source sequence reset or duplicate",
                    code="DATA_GAP_REJECTED",
                )
            if int(event.event_time_ms) < int(previous.event_time_ms):
                raise MarketDatasetError(
                    "trade time moved backwards",
                    code="DATA_GAP_REJECTED",
                )
        previous = event
    return source_kind
