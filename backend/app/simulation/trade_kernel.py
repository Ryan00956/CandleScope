"""TRADE_TAPE / AGG_TRADE_TAPE reference loop. Separate from BAR fill policy."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any, Callable, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent, sha256_hex
from app.market_dataset.trades import assert_trade_stream
from app.simulation.contract_accounting import ContractAccount
from app.simulation.kernel import (
    SimulatedFill,
    SimulatedOrder,
    SimulationResult,
    _fill_action,
    reject_intent,
)

TRADE_FILL_POLICY = "TRADE_NEXT_PRINT_CONSERVATIVE_V1"
StrategyFn = Callable[[tuple[MarketEvent, ...], MarketEvent], list[dict]]


def derived_bar_feature(events: tuple[MarketEvent, ...]) -> dict[str, str] | None:
    """Aggregate prints into an observation-only bar. Never used for fills."""
    trades = [event for event in events if event.role == "TRADES"]
    if not trades:
        return None
    prices = [Decimal(str(event.payload["price"])) for event in trades]
    qty = sum((Decimal(str(event.payload["qty"])) for event in trades), Decimal("0"))
    return {
        "open": str(prices[0]),
        "high": str(max(prices)),
        "low": str(min(prices)),
        "close": str(prices[-1]),
        "volume": str(qty),
        "authority": "OBSERVATION_ONLY",
    }


@dataclass(slots=True)
class TradeSimulationKernel:
    fill_policy: str = TRADE_FILL_POLICY
    max_events: int = 2_000_000
    checkpoint_event_interval: int = 10_000
    slippage_bps: Decimal = Decimal("0")
    taker_fee_bps: Decimal = Decimal("0")
    maker_fee_bps: Decimal = Decimal("0")
    funding_rate: Decimal = Decimal("0")
    funding_interval_ms: int = 28_800_000
    initial_balance: Decimal = Decimal("10000")
    ambiguity_count: int = 0
    orders: list[SimulatedOrder] = field(default_factory=list)
    fills: list[SimulatedFill] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    checkpoints: list[dict] = field(default_factory=list)
    _next_order_id: int = 1
    source_kind: str = "RAW_TRADE"
    rejected: list[dict] = field(default_factory=list)
    fee_total: Decimal = Decimal("0")
    equity_curve: list[dict] = field(default_factory=list)
    execution_reporter: Callable[[dict], None] | None = field(
        default=None,
        repr=False,
    )
    account: ContractAccount = field(init=False)
    _last_event: MarketEvent | None = None
    _next_funding_time_ms: int | None = None

    def __post_init__(self) -> None:
        self.account = ContractAccount(
            quote_balance=self.initial_balance,
            taker_fee_bps=self.taker_fee_bps,
            require_mark=False,
            require_funding=False,
            liquidation_enabled=False,
        )

    @property
    def position_qty(self) -> Decimal:
        return self.account.position_qty

    @property
    def projected_position_qty(self) -> Decimal:
        """Filled position plus outstanding target-position market quantity."""
        pending = sum(
            (
                order.qty if order.side == "BUY" else -order.qty
                for order in self.orders
                if order.type == "MARKET" and order.status in {"OPEN", "PARTIAL"}
            ),
            Decimal("0"),
        )
        return self.position_qty + pending

    def snapshot(self) -> dict[str, Any]:
        return {
            "next_order_id": self._next_order_id,
            "ambiguity_count": self.ambiguity_count,
            "source_kind": self.source_kind,
            "position_qty": str(self.position_qty),
            "slippage_bps": str(self.slippage_bps),
            "taker_fee_bps": str(self.taker_fee_bps),
            "maker_fee_bps": str(self.maker_fee_bps),
            "funding_rate": str(self.funding_rate),
            "funding_interval_ms": self.funding_interval_ms,
            "next_funding_time_ms": self._next_funding_time_ms,
            "fee_total": str(self.fee_total),
            "equity_curve": list(self.equity_curve),
            "account": self.account.snapshot(),
            "orders": [asdict(order) for order in self.orders],
            "fills": [asdict(fill) for fill in self.fills],
            "decisions": list(self.decisions),
            "rejected": list(self.rejected),
            "last_event": (
                None
                if self._last_event is None
                else {
                    "sequence": self._last_event.sequence,
                    "event_time_ms": self._last_event.event_time_ms,
                    "role": self._last_event.role,
                    "payload": dict(self._last_event.payload),
                }
            ),
        }

    def restore(self, payload: Mapping[str, Any]) -> None:
        self._next_order_id = int(payload["next_order_id"])
        self.ambiguity_count = int(payload["ambiguity_count"])
        self.source_kind = str(payload["source_kind"])
        self.slippage_bps = Decimal(str(payload.get("slippage_bps") or "0"))
        self.taker_fee_bps = Decimal(str(payload.get("taker_fee_bps") or "0"))
        self.maker_fee_bps = Decimal(str(payload.get("maker_fee_bps") or "0"))
        self.funding_rate = Decimal(str(payload.get("funding_rate") or "0"))
        self.funding_interval_ms = int(payload.get("funding_interval_ms") or 28_800_000)
        self._next_funding_time_ms = (
            None
            if payload.get("next_funding_time_ms") is None
            else int(payload["next_funding_time_ms"])
        )
        self.fee_total = Decimal(str(payload.get("fee_total") or "0"))
        self.equity_curve = list(payload.get("equity_curve") or [])  # type: ignore[arg-type]
        account_payload = payload.get("account")
        if isinstance(account_payload, Mapping):
            self.account.restore(account_payload)
        else:
            self.account.position_qty = Decimal(str(payload.get("position_qty") or "0"))
        self.orders = [
            SimulatedOrder(
                order_id=str(item["order_id"]),
                side=str(item["side"]),
                type=str(item["type"]),
                qty=Decimal(str(item["qty"])),
                eligible_after_sequence=int(item["eligible_after_sequence"]),
                limit_price=_optional_decimal(item.get("limit_price")),
                stop_price=_optional_decimal(item.get("stop_price")),
                status=str(item.get("status") or "OPEN"),
                fill_price=_optional_decimal(item.get("fill_price")),
                fill_sequence=(
                    None if item.get("fill_sequence") is None else int(item["fill_sequence"])
                ),
                activated=bool(item.get("activated") or False),
                oco_group=(
                    None
                    if not str(item.get("oco_group") or "").strip()
                    else str(item["oco_group"])
                ),
                reduce_only=bool(item.get("reduce_only") or False),
            )
            for item in payload["orders"]  # type: ignore[union-attr]
        ]
        self.fills = [
            SimulatedFill(
                order_id=str(item["order_id"]),
                sequence=int(item["sequence"]),
                event_time_ms=int(item.get("event_time_ms") or 0),
                side=str(item.get("side") or _order_side(self.orders, str(item["order_id"]))),
                price=Decimal(str(item["price"])),
                qty=Decimal(str(item["qty"])),
                fee=Decimal(str("0" if item.get("fee") is None else item["fee"])),
                reason=str(item["reason"]),
                action=str(item.get("action") or ""),
                position_before=Decimal(
                    str("0" if item.get("position_before") is None else item["position_before"])
                ),
                position_after=Decimal(
                    str("0" if item.get("position_after") is None else item["position_after"])
                ),
            )
            for item in payload["fills"]  # type: ignore[union-attr]
        ]
        self.decisions = list(payload["decisions"])  # type: ignore[arg-type]
        self.rejected = list(payload.get("rejected") or [])  # type: ignore[arg-type]
        last_event = payload.get("last_event")
        self._last_event = (
            None
            if not isinstance(last_event, Mapping)
            else MarketEvent(
                sequence=int(last_event["sequence"]),
                event_time_ms=int(last_event["event_time_ms"]),
                role=str(last_event["role"]),
                payload=dict(last_event["payload"]),  # type: ignore[arg-type]
            )
        )

    def run(
        self,
        events: tuple[MarketEvent, ...],
        strategy: StrategyFn,
        *,
        warmup_events: int = 0,
        finalize: bool = False,
    ) -> SimulationResult:
        if len(events) > self.max_events:
            raise MarketDatasetError("trade event budget exceeded", code="BUDGET_EXCEEDED")
        self.source_kind = assert_trade_stream(events)
        for index, event in enumerate(events):
            self._last_event = event
            self.account.mark = Decimal(str(event.payload["price"]))
            self._apply_funding(event)
            self._match(event)
            intents = strategy((event,), event)
            if index < warmup_events:
                intents = []
            self.decisions.append(
                {
                    "sequence": event.sequence,
                    "watermark_ms": event.event_time_ms,
                    "intents": intents,
                    "derived_bar": derived_bar_feature((event,)),
                }
            )
            self._enqueue_many(intents, current_sequence=event.sequence)
            self.equity_curve.append(
                {
                    "sequence": event.sequence,
                    "event_time_ms": event.event_time_ms,
                    "equity": str(self.account.equity()),
                    "position_qty": str(self.account.position_qty),
                }
            )
            if self.checkpoint_event_interval and (index + 1) % self.checkpoint_event_interval == 0:
                self.checkpoints.append(self.snapshot())
        if finalize:
            self.finalize_orders()
        return self.result()

    def finalize_orders(self) -> None:
        for order in self.orders:
            if order.status in {"OPEN", "PARTIAL"}:
                order.status = "CANCELLED_EOF"

    def result(self) -> SimulationResult:
        fills = [asdict(fill) for fill in self.fills]
        label = (
            "TRADE_SEQUENCE" if self.source_kind == "RAW_TRADE" else "AGGREGATED_TRADE_SEQUENCE"
        )
        fidelity = "TRADE_TAPE" if self.source_kind == "RAW_TRADE" else "AGG_TRADE_TAPE"
        account = self.account.snapshot()
        account["equity"] = str(self.account.equity())
        account["initial_balance"] = str(self.initial_balance)
        ledger = {
            "fill_count": len(self.fills),
            "notional": str(sum((fill.price * fill.qty for fill in self.fills), Decimal("0"))),
            "ambiguity_count": self.ambiguity_count,
            "open_order_count": sum(
                order.status in {"OPEN", "PARTIAL"} for order in self.orders
            ),
            "position_qty": str(self.position_qty),
            "fee_total": str(self.fee_total),
            "account": account,
            "account_hash": self.account.ledger_hash(),
        }
        return SimulationResult(
            decision_hash=sha256_hex(self.decisions),
            fill_hash=sha256_hex(fills),
            ledger_hash=sha256_hex(ledger),
            report_hash=sha256_hex(
                {
                    "fidelity_mode": fidelity,
                    "source_event_kind": self.source_kind,
                    "report_label": label,
                    "fills": fills,
                    "ledger": ledger,
                }
            ),
            ambiguity_count=self.ambiguity_count,
            fills=fills,
            orders=[_wire_order(order) for order in self.orders],
            rejected=list(self.rejected),
            ledger=ledger,
            equity_curve=list(self.equity_curve),
        )

    def _enqueue_many(
        self,
        intents: list[dict],
        *,
        current_sequence: int,
    ) -> None:
        normalized = [dict(intent) for intent in intents]
        limits = [
            item
            for item in normalized
            if item.get("type") == "LIMIT" and not item.get("oco_group")
        ]
        stops = [
            item
            for item in normalized
            if item.get("type") == "STOP" and not item.get("oco_group")
        ]
        if len(limits) == 1 and len(stops) == 1:
            limit = limits[0]
            stop = stops[0]
            if (
                limit.get("side") == stop.get("side")
                and str(limit.get("qty")) == str(stop.get("qty"))
            ):
                group = f"oco-{current_sequence}-{self._next_order_id}"
                limit["oco_group"] = group
                stop["oco_group"] = group
        for intent in normalized:
            self._enqueue(intent, current_sequence=current_sequence)

    def _enqueue(self, intent: Mapping[str, object], *, current_sequence: int) -> None:
        reason = reject_intent(intent)
        if reason is not None:
            rejected = {
                "accepted": False,
                "reason": reason,
                "sequence": current_sequence,
                "intent": dict(intent),
            }
            self.rejected.append(rejected)
            if self.execution_reporter is not None:
                self.execution_reporter(rejected)
            return
        order = SimulatedOrder(
                order_id=f"ord-{self._next_order_id}",
                side=str(intent["side"]),
                type=str(intent["type"]),
                qty=Decimal(str(intent["qty"])),
                limit_price=_optional_decimal(intent.get("limit_price")),
                stop_price=_optional_decimal(intent.get("stop_price")),
                eligible_after_sequence=current_sequence + 1,
                oco_group=(
                    None
                    if not str(intent.get("oco_group") or "").strip()
                    else str(intent["oco_group"])
                ),
                reduce_only=bool(intent.get("reduce_only") or False),
        )
        self.orders.append(order)
        if self.execution_reporter is not None:
            self.execution_reporter(
                {
                    "accepted": True,
                    "sequence": current_sequence,
                    "order": _wire_order(order),
                }
            )
        self._next_order_id += 1

    def _match(self, event: MarketEvent) -> None:
        price = Decimal(str(event.payload["price"]))
        qty = Decimal(str(event.payload["qty"]))
        open_orders = [
            order
            for order in self.orders
            if order.status in {"OPEN", "PARTIAL"}
            and order.eligible_after_sequence <= event.sequence
        ]
        remaining = qty
        for order in open_orders:
            if remaining <= 0:
                break
            if order.status not in {"OPEN", "PARTIAL"}:
                continue
            if order.type == "MARKET":
                fill_qty = min(order.qty, remaining)
                slip = price * self.slippage_bps / Decimal("10000")
                fill_price = price + slip if order.side == "BUY" else price - slip
                self._fill(order, event.sequence, fill_price, fill_qty, "NEXT_PRINT")
                remaining -= fill_qty
            elif order.type == "LIMIT" and _print_crosses_limit(order, price):
                assert order.limit_price is not None
                fill_qty = min(order.qty, remaining)
                self._fill(order, event.sequence, order.limit_price, fill_qty, "PRINT_THROUGH")
                remaining -= fill_qty
            elif order.type == "STOP" and _print_triggers_stop(order, price):
                fill_qty = min(order.qty, remaining)
                slip = price * self.slippage_bps / Decimal("10000")
                fill_price = price + slip if order.side == "BUY" else price - slip
                self._fill(order, event.sequence, fill_price, fill_qty, "STOP_PRINT")
                remaining -= fill_qty
            elif order.type == "STOP_LIMIT":
                if not order.activated and _print_triggers_stop(order, price):
                    order.activated = True
                if order.activated and _print_crosses_limit(order, price):
                    assert order.limit_price is not None
                    fill_qty = min(order.qty, remaining)
                    self._fill(
                        order, event.sequence, order.limit_price, fill_qty, "PRINT_THROUGH"
                    )
                    remaining -= fill_qty

    def _fill(
        self,
        order: SimulatedOrder,
        sequence: int,
        price: Decimal,
        qty: Decimal,
        reason: str,
    ) -> None:
        fill_qty = min(qty, order.qty)
        reduce_only_complete = False
        if order.reduce_only:
            reducible = (
                max(self.account.position_qty, Decimal("0"))
                if order.side == "SELL"
                else max(-self.account.position_qty, Decimal("0"))
            )
            fill_qty = min(fill_qty, reducible)
            if fill_qty <= 0:
                order.status = "CANCELLED_REDUCE_ONLY"
                return
            reduce_only_complete = fill_qty >= reducible
        fee_bps = (
            self.maker_fee_bps
            if order.type in {"LIMIT", "STOP_LIMIT"}
            else self.taker_fee_bps
        )
        fee = price * fill_qty * fee_bps / Decimal("10000")
        self.fee_total += fee
        self.account.mark = price
        position_before = self.account.position_qty
        self.account.apply_fill(side=order.side, price=price, qty=fill_qty, fee=fee)
        position_after = self.account.position_qty
        order.qty -= fill_qty
        order.status = "FILLED" if order.qty <= 0 or reduce_only_complete else "PARTIAL"
        if reduce_only_complete:
            order.qty = Decimal("0")
        if order.qty < 0:
            order.qty = Decimal("0")
        order.fill_price = price
        order.fill_sequence = sequence
        fill = SimulatedFill(
            order_id=order.order_id,
            sequence=sequence,
            event_time_ms=(0 if self._last_event is None else self._last_event.event_time_ms),
            side=order.side,
            price=price,
            qty=fill_qty,
            fee=fee,
            reason=reason,
            action=_fill_action(position_before, position_after),
            position_before=position_before,
            position_after=position_after,
        )
        self.fills.append(fill)
        if order.oco_group is not None and order.status == "FILLED":
            for sibling in self.orders:
                if (
                    sibling.order_id != order.order_id
                    and sibling.oco_group == order.oco_group
                    and sibling.status in {"OPEN", "PARTIAL"}
                ):
                    sibling.status = "CANCELLED_OCO"
        if self.execution_reporter is not None:
            self.execution_reporter(
                {
                    "accepted": True,
                    "fill": {**asdict(fill), "side": order.side},
                    "order_id": order.order_id,
                }
            )

    def _apply_funding(self, event: MarketEvent) -> None:
        if self.funding_rate == 0 or self.funding_interval_ms <= 0:
            return
        if self._next_funding_time_ms is None:
            self._next_funding_time_ms = event.event_time_ms + self.funding_interval_ms
            return
        while event.event_time_ms >= self._next_funding_time_ms:
            if self.account.position_qty != 0:
                self.account.apply(
                    MarketEvent(
                        sequence=event.sequence,
                        event_time_ms=self._next_funding_time_ms,
                        role="FUNDING",
                        payload={
                            "rate": str(self.funding_rate),
                            "period_id": f"fixed:{self._next_funding_time_ms}",
                        },
                    )
                )
            self._next_funding_time_ms += self.funding_interval_ms


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _order_side(orders: list[SimulatedOrder], order_id: str) -> str:
    for order in orders:
        if order.order_id == order_id:
            return order.side
    return "BUY"


def _print_crosses_limit(order: SimulatedOrder, price: Decimal) -> bool:
    if order.limit_price is None:
        return False
    if order.side == "BUY":
        return price <= order.limit_price
    return price >= order.limit_price


def _print_triggers_stop(order: SimulatedOrder, price: Decimal) -> bool:
    if order.stop_price is None:
        return False
    if order.side == "SELL":
        return price <= order.stop_price
    return price >= order.stop_price


def _wire_order(order: SimulatedOrder) -> dict[str, object]:
    return {
        "order_id": order.order_id,
        "side": order.side,
        "type": order.type,
        "qty": str(order.qty),
        "eligible_after_sequence": order.eligible_after_sequence,
        "limit_price": None if order.limit_price is None else str(order.limit_price),
        "stop_price": None if order.stop_price is None else str(order.stop_price),
        "status": order.status,
        "fill_price": None if order.fill_price is None else str(order.fill_price),
        "fill_sequence": order.fill_sequence,
        "activated": order.activated,
        "oco_group": order.oco_group,
        "reduce_only": order.reduce_only,
    }
