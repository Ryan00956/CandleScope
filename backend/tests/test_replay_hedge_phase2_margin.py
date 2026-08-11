from __future__ import annotations

import sqlite3
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.broker.models import (
    OrderCapacityRequest,
    OrderSide,
    OrderType,
    PositionBook,
    PositionMode,
    PositionSide,
    TOUCH_OR_TAPE_EXECUTION_MODE,
)
from app.replay.errors import ReplayDomainError
from app.replay.internal_commands import REVEALED_REFERENCE_CLOSE_FIDELITY
from app.replay.training.account import InstrumentRule, MaintenanceTier
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import ReplayV2CommandType
from tests.fixtures.replay.broker_fakes import CONFIG, bar, make_broker, request
from tests.fixtures.replay.hedge_input_fakes import prepare_hedge_request
from tests.test_replay_v2_training_phase5 import _acquire, _request
from tests.test_replay_v2_training_phase6 import (
    _risk_service,
    _sandbox_request,
    _send,
)


pytestmark = pytest.mark.anyio


def _rounded_margin(notional: str, leverage: str) -> Decimal:
    return (Decimal(notional) / Decimal(leverage)).quantize(
        Decimal(CONFIG.instrument.quote_step),
        rounding="ROUND_CEILING",
    )


def test_rule_adapter_rounds_initial_and_maintenance_margin_upward() -> None:
    rule = InstrumentRule(
        track_id="track-1",
        rule_version="PHASE2_MARGIN_V1",
        source_kind="BAR",
        price_tick="0.1",
        quantity_step="0.001",
        min_quantity="0.001",
        max_quantity="100",
        min_notional="5",
        max_notional="100000",
        contract_size="1",
        quote_step="0.01",
        max_leverage="20",
        maintenance_tiers=(
            MaintenanceTier("500", "0.005", "0"),
            MaintenanceTier("100000", "0.01", "2.5"),
        ),
        liquidation_fee_bps="25",
        mark_fidelity="PINNED_MARK",
        rule_fidelity="VERSIONED_EXCHANGE_RULE",
        effective_virtual_time_ms=0,
    )

    assert rule.initial_margin(Decimal("100.01"), Decimal("3")) == Decimal("33.34")
    assert rule.maintenance_margin(Decimal("100.01")) == Decimal("0.51")
    assert rule.active_maintenance_tier(Decimal("500"))[0] == 1
    assert rule.active_maintenance_tier(Decimal("500.01"))[0] == 2


def test_cross_hedge_margin_leverage_capacity_and_restore_are_per_leg() -> None:
    broker = make_broker(
        config=replace(CONFIG, position_mode=PositionMode.HEDGE),
        execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
    )
    broker.apply_bar(bar(0, 100))
    broker.place_order(
        replace(
            request(client_order_id="phase2-long", quantity="1"),
            leverage="2",
            position_side=PositionSide.LONG,
        ),
        command_id="phase2-long",
    )
    broker.place_order(
        replace(
            request(
                client_order_id="phase2-short",
                side=OrderSide.SELL,
                quantity="1",
            ),
            leverage="5",
            position_side=PositionSide.SHORT,
        ),
        command_id="phase2-short",
    )

    assert isinstance(broker.position, PositionBook)
    assert broker.position.quantity == "0"
    assert broker.position.is_flat is False
    assert broker.position.long.leverage == "2"
    assert broker.position.short.leverage == "5"
    expected = _rounded_margin(
        broker.position.long.notional,
        "2",
    ) + _rounded_margin(broker.position.short.notional, "5")
    assert Decimal(broker.account.margin_used) == expected

    long_close_capacity = broker.order_capacity(
        OrderCapacityRequest(
            side=OrderSide.SELL,
            order_type=OrderType.MARKET,
            reduce_only=True,
            position_side=PositionSide.LONG,
        )
    )
    assert long_close_capacity["max_quantity"] == "1"
    close_preview = broker.preview_order(
        replace(
            request(
                client_order_id="phase2-close-preview",
                side=OrderSide.SELL,
                quantity="1",
                reduce_only=True,
            ),
            position_side=PositionSide.LONG,
        )
    )
    assert close_preview["reserved_margin"] == "0"

    with pytest.raises(ReplayDomainError, match="set position leverage first"):
        broker.place_order(
            replace(
                request(client_order_id="phase2-mismatch", quantity="0.1"),
                leverage="3",
                position_side=PositionSide.LONG,
            ),
            command_id="phase2-mismatch",
        )
    before_short = broker.position.short
    broker.set_position_leverage(position_side=PositionSide.LONG, leverage="3")
    assert broker.position.long.leverage == "3"
    assert broker.position.short == before_short

    checkpoint = broker.snapshot()
    restored = make_broker(
        config=replace(CONFIG, position_mode=PositionMode.HEDGE),
        execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
    )
    restored.restore(checkpoint)
    assert restored.state_hash == broker.state_hash
    assert isinstance(restored.position, PositionBook)
    assert restored.position.long.leverage == "3"
    assert restored.position.short.leverage == "5"


def test_revealed_reference_close_rejects_price_drift_and_restores_chart_mark() -> None:
    broker = make_broker(
        config=replace(CONFIG, position_mode=PositionMode.HEDGE),
        execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
    )
    broker.apply_bar(bar(0, 100))
    broker.place_order(
        replace(
            request(client_order_id="no-book-long", quantity="1"),
            position_side=PositionSide.LONG,
        ),
        command_id="no-book-long",
    )
    assert isinstance(broker.position, PositionBook)
    chart_mark = broker.position.long.mark_price
    with pytest.raises(ReplayDomainError, match="pinned execution plan"):
        broker.execute_revealed_reference_close(
            position_side="LONG",
            quantity="1",
            reference_mark="50",
            market_slippage_bps="1",
            price_tick="0.1",
            execution_price="49.8",
            execution_fidelity=REVEALED_REFERENCE_CLOSE_FIDELITY,
            command_id="no-book-invalid-close",
            accepted_source_sequence=1,
            created_time_ms=0,
        )
    order = broker.execute_revealed_reference_close(
        position_side="LONG",
        quantity="1",
        reference_mark="50",
        market_slippage_bps="1",
        price_tick="0.1",
        execution_price="49.9",
        execution_fidelity=REVEALED_REFERENCE_CLOSE_FIDELITY,
        command_id="no-book-close",
        accepted_source_sequence=1,
        created_time_ms=0,
    )
    assert broker.fills[-1].order_id == order.order_id
    assert broker.fills[-1].price == "49.9"
    assert isinstance(broker.position, PositionBook)
    assert broker.position.long.mark_price == chart_mark
    assert broker.position.is_flat is True


async def test_isolated_hedge_wallets_leverage_fork_restart_and_corruption(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase2-isolated.db"
    service = await _risk_service(database)
    run_id = ""
    session_id = ""
    try:
        hedge_request = await prepare_hedge_request(
            service,
            replace(
                _sandbox_request(
                    await _request(service),
                    margin_mode="ISOLATED",
                ),
                market_type="futures",
            ),
            root=tmp_path,
            prefix="phase2-margin",
        )
        created = await service.training.create_run(  # type: ignore[union-attr]
            hedge_request
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase2-acquire",
        )
        for side in ("LONG", "SHORT"):
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase2-allocate-{side.lower()}",
                command_type=ReplayV2CommandType.ALLOCATE_ISOLATED_MARGIN,
                payload={
                    "track_id": "track-1",
                    "position_side": side,
                    "amount": "100",
                },
            )
        long_open = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase2-open-long",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase2-open-long",
                "side": "BUY",
                "position_side": "LONG",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
                "leverage": "2",
            },
        )
        assert long_open["data"]["portfolio"]["isolated_allocations"] == {
            "track-1:LONG": "100",
            "track-1:SHORT": "100",
        }
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase2-open-short",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase2-open-short",
                "side": "SELL",
                "position_side": "SHORT",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
                "leverage": "3",
            },
        )
        changed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase2-leverage-long",
            command_type=ReplayV2CommandType.SET_POSITION_LEVERAGE,
            payload={"position_side": "LONG", "leverage": "1.5"},
        )
        portfolio = changed["data"]["portfolio"]
        positions = {item["position_side"]: item for item in portfolio["positions"]}
        assert positions["LONG"]["leverage"] == "1.5"
        assert positions["SHORT"]["leverage"] == "3"
        assert portfolio["margin_used"] == str(
            Decimal(positions["LONG"]["initial_margin"])
            + Decimal(positions["SHORT"]["initial_margin"])
        )
        adjusted = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase2-adjust-long-wallet",
            command_type=ReplayV2CommandType.ALLOCATE_ISOLATED_MARGIN,
            payload={
                "track_id": "track-1",
                "position_side": "LONG",
                "amount": "90",
            },
        )
        assert adjusted["data"]["portfolio"]["isolated_allocations"] == {
            "track-1:LONG": "90",
            "track-1:SHORT": "100",
        }
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            leg_wallets = {
                str(row["position_side"]): str(row["isolated_wallet"])
                for row in connection.execute(
                    """
                    SELECT position_side, isolated_wallet
                    FROM replay_training_position_leg
                    WHERE run_id = ? AND track_id = 'track-1'
                    ORDER BY position_side
                    """,
                    (run_id,),
                ).fetchall()
            }
            buckets = {
                str(row["position_side"]): dict(row)
                for row in connection.execute(
                    """
                    SELECT position_side, wallet_balance, initial_margin,
                           reserved_margin, available_balance
                    FROM replay_training_margin_bucket
                    WHERE run_id = ? AND bucket_kind = 'ISOLATED_LEG'
                    ORDER BY position_side
                    """,
                    (run_id,),
                ).fetchall()
            }
        assert leg_wallets == {"LONG": "90", "SHORT": "100"}
        assert {side: row["wallet_balance"] for side, row in buckets.items()} == {
            "LONG": "90",
            "SHORT": "100",
        }
        assert all(
            Decimal(str(row["available_balance"]))
            == Decimal(str(row["wallet_balance"]))
            - Decimal(str(row["initial_margin"]))
            - Decimal(str(row["reserved_margin"]))
            for row in buckets.values()
        )
        before_rejection = adjusted["data"]["portfolio"]["hedge_state"]["state_hash"]
        with pytest.raises(TrainingRunError) as rejected:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="phase2-leverage-too-low",
                command_type=ReplayV2CommandType.SET_POSITION_LEVERAGE,
                payload={"position_side": "LONG", "leverage": "1"},
            )
        assert rejected.value.code == "RUN_ACCOUNT_MARGIN_EXCEEDED"
        after_rejection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert after_rejection["portfolio"]["hedge_state"]["state_hash"] == (
            before_rejection
        )

        review = await service.training.start_review(run_id, event_id=None)  # type: ignore[union-attr]
        forked = await service.training.fork_run(  # type: ignore[union-attr]
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        child = await service.training.get_market_tracks(  # type: ignore[union-attr]
            str(forked["run"]["run_id"])
        )
        assert (
            child["portfolio"]["hedge_inputs"]["input_proof_hash"]
            == (adjusted["data"]["portfolio"]["hedge_inputs"]["input_proof_hash"])
        )
        assert child["portfolio"]["hedge_inputs"]["auditor"]["status"] == "PASS"
        child_legs = {
            leg["position_side"]: leg
            for leg in child["portfolio"]["hedge_state"]["position_legs"]
        }
        assert child_legs["LONG"]["leverage"] == "1.5"
        assert child_legs["SHORT"]["leverage"] == "3"
        assert child["portfolio"]["isolated_allocations"] == {
            "track-1:LONG": "90",
            "track-1:SHORT": "100",
        }
    finally:
        await service.shutdown(step_timeout=1.0)

    restored = await _risk_service(database)
    try:
        session = await restored.get_session(session_id)
        position = session["snapshot"]["components"]["position"]
        assert position["long"]["leverage"] == "1.5"
        assert position["short"]["leverage"] == "3"
        closed = await _send(
            restored,
            run_id=run_id,
            session_id=session_id,
            command_id="phase2-close-long",
            command_type=ReplayV2CommandType.CLOSE_POSITION,
            payload={"quantity": None, "position_side": "LONG"},
        )
        assert closed["data"]["portfolio"]["isolated_allocations"] == {
            "track-1:SHORT": "100"
        }
        assert {
            item["position_side"] for item in closed["data"]["portfolio"]["positions"]
        } == {"SHORT"}

        with sqlite3.connect(database) as connection:
            connection.execute(
                """
                UPDATE replay_training_position_leg
                SET signed_quantity = '999'
                WHERE run_id = ? AND track_id = 'track-1'
                  AND position_side = 'SHORT'
                """,
                (run_id,),
            )
            connection.commit()
        with pytest.raises(TrainingRunError) as corrupted:
            await restored.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert corrupted.value.code == "TRAINING_RUN_STORAGE_DEGRADED"
    finally:
        await restored.shutdown(step_timeout=1.0)
