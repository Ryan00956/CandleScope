"""TRADE_TAPE / AGG_TRADE_TAPE reference loop. Separate from BAR fill policy."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any, Callable, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent, sha256_hex
from app.market_dataset.trades import assert_trade_stream
from app.simulation.kernel import SimulatedFill, SimulatedOrder, SimulationResult

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
    ambiguity_count: int = 0
    orders: list[SimulatedOrder] = field(default_factory=list)
    fills: list[SimulatedFill] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    checkpoints: list[dict] = field(default_factory=list)
    _next_order_id: int = 1
    source_kind: str = "RAW_TRADE"

    def snapshot(self) -> dict[str, Any]:
        return {
            "next_order_id": self._next_order_id,
            "ambiguity_count": self.ambiguity_count,
            "source_kind": self.source_kind,
            "orders": [asdict(order) for order in self.orders],
            "fills": [asdict(fill) for fill in self.fills],
            "decisions": list(self.decisions),
        }

    def restore(self, payload: Mapping[str, Any]) -> None:
        self._next_order_id = int(payload["next_order_id"])
        self.ambiguity_count = int(payload["ambiguity_count"])
        self.source_kind = str(payload["source_kind"])
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
            )
            for item in payload["orders"]  # type: ignore[union-attr]
        ]
        self.fills = [
            SimulatedFill(
                order_id=str(item["order_id"]),
                sequence=int(item["sequence"]),
                price=Decimal(str(item["price"])),
                qty=Decimal(str(item["qty"])),
                reason=str(item["reason"]),
            )
            for item in payload["fills"]  # type: ignore[union-attr]
        ]
        self.decisions = list(payload["decisions"])  # type: ignore[arg-type]

    def run(
        self,
        events: tuple[MarketEvent, ...],
        strategy: StrategyFn,
        *,
        warmup_events: int = 0,
    ) -> SimulationResult:
        if len(events) > self.max_events:
            raise MarketDatasetError("trade event budget exceeded", code="BUDGET_EXCEEDED")
        self.source_kind = assert_trade_stream(events)
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
                    "derived_bar": derived_bar_feature((event,)),
                }
            )
            for intent in intents:
                self._enqueue(intent, current_sequence=event.sequence)
            if self.checkpoint_event_interval and (index + 1) % self.checkpoint_event_interval == 0:
                self.checkpoints.append(self.snapshot())
        return self.result()

    def result(self) -> SimulationResult:
        fills = [asdict(fill) for fill in self.fills]
        label = (
            "TRADE_SEQUENCE" if self.source_kind == "RAW_TRADE" else "AGGREGATED_TRADE_SEQUENCE"
        )
        fidelity = "TRADE_TAPE" if self.source_kind == "RAW_TRADE" else "AGG_TRADE_TAPE"
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
                    "fidelity_mode": fidelity,
                    "source_event_kind": self.source_kind,
                    "report_label": label,
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
        price = Decimal(str(event.payload["price"]))
        qty = Decimal(str(event.payload["qty"]))
        open_orders = [
            order
            for order in self.orders
            if order.status == "OPEN" and order.eligible_after_sequence <= event.sequence
        ]
        remaining = qty
        for order in open_orders:
            if remaining <= 0:
                break
            if order.type == "MARKET":
                fill_qty = min(order.qty, remaining)
                self._fill(order, event.sequence, price, fill_qty, "NEXT_PRINT")
                remaining -= fill_qty
            elif order.type == "LIMIT" and _print_crosses_limit(order, price):
                assert order.limit_price is not None
                fill_qty = min(order.qty, remaining)
                self._fill(order, event.sequence, order.limit_price, fill_qty, "PRINT_THROUGH")
                remaining -= fill_qty
            elif order.type == "STOP" and _print_triggers_stop(order, price):
                fill_qty = min(order.qty, remaining)
                self._fill(order, event.sequence, price, fill_qty, "STOP_PRINT")
                remaining -= fill_qty

    def _fill(
        self,
        order: SimulatedOrder,
        sequence: int,
        price: Decimal,
        qty: Decimal,
        reason: str,
    ) -> None:
        order.status = "FILLED"
        order.fill_price = price
        order.fill_sequence = sequence
        self.fills.append(
            SimulatedFill(
                order_id=order.order_id,
                sequence=sequence,
                price=price,
                qty=qty,
                reason=reason,
            )
        )


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


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
