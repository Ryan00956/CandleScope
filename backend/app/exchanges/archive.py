"""Exchange-owned contracts for official historical K-line archives.

Archive support is optional.  The backfill layer discovers it through the
exchange plugin and keeps REST as the correctness/fallback transport.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


class ArchiveDataError(RuntimeError):
    """Official archive input failed validation and must fall back to REST."""


class ArchiveCompatibilityError(ArchiveDataError):
    """Provider website/schema contract drifted; disable this capability."""


class ArchiveGranularity(str, enum.Enum):
    DAILY = "daily"
    MONTHLY = "monthly"


@dataclass(frozen=True, slots=True)
class ArchiveCapabilities:
    provider_id: str
    market_types: tuple[str, ...]
    intervals: tuple[str, ...]
    granularities: tuple[ArchiveGranularity, ...]
    packaging_timezone: str
    rest_page_size: int
    checksum_required: bool = False

    def supports(self, *, market_type: str, interval: str) -> bool:
        return (
            str(market_type or "").strip().lower() in self.market_types
            and str(interval or "").strip() in self.intervals
        )


@dataclass(frozen=True, slots=True)
class ArchiveObjectRef:
    provider_id: str
    exchange: str
    market_type: str
    symbol: str
    interval: str
    granularity: ArchiveGranularity
    period: str
    start_ms: int
    end_ms: int
    expected_filename: str
    packaging_timezone: str
    url: str = ""
    checksum_url: str | None = None
    allowed_hosts: tuple[str, ...] = ()
    size_bytes: int | None = None
    etag: str | None = None
    last_modified: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def object_key(self) -> str:
        return (
            f"{self.provider_id}:{self.exchange}:{self.market_type}:"
            f"{self.symbol}:{self.interval}:{self.granularity.value}:{self.period}"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "object_key": self.object_key,
            "provider_id": self.provider_id,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "interval": self.interval,
            "granularity": self.granularity.value,
            "period": self.period,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "expected_filename": self.expected_filename,
            "packaging_timezone": self.packaging_timezone,
            "url": self.url,
            "checksum_url": self.checksum_url,
            "allowed_hosts": list(self.allowed_hosts),
            "size_bytes": self.size_bytes,
            "etag": self.etag,
            "last_modified": self.last_modified,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True, slots=True)
class ArchiveBar:
    open_time: int
    close_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    quote_volume: float = 0.0
    trades: int = 0
    taker_buy_base: float = 0.0
    taker_buy_quote: float = 0.0
    enhanced_fields: frozenset[str] = field(default_factory=frozenset)
    source: str = "backfill_archive_verified"


@dataclass(frozen=True, slots=True)
class ArchiveHttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes = b""


@runtime_checkable
class ArchiveHttpClient(Protocol):
    async def get_bytes(
        self,
        url: str,
        *,
        allowed_hosts: tuple[str, ...],
        max_bytes: int,
    ) -> ArchiveHttpResponse:
        ...

    async def download(
        self,
        url: str,
        destination: Path,
        *,
        allowed_hosts: tuple[str, ...],
        max_bytes: int,
    ) -> ArchiveHttpResponse:
        ...

    async def head(
        self,
        url: str,
        *,
        allowed_hosts: tuple[str, ...],
    ) -> ArchiveHttpResponse:
        ...

    async def post_json(
        self,
        url: str,
        payload: dict[str, Any],
        *,
        allowed_hosts: tuple[str, ...],
        max_bytes: int,
    ) -> tuple[ArchiveHttpResponse, Any]:
        ...


@runtime_checkable
class HistoricalArchiveProvider(Protocol):
    id: str

    def capabilities(self, market_type: str) -> ArchiveCapabilities:
        ...

    def plan_objects(
        self,
        *,
        market_type: str,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        now_ms: int,
    ) -> list[ArchiveObjectRef]:
        ...

    async def resolve_objects(
        self,
        objects: list[ArchiveObjectRef],
        http: ArchiveHttpClient,
    ) -> list[ArchiveObjectRef]:
        ...

    def parse_checksum(self, payload: bytes, ref: ArchiveObjectRef) -> str:
        ...

    def parse_bars(self, path: Path, ref: ArchiveObjectRef) -> list[ArchiveBar]:
        ...


__all__ = [
    "ArchiveBar",
    "ArchiveCapabilities",
    "ArchiveCompatibilityError",
    "ArchiveDataError",
    "ArchiveGranularity",
    "ArchiveHttpClient",
    "ArchiveHttpResponse",
    "ArchiveObjectRef",
    "HistoricalArchiveProvider",
]
