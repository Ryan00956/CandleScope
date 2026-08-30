from __future__ import annotations

import sqlite3

import pytest

from app.data_engine.manual_history.models import (
    CollectionStatus,
    JobState,
    JobTargetState,
    ManualHistoryCreateSpec,
    ManualHistoryError,
    ManualHistoryIdempotencyConflict,
    ManualHistoryIllegalTransition,
    ManualHistoryTargetSpec,
    ProtectionKind,
    ProtectionState,
    RouteKind,
    TargetStatus,
)
from app.data_engine.manual_history.repository import ManualHistoryRepository
from app.data_engine.storage import klines_repo


FIXED_NOW_MS = 1_700_000_000_000


def _use_temp_db(monkeypatch, tmp_path):
    db_path = tmp_path / "klines.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    klines_repo.init_klines_storage()
    return db_path


def _repo(db_path) -> ManualHistoryRepository:
    return ManualHistoryRepository(db_path, clock=lambda: FIXED_NOW_MS)


def _native_spec(
    *,
    collection_id: str = "col-1",
    job_id: str = "job-1",
    idempotency_key: str = "idem-1",
    request_hash: str = "req-1",
    symbol: str = "BTCUSDT",
    extra_targets: tuple[ManualHistoryTargetSpec, ...] = (),
) -> ManualHistoryCreateSpec:
    targets = (
        ManualHistoryTargetSpec(
            symbol=symbol,
            requested_interval="1m",
            canonical_interval="1m",
            route_kind=RouteKind.NATIVE,
            source_interval="1m",
            effective_start_ms=1_700_000_040_000,
            initial_end_open_ms=1_700_006_000_000,
            estimated_rows=100,
            expected_rows=100,
        ),
        *extra_targets,
    )
    return ManualHistoryCreateSpec(
        collection_id=collection_id,
        job_id=job_id,
        exchange="binance",
        market_type="spot",
        requested_start_ms=1_700_000_000_000,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        plan_hash="plan-1",
        targets=targets,
    )


def _kline_row(open_time: int) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + 59_999,
        "open": 100.0,
        "high": 110.0,
        "low": 90.0,
        "close": 105.0,
        "volume": 1.5,
        "quote_volume": 157.5,
        "trades": 10,
        "taker_buy_base": 0.75,
        "taker_buy_quote": 78.75,
    }


def test_init_klines_storage_creates_manual_history_schema(monkeypatch, tmp_path) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    with klines_repo._connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            )
        }
    assert "klines" in tables
    assert "history_archive_imports" in tables
    assert "manual_history_collections" in tables
    assert "manual_history_jobs" in tables
    assert "manual_history_protections" in tables
    assert db_path.exists()


def test_schema_init_is_idempotent(monkeypatch, tmp_path) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    klines_repo.init_klines_storage()
    repo = _repo(db_path)
    repo.init_storage()
    created = repo.create_collection_and_job(_native_spec())
    klines_repo.init_klines_storage()
    repo.init_storage()
    reloaded = _repo(db_path).get_job(created.job.job_id)
    assert reloaded.idempotency_key == "idem-1"
    assert reloaded.state is JobState.QUEUED


def test_create_transaction_persists_collection_job_and_transient_protection(
    monkeypatch, tmp_path
) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    derived = ManualHistoryTargetSpec(
        symbol="BTCUSDT",
        requested_interval="89m",
        canonical_interval="89m",
        route_kind=RouteKind.DERIVED,
        source_interval="1m",
        effective_start_ms=1_700_000_040_000,
        initial_end_open_ms=1_700_006_000_000,
    )
    result = repo.create_collection_and_job(
        _native_spec(extra_targets=(derived,))
    )
    assert result.reused_existing is False
    assert result.collection.status is CollectionStatus.BUILDING
    assert result.job.state is JobState.QUEUED
    assert result.job.total_targets == 2
    assert result.job.revision == 0
    intervals = {item.interval for item in result.protections}
    assert intervals == {"1m", "89m"}
    assert all(item.state is ProtectionState.ACTIVE for item in result.protections)
    assert all(item.protection_kind is ProtectionKind.TRANSIENT for item in result.protections)
    floors = repo.active_protection_snapshot()
    assert len(floors) == 2
    by_interval = {floor.key.interval: floor for floor in floors}
    assert by_interval["1m"].protected_start_ms == 1_700_000_040_000
    assert by_interval["1m"].transient_owner_count >= 1
    assert by_interval["89m"].durable_owner_count == 0


def test_create_transaction_rolls_back_without_orphans(monkeypatch, tmp_path) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    duplicate = ManualHistoryTargetSpec(
        symbol="BTCUSDT",
        requested_interval="1m",
        canonical_interval="1m",
        route_kind=RouteKind.NATIVE,
        source_interval="1m",
        effective_start_ms=1_700_000_040_000,
        initial_end_open_ms=1_700_006_000_000,
    )
    with pytest.raises(sqlite3.IntegrityError):
        repo.create_collection_and_job(_native_spec(extra_targets=(duplicate,)))
    assert repo.count_rows("manual_history_collections") == 0
    assert repo.count_rows("manual_history_collection_targets") == 0
    assert repo.count_rows("manual_history_jobs") == 0
    assert repo.count_rows("manual_history_job_targets") == 0
    assert repo.count_rows("manual_history_protections") == 0
    assert repo.active_protection_snapshot() == ()


def test_idempotency_lookup_reuses_same_hash_and_rejects_conflict(
    monkeypatch, tmp_path
) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    first = repo.create_collection_and_job(_native_spec())
    reused = repo.create_collection_and_job(_native_spec())
    assert reused.reused_existing is True
    assert reused.job.job_id == first.job.job_id
    lookup = repo.get_job_by_idempotency_key("idem-1")
    assert lookup is not None
    assert lookup.job_id == first.job.job_id
    with pytest.raises(ManualHistoryIdempotencyConflict) as exc:
        repo.create_collection_and_job(_native_spec(request_hash="other-hash"))
    assert exc.value.existing_job_id == first.job.job_id
    assert repo.count_rows("manual_history_jobs") == 1


def test_illegal_job_transition_is_rejected_and_leaves_state(
    monkeypatch, tmp_path
) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    created = repo.create_collection_and_job(_native_spec())
    with pytest.raises(ManualHistoryIllegalTransition):
        repo.cas_job_state(
            created.job.job_id,
            from_state=JobState.QUEUED,
            to_state=JobState.SUCCEEDED,
        )
    assert repo.get_job(created.job.job_id).state is JobState.QUEUED
    running = repo.cas_job_state(
        created.job.job_id,
        from_state=JobState.QUEUED,
        to_state=JobState.RUNNING,
        stage="fetching",
    )
    assert running.state is JobState.RUNNING
    assert running.revision == 1
    assert running.started_at_ms == FIXED_NOW_MS
    with pytest.raises(ManualHistoryIllegalTransition):
        repo.cas_job_target_state(
            created.job.job_id,
            "BTCUSDT",
            "1m",
            from_state=JobTargetState.QUEUED,
            to_state=JobTargetState.READY,
        )
    assert repo.list_job_targets(created.job.job_id)[0].state is JobTargetState.QUEUED


def test_restart_reload_restores_jobs_and_protection_floors(
    monkeypatch, tmp_path
) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    original = _repo(db_path)
    created = original.create_collection_and_job(_native_spec())
    original.cas_job_state(
        created.job.job_id,
        from_state=JobState.QUEUED,
        to_state=JobState.RUNNING,
    )
    snapshot = original.active_protection_snapshot()
    recoverable = original.list_recoverable_jobs()
    assert [job.job_id for job in recoverable] == [created.job.job_id]

    reopened = _repo(db_path)
    restored = reopened.get_job(created.job.job_id)
    assert restored.state is JobState.RUNNING
    assert restored.collection_id == created.collection.collection_id
    assert reopened.active_protection_snapshot() == snapshot
    assert [job.job_id for job in reopened.list_recoverable_jobs()] == [
        created.job.job_id
    ]


def test_seal_upgrades_durable_protection_in_one_transaction(
    monkeypatch, tmp_path
) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    created = repo.create_collection_and_job(_native_spec())
    sealed = repo.seal_target(
        created.job.job_id,
        "BTCUSDT",
        "1m",
        sealed_end_open_ms=1_700_005_940_000,
        verified_rows=99,
    )
    job_target = sealed.job_targets[0]
    collection_target = sealed.collection_targets[0]
    assert job_target.state is JobTargetState.READY
    assert job_target.sealed_end_open_ms == 1_700_005_940_000
    assert collection_target.status is TargetStatus.READY
    assert collection_target.continuous_end_ms == 1_700_005_940_000
    assert collection_target.verified_rows == 99
    kinds = {
        (item.protection_kind, item.state, item.interval)
        for item in sealed.protections
    }
    assert (ProtectionKind.DURABLE, ProtectionState.ACTIVE, "1m") in kinds
    assert (ProtectionKind.TRANSIENT, ProtectionState.RELEASED, "1m") in kinds
    floors = repo.active_protection_snapshot()
    assert len(floors) == 1
    assert floors[0].durable_owner_count == 1
    assert floors[0].transient_owner_count == 0
    assert sealed.job.ready_targets == 1
    assert sealed.job.revision == 1


def test_job_listing_cursor_is_stable_for_equal_timestamps(monkeypatch, tmp_path) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    repo.create_collection_and_job(_native_spec())
    repo.create_collection_and_job(_native_spec(
        collection_id="col-2",
        job_id="job-2",
        idempotency_key="idem-2",
        request_hash="req-2",
    ))
    first = repo.list_jobs(limit=1)
    assert [job.job_id for job in first] == ["job-2"]
    second = repo.list_jobs(limit=1, cursor=first[-1].job_id)
    assert [job.job_id for job in second] == ["job-1"]


def test_release_collection_drops_protection_without_deleting_klines(
    monkeypatch, tmp_path
) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_kline_row(1_700_000_040_000)],
        source="binance",
        exchange="binance",
        market_type="spot",
    )
    created = repo.create_collection_and_job(_native_spec())
    repo.seal_target(
        created.job.job_id,
        "BTCUSDT",
        "1m",
        sealed_end_open_ms=1_700_000_040_000,
        verified_rows=1,
    )
    released = repo.release_collection(created.collection.collection_id)
    assert released.status is CollectionStatus.RELEASED
    assert repo.list_collection_targets(created.collection.collection_id)[0].status is (
        TargetStatus.RELEASED
    )
    assert repo.active_protection_snapshot() == ()
    remaining = klines_repo.query_klines(
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    )
    assert len(remaining) == 1
    assert remaining[0]["open_time"] == 1_700_000_040_000


def test_manual_history_schema_does_not_change_kline_upsert_results(
    monkeypatch, tmp_path
) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    written = klines_repo.upsert_klines(
        "ETHUSDT",
        "5m",
        [_kline_row(1_700_000_000_000), _kline_row(1_700_000_300_000)],
        source="binance",
        exchange="binance",
        market_type="spot",
    )
    assert written == 2
    before = klines_repo.query_klines(
        "ETHUSDT",
        "5m",
        exchange="binance",
        market_type="spot",
    )
    repo = _repo(db_path)
    repo.create_collection_and_job(_native_spec(symbol="ETHUSDT"))
    after = klines_repo.query_klines(
        "ETHUSDT",
        "5m",
        exchange="binance",
        market_type="spot",
    )
    assert [row["open_time"] for row in after] == [row["open_time"] for row in before]
    assert [row["close"] for row in after] == [row["close"] for row in before]


def test_corrupt_job_state_fails_closed_on_read() -> None:
    from app.data_engine.manual_history.models import parse_enum

    with pytest.raises(ManualHistoryError, match="corrupt job.state"):
        parse_enum(JobState, "NOT_A_STATE", field_name="job.state")


def test_schema_rejects_unknown_job_state_on_write(monkeypatch, tmp_path) -> None:
    db_path = _use_temp_db(monkeypatch, tmp_path)
    repo = _repo(db_path)
    created = repo.create_collection_and_job(_native_spec())
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint failed"):
            conn.execute(
                "UPDATE manual_history_jobs SET state = 'NOT_A_STATE' WHERE job_id = ?",
                (created.job.job_id,),
            )
    assert repo.get_job(created.job.job_id).state is JobState.QUEUED
