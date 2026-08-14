"""BAR_APPROX reference kernel used as the Host execution truth."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Callable, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent, sha256_hex
from app.simulation.contract_accounting import ContractAccount
from app.simulation.linear_perp_account_v2 import (
    ACCOUNT_MODEL as ACCOUNT_MODEL_V2,
    LinearPerpetualAccountV2,
)
from app.simulation.execution_realism import (
    BAR_PATH_SCENARIO,
    EXECUTION_REALISM_V2,
    source_event_trace,
)

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
    account_model: str = "LINEAR_PERP_ONE_WAY_V1"
    funding_mode: str = "OFF"
    leverage: Decimal = Decimal("1")
    host_policy_revision: str | None = None
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
    execution_model_revision: str | None = None
    participation_rate: Decimal | None = None
    latency_ms: int = 0
    latency_events: int = 0
    order_end_policy: str = "CANCEL_AT_END"
    bar_path_scenario: str | None = None
    ambiguity_count: int = 0
    paused: bool = False
    fee_total: Decimal = Decimal("0")
    orders: list[SimulatedOrder] = field(default_factory=list)
    fills: list[SimulatedFill] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)
    equity_curve: list[dict] = field(default_factory=list)
    equity_curve_event_interval: int = 1
    equity_curve_mode: str | None = None
    execution_reporter: Callable[[dict], None] | None = field(
        default=None,
        repr=False,
    )
    account: ContractAccount | LinearPerpetualAccountV2 = field(init=False)
    _next_order_id: int = 1
    _last_event: MarketEvent | None = None
    _next_funding_time_ms: int | None = None
    _market_event_count: int = 0
    _order_tif: dict[str, str] = field(default_factory=dict)
    _order_events: list[dict] = field(default_factory=list)
    frozen_intents: list[dict] = field(default_factory=list)
    _decision_chain_hash: str = "sha256:GENESIS"
    _decision_count: int = 0

    def __post_init__(self) -> None:
        if self.execution_model_revision == EXECUTION_REALISM_V2:
            if (
                self.participation_rate is None
                or self.participation_rate <= 0
                or self.participation_rate > 1
            ):
                raise MarketDatasetError(
                    "V2 participation rate must be in (0, 1]",
                    code="SCHEMA_UNKNOWN_FIELD",
                )
            if self.bar_path_scenario != BAR_PATH_SCENARIO:
                raise MarketDatasetError(
                    "V2 bar path scenario is not frozen",
                    code="FIDELITY_UNSUPPORTED",
                )
        if self.account_model == ACCOUNT_MODEL_V2:
            self.account = LinearPerpetualAccountV2(
                initial_balance=self.initial_balance,
                leverage=self.leverage,
                funding_mode=self.funding_mode,
                taker_fee_bps=self.taker_fee_bps,
            )
            return
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

    @property
    def projected_position_qty(self) -> Decimal:
        pending = sum(
            (
                order.qty if order.side == "BUY" else -order.qty
                for order in self.orders
                if order.type == "MARKET" and order.status in {"OPEN", "PARTIAL"}
            ),
            Decimal("0"),
        )
        return self.account.position_qty + pending

    def snapshot(self) -> dict:
        return {
            **(
                {
                    "execution_model_revision": self.execution_model_revision,
                    "participation_rate": str(self.participation_rate),
                    "order_end_policy": self.order_end_policy,
                    "bar_path_scenario": self.bar_path_scenario,
                    "order_tif": dict(self._order_tif),
                    "order_events": list(self._order_events),
                    "frozen_intents": list(self.frozen_intents),
                    "decision_chain_hash": self._decision_chain_hash,
                    "decision_count": self._decision_count,
                    "equity_curve_event_interval": self.equity_curve_event_interval,
                    "equity_curve_mode": self.equity_curve_mode,
                    "fill_source_events": [
                        {
                            "sequence": event.sequence,
                            "event_time_ms": event.event_time_ms,
                            "role": event.role,
                            "payload": dict(event.payload),
                        }
                        for event in self._fill_source_events
                    ],
                }
                if self.execution_model_revision == EXECUTION_REALISM_V2
                else {}
            ),
            **(
                {"host_policy_revision": self.host_policy_revision}
                if self.host_policy_revision is not None
                else {}
            ),
            **(
                {
                    "account_model": self.account_model,
                    "funding_mode": self.funding_mode,
                    "leverage": str(self.leverage),
                    "market_event_count": self._market_event_count,
                }
                if isinstance(self.account, LinearPerpetualAccountV2)
                else {}
            ),
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
        if payload.get("equity_curve_mode") != self.equity_curve_mode:
            raise MarketDatasetError(
                "equity curve checkpoint identity changed", code="CHECKPOINT_CORRUPT"
            )
        if payload.get("execution_model_revision") != self.execution_model_revision:
            raise MarketDatasetError(
                "execution model checkpoint identity changed",
                code="CHECKPOINT_CORRUPT",
            )
        if payload.get("host_policy_revision") != self.host_policy_revision:
            raise MarketDatasetError(
                "Host policy checkpoint identity changed", code="CHECKPOINT_CORRUPT"
            )
        if (
            str(payload.get("account_model") or "LINEAR_PERP_ONE_WAY_V1")
            != self.account_model
        ):
            raise MarketDatasetError(
                "account model checkpoint identity changed", code="CHECKPOINT_CORRUPT"
            )
        self.slippage_bps = Decimal(
            str(payload.get("slippage_bps") or self.slippage_bps)
        )
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
                side=str(
                    item.get("side") or _order_side(self.orders, str(item["order_id"]))
                ),
                price=Decimal(str(item["price"])),
                qty=Decimal(str(item["qty"])),
                fee=Decimal(str("0" if item.get("fee") is None else item["fee"])),
                reason=str(item["reason"]),
                action=str(item.get("action") or ""),
                position_before=Decimal(
                    str(
                        "0"
                        if item.get("position_before") is None
                        else item["position_before"]
                    )
                ),
                position_after=Decimal(
                    str(
                        "0"
                        if item.get("position_after") is None
                        else item["position_after"]
                    )
                ),
            )
            for item in payload["fills"]  # type: ignore[union-attr]
        ]
        self.decisions = list(payload["decisions"])  # type: ignore[arg-type]
        self.rejected = list(payload.get("rejected") or [])  # type: ignore[arg-type]
        if self.execution_model_revision == EXECUTION_REALISM_V2:
            self._order_tif = {
                str(key): str(value)
                for key, value in dict(payload.get("order_tif") or {}).items()
            }
            self._order_events = list(payload.get("order_events") or [])  # type: ignore[arg-type]
            self.frozen_intents = list(payload.get("frozen_intents") or [])  # type: ignore[arg-type]
            self._decision_chain_hash = str(
                payload.get("decision_chain_hash") or "sha256:GENESIS"
            )
            self._decision_count = int(payload.get("decision_count") or 0)
            self._fill_source_events = [
                MarketEvent(
                    sequence=int(item["sequence"]),
                    event_time_ms=int(item["event_time_ms"]),
                    role=str(item["role"]),
                    payload=dict(item["payload"]),  # type: ignore[arg-type]
                )
                for item in payload.get("fill_source_events") or []  # type: ignore[union-attr]
            ]
        self.equity_curve = list(payload.get("equity_curve") or [])  # type: ignore[arg-type]
        account = payload.get("account")
        if isinstance(account, Mapping):
            self.account.restore(account)
        self._next_order_id = int(payload["next_order_id"])
        self._market_event_count = int(payload.get("market_event_count") or 0)
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
        for event in events:
            if self.paused:
                break
            if not self._accept_event(event):
                continue
            if event.role in {"INSTRUMENT_RULES", "MARK_INDEX", "FUNDING"}:
                self.account.apply(event)
                continue
            if event.role != "BARS":
                raise MarketDatasetError(
                    "BAR kernel received unsupported role", code="FIDELITY_MISLABEL"
                )
            self._market_event_count += 1
            market_event = (
                MarketEvent(
                    sequence=self._market_event_count,
                    event_time_ms=event.event_time_ms,
                    role=event.role,
                    payload=event.payload,
                )
                if isinstance(self.account, LinearPerpetualAccountV2)
                else event
            )
            if isinstance(self.account, LinearPerpetualAccountV2):
                self.account.validate_ready()
            else:
                self.account.mark = _bar_decimal(event, "close")
            self._apply_funding(market_event)
            self._match(market_event)
            visible.append(market_event)
            intents = strategy((market_event,), market_event)
            if self._market_event_count <= warmup_events:
                intents = []
            decision = _decision_record(
                intents,
                sequence=market_event.sequence,
                watermark_ms=market_event.event_time_ms,
            )
            if self.execution_model_revision == EXECUTION_REALISM_V2:
                self._decision_chain_hash = "sha256:" + sha256_hex(
                    {"previous": self._decision_chain_hash, "decision": decision}
                )
                self._decision_count += 1
            else:
                self.decisions.append(decision)
            if self.execution_model_revision == EXECUTION_REALISM_V2 and intents:
                self.frozen_intents.append(
                    {
                        "sequence": market_event.sequence,
                        "intents": [dict(intent) for intent in intents],
                    }
                )
            self._enqueue_many(intents, current_sequence=market_event.sequence)
            curve_point = {
                "sequence": market_event.sequence,
                "event_time_ms": market_event.event_time_ms,
                "equity": str(self.account.equity()),
                "position_qty": str(self.account.position_qty),
            }
            if isinstance(self.account, LinearPerpetualAccountV2):
                curve_point.update(
                    {
                        "wallet_balance": str(self.account.quote_balance),
                        "available_balance": str(self.account.available_balance()),
                    }
                )
            if self.equity_curve_mode == "UTC_DAILY_CLOSE_V1":
                self._record_equity_point(curve_point)
            elif (
                self.execution_model_revision != EXECUTION_REALISM_V2
                or self._market_event_count == 1
                or self._market_event_count % self.equity_curve_event_interval == 0
            ):
                self.equity_curve.append(curve_point)
            if checkpoint_callback is not None:
                checkpoint_callback(event)
        self._append_terminal_curve_point()
        if finalize:
            self.finalize_orders()
        return self.result()

    def _append_terminal_curve_point(self) -> None:
        if (
            self.execution_model_revision != EXECUTION_REALISM_V2
            or self._last_event is None
            or self._last_event.role != "BARS"
            or (
                self.equity_curve
                and self.equity_curve[-1]["sequence"] == self._last_event.sequence
            )
        ):
            return
        point = {
            "sequence": self._last_event.sequence,
            "event_time_ms": self._last_event.event_time_ms,
            "equity": str(self.account.equity()),
            "position_qty": str(self.account.position_qty),
        }
        if isinstance(self.account, LinearPerpetualAccountV2):
            point.update(
                {
                    "wallet_balance": str(self.account.quote_balance),
                    "available_balance": str(self.account.available_balance()),
                }
            )
        self._record_equity_point(point)

    def _record_equity_point(self, point: dict) -> None:
        if (
            self.equity_curve_mode == "UTC_DAILY_CLOSE_V1"
            and self.equity_curve
            and int(self.equity_curve[-1]["event_time_ms"]) // 86_400_000
            == int(point["event_time_ms"]) // 86_400_000
        ):
            self.equity_curve[-1] = point
            return
        self.equity_curve.append(point)

    def finalize_orders(self) -> None:
        for order in self.orders:
            if order.status in {"OPEN", "PARTIAL"}:
                if (
                    self.execution_model_revision == EXECUTION_REALISM_V2
                    and self.order_end_policy == "KEEP_OPEN"
                ):
                    continue
                order.status = (
                    "CANCELLED"
                    if self.execution_model_revision == EXECUTION_REALISM_V2
                    else "CANCELLED_EOF"
                )
                self._lifecycle(order, order.status, reason="END_OF_RANGE")
                if isinstance(self.account, LinearPerpetualAccountV2):
                    self.account.release_order_margin(order.order_id)

    def result(self) -> SimulationResult:
        fills = [asdict(fill) for fill in self.fills]
        if self.execution_model_revision == EXECUTION_REALISM_V2:
            for fill, event in zip(fills, self._fill_source_events, strict=True):
                fill.update(source_event_trace(event, source_kind="BAR"))
        orders = [_wire_order(order) for order in self.orders]
        account = self.account.snapshot()
        account["equity"] = str(self.account.equity())
        account["initial_balance"] = str(self.initial_balance)
        ledger = {
            "fill_count": len(self.fills),
            "notional": str(
                sum((fill.price * fill.qty for fill in self.fills), Decimal("0"))
            ),
            "fee_total": str(self.fee_total),
            "ambiguity_count": self.ambiguity_count,
            "account": account,
            "account_hash": self.account.ledger_hash(),
            "open_order_count": sum(
                order.status in {"OPEN", "PARTIAL"} for order in self.orders
            ),
        }
        if self.execution_model_revision == EXECUTION_REALISM_V2:
            ledger["order_events"] = list(self._order_events)
            ledger["decision_count"] = self._decision_count
        return SimulationResult(
            decision_hash=(
                self._decision_chain_hash
                if self.execution_model_revision == EXECUTION_REALISM_V2
                else sha256_hex(self.decisions)
            ),
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
            raise MarketDatasetError(
                "bar time went backwards", code="DATA_GAP_REJECTED"
            )
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
            if limit.get("side") == stop.get("side") and str(limit.get("qty")) == str(
                stop.get("qty")
            ):
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
        price_tick = self.price_tick
        qty_step = self.qty_step
        min_notional = self.min_notional
        if isinstance(self.account, LinearPerpetualAccountV2):
            price_tick = self.account.tick
            qty_step = self.account.step
            min_notional = self.account.min_notional
        reason = reject_intent(
            intent,
            current_price=current_price,
            price_tick=price_tick,
            qty_step=qty_step,
            min_notional=min_notional,
            allow_reduce_only_below_min_notional=(
                self.host_policy_revision is not None
            ),
            allow_ioc=self.execution_model_revision == EXECUTION_REALISM_V2,
        )
        if reason is not None:
            rejected = {
                "accepted": False,
                "reason": reason,
                "sequence": current_sequence,
                "intent": dict(intent),
            }
            self.rejected.append(rejected)
            self._rejected_lifecycle(rejected)
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
        self._order_tif[order.order_id] = str(intent.get("tif") or "GTC").upper()
        self._lifecycle(order, "NEW")
        if isinstance(self.account, LinearPerpetualAccountV2):
            reference = (
                current_price if current_price is not None else self.account.mark
            )
            assert reference is not None
            fee_bps = (
                self.maker_fee_bps
                if order.type in {"LIMIT", "STOP_LIMIT"}
                else self.taker_fee_bps
            )
            try:
                self.account.reserve_order_margin(
                    order_id=order.order_id,
                    qty=(
                        Decimal("0")
                        if order.reduce_only
                        else max(
                            Decimal("0"),
                            abs(self.projected_position_qty)
                            - abs(self.account.position_qty),
                        )
                    ),
                    reference_price=reference,
                    estimated_fee=reference * order.qty * fee_bps / Decimal("10000"),
                )
            except MarketDatasetError as exc:
                self.orders.pop()
                self._order_tif.pop(order.order_id, None)
                rejected = {
                    "accepted": False,
                    "reason": exc.code,
                    "sequence": current_sequence,
                    "intent": dict(intent),
                }
                self.rejected.append(rejected)
                self._rejected_lifecycle(rejected, order_id=order.order_id)
                if self.execution_reporter is not None:
                    self.execution_reporter(rejected)
                return
        if self.execution_reporter is not None:
            self.execution_reporter(
                {
                    "accepted": True,
                    "sequence": current_sequence,
                    "order": _wire_order(order),
                }
            )
        self._lifecycle(order, "ACCEPTED")
        self._lifecycle(order, "OPEN")
        self._next_order_id += 1

    def _match(self, event: MarketEvent) -> None:
        bar = event.payload
        open_orders = [
            order
            for order in self.orders
            if order.status in {"OPEN", "PARTIAL"}
            and order.eligible_after_sequence <= event.sequence
        ]
        if not open_orders:
            return
        remaining_capacity = (
            Decimal(str(bar.get("volume") or "0")) * self.participation_rate
            if self.execution_model_revision == EXECUTION_REALISM_V2
            else None
        )
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
        } & {order.oco_group for order in target_hits if order.oco_group is not None}
        for group in sorted(ambiguous_groups):
            self.ambiguity_count += 1
            for order in stop_hits:
                if order.oco_group == group and order.status in {"OPEN", "PARTIAL"}:
                    used = self._fill(
                        order,
                        event.sequence,
                        _stop_price(order),
                        "WORST_CASE_STOP",
                        remaining_capacity,
                    )
                    if remaining_capacity is not None:
                        remaining_capacity -= used
        for order in open_orders:
            if order.status not in {"OPEN", "PARTIAL"}:
                continue
            if remaining_capacity is not None and remaining_capacity <= 0:
                break
            used = Decimal("0")
            if order.type == "MARKET":
                slip = open_ * self.slippage_bps / Decimal("10000")
                price = open_ + slip if order.side == "BUY" else open_ - slip
                used = self._fill(
                    order, event.sequence, price, "NEXT_BAR_OPEN", remaining_capacity
                )
            elif order.type == "LIMIT" and _limit_hit(order, high, low):
                assert order.limit_price is not None
                used = self._fill(
                    order,
                    event.sequence,
                    order.limit_price,
                    "LIMIT_THROUGH",
                    remaining_capacity,
                )
            elif order.type == "STOP_LIMIT":
                if not order.activated and _stop_hit(order, high, low):
                    order.activated = True
                if order.activated and _limit_hit(order, high, low):
                    assert order.limit_price is not None
                    used = self._fill(
                        order,
                        event.sequence,
                        order.limit_price,
                        "LIMIT_THROUGH",
                        remaining_capacity,
                    )
            elif order.type == "STOP" and _stop_hit(order, high, low):
                used = self._fill(
                    order,
                    event.sequence,
                    _stop_price(order),
                    "STOP_TRIGGER",
                    remaining_capacity,
                )
            if remaining_capacity is not None:
                remaining_capacity -= used
        if self.execution_model_revision == EXECUTION_REALISM_V2:
            for order in open_orders:
                if self._order_tif.get(order.order_id) == "IOC" and order.status in {
                    "OPEN",
                    "PARTIAL",
                }:
                    order.status = "EXPIRED"
                    self._lifecycle(order, "EXPIRED", reason="IOC_REMAINDER")
                    if isinstance(self.account, LinearPerpetualAccountV2):
                        self.account.release_order_margin(order.order_id)

    def _fill(
        self,
        order: SimulatedOrder,
        sequence: int,
        price: Decimal,
        reason: str,
        capacity: Decimal | None = None,
    ) -> Decimal:
        fill_qty = order.qty if capacity is None else min(order.qty, capacity)
        if fill_qty <= 0:
            return Decimal("0")
        if order.reduce_only:
            reducible = (
                max(self.account.position_qty, Decimal("0"))
                if order.side == "SELL"
                else max(-self.account.position_qty, Decimal("0"))
            )
            fill_qty = min(fill_qty, reducible)
            if fill_qty <= 0:
                order.status = (
                    "CANCELLED"
                    if self.execution_model_revision == EXECUTION_REALISM_V2
                    else "CANCELLED_REDUCE_ONLY"
                )
                self._lifecycle(order, order.status, reason="REDUCE_ONLY_ZERO")
                if isinstance(self.account, LinearPerpetualAccountV2):
                    self.account.release_order_margin(order.order_id)
                return Decimal("0")
        order_qty_before = order.qty
        if self.execution_model_revision == EXECUTION_REALISM_V2:
            order.qty -= fill_qty
            order.status = "FILLED" if order.qty <= 0 else "PARTIAL"
        else:
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
        if not isinstance(self.account, LinearPerpetualAccountV2):
            self.account.mark = price
        position_before = self.account.position_qty
        if isinstance(self.account, LinearPerpetualAccountV2):
            self.account.apply_fill(
                side=order.side,
                price=price,
                qty=fill_qty,
                fee=fee,
                event_time_ms=(
                    0 if self._last_event is None else self._last_event.event_time_ms
                ),
                order_id=order.order_id,
                order_margin_fraction=(
                    fill_qty / order_qty_before
                    if self.execution_model_revision == EXECUTION_REALISM_V2
                    else Decimal("1")
                ),
            )
        else:
            self.account.apply_fill(side=order.side, price=price, qty=fill_qty, fee=fee)
        position_after = self.account.position_qty
        fill = SimulatedFill(
            order_id=order.order_id,
            sequence=sequence,
            event_time_ms=(
                0 if self._last_event is None else self._last_event.event_time_ms
            ),
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
        if self.execution_model_revision == EXECUTION_REALISM_V2:
            assert self._last_event is not None
            self._fill_source_events.append(self._last_event)
            self._lifecycle(order, order.status, fill_qty=fill_qty)
        if order.oco_group is not None and order.status == "FILLED":
            for sibling in self.orders:
                if (
                    sibling.order_id != order.order_id
                    and sibling.oco_group == order.oco_group
                    and sibling.status in {"OPEN", "PARTIAL"}
                ):
                    sibling.status = (
                        "CANCELLED"
                        if self.execution_model_revision == EXECUTION_REALISM_V2
                        else "CANCELLED_OCO"
                    )
                    self._lifecycle(
                        sibling, sibling.status, reason="OCO_SIBLING_FILLED"
                    )
                    if isinstance(self.account, LinearPerpetualAccountV2):
                        self.account.release_order_margin(sibling.order_id)
        if self.execution_reporter is not None:
            self.execution_reporter(
                {
                    "accepted": True,
                    "fill": {**asdict(fill), "side": order.side},
                    "order_id": order.order_id,
                }
            )
        return fill_qty

    _fill_source_events: list[MarketEvent] = field(default_factory=list)

    def _lifecycle(
        self,
        order: SimulatedOrder,
        state: str,
        *,
        reason: str | None = None,
        fill_qty: Decimal | None = None,
    ) -> None:
        if self.execution_model_revision != EXECUTION_REALISM_V2:
            return
        self._order_events.append(
            {
                "ordinal": len(self._order_events) + 1,
                "order_id": order.order_id,
                "state": state,
                "sequence": 0
                if self._last_event is None
                else self._last_event.sequence,
                "event_time_ms": 0
                if self._last_event is None
                else self._last_event.event_time_ms,
                "remaining_qty": str(order.qty),
                **({"fill_qty": str(fill_qty)} if fill_qty is not None else {}),
                **({"reason": reason} if reason is not None else {}),
            }
        )

    def _rejected_lifecycle(
        self, rejected: Mapping[str, object], *, order_id: str | None = None
    ) -> None:
        if self.execution_model_revision != EXECUTION_REALISM_V2:
            return
        self._order_events.append(
            {
                "ordinal": len(self._order_events) + 1,
                "order_id": order_id,
                "state": "REJECTED",
                "sequence": int(rejected.get("sequence") or 0),
                "event_time_ms": 0
                if self._last_event is None
                else self._last_event.event_time_ms,
                "reason": str(rejected.get("reason") or "REJECTED"),
            }
        )

    def _apply_funding(self, event: MarketEvent) -> None:
        if isinstance(self.account, LinearPerpetualAccountV2):
            if (
                self.funding_mode != "FIXED_SCENARIO"
                or self.funding_rate == 0
                or self.funding_interval_ms <= 0
            ):
                return
            if self._next_funding_time_ms is None:
                self._next_funding_time_ms = (
                    event.event_time_ms + self.funding_interval_ms
                )
                return
            while event.event_time_ms >= self._next_funding_time_ms:
                self.account.apply_fixed_funding(
                    event_time_ms=self._next_funding_time_ms,
                    rate=self.funding_rate,
                    period_id=f"fixed:{self._next_funding_time_ms}",
                )
                self._next_funding_time_ms += self.funding_interval_ms
            return
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
    allow_reduce_only_below_min_notional: bool = False,
    allow_ioc: bool = False,
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
    if tif not in ({"GTC", "IOC"} if allow_ioc else {"GTC"}):
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
        and not (
            allow_reduce_only_below_min_notional
            and bool(intent.get("reduce_only") or False)
        )
    ):
        return "MIN_NOTIONAL"
    return None


def _decision_record(
    intents: list[dict], *, sequence: int, watermark_ms: int
) -> dict[str, object]:
    provider_decision = getattr(intents, "decision", None)
    if provider_decision is not None:
        return {
            "sequence": sequence,
            "watermark_ms": watermark_ms,
            "provider_decision": provider_decision,
        }
    return {
        "sequence": sequence,
        "watermark_ms": watermark_ms,
        "intents": intents,
    }


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
