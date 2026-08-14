from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from app.backtest.reports import build_report
from app.backtest.service import BacktestService
from app.backtest.strategy.protocol import ProviderCapabilities
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.simulation.contract_accounting import ContractAccount
from app.simulation.trade_kernel import TradeSimulationKernel


class _Hold:
    def describe(self):
        return ProviderCapabilities()

    def prepare(self, context):
        return None

    def warmup(self, frame):
        return None

    def step(self, frame):
        return None

    def on_execution_report(self, report):
        return None

    def snapshot(self):
        return {}

    def restore(self, payload):
        return None

    def close(self):
        return "sha256:close"


def _trade(sequence: int) -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=sequence,
        role="TRADES",
        payload={
            "source_event_kind": "RAW_TRADE",
            "source_sequence": sequence,
            "tie_break": str(sequence),
            "price": "100",
            "qty": "1",
        },
    )


def test_open_order_sqlite_decimal_path_is_not_empty(tmp_path: Path) -> None:
    events = tuple(_trade(index) for index in range(1, 8001))
    kernel = TradeSimulationKernel()
    kernel._enqueue({"side": "BUY", "type": "LIMIT", "qty": "3", "limit_price": "100"}, current_sequence=0)
    result = kernel.run(events, lambda *args: [])
    assert result.fills
    assert str(result.fills[0]["qty"]) == "1"
    account = ContractAccount(taker_fee_bps=Decimal("1"))
    for fill in result.fills:
        account.apply_fill(side="BUY", price=Decimal(str(fill["price"])), qty=Decimal(str(fill["qty"])))
    assert account.fees_paid > 0
    assert account.position_qty == Decimal("3")

    service = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_TRADE_TAPE_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    created = service.create_run(
        {
            "strategy_revision_id": "rev",
            "dataset_id": "ds",
            "data_epoch": "sha256:" + "ab" * 32,
            "snapshot_hash": "sha256:" + "cd" * 32,
            "fidelity_mode": "TRADE_TAPE",
            "start_time_ms": 1,
            "end_time_ms": 2,
        },
        idempotency_key="perf",
        now_ms=2,
    )
    completed = service.execute_trade_run(
        created["run_id"],
        events=events[:32],
        provider=_Hold(),
        now_ms=3,
    )
    stored = service.get_report(created["run_id"])
    assert completed["state"] == "COMPLETED"
    assert stored["hashes"]["report"]
    assert build_report(completed, completed["result"])["report_label"] == "TRADE_SEQUENCE"
    service.shutdown()


def test_trade_event_budget_fails_closed_instead_of_empty_path() -> None:
    from app.market_dataset.snapshot import MarketDatasetError

    kernel = TradeSimulationKernel(max_events=2)
    with pytest.raises(MarketDatasetError, match="BUDGET_EXCEEDED"):
        kernel.run((_trade(1), _trade(2), _trade(3)), lambda *args: [])
