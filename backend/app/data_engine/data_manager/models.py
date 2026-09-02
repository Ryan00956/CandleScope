"""
Data Manager Models — types and protocols for the unified data layer.

This module defines:
  * ``BarData``           — a single OHLCV bar in lightweight-charts format
  * ``QueryResult``       — the standard response envelope for all queries
  * ``SubscriptionHandle``— opaque handle for managing event subscriptions
  * ``DataEvent``         — unified event wrapper for the event bus
  * ``DataEventType``     — enum of event types
  * ``SeriesKey``         — typed (symbol, interval) pair
  * ``StreamInfo``        — runtime info about an active data stream

All timestamps follow the project convention:
  * Internal / storage: **milliseconds** (int)
  * Lightweight-charts output: **seconds** (``BarData.time``)
"""
from __future__ import annotations

import enum
import math
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Collection, Protocol, runtime_checkable

from app.data_engine.market_data.kline_metrics import (
    KLINE_ENHANCED_FIELDS,
    normalize_declared_kline_components,
    normalize_declared_kline_enhancements,
    normalize_kline_aggregation_fields,
    normalize_prevalidated_kline_aggregation_fields,
    normalize_validated_kline_aggregation_fields,
    serialize_kline_enhancements,
)
from app.data_engine.interval_policy import parse_interval_spec
from app.data_engine.kline_quality import (
    kline_source_quality,
    normalize_kline_source,
)
from app.data_engine.series_identity import (
    DEFAULT_ASSET_CLASS,
    DEFAULT_PRICE_ADJUSTMENT,
    DEFAULT_SERIES_VARIANT,
    DEFAULT_SESSION_VARIANT,
    DEFAULT_VOLUME_SEMANTICS,
    KlineSeriesIdentity,
)


# ═══════════════════════════════════════════════════════════════
#  Series Key
# ═══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class SeriesKey:
    """Immutable identifier for one routed and semantically distinct series.

    Usable as a dict key and set member.

    Examples::

        key = SeriesKey("BTCUSDT", "1m")
        key = SeriesKey("BTCUSDT", "1m", market_type="futures")
        cache[key] = bars
    """
    symbol: str
    interval: str
    exchange: str = "binance"
    market_type: str = "spot"  # "spot" or "futures"
    provider_id: str | None = None
    venue: str | None = None
    asset_class: str = DEFAULT_ASSET_CLASS
    series_variant: str = DEFAULT_SERIES_VARIANT
    price_adjustment: str = DEFAULT_PRICE_ADJUSTMENT
    session_variant: str = DEFAULT_SESSION_VARIANT
    volume_semantics: str = DEFAULT_VOLUME_SEMANTICS

    def __post_init__(self) -> None:
        # Normalize symbol to uppercase
        object.__setattr__(self, "symbol", self.symbol.upper().strip())
        requested_interval = self.interval.strip()
        interval_spec = parse_interval_spec(requested_interval)
        object.__setattr__(
            self,
            "interval",
            interval_spec.canonical if interval_spec is not None else requested_interval,
        )
        object.__setattr__(self, "exchange", self.exchange.strip().lower())
        object.__setattr__(self, "market_type", self.market_type.strip().lower())
        identity = KlineSeriesIdentity.for_exchange(
            self.exchange,
            provider_id=self.provider_id,
            venue=self.venue,
            asset_class=self.asset_class,
            series_variant=self.series_variant,
            price_adjustment=self.price_adjustment,
            session_variant=self.session_variant,
            volume_semantics=self.volume_semantics,
        )
        for field_name, value in identity.to_dict().items():
            object.__setattr__(self, field_name, value)

    @property
    def identity(self) -> KlineSeriesIdentity:
        return KlineSeriesIdentity(
            provider_id=str(self.provider_id),
            venue=str(self.venue),
            asset_class=self.asset_class,
            series_variant=self.series_variant,
            price_adjustment=self.price_adjustment,
            session_variant=self.session_variant,
            volume_semantics=self.volume_semantics,
        )

    @property
    def topic(self) -> str:
        """Event bus topic string, e.g. ``'BTCUSDT@1m'`` or ``'okx:futures:BTCUSDT@1m'``."""
        base = f"{self.symbol}@{self.interval}"
        prefixes: list[str] = []
        if self.exchange != "binance":
            prefixes.append(self.exchange)
        if self.market_type != "spot":
            prefixes.append(self.market_type)
        routed = f"{':'.join(prefixes)}:{base}" if prefixes else base
        if not self.identity.is_legacy_default_for(self.exchange):
            semantic = ":".join(self.identity.storage_values)
            return f"series:{semantic}:{routed}"
        if prefixes:
            return routed
        return base

    def __str__(self) -> str:
        return self.topic


# ═══════════════════════════════════════════════════════════════
#  Bar Data (lightweight-charts compatible)
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class BarData:
    """A single OHLCV bar in the format expected by lightweight-charts.

    ``time`` is in **seconds** (Unix epoch).  All other fields are floats.

    This is the universal output type — every query, every event, every
    cache entry uses this structure.
    """
    time: int          # Unix seconds (for lightweight-charts)
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_closed: bool = True
    quote_volume: float | None = None
    trades: int | None = None
    taker_buy_base: float | None = None
    taker_buy_quote: float | None = None
    _prevalidated_aggregation_fields: tuple[
        float | None,
        int | None,
        float | None,
        float | None,
    ] | None = field(default=None, init=False, repr=False, compare=False)
    source: str = ""
    quality_rank: int = field(init=False, repr=False)
    quality: str = field(init=False, repr=False)
    trusted_final: bool = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.source = normalize_kline_source(self.source)
        resolved = kline_source_quality(self.source)
        self.quality_rank = resolved.rank
        self.quality = resolved.finality.value
        self.trusted_final = bool(self.is_closed and resolved.trusted_final)

    def to_dict(self) -> dict:
        """Return the legacy lightweight-charts OHLCV shape."""
        return {
            "time": self.time,
            "open": round(self.open, 8),
            "high": round(self.high, 8),
            "low": round(self.low, 8),
            "close": round(self.close, 8),
            "volume": round(self.volume, 8),
            "is_closed": bool(self.is_closed),
        }

    def to_kline_dict(self) -> dict:
        """Return OHLCV plus capability-gated Kline order-flow metrics."""
        payload = self.to_dict()
        payload.update(self._enhanced_payload())
        return payload

    def to_aggregation_dict(self) -> dict:
        """Return the additive raw fields needed to aggregate custom bars."""
        payload = self.to_dict()
        enhanced = self._enhanced_payload()
        payload.update({field: enhanced[field] for field in KLINE_ENHANCED_FIELDS})
        return payload

    def normalized_aggregation_fields(
        self,
    ) -> tuple[float | None, int | None, float | None, float | None]:
        """Return the exact twice-normalized fields used by custom bars."""
        cached = self._prevalidated_aggregation_fields
        if cached is not None:
            if cached == (None, None, None, None):
                return cached
            return normalize_prevalidated_kline_aggregation_fields(
                normalized_volume=round(self.volume, 8),
                fields=cached,
            )
        return normalize_kline_aggregation_fields(
            volume=self.volume,
            quote_volume=self.quote_volume,
            trades=self.trades,
            taker_buy_base=self.taker_buy_base,
            taker_buy_quote=self.taker_buy_quote,
        )

    def normalized_aggregation_values(
        self,
    ) -> tuple[
        int,
        float,
        float,
        float,
        float,
        float,
        bool,
        float | None,
        int | None,
        float | None,
        float | None,
    ]:
        """Return one canonical source row without allocating a dictionary."""
        cached = self._prevalidated_aggregation_fields
        if cached is not None:
            enhanced = (
                cached
                if cached == (None, None, None, None)
                else normalize_prevalidated_kline_aggregation_fields(
                    normalized_volume=self.volume,
                    fields=cached,
                )
            )
            return (
                int(self.time),
                self.open,
                self.high,
                self.low,
                self.close,
                self.volume,
                bool(self.is_closed),
                *enhanced,
            )
        enhanced = self.normalized_aggregation_fields()
        return (
            int(self.time),
            round(self.open, 8),
            round(self.high, 8),
            round(self.low, 8),
            round(self.close, 8),
            round(self.volume, 8),
            bool(self.is_closed),
            *enhanced,
        )

    @property
    def enhanced_fields(self) -> frozenset[str]:
        """Enhanced raw fields that contain valid, user-visible values."""
        payload = self._enhanced_payload()
        return frozenset(
            field for field in KLINE_ENHANCED_FIELDS if payload[field] is not None
        )

    def _enhanced_payload(self) -> dict[str, Any]:
        return serialize_kline_enhancements(
            volume=self.volume,
            quote_volume=self.quote_volume,
            trades=self.trades,
            taker_buy_base=self.taker_buy_base,
            taker_buy_quote=self.taker_buy_quote,
        )

    @staticmethod
    def _coerce_is_closed(value: Any, default: bool = True) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"false", "0", "no", "n", "open", "forming"}:
                return False
            if normalized in {"true", "1", "yes", "y", "closed", "final"}:
                return True
        return bool(value)

    @classmethod
    def from_dict(cls, d: dict) -> BarData:
        """Create from a dict with ``time, open, high, low, close, volume``.

        Accepts both seconds and milliseconds for ``time`` — if the value
        looks like milliseconds (> 1e12) it is auto-converted.
        """
        t = int(d["time"])
        if t > 1_000_000_000_000:  # milliseconds → seconds
            t = t // 1000
        return cls(
            time=t,
            open=float(d["open"]),
            high=float(d["high"]),
            low=float(d["low"]),
            close=float(d["close"]),
            volume=float(d.get("volume", 0)),
            is_closed=cls._coerce_is_closed(
                d.get("is_closed", d.get("isClosed")),
                default=True,
            ),
            quote_volume=cls._optional_float(d.get("quote_volume")),
            trades=cls._optional_int(d.get("trades")),
            taker_buy_base=cls._optional_float(d.get("taker_buy_base")),
            taker_buy_quote=cls._optional_float(d.get("taker_buy_quote")),
            source=d.get("source", ""),
        )

    @classmethod
    def from_storage_row(
        cls,
        row: dict,
        *,
        exchange: str | None = None,
        market_type: str | None = None,
        declared_fields: Collection[str] | None = None,
    ) -> BarData:
        """Create from a storage/SQLite row dict (open_time in ms)."""
        resolved_exchange = str(exchange or row.get("exchange") or "")
        resolved_market_type = str(market_type or row.get("market_type") or "")
        normalized_fields = normalize_declared_kline_enhancements(
            resolved_exchange,
            resolved_market_type,
            row,
            explicit_fields=declared_fields,
        )
        bar = cls(
            time=int(row["open_time"]) // 1000,
            open=round(float(row["open"]), 8),
            high=round(float(row["high"]), 8),
            low=round(float(row["low"]), 8),
            close=round(float(row["close"]), 8),
            volume=round(float(row.get("volume", 0)), 8),
            is_closed=cls._coerce_is_closed(row.get("is_closed"), default=True),
            quote_volume=float(row["quote_volume"])
            if normalized_fields[0] is not None else None,
            trades=int(row["trades"])
            if normalized_fields[1] is not None else None,
            taker_buy_base=float(row["taker_buy_base"])
            if normalized_fields[2] is not None else None,
            taker_buy_quote=float(row["taker_buy_quote"])
            if normalized_fields[3] is not None else None,
            source=row.get("source", ""),
        )
        bar._prevalidated_aggregation_fields = normalized_fields
        return bar

    @classmethod
    def from_storage_components(
        cls,
        row: tuple[Any, ...],
        *,
        exchange: str,
        market_type: str,
        declared_fields: Collection[str] | None = None,
    ) -> BarData:
        """Create from the compact SQLite query projection.

        The tuple order is ``open_time, OHLCV, quote_volume, trades,
        taker_buy_base, taker_buy_quote, source``.  Identity columns are
        supplied by the resolved series key while provenance remains a
        per-row quality input.
        """
        # Ten-column tuples were exposed briefly by the feature branch. Keep
        # them readable as untrusted legacy rows while every repository query
        # now emits the provenance-bearing eleven-column projection.
        components = row if len(row) == 11 else (*row, "")
        (
            open_time,
            open_price,
            high,
            low,
            close,
            volume,
            quote_volume,
            trades,
            taker_buy_base,
            taker_buy_quote,
            source,
        ) = components
        normalized_fields = normalize_declared_kline_components(
            exchange,
            market_type,
            volume=volume,
            quote_volume=quote_volume,
            trades=trades,
            taker_buy_base=taker_buy_base,
            taker_buy_quote=taker_buy_quote,
            explicit_fields=declared_fields,
        )
        bar = cls(
            time=int(open_time) // 1000,
            open=round(float(open_price), 8),
            high=round(float(high), 8),
            low=round(float(low), 8),
            close=round(float(close), 8),
            volume=round(float(volume), 8),
            is_closed=True,
            quote_volume=float(quote_volume)
            if normalized_fields[0] is not None else None,
            trades=int(trades) if normalized_fields[1] is not None else None,
            taker_buy_base=float(taker_buy_base)
            if normalized_fields[2] is not None else None,
            taker_buy_quote=float(taker_buy_quote)
            if normalized_fields[3] is not None else None,
            source=str(source or ""),
        )
        bar._prevalidated_aggregation_fields = normalized_fields
        return bar

    @classmethod
    def from_storage_component_page(
        cls,
        rows: list[tuple[Any, ...]],
        *,
        exchange: str,
        market_type: str,
        declared_fields: Collection[str] | None,
    ) -> tuple[list[BarData], bool]:
        """Decode one homogeneous SQLite tuple page with a safe fast path.

        SQLite's compact projection normally returns fixed native types.  We
        prove that contract once for the whole page, then skip repeated
        coercion and generic finite/type checks while retaining the relational
        fail-closed rules.  Any unexpected value sends the *entire* page
        through :meth:`from_storage_components`.

        Returns ``(bars, fast_path_used)`` for query telemetry.
        """
        if declared_fields is None:
            return (
                [
                    cls.from_storage_components(
                        row,
                        exchange=exchange,
                        market_type=market_type,
                    )
                    for row in rows
                ],
                False,
            )
        resolved_fields = (
            declared_fields
            if isinstance(declared_fields, frozenset)
            else frozenset(declared_fields)
        )
        for row in rows:
            components = row if len(row) == 11 else (*row, "")
            (
                open_time,
                open_price,
                high,
                low,
                close,
                volume,
                quote_volume,
                trades,
                taker_buy_base,
                taker_buy_quote,
                source,
            ) = components
            if not (
                type(open_time) is int
                and type(open_price) is float
                and type(high) is float
                and type(low) is float
                and type(close) is float
                and type(volume) is float
                and volume >= 0
                and math.isfinite(volume)
                and (
                    quote_volume is None
                    or (
                        type(quote_volume) is float
                        and quote_volume >= 0
                        and math.isfinite(quote_volume)
                    )
                )
                and (
                    trades is None
                    or (type(trades) is int and trades >= 0)
                )
                and (
                    taker_buy_base is None
                    or (
                        type(taker_buy_base) is float
                        and taker_buy_base >= 0
                        and math.isfinite(taker_buy_base)
                    )
                )
                and (
                    taker_buy_quote is None
                    or (
                        type(taker_buy_quote) is float
                        and taker_buy_quote >= 0
                        and math.isfinite(taker_buy_quote)
                    )
                )
                and isinstance(source, str)
            ):
                return (
                    [
                        cls.from_storage_components(
                            item,
                            exchange=exchange,
                            market_type=market_type,
                            declared_fields=resolved_fields,
                        )
                        for item in rows
                    ],
                    False,
                )

        quote_volume_declared = "quote_volume" in resolved_fields
        trades_declared = "trades" in resolved_fields
        taker_buy_base_declared = "taker_buy_base" in resolved_fields
        taker_buy_quote_declared = "taker_buy_quote" in resolved_fields
        bars: list[BarData] = []
        append_bar = bars.append
        for row in rows:
            components = row if len(row) == 11 else (*row, "")
            (
                open_time,
                open_price,
                high,
                low,
                close,
                volume,
                quote_volume,
                trades,
                taker_buy_base,
                taker_buy_quote,
                source,
            ) = components
            normalized = normalize_validated_kline_aggregation_fields(
                volume=volume,
                quote_volume=quote_volume,
                trades=trades,
                taker_buy_base=taker_buy_base,
                taker_buy_quote=taker_buy_quote,
            )
            normalized_fields = (
                normalized[0] if quote_volume_declared else None,
                normalized[1] if trades_declared else None,
                normalized[2] if taker_buy_base_declared else None,
                normalized[3] if taker_buy_quote_declared else None,
            )
            bar = cls(
                time=open_time // 1000,
                open=round(open_price, 8),
                high=round(high, 8),
                low=round(low, 8),
                close=round(close, 8),
                volume=round(volume, 8),
                is_closed=True,
                quote_volume=quote_volume
                if normalized_fields[0] is not None else None,
                trades=trades if normalized_fields[1] is not None else None,
                taker_buy_base=taker_buy_base
                if normalized_fields[2] is not None else None,
                taker_buy_quote=taker_buy_quote
                if normalized_fields[3] is not None else None,
                source=source,
            )
            bar._prevalidated_aggregation_fields = normalized_fields
            append_bar(bar)
        return bars, True

    @classmethod
    def from_bar_state(cls, bar_state: Any, is_closed: bool | None = None) -> BarData:
        """Create from a ``bar_aggregator.BarState`` instance."""
        if is_closed is None:
            status = getattr(bar_state, "status", None)
            is_closed = getattr(status, "value", status) == "closed"
        fields = frozenset(getattr(bar_state, "enhanced_fields", ()) or ())
        source = str(getattr(bar_state, "quality_source", "") or "")
        if not source and bool(is_closed):
            finality_is_explicit = hasattr(bar_state, "finality")
            finality = getattr(bar_state, "finality", None)
            finality_value = getattr(finality, "value", finality)
            close_reason = str(getattr(bar_state, "close_reason", "") or "")
            if (
                not close_reason
                and not finality_is_explicit
                and bool(getattr(bar_state, "requires_authoritative_close", False))
                and bool(getattr(bar_state, "last_close_received", False))
            ):
                close_reason = "source_close"
                finality_value = "authoritative"
            if finality_value == "authoritative":
                source = {
                    "source_close": "data_manager_exchange_closed",
                    "composite_close": "data_manager_composite_closed",
                    "batch": "backfill_rest_verified",
                    "backfill_amendment": "data_manager_amended",
                }.get(close_reason, "")
        return cls(
            time=bar_state.bucket_start_ms // 1000,
            open=round(bar_state.open, 8),
            high=round(bar_state.high, 8),
            low=round(bar_state.low, 8),
            close=round(bar_state.close, 8),
            volume=round(bar_state.volume, 8),
            is_closed=bool(is_closed),
            quote_volume=cls._optional_float(getattr(bar_state, "quote_volume", None))
            if "quote_volume" in fields else None,
            trades=cls._optional_int(getattr(bar_state, "trades", None))
            if "trades" in fields else None,
            taker_buy_base=cls._optional_float(getattr(bar_state, "taker_buy_base", None))
            if "taker_buy_base" in fields else None,
            taker_buy_quote=cls._optional_float(getattr(bar_state, "taker_buy_quote", None))
            if "taker_buy_quote" in fields else None,
            source=source,
        )

    def with_closed_state(self, is_closed: bool) -> BarData:
        """Return a copy with the same OHLCV values and explicit close state."""
        bar = BarData(
            time=self.time,
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            volume=self.volume,
            is_closed=bool(is_closed),
            quote_volume=self.quote_volume,
            trades=self.trades,
            taker_buy_base=self.taker_buy_base,
            taker_buy_quote=self.taker_buy_quote,
            source=self.source,
        )
        bar._prevalidated_aggregation_fields = self._prevalidated_aggregation_fields
        return bar

    def with_source(self, source: str) -> BarData:
        """Return a copy with identical values and newly resolved provenance."""
        bar = BarData(
            time=self.time,
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            volume=self.volume,
            is_closed=self.is_closed,
            quote_volume=self.quote_volume,
            trades=self.trades,
            taker_buy_base=self.taker_buy_base,
            taker_buy_quote=self.taker_buy_quote,
            source=source,
        )
        bar._prevalidated_aggregation_fields = self._prevalidated_aggregation_fields
        return bar

    @staticmethod
    def _optional_float(value: Any) -> float | None:
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if not math.isfinite(number) or number < 0:
            return None
        return number

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(value)
            integer = int(number)
        except (TypeError, ValueError, OverflowError):
            return None
        if not math.isfinite(number) or number < 0 or number != integer:
            return None
        return integer

    @property
    def time_ms(self) -> int:
        """Convenience: time in milliseconds."""
        return self.time * 1000


# ═══════════════════════════════════════════════════════════════
#  Query Result
# ═══════════════════════════════════════════════════════════════


class QuerySource(str, enum.Enum):
    """Where the data came from."""
    CACHE = "cache"
    STORAGE = "storage"
    BACKFILL = "backfill"
    MIXED = "mixed"            # cache + storage/backfill combined
    EMPTY = "empty"


@dataclass(slots=True)
class MissingRange:
    """A storage gap detected during a query."""

    symbol: str
    interval: str
    start_ms: int
    end_ms: int
    exchange: str = "binance"
    market_type: str = "spot"
    provider_id: str | None = None
    venue: str | None = None
    asset_class: str = DEFAULT_ASSET_CLASS
    series_variant: str = DEFAULT_SERIES_VARIANT
    price_adjustment: str = DEFAULT_PRICE_ADJUSTMENT
    session_variant: str = DEFAULT_SESSION_VARIANT
    volume_semantics: str = DEFAULT_VOLUME_SEMANTICS
    reason: str = "query_gap"
    missing_bars: int | None = None
    status: str = "detected"

    def __post_init__(self) -> None:
        identity = KlineSeriesIdentity.for_exchange(
            self.exchange,
            provider_id=self.provider_id,
            venue=self.venue,
            asset_class=self.asset_class,
            series_variant=self.series_variant,
            price_adjustment=self.price_adjustment,
            session_variant=self.session_variant,
            volume_semantics=self.volume_semantics,
        )
        for field_name, value in identity.to_dict().items():
            setattr(self, field_name, value)

    def to_dict(self) -> dict:
        payload = {
            "symbol": self.symbol,
            "interval": self.interval,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "reason": self.reason,
            "status": self.status,
        }
        if self.missing_bars is not None:
            payload["missing_bars"] = self.missing_bars
        return payload


@dataclass(slots=True)
class QueryResult:
    """Standard response envelope for all bar queries.

    Every query method in DataManager returns this structure.

    Attributes:
        bars:        The requested OHLCV bars, sorted by time ascending.
        symbol:      Normalized symbol.
        interval:    Requested interval.
        source:      Where the data came from.
        total:       Number of bars returned.
        has_more:    Whether older data is available beyond this result.
        cache_hit:   Whether the query was (partially) served from cache.
        backfill_triggered:
                     Whether a backfill was triggered to fill gaps.
        missing_ranges:
                     Structured missing ranges detected by QueryEngine.
        metadata:    Arbitrary extra info (bounds, timing, etc.).
    """
    bars: list[BarData] = field(default_factory=list)
    symbol: str = ""
    interval: str = ""
    exchange: str = "binance"
    market_type: str = "spot"
    provider_id: str | None = None
    venue: str | None = None
    asset_class: str = DEFAULT_ASSET_CLASS
    series_variant: str = DEFAULT_SERIES_VARIANT
    price_adjustment: str = DEFAULT_PRICE_ADJUSTMENT
    session_variant: str = DEFAULT_SESSION_VARIANT
    volume_semantics: str = DEFAULT_VOLUME_SEMANTICS
    source: QuerySource = QuerySource.EMPTY
    total: int = 0
    has_more: bool = False
    cache_hit: bool = False
    backfill_triggered: bool = False
    has_tail_gap: bool = False
    missing_ranges: list[MissingRange] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    # Directional history-resolution state.  These fields are additive so
    # older callers can continue to rely on ``has_more`` while newer clients
    # can distinguish a terminal left edge from a pending repair.
    history_state: str = "ready"
    complete: bool = False
    retryable: bool = False
    terminal_reason: str | None = None
    earliest_available_ms: int | None = None
    next_before_ms: int | None = None
    availability_revision: str | None = None
    excluded_ranges: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        identity = KlineSeriesIdentity.for_exchange(
            self.exchange,
            provider_id=self.provider_id,
            venue=self.venue,
            asset_class=self.asset_class,
            series_variant=self.series_variant,
            price_adjustment=self.price_adjustment,
            session_variant=self.session_variant,
            volume_semantics=self.volume_semantics,
        )
        for field_name, value in identity.to_dict().items():
            setattr(self, field_name, value)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "provider_id": self.provider_id,
            "venue": self.venue,
            "asset_class": self.asset_class,
            "series_variant": self.series_variant,
            "price_adjustment": self.price_adjustment,
            "session_variant": self.session_variant,
            "volume_semantics": self.volume_semantics,
            "source": self.source.value,
            "total": self.total,
            "has_more": self.has_more,
            "cache_hit": self.cache_hit,
            "backfill_triggered": self.backfill_triggered,
            "has_tail_gap": self.has_tail_gap,
            "missing_ranges": [r.to_dict() for r in self.missing_ranges],
            "data": [b.to_dict() for b in self.bars],
            "metadata": self.metadata,
            "history_state": self.history_state,
            "complete": self.complete,
            "retryable": self.retryable,
            "terminal_reason": self.terminal_reason,
            "earliest_available_ms": self.earliest_available_ms,
            "next_before_ms": self.next_before_ms,
            "availability_revision": self.availability_revision,
            "excluded_ranges": list(self.excluded_ranges),
        }

    @property
    def data(self) -> list[dict]:
        """Convenience: bars as list of dicts (for JSON serialization)."""
        return [b.to_dict() for b in self.bars]


# ═══════════════════════════════════════════════════════════════
#  Event Types & Data Events
# ═══════════════════════════════════════════════════════════════


class DataEventType(str, enum.Enum):
    """Types of events flowing through the Data Manager event bus."""
    BAR_CREATED = "bar.created"     # new bar bucket started
    BAR_UPDATED = "bar.updated"     # bar OHLCV updated (live tick)
    BAR_CLOSED = "bar.closed"       # bar finalized — most important!
    BAR_AMENDED = "bar.amended"     # historical bar corrected (backfill)
    BAR_EXPIRED = "bar.expired"     # bar evicted from memory
    STREAM_STARTED = "stream.started"
    STREAM_STOPPED = "stream.stopped"
    STREAM_ERROR = "stream.error"
    BACKFILL_STARTED = "backfill.started"
    BACKFILL_COMPLETED = "backfill.completed"
    BACKFILL_FAILED = "backfill.failed"
    CACHE_PREWARM = "cache.prewarm"
    CACHE_EVICTION = "cache.eviction"
    PRICE_UPDATED = "price.updated"


USER_VISIBLE_BACKFILL_REASONS: frozenset[str] = frozenset({
    "initial_history",
    "visible_load_more",
    "visible_range_gap",
    "visible_seed_gap",
    "tail_gap",
})

INTERNAL_BACKFILL_REASONS: frozenset[str] = frozenset({
    "active_history_hydration",
    "related_interval_warmup",
    "full_subscription_warmup",
    "startup_gap_scan",
    "background_gap_audit",
    "latest_refresh",
    "query_gap",
    "query_empty",
    "query_tail_gap",
    "query_left_gap",
    "query_shortfall",
    "query_interior_gap",
    "price_daily_open",
})


def audience_for_backfill_reason(reason: str | None) -> str:
    """Classify a backfill completion for browser delivery."""
    parts = [
        part.strip()
        for part in str(reason or "").split("+")
        if part.strip()
    ]
    if any(part in USER_VISIBLE_BACKFILL_REASONS for part in parts):
        return "user"
    return "internal"


@dataclass(slots=True)
class DataEvent:
    """Unified event wrapper for the event bus.

    All events in the Data Manager flow through this envelope.

    Attributes:
        event_type:   What kind of event this is.
        key:          The (symbol, interval) this event relates to.
        bar:          The bar data (for bar events).
        previous_bar: The previous bar (for AMENDED events).
        detail:       Arbitrary extra data (error messages, etc.).
        timestamp_ms: When this event was created.
    """
    event_type: DataEventType
    key: SeriesKey
    bar: BarData | None = None
    previous_bar: BarData | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    audience: str = "user"
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "event_type": self.event_type.value,
            "audience": self.audience,
            "exchange": self.key.exchange,
            "symbol": self.key.symbol,
            "interval": self.key.interval,
            "market_type": self.key.market_type,
            "timestamp_ms": self.timestamp_ms,
            **self.key.identity.to_dict(),
        }
        if self.bar is not None:
            d["bar"] = self.bar.to_dict()
        if self.previous_bar is not None:
            d["previous_bar"] = self.previous_bar.to_dict()
        if self.detail:
            d["detail"] = self.detail
        return d


# ═══════════════════════════════════════════════════════════════
#  Subscription Handle
# ═══════════════════════════════════════════════════════════════

# Callback signature for event subscribers
EventCallback = Callable[[DataEvent], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class SubscriptionHandle:
    """Opaque handle returned when subscribing to events.

    Pass this handle to ``unsubscribe()`` to stop receiving events.
    The ``id`` is auto-generated and globally unique.

    Attributes:
        id:        Unique subscription identifier.
        key:       The (symbol, interval) subscribed to (None = all).
        event_types:
                   Filter by event types (None = all types).
        callback:  The registered callback.
        created_at_ms: When the subscription was created.
    """
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    key: SeriesKey | None = None
    event_types: set[DataEventType] | frozenset[DataEventType] | None = None
    callback: EventCallback | None = None
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def __post_init__(self) -> None:
        # The handle is also the EventBus routing record.  Copy and freeze the
        # caller-owned set so it cannot be mutated without the subscription
        # guard/change notification path.
        if self.event_types is not None:
            object.__setattr__(self, "event_types", frozenset(self.event_types))

    def matches(self, event: DataEvent) -> bool:
        """Return True if this subscription should receive the event."""
        if self.key is not None and event.key != self.key:
            return False
        if self.event_types is not None and event.event_type not in self.event_types:
            return False
        return True


# ═══════════════════════════════════════════════════════════════
#  Stream Info
# ═══════════════════════════════════════════════════════════════


class StreamStatus(str, enum.Enum):
    """Runtime status of a managed data stream."""
    STARTING = "starting"
    ACTIVE = "active"
    IDLE = "idle"           # no subscribers, waiting to be reaped
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


@dataclass(slots=True)
class StreamInfo:
    """Runtime information about an active data stream.

    Attributes:
        key:              The (symbol, interval) this stream serves.
        status:           Current lifecycle status.
        subscriber_count: Number of active subscribers.
        bars_received:    Total bars received since stream start.
        last_bar_at_ms:   Timestamp of the last bar received.
        started_at_ms:    When the stream was started.
        error:            Last error message (if status == ERROR).
    """
    key: SeriesKey
    status: StreamStatus = StreamStatus.STOPPED
    subscriber_count: int = 0
    bars_received: int = 0
    last_bar_at_ms: int = 0
    started_at_ms: int = 0
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "exchange": self.key.exchange,
            "symbol": self.key.symbol,
            "interval": self.key.interval,
            "market_type": self.key.market_type,
            **self.key.identity.to_dict(),
            "topic": self.key.topic,
            "status": self.status.value,
            "subscriber_count": self.subscriber_count,
            "bars_received": self.bars_received,
            "last_bar_at_ms": self.last_bar_at_ms,
            "started_at_ms": self.started_at_ms,
            "error": self.error,
        }


# ═══════════════════════════════════════════════════════════════
#  Storage Protocol (for dependency injection)
# ═══════════════════════════════════════════════════════════════


@runtime_checkable
class StorageBackend(Protocol):
    """Protocol that the Data Manager uses to read/write persistent bars.

    The default implementation wraps ``klines_repo.py``.  Users can
    provide their own implementation (PostgreSQL, ClickHouse, etc.)
    by implementing this protocol.

    All timestamps are in **milliseconds**.
    """

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[dict]:
        """Query bars from storage.  Returns list of row dicts."""
        ...

    def upsert_bars(
        self,
        symbol: str,
        interval: str,
        rows: list[dict],
        source: str = "data_manager",
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Insert or update bars.  Returns number of rows written."""
        ...

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> dict:
        """Return {earliest_open_time, latest_open_time, total_count}."""
        ...

    def delete_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Delete bars in range.  Returns number of rows deleted."""
        ...

    def fetch_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[dict]:
        """Fetch bars before a timestamp, ordered ASC."""
        ...

    def delete_oldest(
        self,
        symbol: str,
        interval: str,
        keep: int,
    ) -> int:
        """Delete oldest bars, keeping only the most recent *keep* rows.

        Returns the number of rows actually deleted.
        """
        ...
