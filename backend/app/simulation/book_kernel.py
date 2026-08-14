"""BOOK_ASSISTED fills. Never assumes own queue position."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Callable

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.market_dataset.trades import assert_trade_stream
from app.market_dataset.snapshot import sha256_hex
from app.simulation.kernel import SimulationResult
from app.simulation.trade_kernel import TradeSimulationKernel

BOOK_FILL_POLICY = "BOOK_ASSISTED_CONSERVATIVE_V1"
StrategyFn = Callable[[tuple[MarketEvent, ...], MarketEvent], list[dict]]


def assert_book_chain(events: tuple[MarketEvent, ...]) -> None:
    last_seq: int | None = None
    for event in events:
        if event.role != "ORDER_BOOK":
            continue
        payload = event.payload
        if payload.get("reset") is True:
            last_seq = None
            if payload.get("snapshot") is not True:
                raise MarketDatasetError("book reset requires snapshot", code="DATA_GAP_REJECTED")
        seq = payload.get("book_sequence")
        if seq is None:
            raise MarketDatasetError("book event missing sequence", code="DATA_QUALITY_FAILED")
        seq_i = int(seq)
        if last_seq is not None and seq_i != last_seq + 1 and payload.get("snapshot") is not True:
            raise MarketDatasetError("book sequence gap", code="DATA_GAP_REJECTED")
        last_seq = seq_i


@dataclass(slots=True)
class BookAssistedKernel(TradeSimulationKernel):
    fill_policy: str = BOOK_FILL_POLICY

    def run(
        self,
        events: tuple[MarketEvent, ...],
        strategy: StrategyFn,
        *,
        warmup_events: int = 0,
    ) -> SimulationResult:
        assert_book_chain(events)
        trades = tuple(event for event in events if event.role == "TRADES")
        self.source_kind = assert_trade_stream(trades)
        visible: list[MarketEvent] = []
        trade_index = 0
        for event in events:
            if event.role == "TRADES":
                self._match(event)
                visible.append(event)
                intents = strategy(tuple(visible), event) if trade_index >= warmup_events else []
                self.decisions.append(
                    {
                        "sequence": event.sequence,
                        "watermark_ms": event.event_time_ms,
                        "intents": intents,
                        "book_assisted": True,
                    }
                )
                for intent in intents:
                    self._enqueue(intent, current_sequence=event.sequence)
                trade_index += 1
        result = self.result()
        fills = result.fills
        ledger = {
            "fill_count": len(fills),
            "notional": result.ledger_hash,
            "ambiguity_count": result.ambiguity_count,
        }
        return SimulationResult(
            decision_hash=result.decision_hash,
            fill_hash=result.fill_hash,
            ledger_hash=result.ledger_hash,
            report_hash=sha256_hex(
                {
                    "fidelity_mode": "BOOK_ASSISTED",
                    "source_event_kind": "TRADE_AND_L2",
                    "report_label": "BOOK_ASSISTED",
                    "queue_exact": False,
                    "fills": fills,
                    "ledger": ledger,
                }
            ),
            ambiguity_count=result.ambiguity_count,
            fills=fills,
        )

    def _match(self, event: MarketEvent) -> None:
        if event.role == "ORDER_BOOK":
            return
        if event.role != "TRADES":
            raise MarketDatasetError("book-assisted kernel expected a trade print", code="FIDELITY_UNSUPPORTED")
        bid = Decimal(str(event.payload.get("bid") or event.payload["price"]))
        ask = Decimal(str(event.payload.get("ask") or event.payload["price"]))
        if ask < bid:
            raise MarketDatasetError("crossed book is not usable", code="DATA_QUALITY_FAILED")
        open_orders = [
            order
            for order in self.orders
            if order.status == "OPEN" and order.eligible_after_sequence <= event.sequence
        ]
        for order in open_orders:
            if order.type == "MARKET":
                price = ask if order.side == "BUY" else bid
                self._fill(order, event.sequence, price, order.qty, "BOOK_ASSISTED_PRINT")
            elif order.type == "LIMIT" and order.limit_price is not None:
                if order.side == "BUY" and bid <= order.limit_price:
                    self._fill(order, event.sequence, order.limit_price, order.qty, "BOOK_CONSERVATIVE_LIMIT")
                elif order.side == "SELL" and ask >= order.limit_price:
                    self._fill(order, event.sequence, order.limit_price, order.qty, "BOOK_CONSERVATIVE_LIMIT")
