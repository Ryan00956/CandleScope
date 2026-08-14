"""BAR_APPROX reference kernel used as the Host execution truth."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Callable, Mapping

from app.market_dataset.snapshot import MarketEvent, sha256_hex


@dataclass(slots=True)
class SimulatedOrder:
    order_id: str
    side: str
    type: str
    qty: Decimal
    eligible_after_sequence: int
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    status: str = "OPEN"
    fill_price: Decimal | None = None
    fill_sequence: int | None = None


@dataclass(frozen=True, slots=True)
class SimulatedFill:
    order_id: str
    sequence: int
    price: Decimal
    qty: Decimal
    reason: str


@dataclass(frozen=True, slots=True)
class SimulationResult:
    decision_hash: str
    fill_hash: str
    ledger_hash: str
    report_hash: str
    ambiguity_count: int
    fills: list[dict]


StrategyFn = Callable[[tuple[MarketEvent, ...], MarketEvent], list[dict]]


@dataclass(slots=True)
class SimulationKernel:
    slippage_bps: Decimal = Decimal("1")
    fill_policy: str = "BAR_NEXT_BAR_WORST_CASE_V1"
    ambiguity_count: int = 0
    orders: list[SimulatedOrder] = field(default_factory=list)
    fills: list[SimulatedFill] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    _next_order_id: int = 1

    def run(
        self,
        events: tuple[MarketEvent, ...],
        strategy: StrategyFn,
        *,
        warmup_events: int = 0,
    ) -> SimulationResult:
        visible: list[MarketEvent] = []
        for index, event in enumerate(events):
            self._match(event)
            visible.append(event)
            intents = strategy(tuple(visible), event) if index >= warmup_events else []
            self.decisions.append(
                {
                    "sequence": event.sequence,
                    "watermark_ms": event.event_time_ms,
                    "intents": intents,
                }
            )
            for intent in intents:
                self._enqueue(intent, current_sequence=event.sequence)
        return self.result()

    def result(self) -> SimulationResult:
        fills = [asdict(fill) for fill in self.fills]
        ledger = {
            "fill_count": len(self.fills),
            "notional": str(sum((fill.price * fill.qty for fill in self.fills), Decimal("0"))),
            "ambiguity_count": self.ambiguity_count,
        }
        return SimulationResult(
            decision_hash=sha256_hex(self.decisions),
            fill_hash=sha256_hex(fills),
            ledger_hash=sha256_hex(ledger),
            report_hash=sha256_hex(
                {
                    "fidelity_mode": "BAR_APPROX",
                    "report_label": "APPROXIMATE",
                    "fills": fills,
                    "ledger": ledger,
                }
            ),
            ambiguity_count=self.ambiguity_count,
            fills=fills,
        )

    def _enqueue(self, intent: Mapping[str, object], *, current_sequence: int) -> None:
        self.orders.append(
            SimulatedOrder(
                order_id=f"ord-{self._next_order_id}",
                side=str(intent["side"]),
                type=str(intent["type"]),
                qty=Decimal(str(intent["qty"])),
                limit_price=_optional_decimal(intent.get("limit_price")),
                stop_price=_optional_decimal(intent.get("stop_price")),
                eligible_after_sequence=current_sequence + 1,
            )
        )
        self._next_order_id += 1

    def _match(self, event: MarketEvent) -> None:
        bar = event.payload
        open_orders = [
            order
            for order in self.orders
            if order.status == "OPEN" and order.eligible_after_sequence <= event.sequence
        ]
        if not open_orders:
            return
        high = Decimal(str(bar["high"]))
        low = Decimal(str(bar["low"]))
        open_ = Decimal(str(bar["open"]))
        stop_hits = [order for order in open_orders if _stop_hit(order, high, low)]
        target_hits = [order for order in open_orders if _limit_hit(order, high, low)]
        if stop_hits and target_hits:
            self.ambiguity_count += 1
            for order in stop_hits:
                self._fill(order, event.sequence, _stop_price(order), "WORST_CASE_STOP")
            return
        for order in open_orders:
            if order.status != "OPEN":
                continue
            if order.type == "MARKET":
                slip = open_ * self.slippage_bps / Decimal("10000")
                price = open_ + slip if order.side == "BUY" else open_ - slip
                self._fill(order, event.sequence, price, "NEXT_BAR_OPEN")
            elif order.type in {"LIMIT", "STOP_LIMIT"} and _limit_hit(order, high, low):
                assert order.limit_price is not None
                self._fill(order, event.sequence, order.limit_price, "LIMIT_THROUGH")
            elif order.type == "STOP" and _stop_hit(order, high, low):
                self._fill(order, event.sequence, _stop_price(order), "STOP_TRIGGER")

    def _fill(self, order: SimulatedOrder, sequence: int, price: Decimal, reason: str) -> None:
        order.status = "FILLED"
        order.fill_price = price
        order.fill_sequence = sequence
        self.fills.append(
            SimulatedFill(
                order_id=order.order_id,
                sequence=sequence,
                price=price,
                qty=order.qty,
                reason=reason,
            )
        )


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _limit_hit(order: SimulatedOrder, high: Decimal, low: Decimal) -> bool:
    if order.limit_price is None:
        return False
    if order.side == "BUY":
        return high >= order.limit_price
    return low <= order.limit_price


def _stop_hit(order: SimulatedOrder, high: Decimal, low: Decimal) -> bool:
    if order.stop_price is None:
        return False
    if order.side == "SELL":
        return low <= order.stop_price
    return high >= order.stop_price


def _stop_price(order: SimulatedOrder) -> Decimal:
    if order.type == "STOP_LIMIT" and order.limit_price is not None:
        return order.limit_price
    assert order.stop_price is not None
    return order.stop_price
