from __future__ import annotations

import json
import shutil
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.training.errors import TrainingRunError
from app.replay.training.models import ReplayV2CommandType
from tests.test_replay_v2_training_hedge_phase5 import (
    _create_bankrupt_hedge_run,
    _trigger_crash,
)
from tests.test_replay_v2_training_phase6 import _risk_service, _send


pytestmark = pytest.mark.anyio


def _copy_risk_store(source: Path, target: Path) -> None:
    shutil.copy2(source, target)
    shutil.copytree(
        source.parent / f"{source.name}.datasets",
        target.parent / f"{target.name}.datasets",
    )
    for suffix in (
        "historical-books",
        "hedge-inputs",
        "account-history",
        "segments",
    ):
        source_root = source.parent / f"{source.stem}-{suffix}"
        if source_root.exists():
            shutil.copytree(
                source_root,
                target.parent / f"{target.stem}-{suffix}",
            )


async def test_hedge_liquidation_consumes_frozen_historical_l2_levels(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase6-levels.db"
    service = await _risk_service(database)
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase6-levels",
            book_level_quantities=["1", "1", "10"],
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase6-levels",
        )
        portfolio = (await service.training.get_market_tracks(run_id))["portfolio"]  # type: ignore[union-attr]
        event = portfolio["liquidations"][0]
        executions = [
            step["book_execution"]
            for step in event["steps"]
            if step["step_type"] == "FULL_LIQUIDATION"
        ]
        assert len(executions) == 2
        assert executions[0]["queue_exact"] == 0
        assert executions[0]["execution_fidelity"] == (
            "HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1"
        )
        assert executions[0]["levels"] == [
            {"book_level": 1, "price": "49", "quantity": "1"},
            {"book_level": 2, "price": "48", "quantity": "1"},
            {"book_level": 3, "price": "47", "quantity": "0.4"},
        ]
        assert executions[1]["levels"] == [
            {"book_level": 1, "price": "51", "quantity": "0.4"}
        ]
        assert len(event["book_snapshots"]) == 1
        assert (
            event["book_snapshots"][0]["as_of_virtual_time_ms"]
            == event["trigger_virtual_time_ms"]
        )

        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            fills = connection.execute(
                """
                SELECT liquidation_fill.book_level, contract.fill_json
                FROM replay_training_liquidation_fill AS liquidation_fill
                JOIN replay_training_contract_fill AS contract
                  ON contract.run_id = liquidation_fill.run_id
                 AND contract.fill_id = liquidation_fill.fill_id
                WHERE liquidation_fill.run_id = ?
                ORDER BY liquidation_fill.order_id, liquidation_fill.fill_sequence
                """,
                (run_id,),
            ).fetchall()
        assert fills
        assert all(row["book_level"] is not None for row in fills)
        assert all(
            json.loads(str(row["fill_json"]))["reason"] == "HISTORICAL_BOOK_LEVEL"
            for row in fills
        )
        assert all(
            json.loads(str(row["fill_json"]))["historical_execution"] is True
            for row in fills
        )
        audit = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert audit["status"] == "PASS"
        assert (
            audit["snapshot"]["independent_exact_state"][
                "historical_l2_liquidation_proof_count"
            ]
            == 2
        )
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize(
    ("book_level_quantities", "book_price_offset", "failure_code"),
    [
        (["1", "1"], "0", "HISTORICAL_BOOK_DEPTH_EXHAUSTED"),
        (["10"], "0.05", "HISTORICAL_BOOK_PRICE_FILTER_CONFLICT"),
        (["1.0005", "10"], "0", "HISTORICAL_BOOK_QUANTITY_FILTER_CONFLICT"),
    ],
)
async def test_hedge_liquidation_fails_closed_without_execution_fallback(
    tmp_path: Path,
    book_level_quantities: list[str],
    book_price_offset: str,
    failure_code: str,
) -> None:
    database = tmp_path / f"phase6-fail-{failure_code}.db"
    service = await _risk_service(database)
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix=f"phase6-fail-{failure_code.lower()}",
            book_level_quantities=book_level_quantities,
            book_price_offset=book_price_offset,
        )
        with pytest.raises(TrainingRunError) as captured:
            await _trigger_crash(
                service,
                run_id=run_id,
                session_id=session_id,
                prefix=f"phase6-fail-{failure_code.lower()}",
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
        assert failed[0]["reason"] == failure_code
        with sqlite3.connect(database) as connection:
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_liquidation_fill WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
                == 0
            )
            assert (
                connection.execute(
                    """
                SELECT COUNT(*) FROM replay_training_contract_fill
                WHERE run_id = ?
                  AND json_extract(fill_json, '$.reason') = 'HISTORICAL_BOOK_LEVEL'
                """,
                    (run_id,),
                ).fetchone()[0]
                == 0
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_historical_l2_proof_tamper_is_detected_by_account_audit(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase6-audit-tamper.db"
    service = await _risk_service(database)
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase6-audit-tamper",
            book_level_quantities=["1", "1", "10"],
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase6-audit-tamper",
        )
        passing = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert passing["status"] == "PASS"

        def tamper(connection: sqlite3.Connection) -> None:
            row = connection.execute(
                """
                SELECT case_id, step_sequence, levels_json
                FROM replay_training_liquidation_book_execution
                WHERE run_id = ? ORDER BY step_sequence LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            levels = json.loads(str(row["levels_json"]))
            levels[0]["quantity"] = "0.5"
            connection.execute(
                """
                UPDATE replay_training_liquidation_book_execution
                SET levels_json = ?
                WHERE run_id = ? AND case_id = ? AND step_sequence = ?
                """,
                (json.dumps(levels), run_id, row["case_id"], row["step_sequence"]),
            )

        await service.training.store.base_store.run_extension_write(tamper)  # type: ignore[union-attr]
        failed = await service.training.audit_account(run_id)  # type: ignore[union-attr]
        assert failed["status"] == "FAIL"
        assert any(
            "execution_plan_hash" in str(item["field"])
            or str(item["field"]).endswith(".quantity")
            for item in failed["differences"]
        )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_fast_forward_request_uses_full_scan_and_matches_step_reference(
    tmp_path: Path,
) -> None:
    seed_root = tmp_path / "phase6-equivalence-seed"
    seed_root.mkdir()
    seed_database = seed_root / "seed.db"
    seed = await _risk_service(seed_database)
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            seed,
            root=seed_root,
            prefix="phase6-equivalence",
            book_level_quantities=["1", "1", "10"],
        )
    finally:
        await seed.shutdown(step_timeout=1.0)

    optimized_database = tmp_path / "phase6-optimized.db"
    reference_database = tmp_path / "phase6-reference.db"
    _copy_risk_store(seed_database, optimized_database)
    _copy_risk_store(seed_database, reference_database)
    optimized = await _risk_service(optimized_database)
    reference = await _risk_service(reference_database)
    optimized.settings = replace(
        optimized.settings,
        replay_fast_forward_optimization_enabled=True,
    )
    reference.settings = replace(
        reference.settings,
        replay_fast_forward_optimization_enabled=False,
    )
    try:
        optimized_result = await _send(
            optimized,
            run_id=run_id,
            session_id=session_id,
            command_id="phase6-optimized-advance",
            command_type=ReplayV2CommandType.ADVANCE_BY,
            payload={"ms": 60_000},
        )
        await _trigger_crash(
            reference,
            run_id=run_id,
            session_id=session_id,
            prefix="phase6-reference",
        )
        assert optimized_result["data"]["plan"]["mode"] == "FULL_EVENT_SCAN"
        optimized_portfolio = (
            await optimized.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        )["portfolio"]
        reference_portfolio = (
            await reference.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        )["portfolio"]
        assert (
            optimized_portfolio["hedge_state"]["state_hash"]
            == (reference_portfolio["hedge_state"]["state_hash"])
        )
        optimized_hashes = [
            row["execution_plan_hash"]
            for row in optimized_portfolio["hedge_state"]["liquidation_book_executions"]
        ]
        reference_hashes = [
            row["execution_plan_hash"]
            for row in reference_portfolio["hedge_state"]["liquidation_book_executions"]
        ]
        assert optimized_hashes == reference_hashes
        assert (await optimized.training.audit_account(run_id))["status"] == "PASS"  # type: ignore[union-attr]
        assert (await reference.training.audit_account(run_id))["status"] == "PASS"  # type: ignore[union-attr]
    finally:
        await optimized.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)
