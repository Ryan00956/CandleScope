from __future__ import annotations

import asyncio
import sqlite3
import threading
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from app.replay.runtime import ReplayRuntime, ReplayStartupError, start_replay_runtime
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import (
    NOW_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)
from tests.fixtures.replay.trade_service_fakes import (
    TRADE_NOW_MS,
    trade_replay_config,
    trade_replay_repository,
    verified_trade_archive,
)


pytestmark = pytest.mark.anyio


def _command(
    command_id: str, command_type: CommandType, revision: int
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="browser-tab-1",
        expected_revision=revision,
        type=command_type,
        payload={"count": 1} if command_type is CommandType.STEP else {},
    )


async def _service(path: Path) -> ReplayService:
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    service = ReplayService(
        settings=replay_settings(path),
        store=store,
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory(),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


async def test_disabled_runtime_opens_no_database_and_starts_no_replay_task(
    tmp_path: Path,
) -> None:
    path = tmp_path / "disabled.db"
    called = False

    def forbidden_store(_path: str) -> ReplaySQLiteStore:
        nonlocal called
        called = True
        raise AssertionError("disabled replay must not construct a store")

    before = {task.get_name() for task in asyncio.all_tasks()}
    runtime = await start_replay_runtime(
        replay_settings(path, enabled=False),
        store_factory=forbidden_store,
    )
    after = {task.get_name() for task in asyncio.all_tasks()}
    assert runtime.service is None
    assert called is False
    assert not path.exists()
    assert not any(name.startswith("replay-actor-") for name in after - before)
    await runtime.shutdown()


async def test_enabled_runtime_start_failure_closes_store_and_fails_startup(
    tmp_path: Path,
) -> None:
    path = tmp_path / "failed.db"
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)

    def service_failure(**_kwargs):
        raise RuntimeError("injected service construction failure")

    with pytest.raises(ReplayStartupError):
        await start_replay_runtime(
            replay_settings(path),
            store_factory=lambda _path: store,
            service_factory=service_failure,
        )
    assert store.closed is True


async def test_cancelled_runtime_store_factory_closes_late_open_handle(
    tmp_path: Path,
) -> None:
    path = tmp_path / "cancelled-store-open.db"
    opened = threading.Event()
    release_factory = threading.Event()
    stores: list[ReplaySQLiteStore] = []

    def blocked_factory(raw_path: str) -> ReplaySQLiteStore:
        store = ReplaySQLiteStore(raw_path, now_ms=lambda: NOW_MS)
        stores.append(store)
        opened.set()
        if not release_factory.wait(timeout=5):
            raise TimeoutError("test store factory barrier timed out")
        return store

    startup = asyncio.create_task(
        start_replay_runtime(
            replay_settings(path),
            store_factory=blocked_factory,
        )
    )
    try:
        assert await asyncio.to_thread(opened.wait, 2) is True
        startup.cancel()
        await asyncio.sleep(0)
        startup.cancel()
        release_factory.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(startup, timeout=2)

        assert len(stores) == 1
        assert stores[0].closed is True
    finally:
        release_factory.set()
        if not startup.done():
            startup.cancel()
        await asyncio.gather(startup, return_exceptions=True)
        for store in stores:
            if not store.closed:
                await store.close()


async def test_cancelled_runtime_partial_start_shuts_recovered_actor_and_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "cancelled-partial-start.db"
    seed = await _service(path)
    created = await seed.create_session(replay_config())
    session_id = str(created["session_id"])
    await seed.shutdown(step_timeout=0.2)

    recovery_published = asyncio.Event()
    services: list[ReplayService] = []

    def service_factory(**kwargs) -> ReplayService:
        service = ReplayService(
            **kwargs,
            repository=replay_repository(),
            now_ms=lambda: NOW_MS,
            session_id_factory=SessionIdFactory("unused-partial-start"),
            native_intervals=lambda _identity: ("1m",),
        )
        original_recover = service._recover_record

        async def blocked_after_publish(record):
            handle = await original_recover(record)
            recovery_published.set()
            await asyncio.Event().wait()
            return handle

        monkeypatch.setattr(service, "_recover_record", blocked_after_publish)
        services.append(service)
        return service

    startup = asyncio.create_task(
        start_replay_runtime(
            replay_settings(path),
            service_factory=service_factory,
        )
    )
    try:
        await asyncio.wait_for(recovery_published.wait(), timeout=2)
        assert len(services) == 1
        service = services[0]
        handle = service._sessions[session_id]
        startup.cancel()
        await asyncio.sleep(0)
        startup.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(startup, timeout=2)

        assert handle.actor.task is not None and handle.actor.task.done()
        assert service.store.closed is True
        assert service.diagnostics()["dataset_pins"]["active_sessions"] == 0
    finally:
        if not startup.done():
            startup.cancel()
        await asyncio.gather(startup, return_exceptions=True)
        for service in services:
            if not service.store.closed:
                await service.shutdown(step_timeout=0.2)


async def test_cancelled_runtime_shutdown_finishes_owned_service_cleanup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "cancelled-runtime-shutdown.db"
    service = await _service(path)
    created = await service.create_session(replay_config())
    actor = service._sessions[str(created["session_id"])].actor
    runtime = ReplayRuntime(settings=replay_settings(path), service=service)
    original_shutdown = service.shutdown
    shutdown_entered = asyncio.Event()
    release_shutdown = asyncio.Event()

    async def blocked_shutdown(*, step_timeout: float = 5.0) -> None:
        shutdown_entered.set()
        await release_shutdown.wait()
        await original_shutdown(step_timeout=step_timeout)

    monkeypatch.setattr(service, "shutdown", blocked_shutdown)
    shutdown = asyncio.create_task(runtime.shutdown(step_timeout=0.2))
    try:
        await asyncio.wait_for(shutdown_entered.wait(), timeout=1)
        shutdown.cancel()
        await asyncio.sleep(0)
        shutdown.cancel()
        assert shutdown.done() is False
        release_shutdown.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(shutdown, timeout=2)

        assert runtime.service is None
        assert service.store.closed is True
        assert actor.task is not None and actor.task.done()
    finally:
        release_shutdown.set()
        if not shutdown.done():
            shutdown.cancel()
        await asyncio.gather(shutdown, return_exceptions=True)
        if not service.store.closed:
            await original_shutdown(step_timeout=0.2)


async def test_persistence_failure_rolls_back_event_and_stops_further_playback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "replay.db")
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    original = service.store.commit_command

    async def fail_commit(**_kwargs):
        service.store._degraded_reason = "injected durable write failure"
        raise ReplayDomainError(
            ReplayErrorCode.PERSISTENCE_DEGRADED,
            "injected durable write failure",
        )

    monkeypatch.setattr(service.store, "commit_command", fail_commit)
    with pytest.raises(ReplayDomainError) as failed:
        await service.command(session_id, _command("step", CommandType.STEP, 1))
    assert failed.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    snapshot = (await service.get_session(session_id))["snapshot"]
    assert snapshot["state"] == SessionState.PAUSED.value
    assert snapshot["cursor"]["source_sequence"] == 0
    assert snapshot["degraded_reason"] is not None
    assert service.capabilities()["available"] is False

    with pytest.raises(ReplayDomainError) as sticky:
        await service.command(session_id, _command("step-2", CommandType.STEP, 1))
    assert sticky.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED

    monkeypatch.setattr(service.store, "commit_command", original)
    service.store._degraded_reason = None
    await service.shutdown(step_timeout=0.2)


async def test_shutdown_finishes_actor_barriers_before_closing_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "replay.db")
    await service.create_session(replay_config())
    actors = [handle.actor for handle in service._sessions.values()]
    original_close = service.store.close
    close_observation: list[bool] = []

    async def observed_close() -> None:
        close_observation.append(
            all(actor.task is not None and actor.task.done() for actor in actors)
        )
        await original_close()

    monkeypatch.setattr(service.store, "close", observed_close)
    await service.shutdown(step_timeout=0.2)
    assert close_observation == [True]
    assert all(actor.task is not None and actor.task.done() for actor in actors)


@pytest.mark.parametrize("operation", ["create", "fork"])
async def test_shutdown_drains_durable_create_before_registration_without_orphan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    path = tmp_path / f"shutdown-{operation}-registration.db"
    service = ReplayService(
        settings=replace(replay_settings(path), max_active_sessions=2),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory(f"shutdown-{operation}"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    source_id: str | None = None
    if operation == "fork":
        source = await service.create_session(replay_config())
        source_id = str(source["session_id"])

    original_create = service.store.create_session
    durable_row_written = asyncio.Event()
    release_registration = asyncio.Event()

    async def blocked_create(**kwargs) -> None:
        await original_create(**kwargs)
        durable_row_written.set()
        await release_registration.wait()

    monkeypatch.setattr(service.store, "create_session", blocked_create)
    operation_task = asyncio.create_task(
        service.create_session(replay_config())
        if source_id is None
        else service.fork_session(source_id)
    )
    shutdown_task: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(durable_row_written.wait(), timeout=2)
        assert service.diagnostics()["pending_session_reservations"] == 1
        shutdown_task = asyncio.create_task(service.shutdown(step_timeout=0.2))
        for _ in range(20):
            if service.diagnostics()["accepting"] is False:
                break
            await asyncio.sleep(0)
        assert service.diagnostics()["accepting"] is False
        assert shutdown_task.done() is False
        assert service.store.closed is False

        release_registration.set()
        result = await asyncio.wait_for(operation_task, timeout=3)
        returned_id = str(result["session_id"])
        assert returned_id
        await asyncio.wait_for(shutdown_task, timeout=3)

        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert service.store.closed is True
        with sqlite3.connect(path) as connection:
            persisted_ids = {
                row[0]
                for row in connection.execute(
                    "SELECT session_id FROM replay_session ORDER BY session_id"
                )
            }
        assert persisted_ids == ({returned_id} | ({source_id} if source_id else set()))
    finally:
        release_registration.set()
        await asyncio.gather(operation_task, return_exceptions=True)
        if shutdown_task is not None:
            await asyncio.gather(shutdown_task, return_exceptions=True)
        if not service.store.closed:
            await service.shutdown(step_timeout=0.2)


@pytest.mark.parametrize("operation", ["create", "fork"])
async def test_cancelled_create_after_durable_commit_is_compensated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    path = tmp_path / f"cancel-{operation}-registration.db"
    service = ReplayService(
        settings=replace(replay_settings(path), max_active_sessions=2),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory(f"cancel-{operation}"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    source_id: str | None = None
    if operation == "fork":
        source = await service.create_session(replay_config())
        source_id = str(source["session_id"])

    original_create = service.store.create_session
    durable_row_written = asyncio.Event()
    release_persist_call = asyncio.Event()

    async def blocked_create(**kwargs) -> None:
        await original_create(**kwargs)
        durable_row_written.set()
        await release_persist_call.wait()

    monkeypatch.setattr(service.store, "create_session", blocked_create)
    operation_task = asyncio.create_task(
        service.create_session(replay_config())
        if source_id is None
        else service.fork_session(source_id)
    )
    try:
        await asyncio.wait_for(durable_row_written.wait(), timeout=2)
        operation_task.cancel()
        release_persist_call.set()
        with pytest.raises(asyncio.CancelledError):
            await operation_task

        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert set(service._sessions) == ({source_id} if source_id else set())
        with sqlite3.connect(path) as connection:
            persisted_ids = {
                row[0]
                for row in connection.execute(
                    "SELECT session_id FROM replay_session ORDER BY session_id"
                )
            }
        assert persisted_ids == ({source_id} if source_id else set())
    finally:
        release_persist_call.set()
        if not operation_task.done():
            operation_task.cancel()
        await asyncio.gather(operation_task, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)


async def test_cancelled_trade_create_releases_pin_returned_by_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "cancelled-trade-pin-create.db"
    archive = verified_trade_archive(tmp_path / "create-archive")
    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: TRADE_NOW_MS),
        repository=trade_replay_repository(),
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("cancelled-trade-pin-create"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    original_pin = archive.pin_dataset
    pin_entered = threading.Event()
    release_pin = threading.Event()

    def blocked_after_pin(dataset_ref) -> str:
        token = original_pin(dataset_ref)
        pin_entered.set()
        if not release_pin.wait(timeout=5):
            raise TimeoutError("test trade pin barrier timed out")
        return token

    monkeypatch.setattr(archive, "pin_dataset", blocked_after_pin)
    create = asyncio.create_task(service.create_session(trade_replay_config()))
    try:
        assert await asyncio.to_thread(pin_entered.wait, 3) is True
        assert len(archive._pins) == 1
        create.cancel()
        await asyncio.sleep(0)
        create.cancel()
        release_pin.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(create, timeout=2)

        assert archive._pins == {}
        diagnostics = service.diagnostics()
        assert diagnostics["dataset_pins"]["active_sessions"] == 0
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_lifecycle_owners"] == 0
        assert service._sessions == {}
    finally:
        release_pin.set()
        if not create.done():
            create.cancel()
        await asyncio.gather(create, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)
        assert archive._pins == {}


async def test_cancelled_lazy_trade_recovery_releases_pin_returned_by_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "cancelled-trade-pin-recovery.db"
    archive = verified_trade_archive(tmp_path / "recovery-archive")
    now = [TRADE_NOW_MS]
    service = ReplayService(
        settings=replace(
            replay_settings(path),
            max_active_sessions=1,
            idle_ttl_seconds=1,
        ),
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=trade_replay_repository(),
        raw_trade_archive=archive,
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("cancelled-trade-pin-recovery"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    created = await service.create_session(trade_replay_config())
    session_id = str(created["session_id"])
    now[0] += 1_001
    await service._prune_reclaimable_sessions()
    assert session_id not in service._sessions
    assert archive._pins == {}

    original_pin = archive.pin_dataset
    pin_entered = threading.Event()
    release_pin = threading.Event()

    def blocked_after_pin(dataset_ref) -> str:
        token = original_pin(dataset_ref)
        pin_entered.set()
        if not release_pin.wait(timeout=5):
            raise TimeoutError("test recovery pin barrier timed out")
        return token

    monkeypatch.setattr(archive, "pin_dataset", blocked_after_pin)
    recovery = asyncio.create_task(service.get_session(session_id))
    try:
        assert await asyncio.to_thread(pin_entered.wait, 3) is True
        assert len(archive._pins) == 1
        recovery.cancel()
        await asyncio.sleep(0)
        recovery.cancel()
        release_pin.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(recovery, timeout=2)

        assert archive._pins == {}
        diagnostics = service.diagnostics()
        assert diagnostics["dataset_pins"]["active_sessions"] == 0
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert diagnostics["pending_lifecycle_owners"] == 0
        assert session_id not in service._sessions
    finally:
        release_pin.set()
        if not recovery.done():
            recovery.cancel()
        await asyncio.gather(recovery, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)
        assert archive._pins == {}


async def test_shutdown_aborts_prune_snapshot_barrier(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "shutdown-prune-barrier.db")
    created = await service.create_session(replay_config())
    handle = service._sessions[str(created["session_id"])]
    snapshot_entered = asyncio.Event()
    snapshot_cancelled = asyncio.Event()

    async def blocked_snapshot():
        snapshot_entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            snapshot_cancelled.set()

    monkeypatch.setattr(handle.actor, "snapshot", blocked_snapshot)
    prune_task = asyncio.create_task(service._prune_reclaimable_sessions())
    try:
        await asyncio.wait_for(snapshot_entered.wait(), timeout=1)
        await asyncio.wait_for(service.shutdown(step_timeout=0.1), timeout=1)
        await asyncio.wait_for(prune_task, timeout=1)
        assert snapshot_cancelled.is_set()
        assert service.store.closed is True
        assert handle.actor.task is not None and handle.actor.task.done()
    finally:
        if not prune_task.done():
            prune_task.cancel()
        await asyncio.gather(prune_task, return_exceptions=True)
        if not service.store.closed:
            await service.shutdown(step_timeout=0.1)


async def test_shutdown_stops_actor_then_cancels_blocked_resident_lease(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "shutdown-blocked-lease.db")
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    handle = service._sessions[session_id]
    public_snapshot_entered = asyncio.Event()
    public_snapshot_cancelled = asyncio.Event()

    async def blocked_public_snapshot():
        public_snapshot_entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            public_snapshot_cancelled.set()

    monkeypatch.setattr(handle.actor, "public_snapshot", blocked_public_snapshot)
    get_task = asyncio.create_task(service.get_session(session_id))
    try:
        await asyncio.wait_for(public_snapshot_entered.wait(), timeout=1)
        assert handle.in_flight == 1
        await asyncio.wait_for(service.shutdown(step_timeout=0.1), timeout=1)
        assert public_snapshot_cancelled.is_set()
        assert get_task.cancelled()
        assert handle.in_flight == 0
        diagnostics = service.diagnostics()
        assert diagnostics["active_lease_owners"] == 0
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert service.store.closed is True
    finally:
        if not get_task.done():
            get_task.cancel()
        await asyncio.gather(get_task, return_exceptions=True)
        if not service.store.closed:
            await service.shutdown(step_timeout=0.1)


async def test_shutdown_cancels_blocked_pre_persist_create_reservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "shutdown-pre-persist-create.db"
    service = await _service(path)
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
        assert await asyncio.to_thread(build_entered.wait, 1) is True
        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 1
        assert diagnostics["pending_lifecycle_owners"] == 1

        await asyncio.wait_for(service.shutdown(step_timeout=0.1), timeout=1)
        assert create_task.cancelled()
        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert diagnostics["pending_lifecycle_owners"] == 0
        assert service.store.closed is True
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_session"
            ).fetchone()[0] == 0
    finally:
        release_build.set()
        if not create_task.done():
            create_task.cancel()
        await asyncio.gather(create_task, return_exceptions=True)
        if not service.store.closed:
            await service.shutdown(step_timeout=0.1)


async def test_shutdown_cancels_lazy_recovery_bootstrap_without_actor_leak(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "shutdown-recovery-bootstrap.db"
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
        session_id_factory=SessionIdFactory("shutdown-recovery"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    now[0] += 60_001
    await service._prune_reclaimable_sessions()
    assert session_id not in service._sessions

    original_actor_factory = service._actor
    bootstrap_entered = asyncio.Event()
    bootstrap_cancelled = asyncio.Event()
    candidate_shutdown = asyncio.Event()
    candidates = []

    def observed_actor_factory(**kwargs):
        candidate = original_actor_factory(**kwargs)
        candidates.append(candidate)
        original_start = candidate.start
        original_shutdown = candidate.shutdown

        async def blocked_start() -> None:
            await original_start()
            bootstrap_entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                bootstrap_cancelled.set()

        async def observed_shutdown(*, step_timeout: float = 5.0) -> None:
            try:
                await original_shutdown(step_timeout=step_timeout)
            finally:
                candidate_shutdown.set()

        monkeypatch.setattr(candidate, "start", blocked_start)
        monkeypatch.setattr(candidate, "shutdown", observed_shutdown)
        return candidate

    monkeypatch.setattr(service, "_actor", observed_actor_factory)
    get_task = asyncio.create_task(service.get_session(session_id))
    try:
        await asyncio.wait_for(bootstrap_entered.wait(), timeout=2)
        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 1
        assert diagnostics["pending_handle_acquisitions"] == 1
        assert diagnostics["pending_recoveries"] == (session_id,)
        assert diagnostics["pending_lifecycle_owners"] == 1

        await asyncio.wait_for(service.shutdown(step_timeout=0.2), timeout=2)
        assert get_task.cancelled()
        assert bootstrap_cancelled.is_set()
        assert candidate_shutdown.is_set()
        assert len(candidates) == 1
        assert candidates[0].task is not None and candidates[0].task.done()
        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert diagnostics["pending_lifecycle_owners"] == 0
        assert service.store.closed is True
    finally:
        if not get_task.done():
            get_task.cancel()
        await asyncio.gather(get_task, return_exceptions=True)
        if not service.store.closed:
            await service.shutdown(step_timeout=0.2)


async def test_client_and_shutdown_double_cancel_compensates_real_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "double-cancel-create.db"
    service = await _service(path)
    original_actor_factory = service._actor
    created_actors = []

    def observed_actor_factory(**kwargs):
        actor = original_actor_factory(**kwargs)
        created_actors.append(actor)
        return actor

    original_create = service.store.create_session
    durable_row_written = asyncio.Event()
    release_persist_call = asyncio.Event()

    async def blocked_after_commit(**kwargs) -> None:
        await original_create(**kwargs)
        durable_row_written.set()
        await release_persist_call.wait()

    monkeypatch.setattr(service, "_actor", observed_actor_factory)
    monkeypatch.setattr(service.store, "create_session", blocked_after_commit)
    create_task = asyncio.create_task(service.create_session(replay_config()))
    shutdown_task: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(durable_row_written.wait(), timeout=2)
        create_task.cancel()
        await asyncio.sleep(0)
        shutdown_task = asyncio.create_task(service.shutdown(step_timeout=0.25))
        for _ in range(100):
            if create_task.cancelling() >= 2:
                break
            await asyncio.sleep(0.005)
        assert create_task.cancelling() >= 2

        release_persist_call.set()
        with pytest.raises(asyncio.CancelledError):
            await create_task
        await asyncio.wait_for(shutdown_task, timeout=2)

        assert len(created_actors) == 1
        assert created_actors[0].task is not None
        assert created_actors[0].task.done()
        diagnostics = service.diagnostics()
        assert diagnostics["pending_session_reservations"] == 0
        assert diagnostics["pending_handle_acquisitions"] == 0
        assert diagnostics["pending_recoveries"] == ()
        assert diagnostics["pending_lifecycle_owners"] == 0
        assert service.store.closed is True
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_session"
            ).fetchone()[0] == 0
    finally:
        release_persist_call.set()
        if not create_task.done():
            create_task.cancel()
        await asyncio.gather(create_task, return_exceptions=True)
        if shutdown_task is not None:
            await asyncio.gather(shutdown_task, return_exceptions=True)
        if not service.store.closed:
            await service.shutdown(step_timeout=0.2)


async def test_startup_recovery_cancellation_propagates_without_degrading_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "cancel-startup-recovery.db"
    seed = await _service(path)
    created = await seed.create_session(replay_config())
    session_id = str(created["session_id"])
    await seed.shutdown(step_timeout=0.2)

    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("unused-startup"),
        native_intervals=lambda _identity: ("1m",),
    )
    original_actor_factory = service._actor
    bootstrap_entered = asyncio.Event()
    bootstrap_cancelled = asyncio.Event()
    candidate_shutdown = asyncio.Event()
    candidates = []

    def observed_actor_factory(**kwargs):
        candidate = original_actor_factory(**kwargs)
        candidates.append(candidate)
        original_start = candidate.start
        original_shutdown = candidate.shutdown

        async def blocked_start() -> None:
            await original_start()
            bootstrap_entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                bootstrap_cancelled.set()

        async def observed_shutdown(*, step_timeout: float = 5.0) -> None:
            try:
                await original_shutdown(step_timeout=step_timeout)
            finally:
                candidate_shutdown.set()

        monkeypatch.setattr(candidate, "start", blocked_start)
        monkeypatch.setattr(candidate, "shutdown", observed_shutdown)
        return candidate

    monkeypatch.setattr(service, "_actor", observed_actor_factory)
    start_task = asyncio.create_task(service.start())
    try:
        await asyncio.wait_for(bootstrap_entered.wait(), timeout=2)
        start_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await start_task

        assert bootstrap_cancelled.is_set()
        assert candidate_shutdown.is_set()
        assert len(candidates) == 1
        assert candidates[0].task is not None and candidates[0].task.done()
        assert service._sessions == {}
        assert service._reaper_task is None
        record = await service.store.get_session(session_id)
        assert record is not None
        assert record["degraded_reason"] is None
        assert session_id not in service._unavailable_sessions
    finally:
        if not start_task.done():
            start_task.cancel()
        await asyncio.gather(start_task, return_exceptions=True)
        await service.shutdown(step_timeout=0.2)
