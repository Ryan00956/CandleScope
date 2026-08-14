"""BAR-signal / aggregate-trade-execution deterministic reference loop."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Callable, Mapping

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent, sha256_hex
from app.market_dataset.trades import assert_trade_stream

from .kernel import SimulationResult
from .trade_bar_builder import TradeBarBuilder
from .trade_kernel import TradeSimulationKernel
from .linear_perp_account_v2 import LinearPerpetualAccountV2

DualClockStrategyFn = Callable[[tuple[MarketEvent, ...], MarketEvent], list[dict]]


@dataclass(slots=True)
class DualClockSimulationKernel:
    signal_interval: str
    gap_policy: str = "REJECT"
    max_events: int = 2_000_000
    checkpoint_event_interval: int = 10_000
    slippage_bps: Decimal = Decimal("0")
    taker_fee_bps: Decimal = Decimal("0")
    maker_fee_bps: Decimal = Decimal("0")
    funding_rate: Decimal = Decimal("0")
    funding_interval_ms: int = 28_800_000
    initial_balance: Decimal = Decimal("10000")
    account_model: str = "LINEAR_PERP_ONE_WAY_V1"
    funding_mode: str = "OFF"
    leverage: Decimal = Decimal("1")
    execution_reporter: Callable[[dict], None] | None = field(default=None, repr=False)
    execution: TradeSimulationKernel = field(init=False)
    builder: TradeBarBuilder = field(init=False)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    execution_event_count: int = 0
    _last_source_sequence: int | None = None

    def __post_init__(self) -> None:
        self.builder = TradeBarBuilder(self.signal_interval, gap_policy=self.gap_policy)
        self.signal_interval = self.builder.interval
        self.execution = TradeSimulationKernel(
            max_events=self.max_events,
            checkpoint_event_interval=0,
            slippage_bps=self.slippage_bps,
            taker_fee_bps=self.taker_fee_bps,
            maker_fee_bps=self.maker_fee_bps,
            funding_rate=self.funding_rate,
            funding_interval_ms=self.funding_interval_ms,
            initial_balance=self.initial_balance,
            account_model=self.account_model,
            funding_mode=self.funding_mode,
            leverage=self.leverage,
            execution_reporter=self.execution_reporter,
        )

    @property
    def account(self):
        return self.execution.account

    @property
    def projected_position_qty(self) -> Decimal:
        return self.execution.projected_position_qty

    def snapshot(self) -> dict[str, Any]:
        return {
            "schemaVersion": "candlescope.dual-clock-kernel/1",
            "signal_interval": self.signal_interval,
            "gap_policy": self.gap_policy,
            "execution": self.execution.snapshot(),
            "bar_builder": self.builder.snapshot(),
            "decisions": list(self.decisions),
            "execution_event_count": self.execution_event_count,
            "last_source_sequence": self._last_source_sequence,
        }

    def restore(self, payload: Mapping[str, Any]) -> None:
        if (
            payload.get("schemaVersion") != "candlescope.dual-clock-kernel/1"
            or payload.get("signal_interval") != self.signal_interval
            or payload.get("gap_policy") != self.gap_policy
        ):
            raise MarketDatasetError(
                "dual-clock checkpoint identity changed", code="CHECKPOINT_CORRUPT"
            )
        self.execution.restore(payload["execution"])
        self.builder.restore(payload["bar_builder"])
        self.decisions = [dict(item) for item in payload.get("decisions") or []]
        self.execution_event_count = int(payload.get("execution_event_count") or 0)
        self._last_source_sequence = (
            None
            if payload.get("last_source_sequence") is None
            else int(payload["last_source_sequence"])
        )

    def run(
        self,
        events: tuple[MarketEvent, ...],
        strategy: DualClockStrategyFn,
        *,
        warmup_events: int = 0,
        finalize: bool = False,
        checkpoint_callback: Callable[[MarketEvent], None] | None = None,
    ) -> SimulationResult:
        trades = tuple(event for event in events if event.role == "TRADES")
        if len(trades) > self.max_events:
            raise MarketDatasetError(
                "trade event budget exceeded", code="BUDGET_EXCEEDED"
            )
        if trades:
            source_kind = assert_trade_stream(trades)
            if source_kind != "AGG_TRADE":
                raise MarketDatasetError(
                    "dual-clock execution requires AGG_TRADE", code="FIDELITY_MISLABEL"
                )
        for trade in events:
            if trade.role in {"INSTRUMENT_RULES", "MARK_INDEX", "FUNDING"}:
                self.execution._last_event = trade
                self.execution.account.apply(trade)
                continue
            if trade.role != "TRADES":
                raise MarketDatasetError(
                    "dual-clock kernel received unsupported role",
                    code="FIDELITY_MISLABEL",
                )
            source_sequence = int(
                trade.payload.get("source_sequence") or trade.sequence
            )
            if self._last_source_sequence is not None:
                if source_sequence <= self._last_source_sequence:
                    raise MarketDatasetError(
                        "aggregate trade cursor did not advance",
                        code="DATA_GAP_REJECTED",
                    )
                if source_sequence != self._last_source_sequence + 1:
                    raise MarketDatasetError(
                        "aggregate trade id gap rejected",
                        code="DATA_GAP_REJECTED",
                    )

            completed = self.builder.push(trade)
            for bar in completed:
                intents = strategy((bar,), bar)
                if bar.sequence <= warmup_events:
                    intents = []
                self.decisions.append(
                    {
                        "sequence": bar.sequence,
                        "watermark_ms": bar.event_time_ms,
                        "intents": intents,
                    }
                )
                # The signal exists immediately before this boundary trade, so
                # its first eligible print is the current authoritative event.
                self.execution._enqueue_many(
                    intents, current_sequence=trade.sequence - 1
                )

            self.execution._last_event = trade
            if isinstance(self.execution.account, LinearPerpetualAccountV2):
                self.execution.account.validate_ready()
            else:
                self.execution.account.mark = Decimal(str(trade.payload["price"]))
            self.execution._apply_funding(trade)
            self.execution._match(trade)
            self.execution.equity_curve.append(
                {
                    "sequence": trade.sequence,
                    "event_time_ms": trade.event_time_ms,
                    "equity": str(self.execution.account.equity()),
                    "position_qty": str(self.execution.account.position_qty),
                    "wallet_balance": str(self.execution.account.quote_balance),
                    "available_balance": str(
                        self.execution.account.available_balance()
                        if isinstance(self.execution.account, LinearPerpetualAccountV2)
                        else self.execution.account.equity()
                    ),
                }
            )
            self.execution_event_count += 1
            self._last_source_sequence = source_sequence
            if (
                checkpoint_callback is not None
                and self.checkpoint_event_interval > 0
                and self.execution_event_count % self.checkpoint_event_interval == 0
            ):
                checkpoint_callback(trade)
        if finalize:
            self.execution.finalize_orders()
        return self.result()

    def result(self) -> SimulationResult:
        base = self.execution.result()
        ledger = dict(base.ledger)
        ledger["signal_event_count"] = self.builder.signal_count
        ledger["execution_event_count"] = self.execution_event_count
        ledger_hash = sha256_hex(ledger)
        return SimulationResult(
            decision_hash=sha256_hex(self.decisions),
            fill_hash=base.fill_hash,
            ledger_hash=ledger_hash,
            report_hash=sha256_hex(
                {
                    "fidelity_mode": "AGG_TRADE_EXECUTION",
                    "source_event_kind": "AGG_TRADE",
                    "report_label": "AGGREGATED_TRADE_SEQUENCE",
                    "fills": base.fills,
                    "ledger": ledger,
                }
            ),
            ambiguity_count=base.ambiguity_count,
            fills=base.fills,
            orders=base.orders,
            rejected=base.rejected,
            ledger=ledger,
            equity_curve=base.equity_curve,
        )
