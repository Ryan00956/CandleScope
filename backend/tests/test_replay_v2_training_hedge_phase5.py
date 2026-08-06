from __future__ import annotations

import json
import shutil
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import ReplayV2CommandType
from tests.fixtures.replay.hedge_input_fakes import prepare_hedge_request
from tests.test_replay_v2_training_phase5 import _acquire, _request
from tests.test_replay_v2_training_phase6 import _risk_service, _sandbox_request, _send


pytestmark = pytest.mark.anyio


async def _create_bankrupt_hedge_run(
    service: ReplayService,
    *,
    root: Path,
    prefix: str,
    insurance_opening_balance: str = "1000000",
    adl_candidates: list[dict[str, object]] | None = None,
    initial_equity: str = "100",
    maintenance_tiers: list[dict[str, str]] | None = None,
) -> tuple[str, str]:
    request = replace(
        _sandbox_request(await _request(service), initial_equity=initial_equity),
        market_type="futures",
    )
    request = await prepare_hedge_request(
        service,
        request,
        root=root,
        prefix=prefix,
        mark_prices=["104", "50"] + ["50"] * 11,
        insurance_opening_balance=insurance_opening_balance,
        adl_candidates=adl_candidates,
        maintenance_tiers=maintenance_tiers,
    )
    created = await service.training.create_run(request)  # type: ignore[union-attr]
    run_id = str(created["run"]["run_id"])
    session_id = str(created["run"]["adapter_session_id"])
    await _acquire(
        service,
        run_id=run_id,
        selected_session_id=session_id,
        command_id=f"{prefix}-acquire",
    )
    for side, position_side, quantity in (
        ("BUY", "LONG", "2.4"),
        ("SELL", "SHORT", "0.4"),
    ):
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"{prefix}-entry-{position_side.lower()}",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": f"{prefix}-entry-{position_side.lower()}",
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
        command_id=f"{prefix}-align",
        command_type=ReplayV2CommandType.STEP_BASE,
        payload={"count": 1},
    )
    return run_id, session_id


async def _trigger_crash(
    service: ReplayService,
    *,
    run_id: str,
    session_id: str,
    prefix: str,
) -> dict[str, object]:
    return await _send(
        service,
        run_id=run_id,
        session_id=session_id,
        command_id=f"{prefix}-crash",
        command_type=ReplayV2CommandType.STEP_BASE,
        payload={"count": 1},
    )


async def test_hedge_liquidation_persists_full_state_machine_and_insurance(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase5-insurance.db")
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase5-insurance",
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase5-insurance",
        )
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        assert portfolio["positions"] == []
        event = portfolio["liquidations"][0]
        step_types = [step["step_type"] for step in event["steps"]]
        assert step_types == [
            "CANCEL_ORDERS",
            "RISK_RECHECK",
            "FULL_LIQUIDATION",
            "FULL_LIQUIDATION",
            "BANKRUPTCY_TRANSFER",
            "INSURANCE_FUND_SETTLEMENT",
            "COMPLETE",
        ]
        execution_orders = [
            order
            for step in event["steps"]
            if step["step_type"] == "FULL_LIQUIDATION"
            for order in step["orders"]
        ]
        assert [order["requested_quantity"] for order in execution_orders] == [
            "2.4",
            "0.4",
        ]
        assert all(order["fills"] for order in execution_orders)
        hedge_state = portfolio["hedge_state"]
        assert len(hedge_state["liquidation_leg_price_proofs"]) >= 2
        postings = [
            posting
            for posting in hedge_state["insurance_postings"]
            if posting["case_id"] == event["case_id"]
        ]
        assert [posting["reason"] for posting in postings] == [
            "LIQUIDATION_FEE_INFLOW",
            "BANKRUPTCY_DEFICIT_DEBIT",
        ]
        assert all(
            not str(posting["balance_after"]).startswith("-") for posting in postings
        )
        assert hedge_state["adl_events"] == []
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_tier_step_down_partial_liquidation_recovers_without_full_close(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase5-partial.db")
    try:
        request = replace(
            _sandbox_request(await _request(service), initial_equity="140"),
            market_type="futures",
        )
        request = await prepare_hedge_request(
            service,
            request,
            root=tmp_path,
            prefix="phase5-partial",
            mark_prices=["104", "50"] + ["50"] * 11,
            maintenance_tiers=[
                {
                    "notional_cap": "100",
                    "maintenance_rate": "0.005",
                    "maintenance_deduction": "0",
                },
                {
                    "notional_cap": "1000000",
                    "maintenance_rate": "0.5",
                    "maintenance_deduction": "49.5",
                },
            ],
        )
        created = await service.training.create_run(request)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase5-partial-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase5-partial-entry",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase5-partial-entry",
                "side": "BUY",
                "position_side": "LONG",
                "order_type": "MARKET",
                "quantity": "2.4",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
            },
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase5-partial-align",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase5-partial",
        )
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        assert portfolio["status"] == "ACTIVE"
        assert len(portfolio["positions"]) == 1
        assert portfolio["positions"][0]["position_side"] == "LONG"
        assert portfolio["positions"][0]["position"]["quantity"] == "2"
        event = portfolio["liquidations"][0]
        execution_steps = [
            step
            for step in event["steps"]
            if step["step_type"] in {"PARTIAL_LIQUIDATION", "FULL_LIQUIDATION"}
        ]
        assert [step["step_type"] for step in execution_steps] == [
            "PARTIAL_LIQUIDATION"
        ]
        assert execution_steps[0]["orders"][0]["requested_quantity"] == "0.4"
        assert event["state"] == "COMPLETED"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_cross_margin_breach_creates_one_account_case_across_full_tracks(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase5-multitrack-case.db")
    try:
        request = replace(
            _sandbox_request(await _request(service), initial_equity="1000"),
            market_type="futures",
        )
        request = await prepare_hedge_request(
            service,
            request,
            root=tmp_path,
            prefix="phase5-multitrack-case",
            mark_prices=["104"] * 13,
        )
        created = await service.training.create_run(request)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase5-multitrack-acquire",
        )
        for side, position_side, quantity in (
            ("BUY", "LONG", "1"),
            ("SELL", "SHORT", "0.2"),
        ):
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"phase5-multitrack-{position_side.lower()}",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": f"phase5-multitrack-{position_side.lower()}",
                    "side": side,
                    "position_side": position_side,
                    "order_type": "MARKET",
                    "quantity": quantity,
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
        store = service.training.store  # type: ignore[union-attr]

        def seed_and_detect(connection: object) -> tuple[int, set[str]]:
            track = connection.execute(  # type: ignore[attr-defined]
                "SELECT * FROM replay_training_market_track WHERE run_id = ? AND track_id = 'track-1'",
                (run_id,),
            ).fetchone()
            raw_account = json.loads(str(track["account_json"]))
            raw_account.update(
                {
                    "equity": "400",
                    "cash_balance": "400",
                    "available_equity": "400",
                }
            )
            connection.execute(  # type: ignore[attr-defined]
                "UPDATE replay_training_market_track SET account_json = ? WHERE run_id = ?",
                (canonical_json(raw_account), run_id),
            )
            connection.execute(  # type: ignore[attr-defined]
                """
                INSERT INTO replay_training_market_track(
                    run_id, track_id, stable_ordinal, adapter_session_id,
                    exchange, market_type, symbol, settlement_asset, source_kind,
                    state, subscription_tier, dataset_epoch, virtual_time_ms,
                    source_sequence, revision, forced_full_reasons_json,
                    capabilities_json, public_price, position_json, account_json,
                    open_orders_json, degraded_reason, created_at_ms, updated_at_ms
                ) SELECT run_id, 'track-2', 2, NULL, exchange, market_type,
                         'ETHUSDT', settlement_asset, source_kind, state,
                         subscription_tier, dataset_epoch, virtual_time_ms,
                         source_sequence, revision, forced_full_reasons_json,
                         capabilities_json, public_price, position_json, account_json,
                         open_orders_json, degraded_reason, created_at_ms, updated_at_ms
                  FROM replay_training_market_track
                 WHERE run_id = ? AND track_id = 'track-1'
                """,
                (run_id,),
            )
            rule = connection.execute(  # type: ignore[attr-defined]
                """
                SELECT * FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = 'track-1'
                ORDER BY revision DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            rule_payload = json.loads(str(rule["rule_json"]))
            rule_payload["track_id"] = "track-2"
            connection.execute(  # type: ignore[attr-defined]
                """
                INSERT INTO replay_training_instrument_rule(
                    run_id, track_id, revision, effective_virtual_time_ms,
                    rule_json, rule_hash, fidelity, created_at_ms
                ) VALUES (?, 'track-2', 1, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    rule["effective_virtual_time_ms"],
                    canonical_json(rule_payload),
                    canonical_sha256(rule_payload),
                    rule["fidelity"],
                    rule["created_at_ms"],
                ),
            )
            store._detect_contract_liquidations(  # type: ignore[attr-defined]
                connection,
                run_id=run_id,
                now_ms=store.base_store._validated_now_ms(),
            )
            cases = connection.execute(  # type: ignore[attr-defined]
                """
                SELECT case_id FROM replay_training_liquidation_case
                WHERE run_id = ? AND state = 'RISK_BREACH_DETECTED'
                """,
                (run_id,),
            ).fetchall()
            legs = connection.execute(  # type: ignore[attr-defined]
                """
                SELECT track_id FROM replay_training_liquidation_leg
                WHERE run_id = ? AND case_id = ?
                """,
                (run_id, cases[0]["case_id"]),
            ).fetchall()
            return len(cases), {str(row["track_id"]) for row in legs}

        case_count, leg_tracks = await store.base_store.run_extension_write(
            seed_and_detect
        )
        assert case_count == 1
        assert leg_tracks == {"track-1", "track-2"}
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_insurance_shortfall_executes_materialized_adl_counterparty_ledger(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase5-adl.db")
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase5-adl",
            insurance_opening_balance="0",
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase5-adl",
        )
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        event = portfolio["liquidations"][0]
        assert "ADL" in [step["step_type"] for step in event["steps"]]
        hedge_state = portfolio["hedge_state"]
        assert hedge_state["insurance_funds"][0]["current_balance"] == "0"
        assert len(hedge_state["adl_events"]) == 1
        assert hedge_state["adl_events"][0]["state"] == "COMPLETED"
        assert hedge_state["adl_selections"]
        counterparty = hedge_state["adl_counterparty_ledger"]
        assert counterparty
        assert all(Decimal(str(row["quantity_after"])) >= 0 for row in counterparty)
        assert all(row["previous_hash"].startswith("sha256:") for row in counterparty)
        assert all(row["entry_hash"].startswith("sha256:") for row in counterparty)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_adl_cohort_exhaustion_pauses_run_failed_closed(tmp_path: Path) -> None:
    service = await _risk_service(tmp_path / "phase5-adl-exhausted.db")
    try:
        candidates = [
            {
                "candidate_id": "phase5-tiny-short",
                "symbol": "BTCUSDT",
                "position_side": "SHORT",
                "quantity": "0.001",
                "entry_price": "110",
                "mark_price": "100",
                "initial_margin": "500",
                "margin_balance": "1000",
            }
        ]
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase5-adl-exhausted",
            insurance_opening_balance="0",
            adl_candidates=candidates,
        )
        with pytest.raises(TrainingRunError) as captured:
            await _trigger_crash(
                service,
                run_id=run_id,
                session_id=session_id,
                prefix="phase5-adl-exhausted",
            )
        assert captured.value.code == "LIQUIDATION_EXECUTION_FAILED"
        run = await service.training.get_run(run_id)  # type: ignore[union-attr]
        assert run["state"] == "PAUSED"
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        failed = [
            event
            for event in portfolio["liquidations"]
            if event["state"] == "FAILED_CLOSED"
        ]
        assert len(failed) == 1
        assert failed[0]["reason"] == "LIQUIDATION_ADL_COHORT_EXHAUSTED"
        assert portfolio["status"] == "FAILED_CLOSED"
        assert portfolio["hedge_state"]["insurance_funds"][0]["current_balance"] == "0"
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize(
    "method_name",
    [
        "commit_liquidation_cancellation",
        "commit_liquidation_recheck",
        "commit_liquidation_execution",
        "commit_liquidation_bankruptcy",
        "commit_liquidation_insurance",
        "commit_liquidation_adl",
        "commit_liquidation_complete",
    ],
)
async def test_liquidation_recovers_after_each_durable_step_without_duplicates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    method_name: str,
) -> None:
    seed_root = tmp_path / f"seed-{method_name}"
    seed_root.mkdir()
    seed_database = seed_root / "seed.db"
    seed = await _risk_service(seed_database)
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            seed,
            root=seed_root,
            prefix=f"phase5-recovery-{method_name}",
            insurance_opening_balance="0",
        )
        original_seed_reconcile = seed.training._reconcile_liquidations  # type: ignore[union-attr]

        async def defer_liquidation(**_kwargs: object) -> int:
            return 0

        monkeypatch.setattr(
            seed.training,  # type: ignore[union-attr]
            "_reconcile_liquidations",
            defer_liquidation,
        )
        await _trigger_crash(
            seed,
            run_id=run_id,
            session_id=session_id,
            prefix=f"phase5-recovery-{method_name}-prepare",
        )
        monkeypatch.setattr(
            seed.training,  # type: ignore[union-attr]
            "_reconcile_liquidations",
            original_seed_reconcile,
        )
        assert await seed.training.store.pending_liquidations(run_id)  # type: ignore[union-attr]
    finally:
        await seed.shutdown(step_timeout=1.0)

    crashed_database = tmp_path / f"phase5-recovery-{method_name}.db"
    reference_database = tmp_path / f"phase5-reference-{method_name}.db"
    shutil.copy2(seed_database, crashed_database)
    shutil.copy2(seed_database, reference_database)
    seed_objects = seed_database.parent / f"{seed_database.name}.datasets"
    shutil.copytree(
        seed_objects,
        crashed_database.parent / f"{crashed_database.name}.datasets",
    )
    shutil.copytree(
        seed_objects,
        reference_database.parent / f"{reference_database.name}.datasets",
    )
    for suffix in (
        "historical-books",
        "hedge-inputs",
        "account-history",
        "segments",
    ):
        seed_owned_root = seed_database.parent / f"{seed_database.stem}-{suffix}"
        if not seed_owned_root.exists():
            continue
        shutil.copytree(
            seed_owned_root,
            crashed_database.parent / f"{crashed_database.stem}-{suffix}",
        )
        shutil.copytree(
            seed_owned_root,
            reference_database.parent / f"{reference_database.stem}-{suffix}",
        )

    service = await _risk_service(crashed_database)
    reference = await _risk_service(reference_database)
    try:
        store = service.training.store  # type: ignore[union-attr]
        original = getattr(store, method_name)
        raised = False

        async def crash_after_commit(*args: object, **kwargs: object) -> object:
            nonlocal raised
            result = await original(*args, **kwargs)
            if not raised:
                raised = True
                raise RuntimeError("simulated process loss after durable commit")
            return result

        monkeypatch.setattr(store, method_name, crash_after_commit)
        with pytest.raises(RuntimeError, match="simulated process loss"):
            await service.training._reconcile_liquidations(  # type: ignore[union-attr]
                run_id=run_id,
                client_instance_id="phase5-recovery-client",
                command_id=f"phase5-recovery-{method_name}",
            )
        monkeypatch.setattr(store, method_name, original)
        for _wave in range(3):
            await service.training._reconcile_liquidations(  # type: ignore[union-attr]
                run_id=run_id,
                client_instance_id="phase5-recovery-client",
                command_id=f"phase5-recovery-{method_name}",
            )
            current = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
            if current["portfolio"]["positions"] == []:
                break
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        assert portfolio["positions"] == []
        assert portfolio["status"] == "BANKRUPT"
        event = portfolio["liquidations"][0]
        assert event["state"] == "COMPLETED"
        order_ids = [
            order["order_id"]
            for step in event["steps"]
            for order in step["orders"]
            if order["requested_quantity"] != "0"
        ]
        fill_ids = [
            fill["fill_id"]
            for step in event["steps"]
            for order in step["orders"]
            for fill in order["fills"]
        ]
        hedge_state = portfolio["hedge_state"]
        assert len(order_ids) == len(set(order_ids)) == 2
        assert len(fill_ids) == len(set(fill_ids)) == 2
        assert len(hedge_state["insurance_postings"]) == 2
        assert len(hedge_state["adl_events"]) == 1
        assert len(hedge_state["adl_selections"]) == 1
        assert len(hedge_state["adl_counterparty_ledger"]) == 1
        for _wave in range(3):
            await reference.training._reconcile_liquidations(  # type: ignore[union-attr]
                run_id=run_id,
                client_instance_id="phase5-recovery-client",
                command_id=f"phase5-recovery-{method_name}",
            )
            reference_projection = await reference.training.get_market_tracks(  # type: ignore[union-attr]
                run_id
            )
            if reference_projection["portfolio"]["positions"] == []:
                break
        reference_event = reference_projection["portfolio"]["liquidations"][0]
        assert event["component_hash"] == reference_event["component_hash"]
        assert [step["step_hash"] for step in event["steps"]] == [
            step["step_hash"] for step in reference_event["steps"]
        ]
    finally:
        await service.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)
