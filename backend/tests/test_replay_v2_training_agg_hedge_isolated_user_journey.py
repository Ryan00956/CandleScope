from __future__ import annotations

from pathlib import Path

import pytest

from app.replay.training.models import ReplayV2CommandType, TrainingRunCreateRequest
from tests.fixtures.replay.hedge_input_fakes import prepare_hedge_request
from tests.test_replay_v2_training_phase5 import (
    _acquire,
    _trade_request,
    _trade_service,
)
from tests.test_replay_v2_training_phase6 import _send


pytestmark = pytest.mark.anyio


async def test_agg_hedge_isolated_user_can_advance_and_flatten_each_leg(
    tmp_path: Path,
) -> None:
    service = await _trade_service(
        tmp_path / "agg-hedge-isolated.db",
        archive_root=tmp_path / "agg-trades",
        symbols=("BTCUSDT",),
    )
    try:
        base_payload = (await _trade_request(service)).to_dict()
        base_payload["name"] = "AGG HEDGE isolated user journey"
        base_payload["margin_mode"] = "ISOLATED"
        request = await prepare_hedge_request(
            service,
            TrainingRunCreateRequest.from_dict(base_payload),
            root=tmp_path,
            prefix="agg-hedge-isolated-user",
            book_mode="OFF",
        )

        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="agg-hedge-isolated-acquire",
        )

        initial = await service.training.get_market_tracks(run_id)
        assert initial["portfolio"]["position_mode"] == "HEDGE"
        assert initial["portfolio"]["margin_mode"] == "ISOLATED"
        assert initial["tracks"][0]["source_kind"] == "AGG_TRADE"
        assert initial["tracks"][0]["historical_book"]["status"] == "OFF"

        for position_side in ("LONG", "SHORT"):
            allocated = await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"agg-hedge-isolated-allocate-{position_side.lower()}",
                command_type=ReplayV2CommandType.ALLOCATE_ISOLATED_MARGIN,
                payload={
                    "track_id": "track-1",
                    "position_side": position_side,
                    "amount": "500",
                },
            )
            assert (
                allocated["data"]["portfolio"]["ledger"]["reconciliation_delta"] == "0"
            )

        for position_side, side in (("LONG", "BUY"), ("SHORT", "SELL")):
            opened = await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"agg-hedge-isolated-open-{position_side.lower()}",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": (
                        f"agg-hedge-isolated-open-{position_side.lower()}"
                    ),
                    "side": side,
                    "position_side": position_side,
                    "order_type": "MARKET",
                    "quantity": "1",
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
            assert opened["data"]["portfolio"]["ledger"]["reconciliation_delta"] == "0"

        before_step = await service.get_session(session_id)
        stepped = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="agg-hedge-isolated-step-trade",
            command_type=ReplayV2CommandType.STEP_EVENT,
            payload={"count": 1},
        )
        assert stepped["cursor"]["source_sequence"] == (
            int(before_step["snapshot"]["cursor"]["source_sequence"]) + 1
        )
        assert any(
            event["event_phase"] == 20 for event in stepped["data"]["stable_order"]
        )
        after_step = (await service.training.get_market_tracks(run_id))["portfolio"]
        assert {
            position["position_side"]: position["position"]["quantity"]
            for position in after_step["positions"]
        } == {"LONG": "1", "SHORT": "-1"}
        assert after_step["isolated_allocations"] == {
            "track-1:LONG": "500",
            "track-1:SHORT": "500",
        }

        long_closed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="agg-hedge-isolated-close-long",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "agg-hedge-isolated-close-long",
                "side": "SELL",
                "position_side": "LONG",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": True,
                "limit_price": None,
                "stop_price": None,
            },
        )
        long_flat = long_closed["data"]["portfolio"]
        assert {
            position["position_side"]: position["position"]["quantity"]
            for position in long_flat["positions"]
        } == {"SHORT": "-1"}
        assert long_flat["isolated_allocations"] == {"track-1:SHORT": "500"}
        assert long_flat["ledger"]["reconciliation_delta"] == "0"

        short_closed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="agg-hedge-isolated-close-short",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "agg-hedge-isolated-close-short",
                "side": "BUY",
                "position_side": "SHORT",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": True,
                "limit_price": None,
                "stop_price": None,
            },
        )
        final = short_closed["data"]["portfolio"]
        assert final["positions"] == []
        assert final["isolated_allocations"] == {}
        assert final["status"] == "ACTIVE"
        assert final["ledger"]["reconciliation_delta"] == "0"

        ledger = await service.training.account_record_page(
            run_id,
            record_type="LEDGER",
            order_scope="ALL",
            track_id=None,
            cursor=None,
            limit=200,
        )
        kinds = [item["kind"] for item in ledger["items"]]
        assert kinds.count("MARGIN_ALLOCATION") == 2
        assert kinds.count("MARGIN_RELEASE") == 2
        assert (await service.training.audit_account(run_id))["status"] == "PASS"
    finally:
        await service.shutdown(step_timeout=1.0)
