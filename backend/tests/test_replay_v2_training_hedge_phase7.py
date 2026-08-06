from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.training.models import ReplayV2CommandType
from tests.test_replay_v2_training_hedge_phase5 import (
    _create_bankrupt_hedge_run,
    _trigger_crash,
)
from tests.test_replay_v2_training_phase6 import _risk_service, _send


pytestmark = pytest.mark.anyio


async def test_hedge_position_projection_exposes_per_leg_risk_and_protection(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase7-position-panel.db")
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase7-position-panel",
        )
        protected = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase7-protect-long",
            command_type=ReplayV2CommandType.SET_POSITION_PROTECTION,
            payload={
                "position_side": "LONG",
                "quantity": None,
                "stop_loss_price": "40",
                "take_profit_price": "110",
            },
        )
        assert [order["position_side"] for order in protected["data"]["orders"]] == [
            "LONG",
            "LONG",
        ]

        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        assert portfolio["position_mode"] == "HEDGE"
        assert [item["position_side"] for item in portfolio["positions"]] == [
            "LONG",
            "SHORT",
        ]
        long_leg = portfolio["positions"][0]
        assert long_leg["position"]["quantity"] == "2.4"
        assert long_leg["leverage"] == "3"
        assert Decimal(long_leg["initial_margin"]) > 0
        assert "maintenance_margin" in long_leg
        assert "risk_ratio" in long_leg
        assert Decimal(long_leg["liquidation_price"]) >= 0
        assert Decimal(long_leg["bankruptcy_price"]) >= 0
        assert Decimal(portfolio["positions"][1]["liquidation_price"]) > Decimal(
            portfolio["positions"][1]["position"]["mark_price"]
        )
        assert Decimal(portfolio["positions"][1]["bankruptcy_price"]) > Decimal(
            portfolio["positions"][1]["position"]["mark_price"]
        )
        assert long_leg["accumulated_funding"] == "0"
        assert long_leg["trading_fees"] != "0"
        assert long_leg["liquidation_fees"] == "0"
        assert [order["order_type"] for order in long_leg["protection"]["orders"]] == [
            "STOP_MARKET",
            "TAKE_PROFIT_MARKET",
        ]
        assert portfolio["positions"][1]["protection"] == {"orders": []}
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_liquidation_timeline_is_identical_in_portfolio_review_and_report(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase7-liquidation-timeline.db")
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase7-liquidation-timeline",
            insurance_opening_balance="0",
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase7-liquidation-timeline",
        )

        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        cases = portfolio["liquidations"]
        assert len(cases) == 1
        case = cases[0]
        assert len(case["legs"]) == 2
        assert case["book_snapshots"]
        assert all(
            snapshot["queue_exact"] is False for snapshot in case["book_snapshots"]
        )
        execution_orders = [order for step in case["steps"] for order in step["orders"]]
        assert execution_orders
        assert all(order["fills"] for order in execution_orders)
        assert any(step["insurance_postings"] for step in case["steps"])
        adl_events = [event for step in case["steps"] for event in step["adl_events"]]
        assert len(adl_events) == 1
        assert adl_events[0]["selections"]
        assert adl_events[0]["counterparty_ledger"]

        review = await service.training.start_review(run_id, event_id=None)  # type: ignore[union-attr]
        report = await service.training.report(run_id)  # type: ignore[union-attr]
        assert review["projection"]["liquidations"] == [
            *portfolio["liquidation_recoveries"],
            *cases,
        ]
        assert report["modelled_account"]["liquidations"] == cases
        assert (
            report["modelled_account"]["liquidation_recoveries"]
            == portfolio["liquidation_recoveries"]
        )

        forbidden = {
            "actual_time_ms",
            "adapter_session_id",
            "archive_id",
            "archive_path",
            "source_path",
            "private_queue_position",
        }

        def assert_public(value: object) -> None:
            if isinstance(value, dict):
                assert forbidden.isdisjoint(value)
                for child in value.values():
                    assert_public(child)
            elif isinstance(value, list):
                for child in value:
                    assert_public(child)
            elif isinstance(value, str):
                assert all(token not in value for token in forbidden)

        assert_public(cases)
    finally:
        await service.shutdown(step_timeout=1.0)
