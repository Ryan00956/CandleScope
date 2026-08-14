"""Historical mark, funding, and instrument-rule accounting for LINEAR_PERP_ONE_WAY_V1."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Iterable

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent, sha256_hex

KIND_RANK = {
    "INSTRUMENT_RULES": 0,
    "MARK_INDEX": 1,
    "FUNDING": 2,
    "TRADES": 3,
    "BARS": 3,
}


def contract_sort_key(event: MarketEvent) -> tuple[int, int, int]:
    return (
        int(event.event_time_ms),
        KIND_RANK.get(event.role, 9),
        int(event.sequence),
    )


def merge_contract_timeline(*groups: Iterable[MarketEvent]) -> tuple[MarketEvent, ...]:
    merged = [event for group in groups for event in group]
    merged.sort(key=contract_sort_key)
    return tuple(merged)


@dataclass(slots=True)
class ContractAccount:
    quote_balance: Decimal = Decimal("10000")
    position_qty: Decimal = Decimal("0")
    entry_price: Decimal | None = None
    mark: Decimal | None = None
    index_price: Decimal | None = None
    multiplier: Decimal = Decimal("1")
    tick: Decimal | None = None
    step: Decimal | None = None
    min_notional: Decimal | None = None
    rule_version: str | None = None
    maintenance_rate: Decimal = Decimal("0.005")
    require_mark: bool = True
    require_funding: bool = True
    funding_paid: Decimal = Decimal("0")
    seen_funding_periods: set[str] = field(default_factory=set)
    liquidated: bool = False
    journal: list[dict[str, str]] = field(default_factory=list)

    def apply(self, event: MarketEvent) -> None:
        if self.liquidated:
            raise MarketDatasetError("account already liquidated", code="ACCOUNT_INSOLVENT")
        if event.role == "INSTRUMENT_RULES":
            self._apply_rules(event)
        elif event.role == "MARK_INDEX":
            self._apply_mark(event)
        elif event.role == "FUNDING":
            self._apply_funding(event)

    def apply_fill(self, *, side: str, price: Decimal, qty: Decimal) -> None:
        signed = qty if side == "BUY" else -qty
        if self.position_qty == 0:
            self.position_qty = signed
            self.entry_price = price
        elif (self.position_qty > 0 and signed > 0) or (self.position_qty < 0 and signed < 0):
            assert self.entry_price is not None
            total = abs(self.position_qty) + qty
            self.entry_price = (
                (self.entry_price * abs(self.position_qty) + price * qty) / total
            )
            self.position_qty += signed
        else:
            self.position_qty += signed
            if self.position_qty == 0:
                self.entry_price = None
        self._check_liquidation(int(0))

    def unrealized(self) -> Decimal:
        if self.position_qty == 0 or self.entry_price is None:
            return Decimal("0")
        mark = self._require_mark()
        return (mark - self.entry_price) * self.position_qty * self.multiplier

    def equity(self) -> Decimal:
        return self.quote_balance + self.unrealized()

    def snapshot(self) -> dict[str, Any]:
        return {
            "quote_balance": str(self.quote_balance),
            "position_qty": str(self.position_qty),
            "entry_price": None if self.entry_price is None else str(self.entry_price),
            "mark": None if self.mark is None else str(self.mark),
            "funding_paid": str(self.funding_paid),
            "rule_version": self.rule_version,
            "liquidated": self.liquidated,
            "journal": list(self.journal),
        }

    def ledger_hash(self) -> str:
        return sha256_hex(self.snapshot())

    def coverage(self) -> dict[str, Any]:
        return {
            "mark_available": self.mark is not None,
            "rule_version": self.rule_version,
            "funding_events": len(self.seen_funding_periods),
            "funding_paid": str(self.funding_paid),
            "fallback": "none",
        }

    def _apply_rules(self, event: MarketEvent) -> None:
        payload = event.payload
        if payload.get("multiplier") is not None:
            self.multiplier = Decimal(str(payload["multiplier"]))
        if payload.get("tick") is not None:
            self.tick = Decimal(str(payload["tick"]))
        if payload.get("step") is not None:
            self.step = Decimal(str(payload["step"]))
        if payload.get("min_notional") is not None:
            self.min_notional = Decimal(str(payload["min_notional"]))
        self.rule_version = str(payload.get("version") or self.rule_version)
        self.journal.append({"kind": "RULES", "version": str(self.rule_version)})

    def _apply_mark(self, event: MarketEvent) -> None:
        self.mark = Decimal(str(event.payload["mark"]))
        if event.payload.get("index") is not None:
            self.index_price = Decimal(str(event.payload["index"]))
        self._check_liquidation(event.event_time_ms)

    def _apply_funding(self, event: MarketEvent) -> None:
        period = str(event.payload.get("period_id") or event.event_time_ms)
        if period in self.seen_funding_periods:
            raise MarketDatasetError("duplicate funding settlement", code="DATA_QUALITY_FAILED")
        if self.require_funding and self.position_qty != 0 and self.mark is None:
            raise MarketDatasetError("funding requires mark", code="DATA_QUALITY_FAILED")
        mark = self._require_mark() if self.position_qty != 0 else Decimal("0")
        rate = Decimal(str(event.payload["rate"]))
        payment = -(self.position_qty * mark * rate * self.multiplier)
        self.quote_balance += payment
        self.funding_paid += payment
        self.seen_funding_periods.add(period)
        self.journal.append({"kind": "FUNDING", "period": period, "amount": str(payment)})
        self._check_liquidation(event.event_time_ms)

    def _require_mark(self) -> Decimal:
        if self.mark is None:
            if self.require_mark:
                raise MarketDatasetError("mark price missing", code="DATA_QUALITY_FAILED")
            raise MarketDatasetError("mark price missing", code="DATA_QUALITY_FAILED")
        return self.mark

    def _check_liquidation(self, event_time_ms: int) -> None:
        if self.position_qty == 0 or self.mark is None:
            return
        equity = self.equity()
        notional = abs(self.position_qty) * self.mark * self.multiplier
        if equity <= 0 or equity < notional * self.maintenance_rate:
            self.liquidated = True
            self.journal.append({"kind": "LIQUIDATION", "time": str(event_time_ms)})
            raise MarketDatasetError("account liquidated", code="ACCOUNT_INSOLVENT")
