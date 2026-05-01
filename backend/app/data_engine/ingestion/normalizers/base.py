"""Common normalizer contracts and helpers."""
from __future__ import annotations

from typing import Protocol

from app.data_engine.ingestion.models import MarketEvent, RawMessage


class ExchangeNormalizer(Protocol):
    """Exchange-specific raw-message parser."""

    def parse(self, msg: RawMessage) -> MarketEvent | None:
        """Parse a raw exchange message into a MarketEvent."""
        ...


def truncate_payload(obj, max_len: int = 200) -> str:
    """Return a compact payload representation for logs."""
    text = str(obj)
    return text if len(text) <= max_len else text[:max_len] + "..."
