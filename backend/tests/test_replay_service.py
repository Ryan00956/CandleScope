from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService, SYNTHETIC_TIME_ANCHOR_MS
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


def _command(
    command_id: str,
    command_type: CommandType,
    *,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="browser-tab-1",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


async def _service(path: Path, *, prefix: str = "session") -> ReplayService:
    settings = replay_settings(path)
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    service = ReplayService(
        settings=settings,
        store=store,
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory(prefix),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


async def test_service_create_command_idempotency_fork_and_shutdown(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "replay.db")
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    assert created["protocol"] == REPLAY_PROTOCOL
    assert created["snapshot"]["state"] == SessionState.PAUSED.value

    acquired = await service.command(
        session_id,
        _command("acquire-1", CommandType.ACQUIRE_CONTROLLER, revision=0),
    )
    step = _command("step-1", CommandType.STEP, revision=1, payload={"count": 2})
    stepped = await service.command(session_id, step)
    replayed = await service.command(session_id, step)
    assert acquired["revision"] == 1
    assert stepped == replayed
    assert stepped["cursor"]["source_sequence"] == 2
    noted = await service.command(
        session_id,
        _command(
            "note-1",
            CommandType.ADD_JOURNAL_NOTE,
            revision=2,
            payload={"text": "waited for confirmation"},
        ),
    )
    journal = await service.journal(session_id)
    assert journal["entries"][0]["text"] == "waited for confirmation"

    forked = await service.fork_session(session_id)
    assert forked["forked"] is True
    assert forked["forked_from_session_id"] == session_id
    assert forked["snapshot"]["state_hash"] == noted["state_hash"]
    assert forked["session_id"] != session_id

    tasks = [handle.actor.task for handle in service._sessions.values()]
    await service.shutdown(step_timeout=0.2)
    assert service.store.closed is True
    assert all(task is not None and task.done() for task in tasks)
    with sqlite3.connect(tmp_path / "replay.db") as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM replay_journal_entry WHERE session_id = ?",
                (session_id,),
            ).fetchone()[0]
            == 1
        )


async def test_ended_command_ack_survives_derived_report_persistence_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "report-write-failure.db")
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0),
    )
    end = _command(
        "end-with-report-failure",
        CommandType.END_SESSION,
        revision=1,
        payload={
            "open_order_disposition": "expire",
            "position_disposition": "keep",
        },
    )
    report_attempts = 0

    async def fail_report_write(*_args, **_kwargs) -> None:
        nonlocal report_attempts
        report_attempts += 1
        service.store._degraded_reason = "injected report persistence failure"
        raise ReplayDomainError(
            ReplayErrorCode.PERSISTENCE_DEGRADED,
            "injected report persistence failure",
        )

    monkeypatch.setattr(service.store, "save_report", fail_report_write)
    try:
        ended = await service.command(session_id, end)
        assert ended["state"] == SessionState.ENDED.value
        assert report_attempts == 1
        assert service.capabilities()["available"] is False
        stored = await service.store.get_command(session_id, end.command_id)
        assert stored is not None and stored.accepted is True

        # Reconciliation is a durable read, not a new mutation.  It must return
        # the exact accepted result even while later persistence is sticky
        # degraded, and it must not repeat the derived report side effect.
        replayed = await service.command(session_id, end)
        assert replayed == ended
        assert report_attempts == 1
        assert service.diagnostics()["report_persistence_failures"] == 1

        with pytest.raises(ReplayDomainError) as unavailable:
            await service.command(
                session_id,
                _command(
                    "new-command-after-degraded",
                    CommandType.ACQUIRE_CONTROLLER,
                    revision=int(ended["revision"]),
                ),
            )
        assert unavailable.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    finally:
        service.store._degraded_reason = None
        await service.shutdown(step_timeout=0.2)


async def test_blind_service_redacts_actual_time_until_explicit_reveal(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "replay.db", prefix="blind")
    created = await service.create_session(replay_config(blind_mode=True))
    session_id = str(created["session_id"])
    serialized = json.dumps(created, sort_keys=True)
    assert str(START_MS) not in serialized
    assert str(tmp_path) not in serialized
    assert created["snapshot"]["cursor"]["virtual_time_ms"] == SYNTHETIC_TIME_ANCHOR_MS

    await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0),
    )
    ended = await service.command(
        session_id,
        _command(
            "end",
            CommandType.END_SESSION,
            revision=1,
            payload={
                "open_order_disposition": "expire",
                "position_disposition": "keep",
            },
        ),
    )
    assert ended["state"] == SessionState.ENDED.value
    await service.command(
        session_id,
        _command("acquire-ended", CommandType.ACQUIRE_CONTROLLER, revision=2),
    )
    revealed = await service.command(
        session_id,
        _command("reveal", CommandType.REVEAL_HISTORY, revision=3),
    )
    assert revealed["data"]["actual_history"] == {
        "replay_start_ms": START_MS + 4 * INTERVAL_MS,
        "replay_end_open_ms": START_MS + 8 * INTERVAL_MS,
    }
    await service.shutdown(step_timeout=0.2)


async def test_ended_session_is_reclaimed_after_stream_snapshot_and_remains_recoverable(
    tmp_path: Path,
) -> None:
    path = tmp_path / "ended-reclaim.db"
    settings = replace(replay_settings(path), max_active_sessions=1)
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("ended-reclaim"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    first = await service.create_session(replay_config(blind_mode=True))
    first_id = str(first["session_id"])
    # Regression: subscribing used to leave a PAUSED snapshot in the actor cache.
    # The capacity reaper then missed the later ENDED transition and rejected the
    # next session even though this one was reclaimable.
    await service.subscribe(first_id, after_sequence=None, data_epoch=None)
    acquired = await service.command(
        first_id,
        _command("acquire-first", CommandType.ACQUIRE_CONTROLLER, revision=0),
    )
    await service.command(
        first_id,
        _command(
            "end-first",
            CommandType.END_SESSION,
            revision=acquired["revision"],
            payload={
                "open_order_disposition": "expire",
                "position_disposition": "keep",
            },
        ),
    )
    first_task = service._sessions[first_id].actor.task

    second = await service.create_session(replay_config(blind_mode=True))
    second_id = str(second["session_id"])
    assert first_id not in service._sessions
    assert first_task is not None and first_task.done()
    assert service.diagnostics()["ended_sessions_evicted"] == 1

    acquired_second = await service.command(
        second_id,
        _command("acquire-second", CommandType.ACQUIRE_CONTROLLER, revision=0),
    )
    await service.command(
        second_id,
        _command(
            "end-second",
            CommandType.END_SESSION,
            revision=acquired_second["revision"],
            payload={
                "open_order_disposition": "expire",
                "position_disposition": "keep",
            },
        ),
    )
    restored = await service.get_session(first_id)
    assert restored["snapshot"]["state"] == SessionState.ENDED.value
    assert second_id not in service._sessions
    restored_acquire = await service.command(
        first_id,
        _command(
            "acquire-restored",
            CommandType.ACQUIRE_CONTROLLER,
            revision=restored["snapshot"]["revision"],
        ),
    )
    revealed = await service.command(
        first_id,
        _command(
            "reveal-restored",
            CommandType.REVEAL_HISTORY,
            revision=restored_acquire["revision"],
        ),
    )
    assert revealed["data"]["actual_history"]["replay_start_ms"] == (
        START_MS + 4 * INTERVAL_MS
    )
    await service.shutdown(step_timeout=0.2)


async def test_controller_free_idle_session_ttl_reclaims_and_lazy_recovers(
    tmp_path: Path,
) -> None:
    path = tmp_path / "idle-reclaim.db"
    now = [NOW_MS]
    settings = replace(
        replay_settings(path),
        max_active_sessions=1,
        idle_ttl_seconds=1,
    )
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("idle-reclaim"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    first = await service.create_session(replay_config())
    first_id = str(first["session_id"])
    first_task = service._sessions[first_id].actor.task

    now[0] += 1_001
    for _ in range(20):
        if first_id not in service._sessions:
            break
        await asyncio.sleep(0.05)
    assert first_id not in service._sessions
    second = await service.create_session(replay_config())
    second_id = str(second["session_id"])
    assert first_task is not None and first_task.done()
    assert service.diagnostics()["idle_sessions_evicted"] == 1

    now[0] += 1_001
    restored = await service.get_session(first_id)
    assert restored["snapshot"]["state"] == SessionState.PAUSED.value
    assert second_id not in service._sessions
    await service.shutdown(step_timeout=0.2)


async def test_stale_reaper_snapshot_cannot_evict_a_concurrent_successful_command(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "stale-reaper-snapshot.db"
    now = [NOW_MS]
    settings = replace(
        replay_settings(path),
        max_active_sessions=2,
        idle_ttl_seconds=60,
    )
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("stale-reaper"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    handle = service._sessions[session_id]
    stale_snapshot = await handle.actor.snapshot()
    snapshot_entered = asyncio.Event()
    release_snapshot = asyncio.Event()

    async def snapshot_barrier():
        snapshot_entered.set()
        await release_snapshot.wait()
        return stale_snapshot

    monkeypatch.setattr(handle.actor, "snapshot", snapshot_barrier)
    now[0] += 60_001
    prune_task = asyncio.create_task(service._prune_reclaimable_sessions())
    try:
        await asyncio.wait_for(snapshot_entered.wait(), timeout=1)
        acquired = await asyncio.wait_for(
            service.command(
                session_id,
                _command(
                    "acquire-during-prune",
                    CommandType.ACQUIRE_CONTROLLER,
                    revision=0,
                ),
            ),
            timeout=1,
        )
        assert acquired["revision"] == 1
        release_snapshot.set()
        await asyncio.wait_for(prune_task, timeout=1)
        assert service._sessions[session_id] is handle
        assert handle.actor.task is not None and not handle.actor.task.done()
        assert handle.in_flight == 0
        assert handle.activity_generation >= 2
    finally:
        release_snapshot.set()
        await asyncio.gather(prune_task, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)


async def test_request_waits_for_claimed_eviction_then_recovers_new_actor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "claimed-eviction.db"
    now = [NOW_MS]
    settings = replace(
        replay_settings(path),
        max_active_sessions=1,
        idle_ttl_seconds=60,
    )
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("claimed-eviction"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    old_handle = service._sessions[session_id]
    original_shutdown = old_handle.actor.shutdown
    shutdown_entered = asyncio.Event()
    release_shutdown = asyncio.Event()

    async def shutdown_barrier(*, step_timeout: float = 5.0) -> None:
        shutdown_entered.set()
        await release_shutdown.wait()
        await original_shutdown(step_timeout=step_timeout)

    monkeypatch.setattr(old_handle.actor, "shutdown", shutdown_barrier)
    now[0] += 60_001
    prune_task = asyncio.create_task(service._prune_reclaimable_sessions())
    get_task: asyncio.Task[dict[str, object]] | None = None
    try:
        await asyncio.wait_for(shutdown_entered.wait(), timeout=1)
        assert old_handle.evicting is True
        get_task = asyncio.create_task(service.get_session(session_id))
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(get_task), timeout=0.05)

        release_shutdown.set()
        await asyncio.wait_for(prune_task, timeout=2)
        restored = await asyncio.wait_for(get_task, timeout=2)
        new_handle = service._sessions[session_id]
        assert new_handle is not old_handle
        assert new_handle.actor is not old_handle.actor
        assert restored["snapshot"]["state"] == SessionState.PAUSED.value
        assert old_handle.actor.task is not None and old_handle.actor.task.done()
    finally:
        release_shutdown.set()
        await asyncio.gather(prune_task, return_exceptions=True)
        if get_task is not None and not get_task.done():
            get_task.cancel()
            await asyncio.gather(get_task, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)


async def test_slow_session_creation_reserves_capacity_without_blocking_existing_commands(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "creation-reservation.db"
    settings = replace(replay_settings(path), max_active_sessions=2)
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("creation-reservation"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    existing = await service.create_session(replay_config())
    existing_id = str(existing["session_id"])
    original_build = service._catalog.build
    build_entered = threading.Event()
    release_build = threading.Event()

    def blocked_build(*args, **kwargs):
        build_entered.set()
        if not release_build.wait(timeout=5):
            raise TimeoutError("test catalog barrier timed out")
        return original_build(*args, **kwargs)

    monkeypatch.setattr(service._catalog, "build", blocked_build)
    create_task = asyncio.create_task(service.create_session(replay_config()))
    try:
        entered = await asyncio.to_thread(build_entered.wait, 1)
        assert entered is True
        assert service.diagnostics()["pending_session_reservations"] == 1

        acquired = await asyncio.wait_for(
            service.command(
                existing_id,
                _command(
                    "acquire-while-create-blocked",
                    CommandType.ACQUIRE_CONTROLLER,
                    revision=0,
                ),
            ),
            timeout=1,
        )
        assert acquired["revision"] == 1

        with pytest.raises(ReplayDomainError) as full:
            await asyncio.wait_for(service.create_session(replay_config()), timeout=1)
        assert full.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
    finally:
        release_build.set()
        await asyncio.gather(create_task, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)


async def test_lazy_recovery_is_singleflight_and_does_not_block_resident_commands(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "lazy-recovery-singleflight.db"
    now = [NOW_MS]
    settings = replace(
        replay_settings(path),
        max_active_sessions=2,
        idle_ttl_seconds=60,
    )
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("lazy-recovery"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    target = await service.create_session(replay_config())
    resident = await service.create_session(replay_config())
    target_id = str(target["session_id"])
    resident_id = str(resident["session_id"])
    await service.command(
        resident_id,
        _command(
            "resident-controller",
            CommandType.ACQUIRE_CONTROLLER,
            revision=0,
        ),
    )

    now[0] += 60_001
    await service._prune_reclaimable_sessions()
    assert target_id not in service._sessions
    assert resident_id in service._sessions

    original_recover = service._recover_record
    recovery_entered = asyncio.Event()
    release_recovery = asyncio.Event()
    recovery_calls = 0

    async def blocked_recover(record):
        nonlocal recovery_calls
        recovery_calls += 1
        recovery_entered.set()
        await release_recovery.wait()
        return await original_recover(record)

    monkeypatch.setattr(service, "_recover_record", blocked_recover)
    first = asyncio.create_task(service.get_session(target_id))
    second: asyncio.Task[dict[str, object]] | None = None
    try:
        await asyncio.wait_for(recovery_entered.wait(), timeout=1)
        second = asyncio.create_task(service.get_session(target_id))
        await asyncio.sleep(0)
        assert second.done() is False
        assert recovery_calls == 1

        changed = await asyncio.wait_for(
            service.command(
                resident_id,
                _command(
                    "resident-speed-during-recovery",
                    CommandType.SET_SPEED,
                    revision=1,
                    payload={"speed": 5},
                ),
            ),
            timeout=1,
        )
        assert changed["revision"] == 2

        release_recovery.set()
        restored_first, restored_second = await asyncio.wait_for(
            asyncio.gather(first, second),
            timeout=2,
        )
        assert restored_first["session_id"] == target_id
        assert restored_second["session_id"] == target_id
        assert recovery_calls == 1
        assert service.diagnostics()["pending_session_reservations"] == 0
        assert service._pending_recoveries == {}
    finally:
        release_recovery.set()
        pending = [first]
        if second is not None:
            pending.append(second)
        await asyncio.gather(*pending, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)


async def test_blind_catalog_and_bar_materialization_errors_are_redacted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "blind-data-errors.db", prefix="blind-errors")
    sentinel = "H:\\secret\\bars.db @ 1700000123456"
    original_build = service._catalog.build

    def broken_catalog(*args, **kwargs):
        raise ReplayDomainError(
            ReplayErrorCode.DATA_GAP,
            f"catalog failed at {sentinel}",
            details={"path": sentinel, "actual_open_time_ms": 1_700_000_123_456},
        )

    monkeypatch.setattr(service._catalog, "build", broken_catalog)
    with pytest.raises(ReplayDomainError) as catalog_failure:
        await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=True,
        )
    assert catalog_failure.value.message == "blind replay dataset validation failed"
    assert dict(catalog_failure.value.details) == {"blind_redacted": True}
    assert sentinel not in json.dumps({
        "message": catalog_failure.value.message,
        "details": dict(catalog_failure.value.details),
    })

    monkeypatch.setattr(service._catalog, "build", original_build)

    def broken_materialization(*args, **kwargs):
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            f"expected {sentinel}",
            details={"gap": sentinel, "last_closed_open_ms": 1_700_000_123_456},
        )

    monkeypatch.setattr(service._dataset_builder, "create", broken_materialization)
    with pytest.raises(ReplayDomainError) as create_failure:
        await service.create_session(replay_config(blind_mode=True))
    assert create_failure.value.message == "blind replay dataset validation failed"
    assert dict(create_failure.value.details) == {"blind_redacted": True}
    assert sentinel not in json.dumps({
        "message": create_failure.value.message,
        "details": dict(create_failure.value.details),
    })
    assert service.diagnostics()["pending_session_reservations"] == 0
    await service.shutdown(step_timeout=0.2)


async def test_startup_defers_healthy_sessions_over_capacity_for_lazy_recovery(
    tmp_path: Path,
) -> None:
    path = tmp_path / "startup-capacity.db"
    seed_settings = replace(replay_settings(path), max_active_sessions=2)
    seed = ReplayService(
        settings=seed_settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("startup-capacity"),
        native_intervals=lambda _identity: ("1m",),
    )
    await seed.start()
    first = await seed.create_session(replay_config())
    second = await seed.create_session(replay_config())
    session_ids = {str(first["session_id"]), str(second["session_id"])}
    await seed.shutdown(step_timeout=0.2)

    now = [NOW_MS]
    service = ReplayService(
        settings=replace(
            replay_settings(path),
            max_active_sessions=1,
            idle_ttl_seconds=60,
        ),
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("unused"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        assert len(service._sessions) == 1
        assert service.diagnostics()["startup_recoveries_deferred"] == 1
        resident_id = next(iter(service._sessions))
        deferred_id = next(iter(session_ids - {resident_id}))
        assert deferred_id not in service._unavailable_sessions
        deferred_record = await service.store.get_session(deferred_id)
        assert deferred_record is not None
        assert deferred_record["degraded_reason"] is None

        now[0] += 60_001
        await service._prune_reclaimable_sessions()
        assert resident_id not in service._sessions
        restored = await service.get_session(deferred_id)
        assert restored["session_id"] == deferred_id
        assert restored["snapshot"]["state"] == SessionState.PAUSED.value
        assert service._sessions[deferred_id].in_flight == 0
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_cancelled_lazy_recovery_owner_releases_claim_and_handle_lease(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "cancelled-recovery-owner.db"
    now = [NOW_MS]
    service = ReplayService(
        settings=replace(
            replay_settings(path),
            max_active_sessions=1,
            idle_ttl_seconds=60,
        ),
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("cancelled-owner"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    now[0] += 60_001
    await service._prune_reclaimable_sessions()
    assert session_id not in service._sessions

    original_recover = service._recover_record
    recovery_published = asyncio.Event()
    lifecycle_wait_entered = asyncio.Event()
    release_lifecycle_wait = asyncio.Event()

    async def observed_recover(record):
        handle = await original_recover(record)
        recovery_published.set()
        return handle

    class LifecycleLockProbe:
        def __init__(self, lock: asyncio.Lock) -> None:
            self._lock = lock
            self._gated = False

        async def __aenter__(self):
            if recovery_published.is_set() and not self._gated:
                self._gated = True
                lifecycle_wait_entered.set()
                await release_lifecycle_wait.wait()
            await self._lock.acquire()

        async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
            self._lock.release()

    monkeypatch.setattr(service, "_recover_record", observed_recover)
    monkeypatch.setattr(
        service,
        "_lifecycle_lock",
        LifecycleLockProbe(service._lifecycle_lock),
    )
    owner = asyncio.create_task(service.get_session(session_id))
    try:
        await asyncio.wait_for(lifecycle_wait_entered.wait(), timeout=2)
        assert session_id in service._sessions
        owner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await owner

        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert service._sessions[session_id].in_flight == 0

        waiter = await asyncio.wait_for(service.get_session(session_id), timeout=2)
        assert waiter["session_id"] == session_id
        assert service._sessions[session_id].in_flight == 0
    finally:
        release_lifecycle_wait.set()
        if not owner.done():
            owner.cancel()
            await asyncio.gather(owner, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)


async def test_blind_internal_failures_and_capabilities_never_disclose_sentinel(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "blind-internal-errors.db"
    now = [NOW_MS]
    service = ReplayService(
        settings=replace(
            replay_settings(path),
            max_active_sessions=3,
            idle_ttl_seconds=60,
        ),
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("blind-internal"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    sentinel = "H:\\private\\replay.db @ 1700000123456"

    service.store._degraded_reason = sentinel
    capabilities = service.capabilities()
    assert capabilities["available"] is False
    assert capabilities["persistence"]["degraded_reason"] == (
        ReplayErrorCode.PERSISTENCE_DEGRADED.value
    )
    assert sentinel not in json.dumps(capabilities, sort_keys=True)
    service.store._degraded_reason = None

    lazy = await service.create_session(replay_config(blind_mode=True))
    lazy_id = str(lazy["session_id"])
    now[0] += 60_001
    await service._prune_reclaimable_sessions()
    assert lazy_id not in service._sessions
    original_recover = service._recover_record

    async def broken_recover(_record):
        raise RuntimeError(sentinel)

    monkeypatch.setattr(service, "_recover_record", broken_recover)
    with pytest.raises(ReplayDomainError) as lazy_failure:
        await service.get_session(lazy_id)
    assert lazy_failure.value.message == "blind replay internal operation failed"
    assert dict(lazy_failure.value.details) == {"blind_redacted": True}
    assert sentinel not in json.dumps(
        {
            "message": lazy_failure.value.message,
            "details": dict(lazy_failure.value.details),
        },
        sort_keys=True,
    )
    assert service.diagnostics()["pending_session_reservations"] == 0
    assert service.diagnostics()["pending_handle_acquisitions"] == 0
    assert service.diagnostics()["pending_recoveries"] == ()
    monkeypatch.setattr(service, "_recover_record", original_recover)

    fork_source = await service.create_session(replay_config(blind_mode=True))
    fork_source_id = str(fork_source["session_id"])

    async def broken_fork_create(**_kwargs):
        raise RuntimeError(sentinel)

    monkeypatch.setattr(service, "_create_from_dataset", broken_fork_create)
    with pytest.raises(ReplayDomainError) as fork_failure:
        await service.fork_session(fork_source_id)
    assert fork_failure.value.message == "blind replay dataset validation failed"
    assert dict(fork_failure.value.details) == {"blind_redacted": True}
    assert sentinel not in json.dumps(
        {
            "message": fork_failure.value.message,
            "details": dict(fork_failure.value.details),
        },
        sort_keys=True,
    )
    assert service.diagnostics()["pending_session_reservations"] == 0
    assert service.diagnostics()["pending_handle_acquisitions"] == 0
    assert service._sessions[fork_source_id].in_flight == 0

    await service.shutdown(step_timeout=0.2)
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE replay_session SET degraded_reason = ? WHERE session_id = ?",
            (sentinel, fork_source_id),
        )

    restarted = ReplayService(
        settings=replace(replay_settings(path), max_active_sessions=3),
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("unused-blind"),
        native_intervals=lambda _identity: ("1m",),
    )
    await restarted.start()
    try:
        with pytest.raises(ReplayDomainError) as persisted_failure:
            await restarted.get_session(fork_source_id)
        assert persisted_failure.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
        assert persisted_failure.value.message == (
            "blind replay internal operation failed"
        )
        assert dict(persisted_failure.value.details) == {"blind_redacted": True}
        assert sentinel not in json.dumps(
            {
                "message": persisted_failure.value.message,
                "details": dict(persisted_failure.value.details),
            },
            sort_keys=True,
        )
    finally:
        await restarted.shutdown(step_timeout=0.2)
