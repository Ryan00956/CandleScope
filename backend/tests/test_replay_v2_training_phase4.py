from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.commands import ReplayV2Command
from app.replay.training.disclosure import project_public_time
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import (
    ReplayV2CommandType,
    TimeDisclosurePolicy,
    TrainingCursor,
    TrainingRunCreateRequest,
)
from app.replay.training.schema import TRAINING_SCHEMA_VERSION
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


async def _service(path: Path, *, prefix: str = "run") -> ReplayService:
    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory(prefix),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _request(
    service: ReplayService,
    *,
    integrity_mode: str = "CHALLENGE",
    disclosure: str = "NONE",
    start_mode: str = "MANUAL",
    allowed_mutations: tuple[str, ...] = (),
) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=12 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=disclosure != "NONE",
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 4 integrity",
            "source_kind": "BAR",
            "start_mode": start_mode,
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": (
                START_MS + 4 * INTERVAL_MS if start_mode == "MANUAL" else None
            ),
            "warmup_bars": 2,
            "forward_cache_ms": 12 * INTERVAL_MS,
            "random_seed": 42,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": integrity_mode,
            "time_disclosure_policy": disclosure,
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "funding_mode": "OFF",
            "allow_rule_changes": bool(allowed_mutations),
            "allowed_mutations": list(allowed_mutations),
        }
    )


def _command(
    run_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    session: dict[str, object],
    payload: dict[str, object],
) -> ReplayV2Command:
    snapshot = session["snapshot"]
    assert isinstance(snapshot, dict)
    cursor = snapshot["cursor"]
    assert isinstance(cursor, dict)
    revision = snapshot["revision"]
    assert isinstance(revision, int)
    return ReplayV2Command(
        protocol="replay.v2",
        run_id=run_id,
        command_id=command_id,
        client_instance_id="phase4-browser",
        expected_revision=revision,
        expected_cursor=TrainingCursor(
            virtual_time_ms=int(cursor["virtual_time_ms"]),
            source_sequence=int(cursor["source_sequence"]),
            revision=revision,
        ),
        type=command_type,
        payload=payload,
    )


@pytest.mark.parametrize(
    ("policy", "expected_label", "forbidden"),
    (
        ("NONE", "2024-03-09 16:00:00", ()),
        ("HIDE_YEAR", "03-09 16:00:00", ("2024",)),
        ("HIDE_MONTH", "09 16:00:00", ("2024", "03-")),
        ("HIDE_DAY", "D+1 16:00:00", ("2024", "03-09")),
        ("HIDE_HOUR", "T+0h 00:00", ("2024", "16:")),
        ("HIDE_MINUTE", "T+0m 00", ("2024", "16:00")),
        ("HIDE_ALL", "D+1 T+00:00:00", ("2024", "03-09", "16:00")),
    ),
)
def test_seven_disclosure_policies_are_server_projected_without_hidden_units(
    policy: str,
    expected_label: str,
    forbidden: tuple[str, ...],
) -> None:
    actual = 1_710_000_000_000
    public = 946_684_800_000
    projected = project_public_time(
        actual_time_ms=actual,
        public_time_ms=public,
        actual_origin_ms=actual,
        public_origin_ms=public,
        policy=TimeDisclosurePolicy(policy),
        sequence=0,
    )
    assert projected["label"] == expected_label
    assert projected["timeline_ms"] == (actual if policy == "NONE" else public)
    serialized = json.dumps(projected, sort_keys=True)
    for fragment in forbidden:
        assert fragment not in serialized


async def test_manual_hidden_start_is_known_and_never_strict(tmp_path: Path) -> None:
    service = await _service(tmp_path / "manual-known.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, disclosure="HIDE_DAY")
        )
        integrity = await service.training.integrity(created["run"]["run_id"])  # type: ignore[union-attr,index]
        assert integrity["start_time_known"] is True
        assert integrity["strict_eligible"] is False
        assert integrity["result_label"] == "START_TIME_KNOWN"
        assert str(START_MS + 4 * INTERVAL_MS) not in json.dumps(integrity)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_integrity_policy_capital_audit_and_equity_are_atomic(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "integrity.db")
    try:
        challenge = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        challenge_run = challenge["run"]["run_id"]
        challenge_session = await service.get_session(challenge["run"]["adapter_session_id"])
        with pytest.raises(TrainingRunError, match="integrity"):
            await service.training.command(  # type: ignore[union-attr]
                challenge_run,
                _command(
                    challenge_run,
                    "challenge-deposit",
                    ReplayV2CommandType.DEPOSIT,
                    challenge_session,
                    {"amount": "250", "reason": "forbidden"},
                ),
            )

        practice = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                integrity_mode="PRACTICE",
                allowed_mutations=("deposit", "withdraw"),
            )
        )
        run_id = practice["run"]["run_id"]
        session_id = practice["run"]["adapter_session_id"]
        session = await service.get_session(session_id)
        acquired = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "acquire",
                ReplayV2CommandType.ACQUIRE_CONTROLLER,
                session,
                {"takeover": False},
            ),
        )
        session = await service.get_session(session_id)
        before_hash = acquired["state_hash"]
        deposited = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "deposit-1",
                ReplayV2CommandType.DEPOSIT,
                session,
                {"amount": "250", "reason": "practice capital"},
            ),
        )
        assert deposited["data"]["account"]["equity"] == "10250"
        assert deposited["state_hash"] != before_hash

        report = await service.training.report(run_id)  # type: ignore[union-attr]
        assert report["integrity"]["result_label"] == "PRACTICE"
        assert report["integrity"]["mutations"][0]["event_type"] == "DEPOSIT"
        assert report["integrity"]["mutations"][0]["old_value"] == {"equity": "10000"}
        assert report["integrity"]["mutations"][0]["new_value"] == {"equity": "10250"}

        review = await service.training.start_review(run_id, event_id=None)  # type: ignore[union-attr]
        assert review["events"][-1]["event_type"] == "DEPOSIT"

        equity = await service.training.equity(run_id, resolution="AUTO", limit=100)  # type: ignore[union-attr]
        assert equity["samples"][-1]["equity"] == "10250"
        assert equity["samples"][-1]["state_hash"] == deposited["state_hash"]
        assert equity["bounded"] is True
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_failed_audit_projection_rolls_back_the_entire_capital_command(
    tmp_path: Path,
) -> None:
    path = tmp_path / "audit-failure.db"
    service = await _service(path)
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                integrity_mode="PRACTICE",
                allowed_mutations=("deposit",),
            )
        )
        run_id = created["run"]["run_id"]
        session_id = created["run"]["adapter_session_id"]
        session = await service.get_session(session_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "acquire-failure-test",
                ReplayV2CommandType.ACQUIRE_CONTROLLER,
                session,
                {"takeover": False},
            ),
        )
        session = await service.get_session(session_id)
        with sqlite3.connect(path) as connection:
            durable_before = connection.execute(
                "SELECT revision, state_hash FROM replay_session WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            ledger_before = connection.execute(
                "SELECT entry_id, payload_json FROM replay_ledger_entry "
                "WHERE session_id = ? ORDER BY entry_id",
                (session_id,),
            ).fetchall()
            audit_before = connection.execute(
                "SELECT COUNT(*) FROM replay_run_action_event WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            equity_before = connection.execute(
                "SELECT resolution, bucket_id, equity, state_hash "
                "FROM replay_equity_sample WHERE run_id = ? "
                "ORDER BY resolution, bucket_id",
                (run_id,),
            ).fetchall()

        original_writer = service.store._session_mutation_writer
        assert original_writer is not None

        def fail_after_training_projection(*args: object, **kwargs: object) -> None:
            original_writer(*args, **kwargs)  # type: ignore[arg-type]
            raise RuntimeError("injected audit projection failure")

        service.store._session_mutation_writer = fail_after_training_projection
        try:
            with pytest.raises(TrainingRunError, match="rolled back"):
                await service.training.command(  # type: ignore[union-attr]
                    run_id,
                    _command(
                        run_id,
                        "deposit-must-rollback",
                        ReplayV2CommandType.DEPOSIT,
                        session,
                        {"amount": "250", "reason": "failure injection"},
                    ),
                )
        finally:
            service.store._session_mutation_writer = original_writer

        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT revision, state_hash FROM replay_session WHERE session_id = ?",
                (session_id,),
            ).fetchone() == durable_before
            assert connection.execute(
                "SELECT entry_id, payload_json FROM replay_ledger_entry "
                "WHERE session_id = ? ORDER BY entry_id",
                (session_id,),
            ).fetchall() == ledger_before
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_run_action_event WHERE run_id = ?",
                (run_id,),
            ).fetchone() == audit_before
            assert connection.execute(
                "SELECT resolution, bucket_id, equity, state_hash "
                "FROM replay_equity_sample WHERE run_id = ? "
                "ORDER BY resolution, bucket_id",
                (run_id,),
            ).fetchall() == equity_before
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_command_log "
                "WHERE session_id = ? AND command_id = 'deposit-must-rollback'",
                (session_id,),
            ).fetchone() == (0,)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_internal_capital_command_recovers_without_expanding_v1_transport(
    tmp_path: Path,
) -> None:
    path = tmp_path / "capital-recovery.db"
    service = await _service(path)
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                integrity_mode="PRACTICE",
                allowed_mutations=("deposit",),
            )
        )
        run_id = created["run"]["run_id"]
        session_id = created["run"]["adapter_session_id"]
        session = await service.get_session(session_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "acquire-recovery",
                ReplayV2CommandType.ACQUIRE_CONTROLLER,
                session,
                {"takeover": False},
            ),
        )
        session = await service.get_session(session_id)
        deposited = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "deposit-recovery",
                ReplayV2CommandType.DEPOSIT,
                session,
                {"amount": "250", "reason": "recovery contract"},
            ),
        )
        expected_hash = deposited["state_hash"]
    finally:
        await service.shutdown(step_timeout=1.0)

    recovered_service = await _service(path, prefix="recovered")
    try:
        recovered = await recovered_service.get_session(session_id)
        assert recovered["snapshot"]["state_hash"] == expected_hash
        assert recovered["snapshot"]["components"]["account"]["equity"] == "10250"
    finally:
        await recovered_service.shutdown(step_timeout=1.0)


async def test_reveal_is_irreversible_audited_and_report_gated(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "reveal.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                integrity_mode="PRACTICE",
                disclosure="HIDE_ALL",
                start_mode="RANDOM",
                allowed_mutations=("reveal_time",),
            )
        )
        run_id = created["run"]["run_id"]
        session_id = created["run"]["adapter_session_id"]
        before = await service.training.report(run_id)  # type: ignore[union-attr]
        assert before["revealed"] is False
        assert "actual_history" not in before
        assert str(START_MS) not in json.dumps(before)

        session = await service.get_session(session_id)
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "acquire-reveal",
                ReplayV2CommandType.ACQUIRE_CONTROLLER,
                session,
                {"takeover": False},
            ),
        )
        session = await service.get_session(session_id)
        revealed = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "reveal-once",
                ReplayV2CommandType.REVEAL_TIME,
                session,
                {"reason": "user accepted irreversible reveal"},
            ),
        )
        assert revealed["data"]["integrity_mode"] == "PRACTICE"

        integrity = await service.training.integrity(run_id)  # type: ignore[union-attr]
        assert integrity["revealed"] is True
        assert integrity["effective_time_disclosure_policy"] == "NONE"
        assert integrity["strict_eligible"] is False
        assert integrity["result_label"] == "PRACTICE_REVEALED"
        assert integrity["mutations"][-1]["event_type"] == "REVEAL_TIME"
        assert integrity["mutations"][-1]["reason"] == "user accepted irreversible reveal"

        after = await service.training.report(run_id)  # type: ignore[union-attr]
        assert after["revealed"] is True
        assert after["actual_history"]["replay_start_ms"] >= START_MS

        session = await service.get_session(session_id)
        with pytest.raises(TrainingRunError, match="irreversible"):
            await service.training.command(  # type: ignore[union-attr]
                run_id,
                _command(
                    run_id,
                    "reveal-twice",
                    ReplayV2CommandType.REVEAL_TIME,
                    session,
                    {"reason": "must reject"},
                ),
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_view_actions_are_coalesced_and_review_fork_is_exact(tmp_path: Path) -> None:
    path = tmp_path / "review.db"
    service = await _service(path, prefix="review-run")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, integrity_mode="SANDBOX")
        )
        run_id = created["run"]["run_id"]
        session_id = created["run"]["adapter_session_id"]
        session = await service.get_session(session_id)
        for index in range(10_000):
            await service.training.command(  # type: ignore[union-attr]
                run_id,
                _command(
                    run_id,
                    f"view-{index}",
                    ReplayV2CommandType.RECORD_VIEW_ACTION,
                    session,
                    {
                        "event_type": "VISIBLE_RANGE",
                        "semantic_key": "main-chart-range",
                        "value": {"from_sequence": index, "to_sequence": index + 100},
                    },
                ),
            )
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_run_view_event WHERE run_id = ?",
                (run_id,),
            ).fetchone() == (1,)
            assert connection.execute(
                "SELECT sample_count FROM replay_run_view_event WHERE run_id = ?",
                (run_id,),
            ).fetchone() == (10_000,)

        before = await service.get_session(session_id)
        review = await service.training.start_review(run_id, event_id=None)  # type: ignore[union-attr]
        after = await service.get_session(session_id)
        assert review["read_only"] is True
        assert all(
            not str(event["event_type"]).startswith("_training_")
            for event in review["events"]
        )
        assert review["events"][-1]["event_type"] == "INITIAL_CHECKPOINT"
        assert before["snapshot"]["state_hash"] == after["snapshot"]["state_hash"]
        assert before["snapshot"]["cursor"] == after["snapshot"]["cursor"]

        forked = await service.training.fork_run(  # type: ignore[union-attr]
            run_id,
            event_id=review["selected_event_id"],
        )
        assert forked["parent_run_id"] == run_id
        assert forked["parent_event_id"] == review["selected_event_id"]
        assert forked["run"]["dataset_epoch"] == review["dataset_epoch"]
        assert forked["run"]["state_hash"] == review["selected_state_hash"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase4_schema_is_additive_and_bounded(tmp_path: Path) -> None:
    path = tmp_path / "schema.db"
    service = await _service(path)
    await service.shutdown(step_timeout=1.0)
    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT version FROM replay_training_schema_version WHERE singleton = 1"
        ).fetchone() == (TRAINING_SCHEMA_VERSION,)
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert {
        "replay_run_action_event",
        "replay_run_view_event",
        "replay_equity_sample",
        "replay_review_session",
        "replay_run_lineage",
    } <= tables
