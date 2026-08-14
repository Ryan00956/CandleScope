"""Decimal-authoritative one-way linear perpetual account V2.

The model is intentionally separate from ``ContractAccount`` so historical V1
runs keep their frozen identity and results.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent, sha256_hex

ACCOUNT_MODEL = "LINEAR_PERP_ONE_WAY_V2"
FUNDING_MODES = frozenset({"OFF", "FIXED_SCENARIO", "HISTORICAL_REQUIRED"})
LIQUIDATION_MODEL = "MARK_IMMEDIATE_NO_LIQUIDATION_FEE_V1"


@dataclass(frozen=True, slots=True)
class MaintenanceTier:
    floor: Decimal
    cap: Decimal
    rate: Decimal
    deduction: Decimal


@dataclass(slots=True)
class LinearPerpetualAccountV2:
    initial_balance: Decimal = Decimal("10000")
    leverage: Decimal = Decimal("1")
    funding_mode: str = "OFF"
    taker_fee_bps: Decimal = Decimal("0")
    position_qty: Decimal = Decimal("0")
    entry_price: Decimal | None = None
    mark: Decimal | None = None
    index_price: Decimal | None = None
    multiplier: Decimal | None = None
    tick: Decimal | None = None
    step: Decimal | None = None
    min_notional: Decimal | None = None
    rule_version: str | None = None
    maintenance_tiers: tuple[MaintenanceTier, ...] = ()
    cumulative_realized_pnl: Decimal = Decimal("0")
    cumulative_fees: Decimal = Decimal("0")
    cumulative_funding: Decimal = Decimal("0")
    compensating_entries: Decimal = Decimal("0")
    frozen_order_margin: Decimal = Decimal("0")
    order_margins: dict[str, Decimal] = field(default_factory=dict)
    seen_funding_periods: set[str] = field(default_factory=set)
    lots: list[dict[str, str]] = field(default_factory=list)
    ledger_entries: list[dict[str, Any]] = field(default_factory=list)
    ledger_tail_hash: str = "sha256:" + "0" * 64
    liquidation_state: str = "ACTIVE"
    insolvency_state: str = "SOLVENT"
    liquidation_event: dict[str, Any] | None = None
    _event_ordinal: int = 0

    def __post_init__(self) -> None:
        if self.initial_balance <= 0 or self.leverage <= 0:
            raise ValueError("initial balance and leverage must be positive")
        if self.funding_mode not in FUNDING_MODES:
            raise ValueError("unsupported funding mode")

    @property
    def quote_balance(self) -> Decimal:
        return self.wallet_balance()

    @property
    def fees_paid(self) -> Decimal:
        return self.cumulative_fees

    @property
    def funding_paid(self) -> Decimal:
        return self.cumulative_funding

    def wallet_balance(self) -> Decimal:
        return (
            self.initial_balance
            + self.cumulative_realized_pnl
            - self.cumulative_fees
            + self.cumulative_funding
            + self.compensating_entries
        )

    def unrealized(self) -> Decimal:
        if self.position_qty == 0:
            return Decimal("0")
        if self.entry_price is None or self.mark is None or self.multiplier is None:
            raise MarketDatasetError(
                "V2 unrealized PnL requires historical mark and rules",
                code="DATA_ROLE_COVERAGE_MISSING",
            )
        return (self.mark - self.entry_price) * self.position_qty * self.multiplier

    def equity(self) -> Decimal:
        return self.wallet_balance() + self.unrealized()

    def notional(self) -> Decimal:
        if self.position_qty == 0:
            return Decimal("0")
        self._require_market_state()
        assert self.mark is not None and self.multiplier is not None
        return abs(self.position_qty) * self.mark * self.multiplier

    def initial_margin(self) -> Decimal:
        return self.notional() / self.leverage

    def selected_tier(self) -> MaintenanceTier | None:
        value = self.notional()
        if value == 0:
            return self.maintenance_tiers[0] if self.maintenance_tiers else None
        for tier in self.maintenance_tiers:
            if tier.floor <= value < tier.cap:
                return tier
        raise MarketDatasetError(
            "position notional exceeds frozen maintenance tiers",
            code="ACCOUNT_RISK_LIMIT_EXCEEDED",
        )

    def maintenance_margin(self) -> Decimal:
        tier = self.selected_tier()
        if tier is None or self.position_qty == 0:
            return Decimal("0")
        return max(Decimal("0"), self.notional() * tier.rate - tier.deduction)

    def available_balance(self) -> Decimal:
        return self.equity() - self.initial_margin() - self.frozen_order_margin

    def validate_ready(self) -> None:
        self._require_market_state()
        self.assert_invariants()

    def apply(self, event: MarketEvent) -> None:
        if event.role == "INSTRUMENT_RULES":
            self._apply_rules(event)
        elif event.role == "MARK_INDEX":
            self._apply_mark(event)
        elif event.role == "FUNDING":
            if self.funding_mode == "HISTORICAL_REQUIRED":
                self._apply_funding(event, source="HISTORICAL")
            else:
                self._append(
                    "FUNDING_IGNORED",
                    event.event_time_ms,
                    {
                        "period_id": str(
                            event.payload.get("period_id") or event.event_time_ms
                        ),
                        "mode": self.funding_mode,
                    },
                )
        self._after_event(event.event_time_ms, event.role)

    def apply_fixed_funding(
        self, *, event_time_ms: int, rate: Decimal, period_id: str
    ) -> None:
        if self.funding_mode != "FIXED_SCENARIO":
            return
        self._apply_funding(
            MarketEvent(
                sequence=self._event_ordinal + 1,
                event_time_ms=event_time_ms,
                role="FUNDING",
                payload={"rate": str(rate), "period_id": period_id},
            ),
            source="FIXED_SCENARIO",
        )
        self._after_event(event_time_ms, "FUNDING")

    def reserve_order_margin(
        self,
        *,
        order_id: str,
        qty: Decimal,
        reference_price: Decimal | None = None,
        estimated_fee: Decimal = Decimal("0"),
    ) -> None:
        self._assert_tradable()
        self._require_market_state()
        assert self.mark is not None and self.multiplier is not None
        price = self.mark if reference_price is None else reference_price
        amount = abs(qty) * price * self.multiplier / self.leverage
        required = amount + abs(estimated_fee)
        if required > self.available_balance():
            self._append(
                "ORDER_MARGIN_REJECTED",
                0,
                {
                    "order_id": order_id,
                    "amount": str(amount),
                    "estimated_fee": str(abs(estimated_fee)),
                },
            )
            self.assert_invariants(allow_negative_available=True)
            raise MarketDatasetError(
                "available balance is insufficient for frozen order margin and fee",
                code="ACCOUNT_BALANCE_INSUFFICIENT",
            )
        self.order_margins[order_id] = amount
        self.frozen_order_margin = sum(self.order_margins.values(), Decimal("0"))
        self._append(
            "ORDER_MARGIN_RESERVED", 0, {"order_id": order_id, "amount": str(amount)}
        )
        self.assert_invariants()

    def opening_quantity(self, *, side: str, qty: Decimal) -> Decimal:
        """Return only the quantity that can increase absolute exposure."""
        signed = qty if side == "BUY" else -qty
        if self.position_qty == 0 or self.position_qty * signed > 0:
            return qty
        return max(Decimal("0"), qty - abs(self.position_qty))

    def release_order_margin(
        self, order_id: str, *, event_time_ms: int = 0, fraction: Decimal = Decimal("1")
    ) -> None:
        if fraction <= 0 or fraction > 1:
            raise ValueError("order margin release fraction must be in (0, 1]")
        reserved = self.order_margins.get(order_id, Decimal("0"))
        amount = reserved * fraction
        remainder = reserved - amount
        if remainder:
            self.order_margins[order_id] = remainder
        else:
            self.order_margins.pop(order_id, None)
        self.frozen_order_margin = sum(self.order_margins.values(), Decimal("0"))
        if amount:
            self._append(
                "ORDER_MARGIN_RELEASED",
                event_time_ms,
                {"order_id": order_id, "amount": str(amount)},
            )
        self.assert_invariants(allow_negative_available=True)

    def apply_fill(
        self,
        *,
        side: str,
        price: Decimal,
        qty: Decimal,
        fee: Decimal | None = None,
        event_time_ms: int = 0,
        order_id: str | None = None,
        order_margin_fraction: Decimal = Decimal("1"),
    ) -> None:
        self._assert_tradable()
        self._require_market_state()
        if side not in {"BUY", "SELL"} or qty <= 0 or price <= 0:
            raise MarketDatasetError("invalid V2 fill", code="SCHEMA_UNKNOWN_FIELD")
        if order_id is not None:
            self.release_order_margin(
                order_id, event_time_ms=event_time_ms, fraction=order_margin_fraction
            )
        sign = Decimal("1") if side == "BUY" else Decimal("-1")
        remaining = qty
        realized = Decimal("0")
        while remaining > 0 and self.lots and Decimal(self.lots[0]["sign"]) != sign:
            lot = self.lots[0]
            lot_qty = Decimal(lot["qty"])
            closed = min(remaining, lot_qty)
            assert self.multiplier is not None
            realized += (
                (price - Decimal(lot["price"]))
                * closed
                * Decimal(lot["sign"])
                * self.multiplier
            )
            remaining -= closed
            lot_qty -= closed
            if lot_qty == 0:
                self.lots.pop(0)
            else:
                lot["qty"] = str(lot_qty)
        if remaining > 0:
            self.lots.append(
                {"sign": str(sign), "qty": str(remaining), "price": str(price)}
            )
        self._reproject_position()
        if realized:
            self.cumulative_realized_pnl += realized
            self._append(
                "REALIZED_PNL",
                event_time_ms,
                {"amount": str(realized), "order_id": order_id},
            )
        charged = abs(
            fee
            if fee is not None
            else price * qty * self.taker_fee_bps / Decimal("10000")
        )
        if charged:
            self.cumulative_fees += charged
            self._append(
                "FEE", event_time_ms, {"amount": str(charged), "order_id": order_id}
            )
        self._append(
            "FILL",
            event_time_ms,
            {"side": side, "price": str(price), "qty": str(qty), "order_id": order_id},
        )
        self._after_event(event_time_ms, "FILL")

    def compensate(self, *, amount: Decimal, reason: str, event_time_ms: int) -> None:
        if not reason.strip() or amount == 0:
            raise ValueError("compensation requires non-zero amount and reason")
        self.compensating_entries += amount
        self._append(
            "COMPENSATING_ENTRY",
            event_time_ms,
            {"amount": str(amount), "reason": reason},
        )
        self._after_event(event_time_ms, "COMPENSATION")

    def assert_invariants(self, *, allow_negative_available: bool = False) -> None:
        projected_qty = sum(
            (Decimal(lot["sign"]) * Decimal(lot["qty"]) for lot in self.lots),
            Decimal("0"),
        )
        if projected_qty != self.position_qty:
            raise MarketDatasetError(
                "V2 lot/position invariant failed", code="LEDGER_IMBALANCE"
            )
        if self.position_qty == 0 and self.entry_price is not None:
            raise MarketDatasetError(
                "flat V2 account has entry price", code="LEDGER_IMBALANCE"
            )
        expected_frozen = sum(self.order_margins.values(), Decimal("0"))
        if expected_frozen != self.frozen_order_margin:
            raise MarketDatasetError(
                "V2 order margin invariant failed", code="LEDGER_IMBALANCE"
            )
        expected_wallet = (
            self.initial_balance
            + self.cumulative_realized_pnl
            - self.cumulative_fees
            + self.cumulative_funding
            + self.compensating_entries
        )
        if expected_wallet != self.wallet_balance():
            raise MarketDatasetError(
                "V2 wallet invariant failed", code="LEDGER_IMBALANCE"
            )
        if (
            not allow_negative_available
            and self.liquidation_state == "ACTIVE"
            and self.available_balance() < 0
        ):
            raise MarketDatasetError(
                "V2 available balance is negative", code="ACCOUNT_BALANCE_INSUFFICIENT"
            )

    def snapshot(self) -> dict[str, Any]:
        tier = (
            self.selected_tier()
            if self.multiplier is not None and self.maintenance_tiers
            else None
        )
        return {
            "schemaVersion": "candlescope.linear-perp-account/2",
            "account_model": ACCOUNT_MODEL,
            "funding_mode": self.funding_mode,
            "initial_balance": str(self.initial_balance),
            "wallet_balance": str(self.wallet_balance()),
            "quote_balance": str(self.wallet_balance()),
            "unrealized_pnl": str(self.unrealized()),
            "equity": str(self.equity()),
            "available_balance": str(self.available_balance()),
            "position_qty": str(self.position_qty),
            "entry_price": None if self.entry_price is None else str(self.entry_price),
            "mark_price": None if self.mark is None else str(self.mark),
            "mark": None if self.mark is None else str(self.mark),
            "index_price": None if self.index_price is None else str(self.index_price),
            "notional": str(self.notional()),
            "leverage": str(self.leverage),
            "initial_margin": str(self.initial_margin()),
            "maintenance_margin": str(self.maintenance_margin()),
            "frozen_order_margin": str(self.frozen_order_margin),
            "maintenance_tier": None
            if tier is None
            else {
                "notional_floor": str(tier.floor),
                "notional_cap": str(tier.cap),
                "maintenance_rate": str(tier.rate),
                "maintenance_deduction": str(tier.deduction),
            },
            "multiplier": None if self.multiplier is None else str(self.multiplier),
            "rule_version": self.rule_version,
            "cumulative_realized_pnl": str(self.cumulative_realized_pnl),
            "cumulative_fees": str(self.cumulative_fees),
            "fees_paid": str(self.cumulative_fees),
            "cumulative_funding": str(self.cumulative_funding),
            "funding_paid": str(self.cumulative_funding),
            "compensating_entries": str(self.compensating_entries),
            "funding_event_count": len(self.seen_funding_periods),
            "seen_funding_periods": sorted(self.seen_funding_periods),
            "liquidation_state": self.liquidation_state,
            "insolvency_state": self.insolvency_state,
            "liquidation_event": self.liquidation_event,
            "liquidation_model": LIQUIDATION_MODEL,
            "insurance_fund_modeled": False,
            "adl_modeled": False,
            "lots": [dict(lot) for lot in self.lots],
            "order_margins": {
                key: str(value) for key, value in sorted(self.order_margins.items())
            },
            "ledger_entries": [dict(item) for item in self.ledger_entries],
            "ledger_tail_hash": self.ledger_tail_hash,
            "event_ordinal": self._event_ordinal,
            "rules": {
                "tick": None if self.tick is None else str(self.tick),
                "step": None if self.step is None else str(self.step),
                "min_notional": None
                if self.min_notional is None
                else str(self.min_notional),
                "maintenance_tiers": [
                    {
                        "floor": str(t.floor),
                        "cap": str(t.cap),
                        "rate": str(t.rate),
                        "deduction": str(t.deduction),
                    }
                    for t in self.maintenance_tiers
                ],
            },
        }

    def restore(self, payload: Mapping[str, Any]) -> None:
        if payload.get("schemaVersion") != "candlescope.linear-perp-account/2":
            raise MarketDatasetError(
                "V2 account checkpoint schema changed", code="CHECKPOINT_CORRUPT"
            )
        self.initial_balance = Decimal(str(payload["initial_balance"]))
        self.leverage = Decimal(str(payload["leverage"]))
        self.funding_mode = str(payload["funding_mode"])
        self.position_qty = Decimal(str(payload["position_qty"]))
        self.entry_price = (
            None
            if payload.get("entry_price") is None
            else Decimal(str(payload["entry_price"]))
        )
        self.mark = (
            None
            if payload.get("mark_price") is None
            else Decimal(str(payload["mark_price"]))
        )
        self.index_price = (
            None
            if payload.get("index_price") is None
            else Decimal(str(payload["index_price"]))
        )
        self.multiplier = (
            None
            if payload.get("multiplier") is None
            else Decimal(str(payload["multiplier"]))
        )
        self.rule_version = (
            None
            if payload.get("rule_version") is None
            else str(payload["rule_version"])
        )
        self.cumulative_realized_pnl = Decimal(str(payload["cumulative_realized_pnl"]))
        self.cumulative_fees = Decimal(str(payload["cumulative_fees"]))
        self.cumulative_funding = Decimal(str(payload["cumulative_funding"]))
        self.compensating_entries = Decimal(str(payload["compensating_entries"]))
        self.frozen_order_margin = Decimal(str(payload["frozen_order_margin"]))
        self.seen_funding_periods = {
            str(item) for item in payload.get("seen_funding_periods") or []
        }
        self.lots = [dict(item) for item in payload.get("lots") or []]
        self.order_margins = {
            str(k): Decimal(str(v))
            for k, v in (payload.get("order_margins") or {}).items()
        }
        self.ledger_entries = [
            dict(item) for item in payload.get("ledger_entries") or []
        ]
        self.ledger_tail_hash = str(payload["ledger_tail_hash"])
        self.liquidation_state = str(payload["liquidation_state"])
        self.insolvency_state = str(payload["insolvency_state"])
        self.liquidation_event = (
            None
            if payload.get("liquidation_event") is None
            else dict(payload["liquidation_event"])
        )
        self._event_ordinal = int(payload.get("event_ordinal") or 0)
        rules = payload.get("rules") or {}
        self.tick = None if rules.get("tick") is None else Decimal(str(rules["tick"]))
        self.step = None if rules.get("step") is None else Decimal(str(rules["step"]))
        self.min_notional = (
            None
            if rules.get("min_notional") is None
            else Decimal(str(rules["min_notional"]))
        )
        self.maintenance_tiers = tuple(
            MaintenanceTier(
                Decimal(str(t["floor"])),
                Decimal(str(t["cap"])),
                Decimal(str(t["rate"])),
                Decimal(str(t["deduction"])),
            )
            for t in rules.get("maintenance_tiers") or []
        )
        self.assert_invariants(
            allow_negative_available=self.liquidation_state != "ACTIVE"
        )
        if (
            self.ledger_entries
            and self.ledger_entries[-1]["entry_hash"] != self.ledger_tail_hash
        ):
            raise MarketDatasetError(
                "V2 ledger tail hash mismatch", code="CHECKPOINT_CORRUPT"
            )

    def ledger_hash(self) -> str:
        return self.ledger_tail_hash

    def coverage(self) -> dict[str, Any]:
        return {
            "account_model": ACCOUNT_MODEL,
            "mark_available": self.mark is not None,
            "rule_version": self.rule_version,
            "funding_mode": self.funding_mode,
            "funding_events": len(self.seen_funding_periods),
            "funding_paid": str(self.cumulative_funding),
            "fallback": "none",
        }

    def _apply_rules(self, event: MarketEvent) -> None:
        payload = event.payload
        multiplier = payload.get("contract_multiplier", payload.get("multiplier"))
        if multiplier is None:
            raise MarketDatasetError(
                "V2 rules missing multiplier", code="DATA_ROLE_COVERAGE_MISSING"
            )
        raw_tiers = payload.get("maintenance_tiers")
        if not isinstance(raw_tiers, (list, tuple)) or not raw_tiers:
            raise MarketDatasetError(
                "V2 rules missing maintenance tiers", code="DATA_ROLE_COVERAGE_MISSING"
            )
        tiers = tuple(
            MaintenanceTier(
                Decimal(str(item["notional_floor"])),
                Decimal(str(item["notional_cap"])),
                Decimal(str(item["maintenance_rate"])),
                Decimal(str(item["maintenance_deduction"])),
            )
            for item in raw_tiers
        )
        expected = Decimal("0")
        for tier in tiers:
            if tier.floor != expected or tier.cap <= tier.floor:
                raise MarketDatasetError(
                    "V2 maintenance tiers are not contiguous",
                    code="DATA_QUALITY_FAILED",
                )
            expected = tier.cap
        self.multiplier = Decimal(str(multiplier))
        self.tick = self._optional(payload.get("price_tick", payload.get("tick")))
        self.step = self._optional(payload.get("quantity_step", payload.get("step")))
        self.min_notional = self._optional(payload.get("min_notional"))
        self.rule_version = str(
            payload.get("rule_version", payload.get("version")) or ""
        )
        self.maintenance_tiers = tiers
        self._append(
            "RULES_APPLIED", event.event_time_ms, {"rule_version": self.rule_version}
        )

    def _apply_mark(self, event: MarketEvent) -> None:
        value = event.payload.get("mark_price", event.payload.get("mark"))
        if value is None:
            raise MarketDatasetError(
                "V2 mark event missing price", code="DATA_ROLE_COVERAGE_MISSING"
            )
        self.mark = Decimal(str(value))
        index = event.payload.get("index_price", event.payload.get("index"))
        self.index_price = None if index is None else Decimal(str(index))
        self._append(
            "MARK",
            event.event_time_ms,
            {
                "mark_price": str(self.mark),
                "index_price": None
                if self.index_price is None
                else str(self.index_price),
            },
        )

    def _apply_funding(self, event: MarketEvent, *, source: str) -> None:
        period = str(event.payload.get("period_id") or event.event_time_ms)
        if period in self.seen_funding_periods:
            raise MarketDatasetError(
                "duplicate V2 funding settlement", code="DATA_QUALITY_FAILED"
            )
        self._require_market_state()
        assert self.mark is not None and self.multiplier is not None
        raw_rate = event.payload.get("funding_rate", event.payload.get("rate"))
        if raw_rate is None:
            raise MarketDatasetError(
                "V2 funding event missing rate", code="DATA_ROLE_COVERAGE_MISSING"
            )
        rate = Decimal(str(raw_rate))
        payment = -(self.position_qty * self.mark * rate * self.multiplier)
        self.cumulative_funding += payment
        self.seen_funding_periods.add(period)
        self._append(
            "FUNDING",
            event.event_time_ms,
            {
                "period_id": period,
                "rate": str(rate),
                "amount": str(payment),
                "source": source,
            },
        )

    def _after_event(self, event_time_ms: int, trigger: str) -> None:
        if (
            self.position_qty != 0
            and self.mark is not None
            and self.multiplier is not None
            and self.maintenance_tiers
        ):
            if self.equity() <= self.maintenance_margin():
                self._liquidate(event_time_ms, trigger)
        self.assert_invariants(
            allow_negative_available=self.liquidation_state != "ACTIVE"
        )

    def _liquidate(self, event_time_ms: int, trigger: str) -> None:
        if self.liquidation_state != "ACTIVE" or self.position_qty == 0:
            return
        assert self.mark is not None and self.multiplier is not None
        before = self.position_qty
        equity_before = self.equity()
        maintenance = self.maintenance_margin()
        realized = sum(
            (
                (self.mark - Decimal(lot["price"]))
                * Decimal(lot["qty"])
                * Decimal(lot["sign"])
                * self.multiplier
                for lot in self.lots
            ),
            Decimal("0"),
        )
        self.cumulative_realized_pnl += realized
        self.lots.clear()
        self._reproject_position()
        for order_id in tuple(self.order_margins):
            self.release_order_margin(order_id, event_time_ms=event_time_ms)
        self.liquidation_state = "LIQUIDATED"
        self.insolvency_state = "INSOLVENT" if self.wallet_balance() < 0 else "SOLVENT"
        self.liquidation_event = {
            "event_time_ms": event_time_ms,
            "trigger": trigger,
            "price": str(self.mark),
            "position_qty_before": str(before),
            "equity_before": str(equity_before),
            "maintenance_margin": str(maintenance),
            "realized_pnl": str(realized),
            "price_model": LIQUIDATION_MODEL,
        }
        self._append("LIQUIDATION", event_time_ms, self.liquidation_event)

    def _reproject_position(self) -> None:
        self.position_qty = sum(
            (Decimal(lot["sign"]) * Decimal(lot["qty"]) for lot in self.lots),
            Decimal("0"),
        )
        if self.position_qty == 0:
            self.entry_price = None
            return
        total = sum((Decimal(lot["qty"]) for lot in self.lots), Decimal("0"))
        self.entry_price = (
            sum(
                (Decimal(lot["price"]) * Decimal(lot["qty"]) for lot in self.lots),
                Decimal("0"),
            )
            / total
        )

    def _append(
        self, kind: str, event_time_ms: int, details: Mapping[str, Any]
    ) -> None:
        self._event_ordinal += 1
        body = {
            "ordinal": self._event_ordinal,
            "event_time_ms": int(event_time_ms),
            "kind": kind,
            "details": dict(details),
            "previous_hash": self.ledger_tail_hash,
        }
        entry_hash = "sha256:" + sha256_hex(body)
        self.ledger_entries.append({**body, "entry_hash": entry_hash})
        self.ledger_tail_hash = entry_hash

    def _require_market_state(self) -> None:
        if self.mark is None:
            raise MarketDatasetError(
                "V2 requires historical mark", code="DATA_ROLE_COVERAGE_MISSING"
            )
        if (
            self.multiplier is None
            or not self.maintenance_tiers
            or not self.rule_version
        ):
            raise MarketDatasetError(
                "V2 requires historical instrument rules",
                code="DATA_ROLE_COVERAGE_MISSING",
            )

    def _assert_tradable(self) -> None:
        if self.liquidation_state != "ACTIVE":
            raise MarketDatasetError(
                "V2 account was liquidated", code="ACCOUNT_LIQUIDATED"
            )

    @staticmethod
    def _optional(value: object) -> Decimal | None:
        return None if value is None else Decimal(str(value))
