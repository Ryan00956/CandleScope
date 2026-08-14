"""Deterministic complete-bar derivation from one authoritative trade stream."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Mapping

from app.data_engine.interval_policy import IntervalSpec, parse_interval_spec
from app.market_dataset.snapshot import MarketDatasetError, MarketEvent

BAR_BUILDER_REVISION = "TRADE_DERIVED_COMPLETE_BUCKETS_V1"
SIGNAL_CLOCK = "DERIVED_BAR_CLOSE"
EXECUTION_CLOCK = "NEXT_AGG_TRADE"
BAR_TIMEZONE = "UTC"


@dataclass(slots=True)
class TradeBarBuilder:
    """Emit only buckets proven complete by a trade in a later bucket."""

    interval: str
    gap_policy: str = "REJECT"
    _spec: IntervalSpec = field(init=False, repr=False)
    _open_ms: int | None = field(init=False, default=None)
    _open: Decimal | None = field(init=False, default=None)
    _high: Decimal | None = field(init=False, default=None)
    _low: Decimal | None = field(init=False, default=None)
    _close: Decimal | None = field(init=False, default=None)
    _volume: Decimal = field(init=False, default=Decimal("0"))
    signal_count: int = field(init=False, default=0)
    gap_count: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        spec = parse_interval_spec(self.interval)
        if spec is None:
            raise MarketDatasetError("invalid signal interval", code="SCHEMA_UNKNOWN_FIELD")
        self._spec: IntervalSpec = spec
        self.interval = spec.canonical
        self._open_ms: int | None = None
        self._open: Decimal | None = None
        self._high: Decimal | None = None
        self._low: Decimal | None = None
        self._close: Decimal | None = None
        self._volume = Decimal("0")
        self.signal_count = 0
        self.gap_count = 0

    def push(self, trade: MarketEvent) -> tuple[MarketEvent, ...]:
        if trade.role != "TRADES" or trade.payload.get("source_event_kind") != "AGG_TRADE":
            raise MarketDatasetError(
                "trade bar builder requires AGG_TRADE events",
                code="FIDELITY_MISLABEL",
            )
        bucket = self._spec.floor_ms(trade.event_time_ms)
        price = Decimal(str(trade.payload["price"]))
        qty = Decimal(str(trade.payload["qty"]))
        if not price.is_finite() or not qty.is_finite() or price <= 0 or qty <= 0:
            raise MarketDatasetError("invalid aggregate trade", code="DATA_QUALITY_FAILED")

        completed: list[MarketEvent] = []
        if self._open_ms is not None and bucket != self._open_ms:
            if bucket < self._open_ms:
                raise MarketDatasetError("trade bucket moved backwards", code="DATA_GAP_REJECTED")
            expected = self._spec.next_ms(self._open_ms)
            if bucket != expected:
                self.gap_count += 1
                if self.gap_policy != "SKIP_WITH_WARNING":
                    raise MarketDatasetError(
                        "empty derived-bar bucket rejected",
                        code="DATA_GAP_REJECTED",
                    )
            completed.append(self._close_current())
            self._reset_bucket(bucket, price, qty)
        elif self._open_ms is None:
            self._reset_bucket(bucket, price, qty)
        else:
            assert self._high is not None and self._low is not None
            self._high = max(self._high, price)
            self._low = min(self._low, price)
            self._close = price
            self._volume += qty
        return tuple(completed)

    def snapshot(self) -> dict[str, Any]:
        return {
            "revision": BAR_BUILDER_REVISION,
            "interval": self.interval,
            "timezone": BAR_TIMEZONE,
            "gap_policy": self.gap_policy,
            "open_ms": self._open_ms,
            "open": _decimal_wire(self._open),
            "high": _decimal_wire(self._high),
            "low": _decimal_wire(self._low),
            "close": _decimal_wire(self._close),
            "volume": str(self._volume),
            "signal_count": self.signal_count,
            "gap_count": self.gap_count,
        }

    def restore(self, payload: Mapping[str, Any]) -> None:
        if (
            payload.get("revision") != BAR_BUILDER_REVISION
            or payload.get("interval") != self.interval
            or payload.get("timezone") != BAR_TIMEZONE
            or payload.get("gap_policy") != self.gap_policy
        ):
            raise MarketDatasetError("bar builder checkpoint identity changed", code="CHECKPOINT_CORRUPT")
        self._open_ms = None if payload.get("open_ms") is None else int(payload["open_ms"])
        self._open = _optional_decimal(payload.get("open"))
        self._high = _optional_decimal(payload.get("high"))
        self._low = _optional_decimal(payload.get("low"))
        self._close = _optional_decimal(payload.get("close"))
        self._volume = Decimal(str(payload.get("volume") or "0"))
        self.signal_count = int(payload.get("signal_count") or 0)
        self.gap_count = int(payload.get("gap_count") or 0)

    def _close_current(self) -> MarketEvent:
        assert self._open_ms is not None
        assert self._open is not None and self._high is not None
        assert self._low is not None and self._close is not None
        self.signal_count += 1
        close_ms = self._spec.next_ms(self._open_ms) - 1
        return MarketEvent(
            sequence=self.signal_count,
            event_time_ms=close_ms,
            role="BARS",
            payload={
                "event_kind": SIGNAL_CLOCK,
                "signal_sequence": self.signal_count,
                "tie_break": f"{SIGNAL_CLOCK}:{self.signal_count}",
                "bar_builder": BAR_BUILDER_REVISION,
                "timezone": BAR_TIMEZONE,
                "open_time_ms": self._open_ms,
                "close_time_ms": close_ms,
                "open": str(self._open),
                "high": str(self._high),
                "low": str(self._low),
                "close": str(self._close),
                "volume": str(self._volume),
            },
        )

    def _reset_bucket(self, bucket: int, price: Decimal, qty: Decimal) -> None:
        self._open_ms = bucket
        self._open = price
        self._high = price
        self._low = price
        self._close = price
        self._volume = qty


def derive_complete_trade_bars(
    events: tuple[MarketEvent, ...],
    interval: str,
    *,
    gap_policy: str = "REJECT",
) -> tuple[MarketEvent, ...]:
    builder = TradeBarBuilder(interval, gap_policy=gap_policy)
    completed: list[MarketEvent] = []
    for event in events:
        completed.extend(builder.push(event))
    return tuple(completed)


def _decimal_wire(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _optional_decimal(value: object) -> Decimal | None:
    return None if value is None else Decimal(str(value))
