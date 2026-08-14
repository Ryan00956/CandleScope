"""Immutable MARK_INDEX / FUNDING / INSTRUMENT_RULES event adapter."""

from __future__ import annotations

from typing import Iterable, Mapping

from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import (
    MarketDatasetError,
    MarketDatasetSnapshot,
    MarketEvent,
    sha256_hex,
)

AUX_ROLES = frozenset({"MARK_INDEX", "FUNDING", "INSTRUMENT_RULES"})


class ContractAuxSnapshotProvider:
    def __init__(self, records: Iterable[Mapping[str, object]]) -> None:
        self._records = list(records)

    def open(self, ref: DatasetRef) -> MarketDatasetSnapshot:
        requested = tuple(ref.roles) or tuple(AUX_ROLES)
        unknown = [role for role in requested if role not in AUX_ROLES]
        if unknown:
            raise MarketDatasetError(
                f"contract aux adapter cannot supply {unknown}",
                code="FIDELITY_UNSUPPORTED",
            )
        events: list[MarketEvent] = []
        for index, item in enumerate(self._records, start=1):
            role = str(item["role"])
            if role not in requested:
                continue
            events.append(
                MarketEvent(
                    sequence=index,
                    event_time_ms=int(item["event_time_ms"]),
                    role=role,
                    payload={key: value for key, value in item.items() if key not in {"role", "event_time_ms"}},
                )
            )
        if not events:
            raise MarketDatasetError("contract aux snapshot is empty", code="DATA_QUALITY_FAILED")
        return MarketDatasetSnapshot(
            ref_identity={"dataset_id": ref.dataset_id, "roles": requested},
            coverage_start_ms=events[0].event_time_ms,
            coverage_end_ms=events[-1].event_time_ms,
            events=tuple(events),
            role_hashes={"AUX": f"sha256:{sha256_hex([event.payload for event in events])}"},
            quality={"status": "accepted", "roles": requested},
            provenance={"source": ref.source},
            fidelity_capabilities=("BAR_APPROX", "TRADE_TAPE"),
            snapshot_hash=f"sha256:{sha256_hex([event.payload for event in events])}",
        )
