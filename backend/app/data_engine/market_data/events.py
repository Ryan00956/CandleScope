"""Typed events carried by the independent advanced market-data main chain."""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Mapping

from app.data_engine.ingestion.models import DataSource

from .models import MarketStreamKey


@dataclass(frozen=True, slots=True)
class MarketStateEvent:
    """Latest-state event for one logical market stream."""

    key: MarketStreamKey
    event_time_ms: int
    received_at_ms: int
    source: DataSource | str
    data: Mapping[str, Any]
    sequence: int | None = None

    def __post_init__(self) -> None:
        source = self.source
        if not isinstance(source, DataSource):
            source = DataSource(str(source).strip().lower())
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "event_time_ms", int(self.event_time_ms))
        object.__setattr__(self, "received_at_ms", int(self.received_at_ms))
        object.__setattr__(self, "data", MappingProxyType(dict(self.data)))

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key.to_dict(),
            "topic": self.key.topic,
            "channel": self.key.channel.value,
            "event_time_ms": self.event_time_ms,
            "received_at_ms": self.received_at_ms,
            "source": self.source.value,
            "sequence": self.sequence,
            "data": dict(self.data),
        }


@dataclass(frozen=True, slots=True)
class HubRecord:
    """A market event plus its process-local monotonic revision."""

    event: MarketStateEvent
    revision: int

    def to_dict(self) -> dict[str, Any]:
        payload = self.event.to_dict()
        payload["revision"] = self.revision
        return payload
