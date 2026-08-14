"""Frozen Phase 0 contract helpers and a BAR reference kernel.

The kernel is a specification, not the future Host implementation. Production
code added in later phases must satisfy the same invariants.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Callable, Iterable, Mapping

CONTRACT_ROOT = Path(__file__).resolve().parents[1]
GOLDEN_PATH = CONTRACT_ROOT / "fixtures" / "backtest" / "contract_golden.json"
MANIFEST_SCHEMA_PATH = (
    CONTRACT_ROOT.parents[1]
    / "docs"
    / "perf-baselines"
    / "backtest"
    / "release-manifest.schema.json"
)
PRODUCT_CONTRACT_PATH = (
    CONTRACT_ROOT.parents[1] / "docs" / "BACKTEST_PRODUCT_CONTRACT_zh.md"
)


def load_golden() -> dict:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def sha256_hex(value: object) -> str:
    payload = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def required_roles(fidelity_mode: str, golden: Mapping[str, object] | None = None) -> set[str]:
    matrix = (golden or load_golden())["fidelity_matrix"]
    return set(matrix[fidelity_mode]["required_roles"])


class ContractError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def assert_fidelity_claim(
    *,
    fidelity_mode: str,
    source_event_kind: str,
    report_label: str,
    available_roles: Iterable[str],
    golden: Mapping[str, object] | None = None,
) -> None:
    contract = golden or load_golden()
    matrix = contract["fidelity_matrix"]
    if fidelity_mode not in matrix:
        raise ContractError("FIDELITY_UNSUPPORTED", f"unknown fidelity {fidelity_mode}")
    expected = matrix[fidelity_mode]
    if source_event_kind != expected["source_event_kind"]:
        raise ContractError(
            "FIDELITY_MISLABEL",
            f"{fidelity_mode} cannot use source {source_event_kind}",
        )
    if report_label != expected["report_label"]:
        raise ContractError(
            "FIDELITY_MISLABEL",
            f"{fidelity_mode} cannot use label {report_label}",
        )
    missing = set(expected["required_roles"]) - set(available_roles)
    if missing:
        raise ContractError(
            "FIDELITY_UNSUPPORTED",
            f"{fidelity_mode} missing roles {sorted(missing)}",
        )
    if source_event_kind == "AGG_TRADE" and report_label in {
        "TRADE_SEQUENCE",
        "ORDER_LEVEL_REQUIRED",
    }:
        raise ContractError("FIDELITY_MISLABEL", "aggTrade cannot claim raw or queue exact")


@dataclass(frozen=True, slots=True)
class Bar:
    sequence: int
    open_time_ms: int
    close_time_ms: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


@dataclass(slots=True)
class Order:
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


@dataclass(frozen=True, slots=True)
class Fill:
    order_id: str
    sequence: int
    price: Decimal
    qty: Decimal
    reason: str


@dataclass(slots=True)
class BoundedBarView:
    _bars: tuple[Bar, ...]
    watermark_ms: int

    def __len__(self) -> int:
        return len(self._bars)

    def __getitem__(self, index: int) -> Bar:
        if index < 0:
            index += len(self._bars)
        if index < 0 or index >= len(self._bars):
            raise ContractError("LOOKAHEAD_VIOLATION", "strategy peeked past watermark")
        return self._bars[index]

    @property
    def bars(self) -> tuple[Bar, ...]:
        return self._bars


StrategyFn = Callable[[BoundedBarView], list[dict]]


@dataclass(slots=True)
class ReferenceBarKernel:
    """Executable BAR_APPROX contract: next-bar fill, no lookahead, worst-case."""

    slippage_bps: Decimal = Decimal("1")
    fill_policy: str = "BAR_NEXT_BAR_WORST_CASE_V1"
    ambiguity_count: int = 0
    orders: list[Order] = field(default_factory=list)
    fills: list[Fill] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    event_trace: list[str] = field(default_factory=list)
    _next_order_id: int = 1

    def snapshot(self) -> dict:
        return {
            "ambiguity_count": self.ambiguity_count,
            "orders": [asdict(order) for order in self.orders],
            "fills": [asdict(fill) for fill in self.fills],
            "decisions": list(self.decisions),
            "next_order_id": self._next_order_id,
        }

    def restore(self, payload: Mapping[str, object]) -> None:
        self.ambiguity_count = int(payload["ambiguity_count"])
        self._next_order_id = int(payload["next_order_id"])
        self.orders = [Order(**item) for item in payload["orders"]]  # type: ignore[arg-type]
        self.fills = [
            Fill(
                order_id=item["order_id"],
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
        bars: list[Bar],
        strategy: StrategyFn,
        *,
        warmup_bars: int = 0,
    ) -> dict:
        for index, bar in enumerate(bars):
            self.event_trace.append(f"match:{bar.sequence}")
            self._match_open_orders(bar)
            visible = tuple(bars[: index + 1])
            view = BoundedBarView(visible, watermark_ms=bar.close_time_ms)
            intents = strategy(view) if index >= warmup_bars else []
            self.event_trace.append(f"decide:{bar.sequence}")
            decision = {
                "sequence": bar.sequence,
                "watermark_ms": bar.close_time_ms,
                "visible_last_sequence": visible[-1].sequence,
                "intents": intents,
            }
            self.decisions.append(decision)
            for intent in intents:
                self._enqueue(intent, current_sequence=bar.sequence)
        return self.result_hashes()

    def result_hashes(self) -> dict:
        fills = [asdict(fill) for fill in self.fills]
        ledger = {
            "fill_count": len(self.fills),
            "notional": str(sum((fill.price * fill.qty for fill in self.fills), Decimal("0"))),
            "ambiguity_count": self.ambiguity_count,
        }
        return {
            "decision_hash": sha256_hex(self.decisions),
            "fill_hash": sha256_hex(fills),
            "ledger_hash": sha256_hex(ledger),
            "report_hash": sha256_hex(
                {
                    "fidelity_mode": "BAR_APPROX",
                    "report_label": "APPROXIMATE",
                    "fills": fills,
                    "ledger": ledger,
                }
            ),
            "ambiguity_count": self.ambiguity_count,
            "fills": fills,
        }

    def _enqueue(self, intent: Mapping[str, object], *, current_sequence: int) -> None:
        order = Order(
            order_id=f"ord-{self._next_order_id}",
            side=str(intent["side"]),
            type=str(intent["type"]),
            qty=Decimal(str(intent["qty"])),
            limit_price=(
                Decimal(str(intent["limit_price"])) if intent.get("limit_price") is not None else None
            ),
            stop_price=(
                Decimal(str(intent["stop_price"])) if intent.get("stop_price") is not None else None
            ),
            eligible_after_sequence=current_sequence + 1,
        )
        self._next_order_id += 1
        self.orders.append(order)

    def _match_open_orders(self, bar: Bar) -> None:
        open_orders = [
            order
            for order in self.orders
            if order.status == "OPEN" and order.eligible_after_sequence <= bar.sequence
        ]
        if not open_orders:
            return
        stop_hits = [
            order
            for order in open_orders
            if order.type == "STOP" and self._stop_hit(order, bar)
        ]
        target_hits = [
            order
            for order in open_orders
            if order.type == "LIMIT" and self._limit_hit(order, bar)
        ]
        if stop_hits and target_hits:
            self.ambiguity_count += 1
            for order in stop_hits:
                self._fill(order, bar, self._stop_fill_price(order, bar), "WORST_CASE_STOP")
            return
        for order in open_orders:
            if order.status != "OPEN":
                continue
            if order.type == "MARKET":
                self._fill(order, bar, self._market_price(order, bar), "NEXT_BAR_OPEN")
            elif order.type == "LIMIT" and self._limit_hit(order, bar):
                assert order.limit_price is not None
                self._fill(order, bar, order.limit_price, "LIMIT_THROUGH")
            elif order.type == "STOP_LIMIT":
                if not order.activated and self._stop_hit(order, bar):
                    order.activated = True
                if order.activated and self._limit_hit(order, bar):
                    assert order.limit_price is not None
                    self._fill(order, bar, order.limit_price, "LIMIT_THROUGH")
            elif order.type == "STOP" and self._stop_hit(order, bar):
                self._fill(order, bar, self._stop_fill_price(order, bar), "STOP_TRIGGER")

    def _market_price(self, order: Order, bar: Bar) -> Decimal:
        slip = bar.open * self.slippage_bps / Decimal("10000")
        if order.side == "BUY":
            return bar.open + slip
        return bar.open - slip

    def _limit_hit(self, order: Order, bar: Bar) -> bool:
        if order.limit_price is None:
            return False
        if order.side == "BUY":
            return bar.low <= order.limit_price
        return bar.high >= order.limit_price

    def _stop_hit(self, order: Order, bar: Bar) -> bool:
        if order.stop_price is None:
            return False
        if order.side == "SELL":
            return bar.low <= order.stop_price
        return bar.high >= order.stop_price

    def _stop_fill_price(self, order: Order, bar: Bar) -> Decimal:
        if order.type == "STOP_LIMIT" and order.limit_price is not None:
            return order.limit_price
        assert order.stop_price is not None
        return order.stop_price

    def _fill(self, order: Order, bar: Bar, price: Decimal, reason: str) -> None:
        order.status = "FILLED"
        order.fill_price = price
        order.fill_sequence = bar.sequence
        self.fills.append(
            Fill(
                order_id=order.order_id,
                sequence=bar.sequence,
                price=price,
                qty=order.qty,
                reason=reason,
            )
        )


def sample_bars() -> list[Bar]:
    rows = [
        (1, "100", "110", "95", "105", "10"),
        (2, "105", "108", "104", "107", "10"),
        (3, "107", "120", "90", "115", "10"),
        (4, "115", "116", "114", "115", "10"),
    ]
    bars: list[Bar] = []
    for sequence, open_, high, low, close, volume in rows:
        bars.append(
            Bar(
                sequence=sequence,
                open_time_ms=sequence * 60_000,
                close_time_ms=(sequence + 1) * 60_000,
                open=Decimal(open_),
                high=Decimal(high),
                low=Decimal(low),
                close=Decimal(close),
                volume=Decimal(volume),
            )
        )
    return bars
