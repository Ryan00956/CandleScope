from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.canonical import canonical_json
from app.replay.training.errors import TrainingRunError
from app.replay.training.hedge_inputs import (
    build_hedge_public_history_archive,
    build_hedge_simulation_manifest,
    verify_hedge_public_history,
    verify_hedge_simulation_manifest,
)
from app.replay.training.models import ReplayV2CommandType
from app.replay.training.schema import TRAINING_SCHEMA_VERSION
from tests.fixtures.replay.hedge_input_fakes import prepare_hedge_request
from tests.test_replay_v2_training_phase5 import _acquire, _request
from tests.test_replay_v2_training_phase6 import (
    _risk_service,
    _sandbox_request,
    _send,
)


pytestmark = pytest.mark.anyio


def _rule() -> dict[str, object]:
    return {
        "rule_version": "BINANCE_USDM_LINEAR_V1",
        "price_tick": "0.1",
        "quantity_step": "0.001",
        "min_quantity": "0.001",
        "max_quantity": "100",
        "min_notional": "5",
        "max_notional": "1000000",
        "quote_step": "0.01",
        "contract_size": "1",
        "max_leverage": "20",
        "liquidation_fee_bps": "25",
        "maintenance_tiers": [
            {
                "notional_cap": "1000000",
                "maintenance_rate": "0.005",
                "maintenance_deduction": "0",
            }
        ],
    }


def _public_events(start: int, end: int) -> list[dict[str, object]]:
    return [
        {"event_time_ms": start, "event_kind": "RULE", "payload": _rule()},
        {
            "event_time_ms": start,
            "event_kind": "FEE_POLICY",
            "payload": {
                "policy_version": "BINANCE_VIP0_V1",
                "account_tier": "VIP0",
                "maker_fee_bps": "2",
                "taker_fee_bps": "5",
                "liquidation_fee_bps": "25",
            },
        },
        {
            "event_time_ms": start,
            "event_kind": "MARK_INDEX",
            "payload": {"mark_price": "100", "index_price": "100"},
        },
        {
            "event_time_ms": start + 500,
            "event_kind": "FUNDING",
            "payload": {"funding_rate": "0.0001", "mark_price": "101"},
        },
        {
            "event_time_ms": end,
            "event_kind": "MARK_INDEX",
            "payload": {"mark_price": "102", "index_price": "102"},
        },
    ]


def test_public_and_simulation_builders_pin_all_hashes_and_reject_drift(
    tmp_path: Path,
) -> None:
    start = 1_000
    end = 2_000
    public_path = tmp_path / "public.json"
    public_ref = build_hedge_public_history_archive(
        public_path,
        archive_id="phase3-public-unit",
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        settlement_asset="USDT",
        range_start_ms=start,
        range_end_ms=end,
        max_mark_gap_ms=1_000,
        source_identity="BINANCE_USDM_TEST_CAPTURE",
        capture_receipt="receipt:phase3-unit",
        historical_l2_ref={
            "archive_id": "book-phase3-unit",
            "dataset_epoch": "sha256:" + "1" * 64,
            "checksum_sha256": "sha256:" + "2" * 64,
        },
        events=_public_events(start, end),
    )
    descriptor = verify_hedge_public_history(public_path)
    assert descriptor.dataset_epoch == public_ref["dataset_epoch"]
    assert descriptor.checksum_sha256 == public_ref["checksum_sha256"]
    assert descriptor.event_count == 5

    tampered = json.loads(public_path.read_text(encoding="utf-8"))
    tampered["events"][1]["sequence"] = 1
    public_path.write_text(canonical_json(tampered), encoding="utf-8")
    with pytest.raises(ValueError, match="dataset_epoch|sequence"):
        verify_hedge_public_history(public_path)

    simulation_path = tmp_path / "simulation.json"
    simulation_ref = build_hedge_simulation_manifest(
        simulation_path,
        manifest_id="phase3-simulation-unit",
        range_start_ms=start,
        range_end_ms=end,
        settlement_asset="USDT",
        required_symbols=["BTCUSDT"],
        insurance_events=[
            {
                "effective_time_ms": start,
                "kind": "OPENING_BALANCE",
                "amount": "1000",
            }
        ],
        adl_snapshots=[
            {
                "symbol": "BTCUSDT",
                "effective_time_ms": start,
                "valid_until_ms": end,
                "candidates": [
                    {
                        "candidate_id": "short-unit",
                        "symbol": "BTCUSDT",
                        "position_side": "SHORT",
                        "quantity": "1",
                        "entry_price": "110",
                        "mark_price": "100",
                        "initial_margin": "10",
                        "margin_balance": "20",
                    }
                ],
            }
        ],
    )
    simulation = verify_hedge_simulation_manifest(simulation_path)
    assert simulation.dataset_epoch == simulation_ref["dataset_epoch"]
    assert simulation.checksum_sha256 == simulation_ref["checksum_sha256"]
    assert simulation.contract_hash == simulation_ref["contract_hash"]


async def _prepared_run(
    service: object,
    tmp_path: Path,
    *,
    prefix: str,
) -> tuple[object, str, str]:
    base = replace(
        _sandbox_request(await _request(service)),
        market_type="futures",
    )
    marks = [str(100 + index) for index in range(13)]
    request = await prepare_hedge_request(
        service,
        base,
        root=tmp_path,
        prefix=prefix,
        mark_prices=marks,
    )
    training = getattr(service, "training")
    created = await training.create_run(request)
    return request, str(created["run"]["run_id"]), str(
        created["run"]["adapter_session_id"]
    )


async def test_run_binds_owned_inputs_orders_same_ms_and_rehydrates_offline(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase3-inputs.db"
    service = await _risk_service(database)
    run_id = ""
    session_id = ""
    public_id = ""
    proof = ""
    try:
        request, run_id, session_id = await _prepared_run(
            service, tmp_path, prefix="phase3-runtime"
        )
        public_id = request.hedge_public_history_ref.archive_id  # type: ignore[union-attr]
        training = service.training
        assert training is not None
        repeated = await training.hedge_inputs.import_public(
            tmp_path / "phase3-runtime-public.json"
        )
        assert repeated["idempotent"] is True
        assert repeated["generation"] == 1
        public_document = json.loads(
            (tmp_path / "phase3-runtime-public.json").read_text(encoding="utf-8")
        )
        conflicting_events = [
            {
                "event_time_ms": event["event_time_ms"],
                "event_kind": event["event_kind"],
                "payload": dict(event["payload"]),
            }
            for event in public_document["events"]
        ]
        conflicting_mark = next(
            event
            for event in conflicting_events
            if event["event_kind"] == "MARK_INDEX"
        )
        conflicting_mark["payload"] = {
            "mark_price": "100.1",
            "index_price": "100.1",
        }
        conflict_path = tmp_path / "phase3-runtime-conflict.json"
        build_hedge_public_history_archive(
            conflict_path,
            archive_id=public_document["archive_id"],
            exchange=public_document["exchange"],
            market_type=public_document["market_type"],
            symbol=public_document["symbol"],
            settlement_asset=public_document["settlement_asset"],
            range_start_ms=public_document["range_start_ms"],
            range_end_ms=public_document["range_end_ms"],
            max_mark_gap_ms=public_document["max_mark_gap_ms"],
            source_identity=public_document["source_identity"],
            capture_receipt="receipt:immutable-conflict",
            historical_l2_ref=public_document["historical_l2_ref"],
            events=conflicting_events,
        )
        with pytest.raises(TrainingRunError) as immutable_conflict:
            await training.hedge_inputs.import_public(conflict_path)
        assert immutable_conflict.value.code == "HEDGE_INPUT_IMMUTABLE_ID_CONFLICT"
        initial_projection = await training.get_market_tracks(run_id)
        assert initial_projection["tracks"][0]["public_price"] == "100"
        assert initial_projection["portfolio"]["hedge_inputs"][
            "input_proof_hash"
        ]
        assert initial_projection["portfolio"]["fidelity"]["fees"] == (
            "PINNED_HISTORICAL_FEE_POLICY"
        )
        assert initial_projection["portfolio"]["fidelity"]["funding"] == (
            "PINNED_HISTORICAL_FUNDING"
        )
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            assert connection.execute(
                "SELECT version FROM replay_training_schema_version"
            ).fetchone()[0] == TRAINING_SCHEMA_VERSION
            binding = connection.execute(
                "SELECT * FROM replay_hedge_input_binding WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            assert binding is not None and binding["status"] == "ACTIVE"
            proof = str(binding["input_proof_hash"])
            projections = connection.execute(
                """
                SELECT source_kind, last_event_sequence, state_json
                FROM replay_hedge_input_projection
                WHERE run_id = ? ORDER BY source_kind
                """,
                (run_id,),
            ).fetchall()
            assert [row["source_kind"] for row in projections] == [
                "PUBLIC",
                "SIMULATION",
            ]
            assert all(int(row["last_event_sequence"]) > 0 for row in projections)
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase3-acquire",
        )
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id="phase3-step-one",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        input_audit = await training.hedge_inputs.audit_run(run_id)
        assert input_audit["status"] == "PASS"
        with sqlite3.connect(database) as connection:
            ordered = connection.execute(
                """
                SELECT actual_event_time_ms, event_phase, track_id
                FROM replay_training_global_event
                WHERE run_id = ?
                ORDER BY global_sequence
                """,
                (run_id,),
            ).fetchall()
            assert [(row[0], row[1]) for row in ordered] == sorted(
                (row[0], row[1]) for row in ordered
            )
            same_ms = [row for row in ordered if row[1] in {30, 40}]
            assert [row[1] for row in same_ms] == [30, 40]
            assert same_ms[0][0] == same_ms[1][0]
            assert str(same_ms[0][2]).startswith("hedge-public:")
            public_row = connection.execute(
                """
                SELECT local_path FROM replay_hedge_public_archive
                WHERE archive_id = ?
                """,
                (public_id,),
            ).fetchone()
            assert public_row is not None
            owned_public = (
                database.parent / f"{database.stem}-hedge-inputs" / public_row[0]
            )
    finally:
        await service.shutdown(step_timeout=1.0)

    owned_public.unlink()
    restored = await _risk_service(database)
    try:
        training = restored.training
        assert training is not None
        receipt = await training.hedge_inputs.rehydrate(
            source_kind="PUBLIC",
            object_id=public_id,
        )
        assert receipt["health"] == "READY"
        assert (await training.hedge_inputs.audit_run(run_id))["status"] == "PASS"
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                """
                SELECT input_proof_hash FROM replay_hedge_input_binding
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()[0] == proof
        await _acquire(
            restored,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase3-restart-acquire",
        )
        await _send(
            restored,
            run_id=run_id,
            session_id=session_id,
            command_id="phase3-step-after-rehydrate",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 1},
        )
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_runtime_tamper_pauses_run_without_market_fallback(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase3-tamper.db"
    service = await _risk_service(database)
    try:
        _request_value, run_id, session_id = await _prepared_run(
            service, tmp_path, prefix="phase3-tamper"
        )
        with sqlite3.connect(database) as connection:
            local_path = connection.execute(
                """
                SELECT archive.local_path
                FROM replay_hedge_input_binding AS binding
                JOIN replay_hedge_public_archive AS archive
                  ON archive.archive_id = binding.public_archive_id
                WHERE binding.run_id = ?
                """,
                (run_id,),
            ).fetchone()[0]
        owned = database.parent / f"{database.stem}-hedge-inputs" / local_path
        owned.write_text(owned.read_text(encoding="utf-8") + " ", encoding="utf-8")
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase3-tamper-acquire",
        )
        with pytest.raises(TrainingRunError) as failure:
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id="phase3-tamper-step",
                command_type=ReplayV2CommandType.STEP_BASE,
                payload={"count": 2},
            )
        assert failure.value.code == "HEDGE_INPUT_OBJECT_MISSING_OR_TAMPERED"
        with sqlite3.connect(database) as connection:
            binding = connection.execute(
                """
                SELECT status, degraded_reason FROM replay_hedge_input_binding
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            assert binding is not None and binding[0] == "PAUSED"
            assert binding[1] == "TrainingRunError"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_input_auditor_detects_projection_tamper_and_pauses_run(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase3-audit-tamper.db"
    service = await _risk_service(database)
    try:
        _request_value, run_id, _session_id = await _prepared_run(
            service, tmp_path, prefix="phase3-audit-tamper"
        )
        with sqlite3.connect(database) as connection:
            connection.execute(
                """
                UPDATE replay_hedge_input_projection
                SET state_json = '{"mark_index":{"index_price":"1","mark_price":"1"}}'
                WHERE run_id = ? AND source_kind = 'PUBLIC'
                """,
                (run_id,),
            )
            connection.commit()
        training = service.training
        assert training is not None
        audit = await training.hedge_inputs.audit_run(run_id)
        assert audit["status"] == "FAIL"
        assert any(
            item["field"] == "projection.PUBLIC.component_hash"
            for item in audit["differences"]
        )
        with sqlite3.connect(database) as connection:
            binding_status, run_state = connection.execute(
                """
                SELECT binding.status, run.state
                FROM replay_hedge_input_binding AS binding
                JOIN replay_training_run AS run USING(run_id)
                WHERE binding.run_id = ?
                """,
                (run_id,),
            ).fetchone()
        assert binding_status == "PAUSED"
        assert run_state == "PAUSED"
        with pytest.raises(TrainingRunError, match="HEDGE input proof"):
            await training.get_market_tracks(run_id)
    finally:
        await service.shutdown(step_timeout=1.0)
