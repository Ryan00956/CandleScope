"""Immutable trade-tape snapshot adapter. Does not import replay internals."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Mapping

from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import (
    MarketDatasetError,
    MarketDatasetSnapshot,
    MarketEvent,
    sha256_hex,
)
from app.market_dataset.trades import assert_trade_stream, trade_sort_key

TRADE_ROLES = frozenset({"TRADES", "INSTRUMENT_RULES", "BARS"})


class TradeArchiveSnapshotProvider:
    """Read a frozen raw or aggregate trade archive into a snapshot."""

    def __init__(self, records: Iterable[Mapping[str, object]] | Path) -> None:
        if isinstance(records, Path):
            payload = json.loads(records.read_text(encoding="utf-8"))
            self._records = list(payload["trades"])
            self._meta = dict(payload.get("meta") or {})
        else:
            self._records = list(records)
            self._meta = {}

    def open(self, ref: DatasetRef) -> MarketDatasetSnapshot:
        requested = tuple(ref.roles) or ("TRADES", "INSTRUMENT_RULES")
        unknown = [role for role in requested if role not in TRADE_ROLES]
        if unknown:
            raise MarketDatasetError(
                f"trade archive cannot supply {unknown}",
                code="FIDELITY_UNSUPPORTED",
            )
        events = [_record_to_event(index, item, ref) for index, item in enumerate(self._records, start=1)]
        events.sort(key=trade_sort_key)
        source_kind = assert_trade_stream(tuple(events))
        if ref.snapshot_hash:
            content_hash = sha256_hex([event.payload for event in events])
            if ref.snapshot_hash not in {content_hash, f"sha256:{content_hash}"}:
                raise MarketDatasetError(
                    "Declared snapshot hash does not match trade content",
                    code="DATA_SNAPSHOT_MISMATCH",
                )
        role_hashes = {
            "TRADES": f"sha256:{sha256_hex([event.payload for event in events])}",
        }
        return MarketDatasetSnapshot(
            ref_identity={
                "dataset_id": ref.dataset_id,
                "data_epoch": ref.data_epoch,
                "source_event_kind": source_kind,
                "symbol": ref.symbol,
            },
            coverage_start_ms=events[0].event_time_ms,
            coverage_end_ms=events[-1].event_time_ms,
            events=tuple(events),
            role_hashes=role_hashes,
            quality={
                "status": "accepted",
                "source_event_kind": source_kind,
                "gap_count": 0,
                "row_count": len(events),
            },
            provenance={
                "source": ref.source,
                "retention_policy": ref.retention_policy,
                "archive": self._meta,
            },
            fidelity_capabilities=(
                "TRADE_TAPE" if source_kind == "RAW_TRADE" else "AGG_TRADE_TAPE",
            ),
            snapshot_hash=f"sha256:{sha256_hex([event.payload for event in events])}",
        )


def _record_to_event(index: int, item: Mapping[str, object], ref: DatasetRef) -> MarketEvent:
    kind = str(item.get("source_event_kind") or "")
    if kind not in {"RAW_TRADE", "AGG_TRADE"}:
        raise MarketDatasetError("trade record missing source_event_kind", code="FIDELITY_MISLABEL")
    event_time_ms = int(item["event_time_ms"])
    if event_time_ms < ref.start_time_ms or event_time_ms > ref.end_time_ms:
        raise MarketDatasetError("trade outside requested window", code="DATA_QUALITY_FAILED")
    return MarketEvent(
        sequence=index,
        event_time_ms=event_time_ms,
        role="TRADES",
        payload={
            "source_event_kind": kind,
            "source_sequence": int(item.get("source_sequence") or index),
            "tie_break": str(item.get("tie_break") or f"{kind}:{index}"),
            "price": str(item["price"]),
            "qty": str(item["qty"]),
            "is_buyer_maker": bool(item.get("is_buyer_maker", False)),
            "agg_trade_id": item.get("agg_trade_id"),
            "first_trade_id": item.get("first_trade_id"),
            "last_trade_id": item.get("last_trade_id"),
        },
    )
