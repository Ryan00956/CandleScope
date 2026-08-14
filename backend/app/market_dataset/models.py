from __future__ import annotations

from dataclasses import dataclass


DATASET_REF_FIELDS = (
    "dataset_id",
    "data_epoch",
    "snapshot_hash",
    "venue",
    "market_type",
    "symbol",
    "start_time_ms",
    "end_time_ms",
    "roles",
    "interval",
    "calendar_id",
    "source",
    "retention_policy",
)


@dataclass(frozen=True, slots=True)
class DatasetRef:
    dataset_id: str
    data_epoch: str
    snapshot_hash: str
    venue: str
    market_type: str
    symbol: str
    start_time_ms: int
    end_time_ms: int
    roles: tuple[str, ...]
    interval: str | None
    calendar_id: str
    source: str
    retention_policy: str
