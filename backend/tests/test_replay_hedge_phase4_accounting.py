from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.training import review as review_module
from app.replay.training.account import fee_for_notional
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import ReplayV2CommandType, TimeDisclosurePolicy
from app.replay.training.review import (
    REVIEW_LEDGER_PREFIX_REF_SCHEMA_VERSION,
    ReviewRecorder,
)
from tests.fixtures.replay.hedge_input_fakes import prepare_hedge_request
from tests.test_replay_v2_training_phase5 import _acquire, _request
from tests.test_replay_v2_training_phase6 import (
    _risk_service,
    _sandbox_request,
    _send,
)


pytestmark = pytest.mark.anyio


async def test_review_minimum_equity_resumes_from_latest_drawdown_anchor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE replay_review_timeline_event(
            run_id TEXT NOT NULL,
            timeline_sequence INTEGER NOT NULL,
            category TEXT NOT NULL,
            projection_json TEXT NOT NULL
        )
        """
    )
    rows = [
        ("run-1", sequence, "COMMAND", canonical_json({"domain": {"equity": "100"}}))
        for sequence in range(1, 101)
    ]
    rows.extend(
        (
            ("run-1", 101, "EQUITY", canonical_json({"domain": {"equity": "80"}})),
            ("run-1", 102, "COMMAND", canonical_json({"domain": {"equity": "75"}})),
            ("run-1", 103, "COMMAND", canonical_json({"domain": {"equity": "90"}})),
        )
    )
    connection.executemany(
        "INSERT INTO replay_review_timeline_event VALUES (?, ?, ?, ?)",
        rows,
    )
    original_loads = review_module.json.loads
    decoded = 0

    def observed_loads(value: str) -> object:
        nonlocal decoded
        decoded += 1
        return original_loads(value)

    monkeypatch.setattr(review_module.json, "loads", observed_loads)
    assert ReviewRecorder._minimum_prior_equity(
        connection,
        run_id="run-1",
    ) == Decimal("75")
    assert decoded == 3
    connection.close()


async def test_review_descriptors_distinguish_hedge_structure_from_audit_receipts() -> (
    None
):
    original = {
        "position_mode": "HEDGE",
        "long": {
            "quantity": "1",
            "entry_price": "100",
            "mark_price": "101",
            "realized_pnl": "0",
            "unrealized_pnl": "1",
        },
        "short": {
            "quantity": "-1",
            "entry_price": "100",
            "mark_price": "101",
            "realized_pnl": "0",
            "unrealized_pnl": "-1",
        },
    }
    mark_only = {
        **original,
        "long": {**original["long"], "mark_price": "102", "unrealized_pnl": "2"},
        "short": {**original["short"], "mark_price": "102", "unrealized_pnl": "-2"},
    }
    changed_quantity = {
        **mark_only,
        "long": {**mark_only["long"], "quantity": "2"},
    }
    original_hash = canonical_sha256(ReviewRecorder._position_descriptor(original))
    assert canonical_sha256(ReviewRecorder._position_descriptor(mark_only)) == (
        original_hash
    )
    changed_hash = canonical_sha256(
        ReviewRecorder._position_descriptor(changed_quantity)
    )
    assert changed_hash != original_hash

    previous = {
        "domain": {
            "ledger_count": 10,
            "position_hash": original_hash,
            "equity": "10000",
        },
        "_review_descriptor_internal": {"critical_ledger_count": 3},
    }
    audit_only = {
        "domain": {
            "ledger_count": 25,
            "position_hash": original_hash,
            "equity": "10000",
        },
        "_review_descriptor_internal": {"critical_ledger_count": 3},
    }
    assert ReviewRecorder.descriptors(
        {"kind": "SOURCE_EVENT"}, previous, audit_only
    ) == []
    assert ReviewRecorder.descriptors(
        {"kind": "SOURCE_EVENT"},
        previous,
        {
            **audit_only,
            "domain": {**audit_only["domain"], "position_hash": changed_hash},
        },
    ) == [("POSITION", "POSITION_STATE")]
    assert ReviewRecorder.descriptors(
        {"kind": "SOURCE_EVENT"},
        previous,
        {
            **audit_only,
            "_review_descriptor_internal": {"critical_ledger_count": 4},
        },
    ) == [("POSITION", "LEDGER_POSTING")]


async def _run_with_opposite_legs(
    service: object,
    tmp_path: Path,
    *,
    prefix: str,
    hidden_time: bool = False,
) -> tuple[str, str, int]:
    base_request = _sandbox_request(await _request(service))
    if hidden_time:
        base_request = replace(
            base_request,
            time_disclosure_policy=TimeDisclosurePolicy.HIDE_ALL,
        )
    request = await prepare_hedge_request(
        service,
        replace(
            base_request,
            market_type="futures",
        ),
        root=tmp_path,
        prefix=prefix,
    )
    training = getattr(service, "training")
    created = await training.create_run(request)
    run_id = str(created["run"]["run_id"])
    session_id = str(created["run"]["adapter_session_id"])
    await _acquire(
        service,
        run_id=run_id,
        selected_session_id=session_id,
        command_id=f"{prefix}-acquire",
    )
    for position_side, side in (("LONG", "BUY"), ("SHORT", "SELL")):
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"{prefix}-open-{position_side.lower()}",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": f"{prefix}-open-{position_side.lower()}",
                "side": side,
                "position_side": position_side,
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
                "leverage": "2",
            },
        )
    funding_time = int(request.requested_start_ms or 0) + 60_000
    return run_id, session_id, funding_time


async def test_hedge_contract_size_other_than_one_fails_before_run_binding(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase4-contract-size-unsupported.db"
    service = await _risk_service(database)
    try:
        request = await prepare_hedge_request(
            service,
            replace(
                _sandbox_request(await _request(service)),
                market_type="futures",
            ),
            root=tmp_path,
            prefix="phase4-contract-size-unsupported",
            contract_size="10",
        )
        training = service.training
        assert training is not None
        with pytest.raises(TrainingRunError) as unsupported:
            await training.create_run(request)
        assert unsupported.value.code == "HEDGE_CONTRACT_SIZE_UNSUPPORTED"
        assert unsupported.value.status_code == 409
        assert unsupported.value.details == {
            "contract_size": "10",
            "supported_contract_size": "1",
            "supported_market_model": "BINANCE_USDM_LINEAR_BASE_QUANTITY",
            "fallback_applied": False,
            "archive_id": "phase4-contract-size-unsupported-public",
            "event_sequence": 2,
        }

        # The archive remains inspectable, but no half-bound Run/account/rule is
        # persisted and no order can reach the broker under an unsupported model.
        with sqlite3.connect(database) as connection:
            counts = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM replay_training_run),
                    (SELECT COUNT(*) FROM replay_hedge_input_binding),
                    (SELECT COUNT(*) FROM replay_training_instrument_rule)
                """
            ).fetchone()
        assert counts == (0, 0, 0)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_opposite_funding_fee_revision_retry_and_restart_are_exact(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase4-accounting.db"
    service = await _risk_service(database)
    run_id = ""
    try:
        run_id, session_id, funding_time = await _run_with_opposite_legs(
            service,
            tmp_path,
            prefix="phase4-accounting",
        )
        training = service.training
        assert training is not None
        pending = await training.hedge_inputs.events_at(
            run_id=run_id,
            actual_time_ms=funding_time,
        )
        funding_events = tuple(
            event for event in pending if event.event_kind == "FUNDING"
        )
        assert len(funding_events) == 1
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase4-step-funding",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        portfolio = (await training.get_market_tracks(run_id))["portfolio"]
        accounting = {
            item["position_side"]: item
            for item in portfolio["hedge_state"]["leg_accounting"]
        }
        assert accounting["LONG"]["trading_fees"] == "0.06"
        assert accounting["SHORT"]["trading_fees"] == "0.06"
        assert accounting["LONG"]["accumulated_funding"] == "-0.01"
        assert accounting["SHORT"]["accumulated_funding"] == "0.01"
        assert portfolio["funding_cashflow"] == "0"
        assert portfolio["active_fee_policy"]["policy_version"] == ("BINANCE_VIP0_V1")
        assert portfolio["active_fee_policy"]["liquidation_fee_bps"] == "25"
        aggregated = await training.store.base_store.run_extension_read(
            lambda connection: training.store._hedge_accounting_totals_by_leg(
                connection,
                run_id=run_id,
            )
        )
        assert aggregated[("track-1", "LONG")] == (
            Decimal("-0.01"),
            Decimal("0.06"),
            Decimal("0"),
        )
        assert aggregated[("track-1", "SHORT")] == (
            Decimal("0.01"),
            Decimal("0.06"),
            Decimal("0"),
        )

        # Simulate a lost response: replay exactly the already-committed public
        # input.  The applied receipt short-circuits both settlements and cash.
        await training.store.apply_hedge_input_events(
            run_id,
            events=funding_events,
            virtual_time_ms=funding_time,
        )
        with sqlite3.connect(database) as connection:
            counts = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*)
                     FROM replay_training_hedge_funding_settlement
                     WHERE run_id = ?),
                    (SELECT COUNT(*)
                     FROM replay_training_contract_ledger
                     WHERE run_id = ? AND kind = 'FUNDING_SETTLEMENT')
                """,
                (run_id, run_id),
            ).fetchone()
            assert counts == (2, 2)
        audit = await training.audit_account(run_id)
        assert audit["status"] == "PASS", audit["differences"]
        report = await training.report(run_id)
        assert report["account_audit"]["status"] == "PASS"
        assert {
            item["position_side"]
            for item in report["modelled_account"]["hedge_state"]["leg_accounting"]
        } == {"LONG", "SHORT"}
        review = await training.start_review(run_id, event_id=None)
        ledger = review["projection"]["ledger"]
        assert len(ledger) == review["projection"]["domain"]["ledger_count"]
        logical_projection_bytes = len(
            canonical_json(review["projection"]).encode("utf-8")
        )
        with sqlite3.connect(database) as connection:
            stored_projection_json = str(
                connection.execute(
                    """
                    SELECT projection_json FROM replay_review_timeline_event
                    WHERE run_id = ? ORDER BY timeline_sequence DESC LIMIT 1
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
        stored_projection = json.loads(stored_projection_json)
        assert stored_projection["ledger"] == {
            "schema_version": REVIEW_LEDGER_PREFIX_REF_SCHEMA_VERSION,
            "count": len(ledger),
            "tail_hash": review["projection"]["account"]["ledger_tail_hash"],
        }
        assert len(stored_projection_json.encode("utf-8")) < logical_projection_bytes
        forked = await training.fork_run(
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        child_run_id = str(forked["run"]["run_id"])
        child_portfolio = (await training.get_market_tracks(child_run_id))["portfolio"]
        child_live_portfolio = (
            await training.get_live_market_tracks(child_run_id)
        )["portfolio"]
        for field in (
            "cash_balance",
            "equity",
            "available_equity",
            "reserved_margin",
            "margin_used",
            "realized_pnl",
            "unrealized_pnl",
            "fees_paid",
            "funding_cashflow",
            "liquidation_fees_paid",
            "risk_ratio",
            "positions",
            "orders",
            "history",
        ):
            assert child_live_portfolio[field] == child_portfolio[field]
        child_accounting = {
            item["position_side"]: item
            for item in child_portfolio["hedge_state"]["leg_accounting"]
        }
        assert {
            side: (
                item["accumulated_funding"],
                item["trading_fees"],
            )
            for side, item in child_accounting.items()
        } == {
            side: (
                item["accumulated_funding"],
                item["trading_fees"],
            )
            for side, item in accounting.items()
        }
        child_audit = await training.audit_account(child_run_id)
        assert child_audit["status"] == "PASS", child_audit["differences"]
        with sqlite3.connect(database) as connection:
            parent_hashes = {
                row[0]
                for row in connection.execute(
                    """
                    SELECT component_hash
                    FROM replay_training_hedge_funding_settlement
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchall()
            }
            child_hashes = {
                row[0]
                for row in connection.execute(
                    """
                    SELECT component_hash
                    FROM replay_training_hedge_funding_settlement
                    WHERE run_id = ?
                    """,
                    (child_run_id,),
                ).fetchall()
            }
        assert len(parent_hashes) == len(child_hashes) == 2
        assert parent_hashes.isdisjoint(child_hashes)
    finally:
        await service.shutdown(step_timeout=1.0)

    restored = await _risk_service(database)
    try:
        training = restored.training
        assert training is not None
        audit = await training.audit_account(run_id)
        assert audit["status"] == "PASS", audit["differences"]
        portfolio = (await training.get_market_tracks(run_id))["portfolio"]
        accounting = {
            item["position_side"]: item
            for item in portfolio["hedge_state"]["leg_accounting"]
        }
        assert Decimal(accounting["LONG"]["accumulated_funding"]) == Decimal("-0.01")
        assert Decimal(accounting["SHORT"]["accumulated_funding"]) == Decimal("0.01")
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_account_auditor_uses_ledger_order_across_public_and_virtual_time(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase4-accounting-time-domains.db"
    service = await _risk_service(database)
    run_id = ""
    try:
        run_id, session_id, _funding_time = await _run_with_opposite_legs(
            service,
            tmp_path,
            prefix="phase4-accounting-time-domains",
            hidden_time=True,
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase4-time-domains-step-funding",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase4-time-domains-later-short",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase4-time-domains-later-short",
                "side": "SELL",
                "position_side": "SHORT",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
                "leverage": "2",
            },
        )
        with sqlite3.connect(database) as connection:
            funding = connection.execute(
                """
                SELECT actual_settlement_time_ms, ledger_sequence
                FROM replay_training_hedge_funding_settlement
                WHERE run_id = ? AND position_side = 'SHORT'
                """,
                (run_id,),
            ).fetchone()
            later_fill = connection.execute(
                """
                SELECT fill.fill_json, ledger.ledger_sequence
                FROM replay_training_contract_fill AS fill
                JOIN replay_training_contract_ledger AS ledger
                  ON ledger.run_id = fill.run_id
                 AND ledger.posting_id = 'fee:' || fill.track_id || ':' || fill.fill_id
                WHERE fill.run_id = ?
                  AND json_extract(fill.fill_json, '$.position_side') = 'SHORT'
                ORDER BY ledger.ledger_sequence DESC
                LIMIT 1
                """,
                (run_id,),
            ).fetchone()
        assert funding is not None
        assert later_fill is not None
        fill_payload = json.loads(str(later_fill[0]))
        assert int(fill_payload["event_time_ms"]) < int(funding[0])
        assert int(later_fill[1]) > int(funding[1])
        training = service.training
        assert training is not None
        audit = await training.audit_account(run_id)
        assert audit["status"] == "PASS", audit["differences"]
        review = await training.start_review(run_id, event_id=None)
        forked = await training.fork_run(
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        child_audit = await training.audit_account(str(forked["run"]["run_id"]))
        assert child_audit["status"] == "PASS", child_audit["differences"]
    finally:
        await service.shutdown(step_timeout=1.0)

    restored = await _risk_service(database)
    try:
        training = restored.training
        assert training is not None
        audit = await training.audit_account(run_id)
        assert audit["status"] == "PASS", audit["differences"]
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_review_ledger_prefix_reference_tamper_fails_closed(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase4-review-prefix-tamper.db"
    service = await _risk_service(database)
    try:
        run_id, _session_id, _funding_time = await _run_with_opposite_legs(
            service,
            tmp_path,
            prefix="phase4-review-prefix-tamper",
        )
        assert service.training is not None
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                """
                SELECT timeline_sequence, projection_json
                FROM replay_review_timeline_event
                WHERE run_id = ? ORDER BY timeline_sequence DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            assert row is not None
            projection = json.loads(str(row[1]))
            projection["ledger"]["count"] += 1
            connection.execute(
                """
                UPDATE replay_review_timeline_event SET projection_json = ?
                WHERE run_id = ? AND timeline_sequence = ?
                """,
                (canonical_json(projection), run_id, row[0]),
            )
            connection.commit()
        with pytest.raises(TrainingRunError) as corrupted:
            await service.training.start_review(run_id, event_id=None)
        assert corrupted.value.code == "REVIEW_PROJECTION_CORRUPT"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_account_auditor_names_tampered_hedge_funding_field(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase4-auditor.db"
    service = await _risk_service(database)
    try:
        run_id, session_id, _funding_time = await _run_with_opposite_legs(
            service,
            tmp_path,
            prefix="phase4-auditor",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase4-auditor-step",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        training = service.training
        assert training is not None
        assert (await training.audit_account(run_id))["status"] == "PASS"
        with sqlite3.connect(database) as connection:
            connection.execute(
                """
                UPDATE replay_training_hedge_funding_settlement
                SET pre_settlement_signed_quantity = '999'
                WHERE run_id = ? AND position_side = 'LONG'
                """,
                (run_id,),
            )
            connection.commit()
        audit = await training.audit_account(run_id)
        assert audit["status"] == "FAIL"
        assert any(
            item["field"].startswith("hedge_funding[track-1:LONG:")
            and item["field"].endswith(".pre_settlement_signed_quantity")
            for item in audit["differences"]
        )
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute(
                """
                UPDATE replay_training_hedge_funding_settlement
                SET pre_settlement_signed_quantity = '1'
                WHERE run_id = ? AND position_side = 'LONG'
                """,
                (run_id,),
            )
            leg = connection.execute(
                """
                SELECT * FROM replay_training_position_leg
                WHERE run_id = ? AND track_id = 'track-1'
                  AND position_side = 'LONG'
                """,
                (run_id,),
            ).fetchone()
            component = training.store._position_leg_component(
                leg,
                accumulated_funding="999",
                trading_fees=str(leg["trading_fees"]),
                liquidation_fees=str(leg["liquidation_fees"]),
            )
            connection.execute(
                """
                UPDATE replay_training_position_leg
                SET accumulated_funding = '999', component_hash = ?
                WHERE run_id = ? AND track_id = 'track-1'
                  AND position_side = 'LONG'
                """,
                (canonical_sha256(component), run_id),
            )
            connection.commit()
        audit = await training.audit_account(run_id)
        assert any(
            item["field"] == "position_leg[track-1:LONG].accumulated_funding"
            for item in audit["differences"]
        )

        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            leg = connection.execute(
                """
                SELECT * FROM replay_training_position_leg
                WHERE run_id = ? AND track_id = 'track-1'
                  AND position_side = 'LONG'
                """,
                (run_id,),
            ).fetchone()
            component = training.store._position_leg_component(
                leg,
                accumulated_funding="-0.01",
                trading_fees=str(leg["trading_fees"]),
                liquidation_fees=str(leg["liquidation_fees"]),
            )
            connection.execute(
                """
                UPDATE replay_training_position_leg
                SET accumulated_funding = '-0.01', component_hash = ?
                WHERE run_id = ? AND track_id = 'track-1'
                  AND position_side = 'LONG'
                """,
                (canonical_sha256(component), run_id),
            )
            connection.execute(
                """
                UPDATE replay_training_contract_ledger
                SET entry_hash = ?
                WHERE run_id = ? AND kind = 'TRADING_FEE'
                  AND ledger_sequence = (
                      SELECT MIN(ledger_sequence)
                      FROM replay_training_contract_ledger
                      WHERE run_id = ? AND kind = 'TRADING_FEE'
                  )
                """,
                ("sha256:" + "f" * 64, run_id, run_id),
            )
            connection.commit()
        audit = await training.audit_account(run_id)
        assert any(
            item["field"].startswith("ledger[")
            and item["field"].endswith(".entry_hash")
            for item in audit["differences"]
        )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_fill_binds_latest_effective_complete_fee_revision(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase4-fee-revision.db"
    service = await _risk_service(database)
    try:
        run_id, session_id, _funding_time = await _run_with_opposite_legs(
            service,
            tmp_path,
            prefix="phase4-fee-revision",
        )
        with sqlite3.connect(database) as connection:
            effective_time, public_id, now_ms = connection.execute(
                """
                SELECT track.virtual_time_ms, binding.public_archive_id,
                       run.updated_at_ms
                FROM replay_training_market_track AS track
                JOIN replay_hedge_input_binding AS binding USING(run_id)
                JOIN replay_training_run AS run USING(run_id)
                WHERE track.run_id = ? AND track.track_id = 'track-1'
                """,
                (run_id,),
            ).fetchone()
            policy = {
                "schema_version": "replay.training.fee-policy.v1",
                "run_id": run_id,
                "revision": 2,
                "effective_virtual_time_ms": int(effective_time),
                "maker_fee_bps": "1",
                "taker_fee_bps": "10",
                "liquidation_fee_bps": "30",
                "policy_version": "BINANCE_VIP1_V2",
                "account_tier": "VIP1",
                "fidelity": "PINNED_HISTORICAL_FEE_POLICY",
            }
            extension = {
                "schema_version": "replay.training.fee-policy-extension.v1",
                "run_id": run_id,
                "revision": 2,
                "policy_version": "BINANCE_VIP1_V2",
                "account_tier": "VIP1",
                "liquidation_fee_bps": "30",
                "source_kind": "PUBLIC",
                "source_id": str(public_id),
                "source_event_sequence": 999,
            }
            connection.execute(
                """
                INSERT INTO replay_training_fee_policy(
                    run_id, revision, effective_virtual_time_ms,
                    maker_fee_bps, taker_fee_bps, policy_hash, fidelity,
                    reason, created_at_ms
                ) VALUES (?, 2, ?, '1', '10', ?,
                          'PINNED_HISTORICAL_FEE_POLICY',
                          'Phase 4 effective revision test', ?)
                """,
                (run_id, effective_time, canonical_sha256(policy), now_ms),
            )
            connection.execute(
                """
                INSERT INTO replay_training_fee_policy_extension(
                    run_id, revision, policy_version, account_tier,
                    liquidation_fee_bps, source_kind, source_id,
                    source_event_sequence, component_hash, created_at_ms
                ) VALUES (?, 2, 'BINANCE_VIP1_V2', 'VIP1', '30',
                          'PUBLIC', ?, 999, ?, ?)
                """,
                (
                    run_id,
                    public_id,
                    canonical_sha256(extension),
                    now_ms,
                ),
            )
            connection.commit()
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase4-fee-revision-second-long",
            command_type=ReplayV2CommandType.PLACE_ORDER,
            payload={
                "client_order_id": "phase4-fee-revision-second-long",
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
        training = service.training
        assert training is not None
        fills = await training.account_record_page(
            run_id,
            record_type="FILLS",
            track_id="track-1",
            order_scope="ALL",
            cursor=None,
            limit=10,
        )
        latest = fills["items"][0]
        assert latest["fee_policy_revision"] == 2
        assert latest["configured_fee"] == "0.11"
        portfolio = (await training.get_market_tracks(run_id))["portfolio"]
        assert portfolio["active_fee_policy"]["policy_version"] == ("BINANCE_VIP1_V2")
        assert portfolio["active_fee_policy"]["liquidation_fee_bps"] == "30"
        assert fee_for_notional(
            notional=Decimal("101"),
            liquidity="MAKER",
            maker_bps="1",
            taker_bps="10",
            quote_step="0.01",
        ) == Decimal("0.02")
        audit = await training.audit_account(run_id)
        assert audit["status"] == "PASS", audit["differences"]
    finally:
        await service.shutdown(step_timeout=1.0)
