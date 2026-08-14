"""BAR_APPROX reference kernel used as the Host execution truth."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Callable, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent, sha256_hex
from app.simulation.contract_accounting import ContractAccount

ALLOWED_ORDER_TYPES = frozenset({"MARKET", "LIMIT", "STOP", "STOP_LIMIT"})
ALLOWED_SIDES = frozenset({"BUY", "SELL"})
GAP_POLICIES = frozenset({"REJECT", "PAUSE", "SKIP_WITH_WARNING"})


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
    activated: bool = False
    oco_group: str | None = None
    reduce_only: bool = False


@dataclass(frozen=True, slots=True)
class SimulatedFill:
    order_id: str
    sequence: int
    event_time_ms: int
    side: str
    price: Decimal
    qty: Decimal
    fee: Decimal
    reason: str
    action: str = ""
    position_before: Decimal = Decimal("0")
    position_after: Decimal = Decimal("0")


@dataclass(frozen=True, slots=True)
class SimulationResult:
    decision_hash: str
    fill_hash: str
    ledger_hash: str
    report_hash: str
    ambiguity_count: int
    fills: list[dict]
    orders: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)
    ledger: dict = field(default_factory=dict)
    equity_curve: list[dict] = field(default_factory=list)


StrategyFn = Callable[[tuple[MarketEvent, ...], MarketEvent], list[dict]]


@dataclass(slots=True)
class SimulationKernel:
    slippage_bps: Decimal = Decimal("1")
    taker_fee_bps: Decimal = Decimal("0")
    maker_fee_bps: Decimal = Decimal("0")
    funding_rate: Decimal = Decimal("0")
    funding_interval_ms: int = 28_800_000
    initial_balance: Decimal = Decimal("10000")
    price_tick: Decimal | None = None
    qty_step: Decimal | None = None
    min_notional: Decimal | None = None
    gap_policy: str = "REJECT"
    fill_policy: str = "BAR_NEXT_BAR_WORST_CASE_V1"
    ambiguity_count: int = 0
    paused: bool = False
    fee_total: Decimal = Decimal("0")
    orders: list[SimulatedOrder] = field(default_factory=list)
    fills: list[SimulatedFill] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)
    equity_curve: list[dict] = field(default_factory=list)
    execution_reporter: Callable[[dict], None] | None = field(
        default=None,
        repr=False,
    )
    account: ContractAccount = field(init=False)
    _next_order_id: int = 1
    _last_event: MarketEvent | None = None
    _next_funding_time_ms: int | None = None

    def __post_init__(self) -> None:
        self.account = ContractAccount(
            quote_balance=self.initial_balance,
            taker_fee_bps=self.taker_fee_bps,
            require_mark=False,
            require_funding=False,
            tick=self.price_tick,
            step=self.qty_step,
            min_notional=self.min_notional,
            liquidation_enabled=False,
        )

    def snapshot(self) -> dict:
        return {
            "slippage_bps": str(self.slippage_bps),
            "taker_fee_bps": str(self.taker_fee_bps),
            "maker_fee_bps": str(self.maker_fee_bps),
            "funding_rate": str(self.funding_rate),
            "funding_interval_ms": self.funding_interval_ms,
            "next_funding_time_ms": self._next_funding_time_ms,
            "gap_policy": self.gap_policy,
            "ambiguity_count": self.ambiguity_count,
            "paused": self.paused,
            "fee_total": str(self.fee_total),
            "orders": [asdict(order) for order in self.orders],
            "fills": [asdict(fill) for fill in self.fills],
            "decisions": list(self.decisions),
            "rejected": list(self.rejected),
            "equity_curve": list(self.equity_curve),
            "account": self.account.snapshot(),
            "next_order_id": self._next_order_id,
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

    def restore(self, payload: Mapping[str, object]) -> None:
        self.slippage_bps = Decimal(str(payload.get("slippage_bps") or self.slippage_bps))
        self.taker_fee_bps = Decimal(str(payload.get("taker_fee_bps") or "0"))
        self.maker_fee_bps = Decimal(str(payload.get("maker_fee_bps") or "0"))
        self.funding_rate = Decimal(str(payload.get("funding_rate") or "0"))
        self.funding_interval_ms = int(payload.get("funding_interval_ms") or 28_800_000)
        self._next_funding_time_ms = (
            None
            if payload.get("next_funding_time_ms") is None
            else int(payload["next_funding_time_ms"])
        )
        self.gap_policy = str(payload.get("gap_policy") or self.gap_policy)
        self.ambiguity_count = int(payload["ambiguity_count"])
        self.paused = bool(payload.get("paused") or False)
        self.fee_total = Decimal(str(payload.get("fee_total") or "0"))
        self.orders = [_order_from_mapping(item) for item in payload["orders"]]  # type: ignore[union-attr]
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
        self.equity_curve = list(payload.get("equity_curve") or [])  # type: ignore[arg-type]
        account = payload.get("account")
        if isinstance(account, Mapping):
            self.account.restore(account)
        self._next_order_id = int(payload["next_order_id"])
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
        checkpoint_callback: Callable[[MarketEvent], None] | None = None,
    ) -> SimulationResult:
        visible: list[MarketEvent] = []
        for index, event in enumerate(events):
            if self.paused:
                break
            if not self._accept_event(event):
                continue
            self.account.mark = _bar_decimal(event, "close")
            self._apply_funding(event)
            self._match(event)
            visible.append(event)
            intents = strategy((event,), event)
            if index < warmup_events:
                intents = []
            self.decisions.append(
                {
                    "sequence": event.sequence,
                    "watermark_ms": event.event_time_ms,
                    "intents": intents,
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
            if checkpoint_callback is not None:
                checkpoint_callback(event)
        if finalize:
            self.finalize_orders()
        return self.result()

    def finalize_orders(self) -> None:
        for order in self.orders:
            if order.status in {"OPEN", "PARTIAL"}:
                order.status = "CANCELLED_EOF"

    def result(self) -> SimulationResult:
        fills = [asdict(fill) for fill in self.fills]
        orders = [_wire_order(order) for order in self.orders]
        account = self.account.snapshot()
        account["equity"] = str(self.account.equity())
        account["initial_balance"] = str(self.initial_balance)
        ledger = {
            "fill_count": len(self.fills),
            "notional": str(sum((fill.price * fill.qty for fill in self.fills), Decimal("0"))),
            "fee_total": str(self.fee_total),
            "ambiguity_count": self.ambiguity_count,
            "account": account,
            "account_hash": self.account.ledger_hash(),
            "open_order_count": sum(
                order.status in {"OPEN", "PARTIAL"} for order in self.orders
            ),
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
            orders=orders,
            rejected=list(self.rejected),
            ledger=ledger,
            equity_curve=list(self.equity_curve),
        )

    def _accept_event(self, event: MarketEvent) -> bool:
        previous = self._last_event
        self._last_event = event
        if previous is None:
            return True
        if int(event.event_time_ms) < int(previous.event_time_ms):
            raise MarketDatasetError("bar time went backwards", code="DATA_GAP_REJECTED")
        if int(event.sequence) == int(previous.sequence) + 1:
            return True
        if self.gap_policy not in GAP_POLICIES:
            raise MarketDatasetError("unknown gap policy", code="SCHEMA_UNKNOWN_FIELD")
        if self.gap_policy == "REJECT":
            raise MarketDatasetError("bar sequence gap", code="DATA_GAP_REJECTED")
        if self.gap_policy == "PAUSE":
            self.paused = True
            self._last_event = previous
            return False
        self.ambiguity_count += 1
        return True

    def _enqueue_many(
        self,
        intents: list[dict],
        *,
        current_sequence: int,
    ) -> None:
        normalized = [dict(intent) for intent in intents]
        limits = [
            item for item in normalized
            if item.get("type") == "LIMIT" and not item.get("oco_group")
        ]
        stops = [
            item for item in normalized
            if item.get("type") == "STOP" and not item.get("oco_group")
        ]
        if len(limits) == 1 and len(stops) == 1:
            limit = limits[0]
            stop = stops[0]
            if limit.get("side") == stop.get("side") and str(limit.get("qty")) == str(stop.get("qty")):
                group = f"oco-{current_sequence}-{self._next_order_id}"
                limit["oco_group"] = group
                stop["oco_group"] = group
        for intent in normalized:
            self._enqueue(intent, current_sequence=current_sequence)

    def _enqueue(self, intent: Mapping[str, object], *, current_sequence: int) -> None:
        current_price = (
            None
            if self._last_event is None
            else _bar_decimal(self._last_event, "close")
        )
        reason = reject_intent(
            intent,
            current_price=current_price,
            price_tick=self.price_tick,
            qty_step=self.qty_step,
            min_notional=self.min_notional,
        )
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
        stop_hits = [
            order
            for order in open_orders
            if order.type == "STOP" and _stop_hit(order, high, low)
        ]
        target_hits = [
            order
            for order in open_orders
            if order.type == "LIMIT" and _limit_hit(order, high, low)
        ]
        ambiguous_groups = {
            order.oco_group for order in stop_hits if order.oco_group is not None
        } & {
            order.oco_group for order in target_hits if order.oco_group is not None
        }
        for group in sorted(ambiguous_groups):
            self.ambiguity_count += 1
            for order in stop_hits:
                if order.oco_group == group and order.status == "OPEN":
                    self._fill(order, event.sequence, _stop_price(order), "WORST_CASE_STOP")
        for order in open_orders:
            if order.status != "OPEN":
                continue
            if order.type == "MARKET":
                slip = open_ * self.slippage_bps / Decimal("10000")
                price = open_ + slip if order.side == "BUY" else open_ - slip
                self._fill(order, event.sequence, price, "NEXT_BAR_OPEN")
            elif order.type == "LIMIT" and _limit_hit(order, high, low):
                assert order.limit_price is not None
                self._fill(order, event.sequence, order.limit_price, "LIMIT_THROUGH")
            elif order.type == "STOP_LIMIT":
                if not order.activated and _stop_hit(order, high, low):
                    order.activated = True
                if order.activated and _limit_hit(order, high, low):
                    assert order.limit_price is not None
                    self._fill(order, event.sequence, order.limit_price, "LIMIT_THROUGH")
            elif order.type == "STOP" and _stop_hit(order, high, low):
                self._fill(order, event.sequence, _stop_price(order), "STOP_TRIGGER")

    def _fill(self, order: SimulatedOrder, sequence: int, price: Decimal, reason: str) -> None:
        fill_qty = order.qty
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
        order.status = "FILLED"
        order.fill_price = price
        order.fill_sequence = sequence
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
        if order.oco_group is not None:
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


def reject_intent(
    intent: Mapping[str, object],
    *,
    current_price: Decimal | None = None,
    price_tick: Decimal | None = None,
    qty_step: Decimal | None = None,
    min_notional: Decimal | None = None,
) -> str | None:
    side = str(intent.get("side") or "")
    order_type = str(intent.get("type") or "")
    tif = str(intent.get("time_in_force") or intent.get("tif") or "GTC")
    try:
        qty = Decimal(str(intent.get("qty")))
    except (InvalidOperation, TypeError, ValueError):
        return "INVALID_QTY"
    if side not in ALLOWED_SIDES:
        return "INVALID_SIDE"
    if order_type not in ALLOWED_ORDER_TYPES:
        return "UNSUPPORTED_TYPE"
    if not qty.is_finite() or qty <= 0:
        return "NON_POSITIVE_QTY"
    if tif != "GTC":
        return "UNSUPPORTED_TIF"
    limit_price, limit_error = _validated_price(intent.get("limit_price"))
    stop_price, stop_error = _validated_price(intent.get("stop_price"))
    if order_type in {"LIMIT", "STOP_LIMIT"} and limit_price is None:
        return limit_error or "LIMIT_PRICE_REQUIRED"
    if order_type in {"STOP", "STOP_LIMIT"} and stop_price is None:
        return stop_error or "STOP_PRICE_REQUIRED"
    if qty_step is not None and qty % qty_step != 0:
        return "QTY_STEP_MISMATCH"
    for price in (limit_price, stop_price):
        if price is not None and price_tick is not None and price % price_tick != 0:
            return "PRICE_TICK_MISMATCH"
    reference_price = limit_price or stop_price or current_price
    if (
        min_notional is not None
        and reference_price is not None
        and reference_price * qty < min_notional
    ):
        return "MIN_NOTIONAL"
    return None


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _order_side(orders: list[SimulatedOrder], order_id: str) -> str:
    for order in orders:
        if order.order_id == order_id:
            return order.side
    return "BUY"


def _fill_action(before: Decimal, after: Decimal) -> str:
    if before == 0:
        return "OPEN_LONG" if after > 0 else "OPEN_SHORT"
    if after == 0:
        return "CLOSE_LONG" if before > 0 else "CLOSE_SHORT"
    if before > 0 > after:
        return "REVERSE_TO_SHORT"
    if before < 0 < after:
        return "REVERSE_TO_LONG"
    if abs(after) > abs(before):
        return "ADD_LONG" if after > 0 else "ADD_SHORT"
    return "REDUCE_LONG" if before > 0 else "REDUCE_SHORT"


def _validated_price(value: object) -> tuple[Decimal | None, str | None]:
    if value is None:
        return None, None
    try:
        price = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None, "INVALID_PRICE"
    if not price.is_finite() or price <= 0:
        return None, "INVALID_PRICE"
    return price, None


def _bar_decimal(event: MarketEvent, name: str) -> Decimal:
    try:
        value = Decimal(str(event.payload[name]))
    except (KeyError, InvalidOperation, TypeError, ValueError) as exc:
        raise MarketDatasetError(
            f"bar {name} is invalid",
            code="DATA_QUALITY_FAILED",
        ) from exc
    if not value.is_finite() or value <= 0:
        raise MarketDatasetError(
            f"bar {name} must be finite and positive",
            code="DATA_QUALITY_FAILED",
        )
    return value


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


def _order_from_mapping(item: Mapping[str, object]) -> SimulatedOrder:
    return SimulatedOrder(
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
        oco_group=(None if item.get("oco_group") is None else str(item["oco_group"])),
        reduce_only=bool(item.get("reduce_only") or False),
    )


def _limit_hit(order: SimulatedOrder, high: Decimal, low: Decimal) -> bool:
    if order.limit_price is None:
        return False
    if order.side == "BUY":
        return low <= order.limit_price
    return high >= order.limit_price


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
