from __future__ import annotations

import sqlite3
from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.training.models import ReplayV2CommandType, TrainingCursor
from tests.test_replay_v2_training_phase5 import _command, _request, _service


pytestmark = pytest.mark.anyio


async def test_trade_plan_is_sized_logged_and_projected_into_training_results(
    tmp_path: Path,
) -> None:
    database = tmp_path / "p2-training-results.db"
    service = await _service(database)
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        session = await service.get_session(session_id)
        snapshot = session["snapshot"]
        cursor = snapshot["cursor"]
        mark = Decimal(str(snapshot["components"]["position"]["mark_price"]))
        draft = {
            "sizing_mode": "RISK_AMOUNT",
            "risk_amount": "10",
            "risk_percent": None,
            "invalidation_price": format(mark - Decimal("10"), "f"),
            "target_price": format(mark + Decimal("20"), "f"),
            "reason": "breakout retest with a fixed invalidation",
        }
        order = {
            "client_order_id": "planned-entry",
            "side": "BUY",
            "order_type": "MARKET",
            "quantity": "1",
            "reduce_only": False,
            "limit_price": None,
            "stop_price": None,
        }
        preview = await service.training.preview_order(  # type: ignore[union-attr]
            run_id,
            expected_revision=int(snapshot["revision"]),
            expected_cursor=TrainingCursor(
                virtual_time_ms=int(cursor["virtual_time_ms"]),
                source_sequence=int(cursor["source_sequence"]),
                revision=int(snapshot["revision"]),
            ),
            position_intent="OPEN",
            order=order,
            trade_plan=draft,
        )
        assert preview["schema_version"] == "replay.order-preview.v2"
        plan = preview["trade_plan"]
        assert isinstance(plan, dict)
        assert Decimal(str(plan["quantity"])) > 0
        assert plan["risk_amount"] == "10"

        placed = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "planned-place",
                ReplayV2CommandType.PLACE_ORDER,
                session,
                {
                    **order,
                    "quantity": plan["quantity"],
                    "trade_plan": draft,
                },
            ),
        )
        assert placed["data"]["orders"][0]["client_order_id"] == "planned-entry"

        session = await service.get_session(session_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "advance-planned-position",
                ReplayV2CommandType.STEP_BASE,
                session,
                {"count": 2},
            ),
        )
        session = await service.get_session(session_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "close-planned-position",
                ReplayV2CommandType.CLOSE_POSITION,
                session,
                {"quantity": None},
            ),
        )

        results = await service.training.training_results(run_id, limit=100)  # type: ignore[union-attr]
        assert results["summary"]["trade_count"] == 1
        assert results["summary"]["planned_trade_count"] == 1
        item = results["items"][0]
        assert Decimal(str(item["initial_risk_amount"])) == (
            Decimal(str(plan["risk_per_unit"])) * Decimal(str(plan["quantity"]))
        )
        assert Decimal(str(item["initial_risk_amount"])) <= Decimal("10")
        assert item["r_multiple"] is not None
        assert Decimal(str(item["mae"])) <= 0
        assert Decimal(str(item["mfe"])) >= 0
        assert int(item["holding_duration_ms"]) > 0
        assert item["review_event_id"] is not None
        assert item["settlement_asset"] == "USDT"
        assert item["plans"][0]["reason"] == draft["reason"]
        assert Decimal(str(results["summary"]["fees_paid"])) > 0
        assert Decimal(str(results["summary"]["net_realized_pnl"])) == (
            Decimal(str(results["summary"]["gross_realized_pnl"]))
            - Decimal(str(results["summary"]["fees_paid"]))
        )

        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                SELECT plan_hash, previous_plan_hash, plan_json
                FROM replay_training_trade_plan WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            assert row is not None
            assert str(row["plan_hash"]).startswith("sha256:")
            assert str(row["previous_plan_hash"]) == "sha256:" + ("0" * 64)
            assert "breakout retest" in str(row["plan_json"])
            connection.execute(
                """
                UPDATE replay_training_trade_plan SET reason = 'tampered'
                WHERE run_id = ?
                """,
                (run_id,),
            )
            connection.commit()
        with pytest.raises(Exception, match="hash chain verification failed"):
            await service.training.training_results(run_id, limit=100)  # type: ignore[union-attr]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_account_risk_percent_preview_rejects_wrong_price_side(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "p2-plan-validation.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        session = await service.get_session(session_id)
        snapshot = session["snapshot"]
        cursor = snapshot["cursor"]
        mark = Decimal(str(snapshot["components"]["position"]["mark_price"]))
        with pytest.raises(Exception, match="bracket entry"):
            await service.training.preview_order(  # type: ignore[union-attr]
                run_id,
                expected_revision=int(snapshot["revision"]),
                expected_cursor=TrainingCursor(
                    virtual_time_ms=int(cursor["virtual_time_ms"]),
                    source_sequence=int(cursor["source_sequence"]),
                    revision=int(snapshot["revision"]),
                ),
                position_intent="OPEN",
                order={
                    "client_order_id": "bad-plan",
                    "side": "BUY",
                    "order_type": "MARKET",
                    "quantity": "1",
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
                trade_plan={
                    "sizing_mode": "ACCOUNT_RISK_PERCENT",
                    "risk_amount": None,
                    "risk_percent": "1",
                    "invalidation_price": format(mark + Decimal("1"), "f"),
                    "target_price": format(mark + Decimal("2"), "f"),
                    "reason": "invalid long stop",
                },
            )
    finally:
        await service.shutdown(step_timeout=1.0)
