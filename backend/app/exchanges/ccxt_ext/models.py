from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class CcxtRawMarketEvent:
    """An un-normalized exchange event intercepted before CCXT loses fields.

    Sinks must be synchronous and non-blocking.  A typical sink calls
    ``asyncio.Queue.put_nowait`` so ordering is preserved by CCXT's websocket
    reader while downstream normalization remains asynchronous.
    """

    channel: str
    symbol: str | None
    payload: dict[str, Any]
    received_at_ms: int
    exchange: str = "binance"
    market_type: str = "futures"


@dataclass(frozen=True, slots=True)
class CcxtLifecycleEvent:
    """Observable CCXT websocket lifecycle transition."""

    state: str
    url: str | None
    observed_at_ms: int
    error: str | None = None
