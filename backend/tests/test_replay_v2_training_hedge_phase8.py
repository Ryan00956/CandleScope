from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.service import ReplayService
from app.replay.canonical import canonical_sha256
from tests.test_replay_v2_training_hedge_phase5 import (
    _create_bankrupt_hedge_run,
    _trigger_crash,
)
from tests.test_replay_v2_training_hedge_phase6 import _copy_risk_store
from tests.test_replay_v2_training_phase6 import _risk_service


pytestmark = pytest.mark.anyio


_LIQUIDATION_TRANSITIONS = (
    "commit_liquidation_cancellation",
    "commit_liquidation_recheck",
    "commit_liquidation_execution",
    "commit_liquidation_bankruptcy",
    "commit_liquidation_insurance",
    "commit_liquidation_adl",
    "commit_liquidation_complete",
)


def _projection_fingerprint(projection: dict[str, object]) -> str:
    portfolio = projection["portfolio"]
    assert isinstance(portfolio, dict)
    hedge_state = portfolio["hedge_state"]
    assert isinstance(hedge_state, dict)
    return canonical_sha256(
        {
            "portfolio_status": portfolio["status"],
            "positions": portfolio["positions"],
            "hedge_state_hash": hedge_state["state_hash"],
            "liquidation_components": [
                event["component_hash"] for event in portfolio["liquidations"]
            ],
            "liquidation_steps": [
                step["step_hash"]
                for event in portfolio["liquidations"]
                for step in event["steps"]
            ],
            "insurance_posting_hashes": [
                posting["posting_hash"]
                for posting in hedge_state["insurance_postings"]
            ],
            "adl_event_hashes": [
                event["event_hash"] for event in hedge_state["adl_events"]
            ],
            "adl_selection_hashes": [
                selection["selection_hash"]
                for selection in hedge_state["adl_selections"]
            ],
            "adl_counterparty_hashes": [
                entry["entry_hash"]
                for entry in hedge_state["adl_counterparty_ledger"]
            ],
        }
    )


def _portable_evidence_fingerprint(projection: dict[str, object]) -> str:
    portfolio = projection["portfolio"]
    assert isinstance(portfolio, dict)
    hedge_state = portfolio["hedge_state"]
    assert isinstance(hedge_state, dict)
    return canonical_sha256(
        {
            "liquidation_components": [
                event["component_hash"] for event in portfolio["liquidations"]
            ],
            "liquidation_steps": [
                step["step_hash"]
                for event in portfolio["liquidations"]
                for step in event["steps"]
            ],
            "insurance_posting_hashes": [
                posting["posting_hash"]
                for posting in hedge_state["insurance_postings"]
            ],
            "adl_event_hashes": [
                event["event_hash"] for event in hedge_state["adl_events"]
            ],
            "adl_selection_hashes": [
                selection["selection_hash"]
                for selection in hedge_state["adl_selections"]
            ],
            "adl_counterparty_hashes": [
                entry["entry_hash"]
                for entry in hedge_state["adl_counterparty_ledger"]
            ],
        }
    )


async def _finish_pending_liquidation(
    service: ReplayService,
    *,
    run_id: str,
    command_id: str,
) -> dict[str, object]:
    assert service.training is not None
    projection: dict[str, object] | None = None
    for _wave in range(4):
        await service.training._reconcile_liquidations(  # noqa: SLF001
            run_id=run_id,
            client_instance_id="phase8-recovery-client",
            command_id=command_id,
        )
        projection = await service.training.get_market_tracks(run_id)
        portfolio = projection["portfolio"]
        assert isinstance(portfolio, dict)
        if portfolio["positions"] == []:
            break
    assert projection is not None
    return projection


@pytest.mark.parametrize(
    ("table", "column"),
    [
        ("replay_training_insurance_posting", "posting_hash"),
        ("replay_training_adl_snapshot", "snapshot_hash"),
        ("replay_training_adl_candidate", "candidate_hash"),
        ("replay_training_adl_event", "event_hash"),
        ("replay_training_adl_selection", "selection_hash"),
        ("replay_training_adl_counterparty_ledger", "entry_hash"),
    ],
)
async def test_insurance_and_adl_are_independently_audited_and_tamper_evident(
    tmp_path: Path,
    table: str,
    column: str,
) -> None:
    database = tmp_path / f"phase8-audit-{table}.db"
    service = await _risk_service(database)
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix=f"phase8-audit-{column}",
            insurance_opening_balance="0",
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix=f"phase8-audit-{column}",
        )
        assert service.training is not None
        passing = await service.training.audit_account(run_id)
        assert passing["status"] == "PASS", passing["differences"]
        independent = passing["snapshot"]["independent_exact_state"]
        assert independent["insurance_and_adl"] == {
            "insurance_fund_count": 1,
            "insurance_posting_count": 2,
            "insurance_ledger_tails": {
                "USDT": independent["insurance_and_adl"]["insurance_ledger_tails"][
                    "USDT"
                ]
            },
            "adl_snapshot_count": 1,
            "adl_candidate_count": 1,
            "adl_selection_count": 1,
            "adl_counterparty_ledger_count": 1,
        }

        def tamper(connection: sqlite3.Connection) -> None:
            connection.execute(
                f"UPDATE {table} SET {column} = ? WHERE rowid = "
                f"(SELECT rowid FROM {table} WHERE run_id = ? LIMIT 1)",
                ("sha256:" + "1" * 64, run_id),
            )

        await service.training.store.base_store.run_extension_write(tamper)
        failed = await service.training.audit_account(run_id)
        assert failed["status"] == "FAIL"
        assert failed["account_audit_status"] == "FAIL"
        assert any(column.removesuffix("_hash") in item["field"] for item in failed["differences"])
        failed_projection = await service.training.get_market_tracks(run_id)
        assert failed_projection["portfolio"]["status"] == "FAILED_CLOSED"
        assert (await service.training.get_run(run_id))["state"] == "PAUSED"
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize("method_name", _LIQUIDATION_TRANSITIONS)
@pytest.mark.parametrize("boundary", ("BEFORE_COMMIT", "AFTER_COMMIT_RESPONSE_LOSS"))
async def test_each_liquidation_transition_recovers_after_real_restart(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    method_name: str,
    boundary: str,
) -> None:
    seed_root = tmp_path / f"seed-{boundary}-{method_name}"
    seed_root.mkdir()
    seed_database = seed_root / "seed.db"
    seed = await _risk_service(seed_database)
    run_id = ""
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            seed,
            root=seed_root,
            prefix=f"phase8-{boundary}-{method_name}",
            insurance_opening_balance="0",
        )
        assert seed.training is not None
        original_reconcile = seed.training._reconcile_liquidations  # noqa: SLF001

        async def defer_liquidation(**_kwargs: object) -> int:
            return 0

        monkeypatch.setattr(seed.training, "_reconcile_liquidations", defer_liquidation)
        await _trigger_crash(
            seed,
            run_id=run_id,
            session_id=session_id,
            prefix=f"phase8-{boundary}-{method_name}-prepare",
        )
        monkeypatch.setattr(
            seed.training,
            "_reconcile_liquidations",
            original_reconcile,
        )
        assert await seed.training.store.pending_liquidations(run_id)
    finally:
        await seed.shutdown(step_timeout=1.0)

    crashed_database = tmp_path / f"phase8-{boundary}-{method_name}.db"
    reference_database = tmp_path / f"phase8-reference-{boundary}-{method_name}.db"
    _copy_risk_store(seed_database, crashed_database)
    _copy_risk_store(seed_database, reference_database)

    crashing = await _risk_service(crashed_database)
    try:
        assert crashing.training is not None
        store = crashing.training.store
        original = getattr(store, method_name)
        injected = False

        async def inject(*args: object, **kwargs: object) -> object:
            nonlocal injected
            if not injected and boundary == "BEFORE_COMMIT":
                injected = True
                raise RuntimeError("phase8 process loss before durable commit")
            result = await original(*args, **kwargs)
            if not injected:
                injected = True
                raise RuntimeError("phase8 response loss after durable commit")
            return result

        monkeypatch.setattr(store, method_name, inject)
        with pytest.raises(RuntimeError, match="phase8 (process|response) loss"):
            await crashing.training._reconcile_liquidations(  # noqa: SLF001
                run_id=run_id,
                client_instance_id="phase8-recovery-client",
                command_id=f"phase8-{boundary}-{method_name}",
            )
    finally:
        await crashing.shutdown(step_timeout=1.0)

    recovered = await _risk_service(crashed_database)
    reference = await _risk_service(reference_database)
    try:
        recovered_projection = await _finish_pending_liquidation(
            recovered,
            run_id=run_id,
            command_id=f"phase8-{boundary}-{method_name}",
        )
        reference_projection = await _finish_pending_liquidation(
            reference,
            run_id=run_id,
            command_id=f"phase8-{boundary}-{method_name}",
        )
        assert _projection_fingerprint(recovered_projection) == _projection_fingerprint(
            reference_projection
        )
        assert recovered.training is not None
        assert (await recovered.training.audit_account(run_id))["status"] == "PASS"
        with sqlite3.connect(crashed_database) as connection:
            for table, identifier in (
                ("replay_training_liquidation_order", "order_id"),
                ("replay_training_liquidation_fill", "fill_id"),
                ("replay_training_insurance_posting", "posting_id"),
                ("replay_training_adl_event", "adl_event_id"),
                ("replay_training_adl_selection", "selection_hash"),
                ("replay_training_adl_counterparty_ledger", "entry_hash"),
            ):
                count, unique_count = connection.execute(
                    f"SELECT COUNT(*), COUNT(DISTINCT {identifier}) "
                    f"FROM {table} WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                assert count == unique_count, (table, count, unique_count)
    finally:
        await recovered.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)


async def test_sqlite_busy_exhaustion_preserves_pending_projection_and_wal_recovers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_root = tmp_path / "phase8-busy-seed"
    seed_root.mkdir()
    seed_database = seed_root / "seed.db"
    seed = await _risk_service(seed_database)
    run_id = ""
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            seed,
            root=seed_root,
            prefix="phase8-busy",
            insurance_opening_balance="0",
        )
        assert seed.training is not None
        original_reconcile = seed.training._reconcile_liquidations  # noqa: SLF001

        async def defer_liquidation(**_kwargs: object) -> int:
            return 0

        monkeypatch.setattr(seed.training, "_reconcile_liquidations", defer_liquidation)
        await _trigger_crash(
            seed,
            run_id=run_id,
            session_id=session_id,
            prefix="phase8-busy-prepare",
        )
        monkeypatch.setattr(
            seed.training,
            "_reconcile_liquidations",
            original_reconcile,
        )
    finally:
        await seed.shutdown(step_timeout=1.0)

    busy_database = tmp_path / "phase8-busy.db"
    reference_database = tmp_path / "phase8-busy-reference.db"
    _copy_risk_store(seed_database, busy_database)
    _copy_risk_store(seed_database, reference_database)
    busy = await _risk_service(busy_database)
    try:
        assert busy.training is not None
        before = await busy.training.get_market_tracks(run_id)
        blocker = sqlite3.connect(busy_database, timeout=0, isolation_level=None)
        try:
            blocker.execute("PRAGMA busy_timeout=0")
            blocker.execute("BEGIN IMMEDIATE")
            with pytest.raises(ReplayDomainError) as captured:
                await busy.training._reconcile_liquidations(  # noqa: SLF001
                    run_id=run_id,
                    client_instance_id="phase8-busy-client",
                    command_id="phase8-busy-command",
                )
            assert captured.value.code == ReplayErrorCode.PERSISTENCE_DEGRADED
            diagnostics = busy.training.store.base_store.diagnostics()
            assert diagnostics["degraded"] is True
            assert diagnostics["busy_exhaustions"] == 1
            assert diagnostics["busy_retries"] >= 3
            after = await busy.training.get_market_tracks(run_id)
            assert _projection_fingerprint(after) == _projection_fingerprint(before)
        finally:
            blocker.rollback()
            blocker.close()
    finally:
        try:
            await busy.shutdown(step_timeout=1.0)
        except ReplayDomainError as exc:
            assert exc.code == ReplayErrorCode.PERSISTENCE_DEGRADED

    with sqlite3.connect(busy_database) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"

    recovered = await _risk_service(busy_database)
    reference = await _risk_service(reference_database)
    try:
        recovered_projection = await _finish_pending_liquidation(
            recovered,
            run_id=run_id,
            command_id="phase8-busy-command",
        )
        reference_projection = await _finish_pending_liquidation(
            reference,
            run_id=run_id,
            command_id="phase8-busy-command",
        )
        assert _projection_fingerprint(recovered_projection) == _projection_fingerprint(
            reference_projection
        )
        assert recovered.training is not None
        assert (await recovered.training.audit_account(run_id))["status"] == "PASS"
    finally:
        await recovered.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)


async def test_review_and_fork_leave_parent_hashes_immutable(tmp_path: Path) -> None:
    service = await _risk_service(tmp_path / "phase8-parent-immutable.db")
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase8-parent-immutable",
            insurance_opening_balance="0",
        )
        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase8-parent-immutable",
        )
        assert service.training is not None
        parent_before = await service.training.get_market_tracks(run_id)
        audit_before = await service.training.audit_account(run_id)
        assert audit_before["status"] == "PASS"

        review = await service.training.start_review(run_id, event_id=None)
        parent_state_hash = str(review["selected_state_hash"])
        child = await service.training.fork_run(
            run_id,
            event_id=str(review["selected_event_id"]),
        )

        parent_after = await service.training.get_market_tracks(run_id)
        review_after = await service.training.start_review(
            run_id,
            event_id=str(review["selected_event_id"]),
        )
        audit_after = await service.training.audit_account(run_id)
        assert _projection_fingerprint(parent_after) == _projection_fingerprint(
            parent_before
        )
        assert review_after["selected_state_hash"] == parent_state_hash
        assert child["run"]["state_hash"] == parent_state_hash
        assert audit_after["status"] == "PASS"
        assert audit_after["proof_hash"] == audit_before["proof_hash"]

        child_run_id = str(child["run"]["run_id"])
        child_projection = await service.training.get_market_tracks(child_run_id)
        assert _portable_evidence_fingerprint(
            child_projection
        ) == _portable_evidence_fingerprint(
            parent_before,
        )
        child_audit = await service.training.audit_account(child_run_id)
        assert child_audit["status"] == "PASS", child_audit["differences"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_pinned_hedge_and_l2_archives_rehydrate_exact_receipts(
    tmp_path: Path,
) -> None:
    service = await _risk_service(tmp_path / "phase8-rehydrate.db")
    try:
        run_id, session_id = await _create_bankrupt_hedge_run(
            service,
            root=tmp_path,
            prefix="phase8-rehydrate",
            insurance_opening_balance="0",
        )
        assert service.training is not None

        def catalog(connection: sqlite3.Connection) -> dict[str, dict[str, object]]:
            binding = connection.execute(
                "SELECT * FROM replay_hedge_input_binding WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            public = connection.execute(
                "SELECT * FROM replay_hedge_public_archive WHERE archive_id = ?",
                (binding["public_archive_id"],),
            ).fetchone()
            simulation = connection.execute(
                """
                SELECT * FROM replay_hedge_simulation_manifest
                WHERE manifest_id = ?
                """,
                (binding["simulation_manifest_id"],),
            ).fetchone()
            book = connection.execute(
                """
                SELECT archive.* FROM replay_historical_book_archive AS archive
                JOIN replay_historical_book_ref AS ref USING(archive_id)
                WHERE ref.run_id = ? AND ref.active = 1
                ORDER BY ref.track_id LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            projection = connection.execute(
                """
                SELECT book_hash FROM replay_historical_book_projection
                WHERE run_id = ? ORDER BY track_id LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            return {
                "binding": dict(binding),
                "public": dict(public),
                "simulation": dict(simulation),
                "book": dict(book),
                "book_projection": dict(projection),
            }

        before = await service.training.store.base_store.run_extension_read(catalog)
        audit_before = await service.training.audit_account(run_id)
        assert audit_before["status"] == "PASS"

        for source_kind, key, table, id_column in (
            ("PUBLIC", "public", "replay_hedge_public_archive", "archive_id"),
            (
                "SIMULATION",
                "simulation",
                "replay_hedge_simulation_manifest",
                "manifest_id",
            ),
        ):
            row = before[key]
            object_id = str(row[id_column])
            local_path = service.training.hedge_inputs.root / str(row["local_path"])
            assert local_path.is_file()
            local_path.unlink()

            def evict_input(connection: sqlite3.Connection) -> None:
                connection.execute(
                    f"UPDATE {table} SET health = 'EVICTED', local_path = NULL, "
                    f"quarantine_reason = NULL WHERE {id_column} = ?",
                    (object_id,),
                )

            await service.training.store.base_store.run_extension_write(evict_input)
            restored = await service.training.hedge_inputs.rehydrate(
                source_kind=source_kind,
                object_id=object_id,
            )
            assert restored["health"] == "READY"
            assert restored["checksum_sha256"] == row["checksum_sha256"]
            assert restored["dataset_epoch"] == row["dataset_epoch"]

        book = before["book"]
        book_id = str(book["archive_id"])
        book_path = service.training.historical_books.root / str(book["local_path"])
        assert book_path.is_file()
        book_path.unlink()

        def evict_book(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                UPDATE replay_historical_book_archive
                SET health = 'EVICTED', local_path = NULL,
                    quarantine_reason = NULL
                WHERE archive_id = ?
                """,
                (book_id,),
            )

        await service.training.store.base_store.run_extension_write(evict_book)
        restored_book = await service.training.rehydrate_historical_book_archive(
            book_id
        )
        assert restored_book["health"] == "READY"
        assert restored_book["checksum_sha256"] == book["checksum_sha256"]
        assert restored_book["dataset_epoch"] == book["dataset_epoch"]

        after = await service.training.store.base_store.run_extension_read(catalog)
        assert after["binding"]["input_proof_hash"] == before["binding"][
            "input_proof_hash"
        ]
        assert after["book_projection"]["book_hash"] == before["book_projection"][
            "book_hash"
        ]
        audit_after = await service.training.audit_account(run_id)
        assert audit_after["status"] == "PASS"
        assert audit_after["proof_hash"] == audit_before["proof_hash"]

        await _trigger_crash(
            service,
            run_id=run_id,
            session_id=session_id,
            prefix="phase8-rehydrate",
        )
        assert (await service.training.audit_account(run_id))["status"] == "PASS"
    finally:
        await service.shutdown(step_timeout=1.0)
