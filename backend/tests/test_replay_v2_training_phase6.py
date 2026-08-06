from __future__ import annotations

import json
import sqlite3
from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.bars.builder import ReplayBarBuilder
from app.replay.bars.trade_builder import TradeReplayBarBuilder
from app.replay.broker.execution import ConservativeBarBroker
from app.replay.broker.models import (
    AGG_TRADE_TOUCH_OR_TAPE_MODEL_VERSION,
    BAR_TOUCH_OR_TAPE_MODEL_VERSION,
    TOUCH_OR_TAPE_EXECUTION_MODE,
    FillReason,
    LiquidityRole,
    OrderSide,
    OrderStatus,
    OrderType,
    WarningCode,
)
from app.replay.service import ReplayService
from app.replay.sources.trade_reader import ReplayTrade
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.account import (
    InstrumentRule,
    MaintenanceTier,
    fee_for_notional,
    ledger_chain_hash,
    round_to_step,
)
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import (
    POLICY_MUTATION_VALUES,
    ReplayV2CommandType,
    TrainingRunCreateRequest,
)
from tests.fixtures.replay.bar_builder_fakes import (
    INTERVAL_MS as BROKER_INTERVAL_MS,
    REPLAY_START_MS,
)
from tests.fixtures.replay.broker_fakes import CONFIG, bar, request
from tests.fixtures.replay.fakes import FixtureIdentity, make_bar
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    ImmutableReplayHistoryFake,
    SessionIdFactory,
    replay_settings,
)
from tests.test_replay_v2_training_phase5 import (
    _acquire,
    _add_track,
    _command,
    _request,
    _service,
)


pytestmark = pytest.mark.anyio


def _bar_broker(*, v2: bool) -> ConservativeBarBroker:
    return ConservativeBarBroker(
        config=CONFIG,
        bar_builder=ReplayBarBuilder(
            base_interval="1m",
            display_interval="1m",
            replay_start_ms=REPLAY_START_MS,
            warmup_bars=(),
            max_closed_bars=32,
        ),
        execution_mode=(TOUCH_OR_TAPE_EXECUTION_MODE if v2 else "paper_linear_v1"),
    )


def _trade(index: int, *, price: str, quantity: str) -> ReplayTrade:
    return ReplayTrade(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        agg_trade_id=10_000 + index,
        first_trade_id=20_000 + index,
        last_trade_id=20_000 + index,
        price=price,
        quantity=quantity,
        quote_quantity=str(Decimal(price) * Decimal(quantity)),
        trade_time_ms=REPLAY_START_MS + index * 1_000,
        is_buyer_maker=False,
    )


def _trade_broker() -> ConservativeBarBroker:
    return ConservativeBarBroker(
        config=CONFIG,
        bar_builder=TradeReplayBarBuilder(
            base_interval="1m",
            display_interval="1m",
            replay_start_ms=REPLAY_START_MS,
            replay_end_time_ms=REPLAY_START_MS + 5 * BROKER_INTERVAL_MS - 1,
        ),
        execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
    )


def _sandbox_request(
    base: TrainingRunCreateRequest,
    *,
    margin_mode: str = "CROSS",
    funding_mode: str = "OFF",
    fixed_funding_rate: str | None = None,
    funding_interval_ms: int | None = None,
    initial_equity: str | None = None,
) -> TrainingRunCreateRequest:
    payload = base.to_dict()
    payload.update(
        {
            "integrity_mode": "SANDBOX",
            "margin_mode": margin_mode,
            "funding_mode": funding_mode,
            "fixed_funding_rate": fixed_funding_rate,
            "funding_interval_ms": funding_interval_ms,
            "allow_rule_changes": True,
            "allowed_mutations": list(POLICY_MUTATION_VALUES),
        }
    )
    if initial_equity is not None:
        payload["initial_equity"] = initial_equity
    return TrainingRunCreateRequest.from_dict(payload)


async def _send(
    service: ReplayService,
    *,
    run_id: str,
    session_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    payload: dict[str, object],
) -> dict[str, object]:
    session = await service.get_session(session_id)
    return await service.training.command(  # type: ignore[union-attr]
        run_id,
        _command(run_id, command_id, command_type, session, payload),
    )


def test_decimal_rule_fee_and_contract_rounding_golden() -> None:
    assert round_to_step(Decimal("1.234"), Decimal("0.01"), upward=False) == Decimal(
        "1.23"
    )
    assert round_to_step(Decimal("1.234"), Decimal("0.01"), upward=True) == Decimal(
        "1.24"
    )
    assert fee_for_notional(
        notional=Decimal("123.456"),
        liquidity="MAKER",
        maker_bps="2",
        taker_bps="5",
        quote_step="0.01",
    ) == Decimal("0.03")
    assert fee_for_notional(
        notional=Decimal("123.456"),
        liquidity="TAKER",
        maker_bps="2",
        taker_bps="5",
        quote_step="0.01",
    ) == Decimal("0.07")
    rule = InstrumentRule(
        track_id="track-1",
        rule_version="CANDLESCOPE_LINEAR_CONTRACT_V1",
        source_kind="BAR",
        price_tick="0.1",
        quantity_step="0.001",
        min_quantity="0.001",
        max_quantity="100",
        min_notional="5",
        max_notional="10000",
        quote_step="0.01",
        contract_size="1",
        max_leverage="5",
        liquidation_fee_bps="50",
        maintenance_tiers=(
            MaintenanceTier("1000", "0.005", "0"),
            MaintenanceTier("10000", "0.01", "5"),
        ),
        mark_fidelity="REVEALED_BAR_CLOSE_PROXY",
        rule_fidelity="AVAILABLE_APPROX_SIMULATION_RULES",
        effective_virtual_time_ms=REPLAY_START_MS,
    )
    assert rule.maintenance_margin(Decimal("1000")) == Decimal("5")
    assert rule.maintenance_margin(Decimal("2000")) == Decimal("15")
    assert rule.liquidation_fee(Decimal("123.45")) == Decimal("0.62")
    assert rule.to_dict()["contract_size"] == "1"


def test_touch_or_tape_market_uses_current_reference_and_v1_stays_deferred() -> None:
    broker = _bar_broker(v2=True)
    accepted_sequence = 0
    result = broker.apply_command(
        "place_order",
        request(client_order_id="v2-market").to_dict(),
        command_id="cmd-v2-market",
        source_sequence=int(accepted_sequence),
        virtual_time_ms=REPLAY_START_MS,
    )
    assert broker.model_version == BAR_TOUCH_OR_TAPE_MODEL_VERSION
    assert len(result["fills"]) == 1
    fill = result["fills"][0]
    assert fill["reason"] == FillReason.MARKET_REVEALED_REFERENCE.value
    assert fill["source_sequence"] == accepted_sequence
    current_fill_price = fill["price"]
    broker.apply_bar(bar(0, 150))
    assert broker.fills[0].price == current_fill_price

    legacy = _bar_broker(v2=False)
    legacy_result = legacy.apply_command(
        "place_order",
        request(client_order_id="v1-market").to_dict(),
        command_id="cmd-v1-market",
        source_sequence=0,
        virtual_time_ms=REPLAY_START_MS,
    )
    assert legacy_result["fills"] == []
    assert legacy.position.quantity == "0"
    assert legacy.apply_bar(bar(0, 150)).fills[0].source_sequence == 1


def test_limit_never_backfills_before_acceptance_and_fee_role_is_stable() -> None:
    broker = _bar_broker(v2=True)
    broker.apply_bar(bar(0, 90))
    broker.apply_bar(bar(1, 100))
    resting = broker.place_order(
        request(
            client_order_id="resting",
            order_type=OrderType.LIMIT,
            limit_price="95",
        ),
        command_id="cmd-resting",
    )
    assert resting.status is OrderStatus.OPEN
    assert broker.apply_bar(bar(2, 100)).fills == ()
    touched = broker.apply_bar(bar(3, 94))
    assert touched.fills[0].liquidity is LiquidityRole.MAKER
    assert touched.fills[0].source_sequence > resting.accepted_source_sequence

    marketable = broker.place_order(
        request(
            client_order_id="marketable",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            limit_price="93",
        ),
        command_id="cmd-marketable",
    )
    marketable_fill = next(fill for fill in broker.fills if fill.order_id == marketable.order_id)
    assert marketable_fill.liquidity is LiquidityRole.TAKER
    assert marketable_fill.reason is FillReason.LIMIT_MARKETABLE_REVEALED
    assert marketable_fill.source_sequence == marketable.accepted_source_sequence


def test_agg_resting_order_keeps_tape_volume_constraint() -> None:
    broker = _trade_broker()
    broker.apply_trade(_trade(0, price="100", quantity="1"))
    order = broker.place_order(
        request(
            client_order_id="agg-resting",
            order_type=OrderType.LIMIT,
            quantity="1",
            limit_price="99",
        ),
        command_id="cmd-agg-resting",
    )
    result = broker.apply_trade(_trade(1, price="98", quantity="0.4"))
    assert broker.model_version == AGG_TRADE_TOUCH_OR_TAPE_MODEL_VERSION
    assert result.fills[0].quantity == "0.4"
    assert result.fills[0].liquidity is LiquidityRole.MAKER
    assert broker.order(order.order_id).status is OrderStatus.PARTIALLY_FILLED


def test_v2_bar_same_root_tp_sl_keeps_adverse_conservative_order() -> None:
    broker = _bar_broker(v2=True)
    broker.place_order(request(client_order_id="entry"), command_id="cmd-entry")
    stop = broker.place_order(
        request(
            client_order_id="stop",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_MARKET,
            quantity="1",
            reduce_only=True,
            stop_price="99",
        ),
        command_id="cmd-stop",
    )
    take_profit = broker.place_order(
        request(
            client_order_id="take-profit",
            side=OrderSide.SELL,
            order_type=OrderType.TAKE_PROFIT_MARKET,
            quantity="1",
            reduce_only=True,
            stop_price="101",
        ),
        command_id="cmd-take-profit",
    )
    result = broker.apply_bar(bar(0, 100))
    assert result.fills[0].order_id == stop.order_id
    assert broker.order(take_profit.order_id).status is OrderStatus.CANCELED
    assert WarningCode.AMBIGUOUS_INTRABAR_WORST_CASE in {
        warning.code for warning in result.warnings
    }


async def test_contract_account_fee_revision_and_ledger_recompute_to_zero(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "contract-ledger.db")
    try:
        request_value = _sandbox_request(await _request(service))
        created = await service.training.create_run(request_value)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase6-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="fee-revision",
            command_type=ReplayV2CommandType.CHANGE_FEE_POLICY,
            payload={
                "maker_fee_bps": "1",
                "taker_fee_bps": "10",
                "reason": "phase6 fee golden",
            },
        )
        result = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="immediate-market",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase6-immediate-market",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        portfolio = result["data"]["portfolio"]
        assert portfolio["schema_version"] == "replay.training.portfolio.v2"
        assert portfolio["execution_model"] == "TOUCH_OR_TAPE_V2"
        assert portfolio["active_fee_policy"]["revision"] == 2
        assert portfolio["fills"] == []
        assert portfolio["history"]["fills_total"] == 1
        fill_page = await service.training.account_record_page(  # type: ignore[union-attr]
            run_id,
            record_type="FILLS",
            order_scope="ALL",
            track_id=None,
            cursor=None,
            limit=50,
        )
        assert fill_page["items"][-1]["fee_policy_revision"] == 2
        assert fill_page["items"][-1]["liquidity"] == "TAKER"
        assert portfolio["ledger"]["reconciliation_delta"] == "0"

        with sqlite3.connect(tmp_path / "contract-ledger.db") as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                """
                SELECT * FROM replay_training_contract_ledger
                WHERE run_id = ? ORDER BY ledger_sequence
                """,
                (run_id,),
            ).fetchall()
            account = connection.execute(
                "SELECT ledger_tail_hash FROM replay_training_contract_account WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        previous = str(rows[0]["previous_hash"])
        cash_total = Decimal(0)
        for row in rows:
            posting = {
                "posting_id": row["posting_id"],
                "track_id": row["track_id"],
                "kind": row["kind"],
                "cash_delta": row["cash_delta"],
                "asset": row["asset"],
                "virtual_time_ms": row["virtual_time_ms"],
                "source_sequence": row["source_sequence"],
                "fidelity": row["fidelity"],
                "rule_revision": row["rule_revision"],
                "reference_type": row["reference_type"],
                "reference_id": row["reference_id"],
                "metadata": json.loads(row["metadata_json"]),
            }
            assert row["previous_hash"] == previous
            assert row["entry_hash"] == ledger_chain_hash(
                previous_hash=previous,
                ledger_sequence=int(row["ledger_sequence"]),
                posting=posting,
            )
            previous = str(row["entry_hash"])
            cash_total += Decimal(str(row["cash_delta"]))
        assert previous == account["ledger_tail_hash"]
        assert cash_total == Decimal(str(portfolio["cash_balance"]))
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_training_run_replace_batch_cancel_and_record_pages_are_strict(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "order-management-pages.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            _sandbox_request(await _request(service))
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="order-management-acquire",
        )
        placed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="order-management-place",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "order-management-original",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": "50",
                "stop_price": None,
            },
        )
        original = placed["data"]["portfolio"]["orders"][0]
        replaced = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="order-management-replace",
            command_type=ReplayV2CommandType.REPLACE_ORDER,
            payload={
                "order_id": original["order_id"],
                "client_order_id": "order-management-replacement",
                "quantity": "2",
                "limit_price": "51",
                "stop_price": None,
            },
        )
        active = replaced["data"]["portfolio"]["orders"]
        assert len(active) == 1
        assert active[0]["client_order_id"] == "order-management-replacement"
        assert active[0]["quantity"] == "2"
        history = replaced["data"]["portfolio"]["history"]
        assert history["orders_total"] == 2
        assert history["active_orders"] == 1
        assert history["historical_orders"] == 1
        assert history["fills_total"] == 0
        assert history["ledger_entries_total"] >= 1
        assert history["page_limit_max"] == 200

        second = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="order-management-second",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "order-management-second",
                "side": "BUY",
                "order_type": "LIMIT",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": "49",
                "stop_price": None,
            },
        )
        active_ids = [
            order["order_id"] for order in second["data"]["portfolio"]["orders"]
        ]
        canceled = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="order-management-batch-cancel",
            command_type=ReplayV2CommandType.CANCEL_ORDERS,
            payload={"scope": "ORDER_IDS", "order_ids": active_ids},
        )
        assert canceled["data"]["portfolio"]["orders"] == []
        assert canceled["data"]["portfolio"]["history"]["historical_orders"] == 3

        first_page = await service.training.account_record_page(  # type: ignore[union-attr]
            run_id,
            record_type="ORDERS",
            order_scope="HISTORY",
            track_id=None,
            cursor=None,
            limit=1,
        )
        assert len(first_page["items"]) == 1
        assert first_page["total_count"] == 3
        assert isinstance(first_page["next_cursor"], str)
        second_page = await service.training.account_record_page(  # type: ignore[union-attr]
            run_id,
            record_type="ORDERS",
            order_scope="HISTORY",
            track_id=None,
            cursor=first_page["next_cursor"],
            limit=1,
        )
        assert second_page["items"][0]["order_id"] != first_page["items"][0]["order_id"]
        with pytest.raises(TrainingRunError) as mismatch:
            await service.training.account_record_page(  # type: ignore[union-attr]
                run_id,
                record_type="FILLS",
                order_scope="ALL",
                track_id=None,
                cursor=first_page["next_cursor"],
                limit=1,
            )
        assert mismatch.value.code == "REPLAY_ACCOUNT_RECORD_CURSOR_INVALID"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_historical_exact_funding_fails_closed_without_fallback(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "historical-funding-rejected.db")
    try:
        base = await _request(service)
        payload = base.to_dict()
        payload["funding_mode"] = "HISTORICAL_EXACT"
        request_value = TrainingRunCreateRequest.from_dict(payload)
        with pytest.raises(TrainingRunError) as rejected:
            await service.training.create_run(request_value)  # type: ignore[union-attr]
        assert rejected.value.code == "HISTORICAL_FUNDING_UNAVAILABLE"
        assert rejected.value.details["fallback_applied"] is False
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_sandbox_funding_boundary_and_restart_are_idempotent(tmp_path: Path) -> None:
    database = tmp_path / "funding-restart.db"
    service = await _service(database)
    run_id = ""
    try:
        request_value = _sandbox_request(
            await _request(service),
            funding_mode="SANDBOX_FIXED",
            fixed_funding_rate="0.001",
            funding_interval_ms=60_000,
        )
        created = await service.training.create_run(request_value)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="funding-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="funding-position",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "funding-position",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        before = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert before["portfolio"]["funding_cashflow"] == "0"
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="funding-before-boundary",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        before_boundary = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert before_boundary["portfolio"]["funding_cashflow"] == "0"
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="funding-at-boundary",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        at_boundary = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert Decimal(str(at_boundary["portfolio"]["funding_cashflow"])) < 0
        with sqlite3.connect(database) as connection:
            count_before_restart = connection.execute(
                "SELECT COUNT(*) FROM replay_training_funding_settlement WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
        assert count_before_restart == 1
    finally:
        await service.shutdown(step_timeout=1.0)

    restored = await _service(database)
    try:
        restored_session = await restored.get_session(session_id)
        assert (
            restored_session["snapshot"]["components"]["model_version"]
            == BAR_TOUCH_OR_TAPE_MODEL_VERSION
        )
        projection = await restored.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert projection["portfolio"]["ledger"]["reconciliation_delta"] == "0"
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_training_funding_settlement WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0] == count_before_restart
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_multi_market_funding_settles_once_per_track_at_global_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "multi-funding.db"
    service = await _service(database, symbols=("ETHUSDT",))
    try:
        request_value = _sandbox_request(
            await _request(service),
            funding_mode="SANDBOX_FIXED",
            fixed_funding_rate="0.001",
            funding_interval_ms=60_000,
        )
        created = await service.training.create_run(request_value)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        primary_id = str(created["run"]["adapter_session_id"])
        await _add_track(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            symbol="ETHUSDT",
            tier="FULL",
            command_id="funding-add-eth",
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=primary_id,
            command_id="multi-funding-acquire",
        )
        market_payload = {
            "side": "BUY",
            "order_type": "MARKET",
            "quantity": "1",
            "reduce_only": False,
            "limit_price": None,
            "stop_price": None,
        }
        await _send(
            service,
            run_id=run_id,
            session_id=primary_id,
            command_id="funding-btc-position",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={"client_order_id": "funding-btc-position", **market_payload},
        )
        selected = await _send(
            service,
            run_id=run_id,
            session_id=primary_id,
            command_id="funding-select-eth",
            command_type=ReplayV2CommandType.SELECT_TRACK,
            payload={"track_id": "track-2", "expected_viewer_revision": 0},
        )
        secondary_id = str(selected["session_id"])
        await _send(
            service,
            run_id=run_id,
            session_id=secondary_id,
            command_id="funding-eth-position",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={"client_order_id": "funding-eth-position", **market_payload},
        )
        heartbeat_sessions: list[str] = []
        original_heartbeat = service.heartbeat

        async def observed_heartbeat(
            session_id: str,
            client_instance_id: str,
        ) -> None:
            heartbeat_sessions.append(session_id)
            await original_heartbeat(session_id, client_instance_id)

        monkeypatch.setattr(service, "heartbeat", observed_heartbeat)
        assert service.training is not None
        original_multi_track_control = service.training._execute_multi_track_control
        expire_before_step = True

        async def expire_after_cursor_validation(**kwargs):
            nonlocal expire_before_step
            command = kwargs["command"]
            if expire_before_step and command.type is ReplayV2CommandType.STEP_BASE:
                expire_before_step = False
                for adapter_session_id in (primary_id, secondary_id):
                    actor = service._sessions[adapter_session_id].actor
                    actor._controller_deadline_wall = actor._read_wall() - 1
            return await original_multi_track_control(**kwargs)

        monkeypatch.setattr(
            service.training,
            "_execute_multi_track_control",
            expire_after_cursor_validation,
        )
        for index in range(2):
            await _send(
                service,
                run_id=run_id,
                session_id=secondary_id,
                command_id=f"multi-funding-step-{index}",
                command_type=ReplayV2CommandType.STEP_BASE,
                payload={"count": 1},
            )
        assert set(heartbeat_sessions) == {primary_id, secondary_id}
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert Decimal(str(projection["portfolio"]["funding_cashflow"])) < 0
        with sqlite3.connect(database) as connection:
            settlements = connection.execute(
                """
                SELECT track_id, settlement_time_ms
                FROM replay_training_funding_settlement
                WHERE run_id = ? ORDER BY track_id
                """,
                (run_id,),
            ).fetchall()
        assert [row[0] for row in settlements] == ["track-1", "track-2"]
        assert settlements[0][1] == settlements[1][1]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_isolated_margin_requires_allocation_and_releases_when_flat(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "isolated.db")
    try:
        request_value = _sandbox_request(
            await _request(service),
            margin_mode="ISOLATED",
        )
        created = await service.training.create_run(request_value)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="isolated-acquire",
        )
        with pytest.raises(TrainingRunError) as missing:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="isolated-without-allocation",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": "isolated-without-allocation",
                    "side": "BUY",
                    "order_type": "MARKET",
                    "quantity": "1",
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
        assert missing.value.code == "ISOLATED_MARGIN_REQUIRED"
        allocated = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="isolated-allocation",
            command_type=ReplayV2CommandType.ALLOCATE_ISOLATED_MARGIN,
            payload={"track_id": "track-1", "amount": "1000"},
        )
        assert allocated["data"]["portfolio"]["isolated_allocations"] == {
            "track-1": "1000"
        }
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="isolated-entry",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "isolated-entry",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        closed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="isolated-close",
            command_type=ReplayV2CommandType.CLOSE_POSITION,
            payload={"quantity": None},
        )
        assert closed["data"]["portfolio"]["isolated_allocations"] == {}
        assert closed["data"]["portfolio"]["ledger"]["entries"] == []
        ledger_page = await service.training.account_record_page(  # type: ignore[union-attr]
            run_id,
            record_type="LEDGER",
            order_scope="ALL",
            track_id=None,
            cursor=None,
            limit=200,
        )
        kinds = [item["kind"] for item in ledger_page["items"]]
        assert "MARGIN_ALLOCATION" in kinds
        assert "MARGIN_RELEASE" in kinds
    finally:
        await service.shutdown(step_timeout=1.0)


async def _risk_service(path: Path) -> ReplayService:
    repository = ImmutableReplayHistoryFake()
    prices = ["100", "101", "102", "103", "104", "50"] + ["50"] * 14
    repository.add_rows(
        FixtureIdentity("binance", "spot", "BTCUSDT"),
        "1m",
        [
            make_bar(START_MS + index * INTERVAL_MS, price=price)
            for index, price in enumerate(prices)
        ],
    )
    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=repository,
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("risk-adapter"),
        training_run_id_factory=SessionIdFactory("risk-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def test_simulated_liquidation_closes_normally_and_stays_distinct(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "liquidation.db")
    try:
        request_value = _sandbox_request(
            await _request(service),
            initial_equity="100",
        )
        created = await service.training.create_run(request_value)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="risk-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="risk-entry",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "risk-entry",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "2.5",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="risk-before-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        crashed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="risk-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        assert crashed["data"]["simulated_account_liquidations"] == 1
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        portfolio = projection["portfolio"]
        assert portfolio["status"] == "BANKRUPT"
        assert portfolio["positions"] == []
        assert portfolio["ledger"]["reconciliation_delta"] == "0"
        assert len(portfolio["liquidations"]) == 1
        event = portfolio["liquidations"][0]
        assert event["state"] == "COMPLETED"
        assert event["close_order_id"] is not None
        assert event["reason"] == "MAINTENANCE_MARGIN_BREACH"
        assert event["fidelity"] == "REVEALED_BAR_CLOSE_PROXY"
        assert event["account_equity_after"] == portfolio["equity"]
        assert portfolio["fidelity"]["liquidation"] == (
            "AVAILABLE_APPROX_SIMULATED_ACCOUNT"
        )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_cross_hedge_liquidation_closes_and_records_each_leg(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "hedge-liquidation.db")
    try:
        request_payload = _sandbox_request(
            await _request(service),
            initial_equity="100",
        ).to_dict()
        request_payload["position_mode"] = "HEDGE"
        created = await service.training.create_run(  # type: ignore[union-attr]
            TrainingRunCreateRequest.from_dict(request_payload)
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="hedge-risk-acquire",
        )
        for side, position_side, quantity in (
            ("BUY", "LONG", "2.4"),
            ("SELL", "SHORT", "0.4"),
        ):
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"hedge-risk-entry-{position_side.lower()}",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": f"hedge-risk-entry-{position_side.lower()}",
                    "side": side,
                    "position_side": position_side,
                    "order_type": "MARKET",
                    "quantity": quantity,
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="hedge-risk-before-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        crashed = await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="hedge-risk-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        assert crashed["data"]["simulated_account_liquidations"] == 1
        portfolio = (
            await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        )["portfolio"]
        assert portfolio["positions"] == []
        events = portfolio["liquidations"]
        assert len(events) == 1
        assert events[0]["position_quantity"] == "2"
        assert events[0]["position_notional"] == "141.4"
        assert events[0]["bankruptcy_price"] is None
        assert all(item["state"] == "COMPLETED" for item in events)
        assert all(item["close_order_id"] is not None for item in events)
    finally:
        await service.shutdown(step_timeout=1.0)
