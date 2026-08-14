from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Iterator, Mapping


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def sha256_hex(value: object) -> str:
    payload = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class MarketDatasetError(ValueError):
    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class MarketEvent:
    sequence: int
    event_time_ms: int
    role: str
    payload: Mapping[str, object]


class MarketDatasetSnapshot:
    schema_version = "candlescope.market-dataset/1"

    def __init__(
        self,
        *,
        ref_identity: Mapping[str, object],
        coverage_start_ms: int,
        coverage_end_ms: int,
        events: tuple[MarketEvent, ...],
        role_hashes: Mapping[str, str],
        quality: Mapping[str, object],
        provenance: Mapping[str, object],
        fidelity_capabilities: tuple[str, ...],
        snapshot_hash: str,
    ) -> None:
        self.ref_identity = dict(ref_identity)
        self.coverage_start_ms = coverage_start_ms
        self.coverage_end_ms = coverage_end_ms
        self.row_count = len(events)
        self.first_sequence = events[0].sequence if events else None
        self.last_sequence = events[-1].sequence if events else None
        self.role_hashes = dict(role_hashes)
        self.quality = dict(quality)
        self.provenance = dict(provenance)
        self.fidelity_capabilities = fidelity_capabilities
        self.snapshot_hash = snapshot_hash
        self._events = events
        self._closed = False

    def cursor(self) -> Iterator[MarketEvent]:
        if self._closed:
            raise MarketDatasetError("snapshot is closed", code="DATA_QUALITY_FAILED")
        yield from self._events

    @property
    def events(self) -> tuple[MarketEvent, ...]:
        if self._closed:
            raise MarketDatasetError("snapshot is closed", code="DATA_QUALITY_FAILED")
        return self._events

    def close(self) -> None:
        self._closed = True
