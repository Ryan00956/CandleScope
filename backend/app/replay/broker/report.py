"""Deterministic report projection recomputable from broker domain records."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext

from ..canonical import canonical_sha256
from .ledger import LedgerBook, LedgerEntry
from .models import (
    BROKER_MODEL_VERSION,
    Account,
    BrokerWarning,
    ClosedTrade,
    ReplayFill,
    ReplayOrder,
    WarningCode,
    decimal_to_string,
)


REPORT_SCHEMA_VERSION = "replay-broker-report.v1"


@dataclass(frozen=True, slots=True)
class BrokerReport:
    schema_version: str
    config_hash: str
    model_version: str
    initial_equity: str
    final_equity: str
    realized_pnl: str
    fees_paid: str
    max_drawdown: str
    trade_count: int
    winning_trades: int
    losing_trades: int
    win_rate: str
    average_win: str
    average_loss: str
    profit_factor: str | None
    ambiguous_bar_count: int
    order_count: int
    fill_count: int
    ledger_entry_count: int
    ledger_tail_hash: str
    state_hash: str
    ended: bool
    orders: tuple[dict[str, object], ...]
    fills: tuple[dict[str, object], ...]
    closed_trades: tuple[dict[str, object], ...]
    warnings: tuple[dict[str, object], ...]
    report_hash: str

    def hash_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "config_hash": self.config_hash,
            "model_version": self.model_version,
            "initial_equity": self.initial_equity,
            "final_equity": self.final_equity,
            "realized_pnl": self.realized_pnl,
            "fees_paid": self.fees_paid,
            "max_drawdown": self.max_drawdown,
            "trade_count": self.trade_count,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "win_rate": self.win_rate,
            "average_win": self.average_win,
            "average_loss": self.average_loss,
            "profit_factor": self.profit_factor,
            "ambiguous_bar_count": self.ambiguous_bar_count,
            "order_count": self.order_count,
            "fill_count": self.fill_count,
            "ledger_entry_count": self.ledger_entry_count,
            "ledger_tail_hash": self.ledger_tail_hash,
            "state_hash": self.state_hash,
            "ended": self.ended,
            "orders": list(self.orders),
            "fills": list(self.fills),
            "closed_trades": list(self.closed_trades),
            "warnings": list(self.warnings),
        }

    def to_dict(self) -> dict[str, object]:
        return {**self.hash_payload(), "report_hash": self.report_hash}

    def verify(self) -> bool:
        return self.report_hash == canonical_sha256(self.hash_payload())


def build_broker_report(
    *,
    config_hash: str,
    initial_equity: str,
    account: Account,
    orders: tuple[ReplayOrder, ...],
    fills: tuple[ReplayFill, ...],
    closed_trades: tuple[ClosedTrade, ...],
    warnings: tuple[BrokerWarning, ...],
    ledger_entries: tuple[LedgerEntry, ...],
    ledger_tail_hash: str,
    max_drawdown: str,
    ended: bool,
    state_hash: str,
    model_version: str = BROKER_MODEL_VERSION,
) -> BrokerReport:
    LedgerBook.assert_entries_balanced(ledger_entries)
    realized_values = [Decimal(trade.realized_pnl) for trade in closed_trades]
    wins = [value for value in realized_values if value > 0]
    losses = [value for value in realized_values if value < 0]
    trade_count = len(realized_values)
    with localcontext() as context:
        context.prec = 60
        win_rate = Decimal(len(wins)) / trade_count if trade_count else Decimal(0)
        average_win = sum(wins, Decimal(0)) / len(wins) if wins else Decimal(0)
        average_loss = sum(losses, Decimal(0)) / len(losses) if losses else Decimal(0)
        gross_profit = sum(wins, Decimal(0))
        gross_loss = abs(sum(losses, Decimal(0)))
        profit_factor = None if gross_loss == 0 else gross_profit / gross_loss
    ambiguous_count = len(
        {
            warning.source_sequence
            for warning in warnings
            if warning.code
            in {
                WarningCode.AMBIGUOUS_INTRABAR_WORST_CASE,
                WarningCode.ENTRY_EXIT_SAME_BAR_WORST_CASE,
            }
        }
    )
    values: dict[str, object] = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "config_hash": config_hash,
        "model_version": model_version,
        "initial_equity": initial_equity,
        "final_equity": account.equity,
        "realized_pnl": account.realized_pnl,
        "fees_paid": account.fees_paid,
        "max_drawdown": max_drawdown,
        "trade_count": trade_count,
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "win_rate": decimal_to_string(win_rate, field_name="win_rate"),
        "average_win": decimal_to_string(average_win, field_name="average_win"),
        "average_loss": decimal_to_string(
            average_loss,
            field_name="average_loss",
        ),
        "profit_factor": (
            None
            if profit_factor is None
            else decimal_to_string(profit_factor, field_name="profit_factor")
        ),
        "ambiguous_bar_count": ambiguous_count,
        "order_count": len(orders),
        "fill_count": len(fills),
        "ledger_entry_count": len(ledger_entries),
        "ledger_tail_hash": ledger_tail_hash,
        "state_hash": state_hash,
        "ended": ended,
        "orders": tuple(order.to_dict() for order in orders),
        "fills": tuple(fill.to_dict() for fill in fills),
        "closed_trades": tuple(trade.to_dict() for trade in closed_trades),
        "warnings": tuple(warning.to_dict() for warning in warnings),
    }
    report_hash = canonical_sha256(values)
    return BrokerReport(**values, report_hash=report_hash)  # type: ignore[arg-type]
