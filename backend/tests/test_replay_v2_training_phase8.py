from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.actor import ReplaySessionActor
from app.replay.constants import REPLAY_PROTOCOL, CommandType, ReplayEventType
from app.replay.internal_commands import InternalCommandType
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService
from app.replay.training.errors import TrainingRunError
from app.replay.training.fast_forward import FastForwardContext, FastForwardPlanner
from app.replay.training.models import FastForwardPlan, ReplaySource, ReplayV2CommandType
from app.replay.training.trade_flow import ReplayTradeFlowAdapter
from tests.fixtures.replay.service_fakes import INTERVAL_MS
from tests.fixtures.replay.actor_fakes import (
    CountingReducer,
    FixtureEvent,
    event_fixture,
    session_config,
    source_factory,
)
from tests.test_replay_v2_training_phase5 import (
    _acquire,
    _command,
    _place_limit,
    _trade_request,
    _trade_service,
)


pytestmark = pytest.mark.anyio


def _context(**overrides: object) -> FastForwardContext:
    values: dict[str, object] = {
        "source_kind": ReplaySource.AGG_TRADE,
        "current_virtual_time_ms": 1_000,
        "target_virtual_time_ms": 61_000,
        "dataset_epoch": "sha256:" + "1" * 64,
        "optimization_enabled": True,
        "chunk_event_limit": 512,
        "tail_event_count": 32,
    }
    values.update(overrides)
    return FastForwardContext(**values)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("context", "expected", "reason"),
    (
        (_context(), FastForwardPlan.AGGREGATE_SCAN, "NO_PATH_DEPENDENCIES"),
        (
            _context(path_dependencies=("OPEN_POSITION",)),
            FastForwardPlan.FULL_EVENT_SCAN,
            "OPEN_POSITION",
        ),
        (
            _context(blocking_reasons=("TRACK_DEGRADED",)),
            FastForwardPlan.BLOCKED,
            "TRACK_DEGRADED",
        ),
        (
            _context(
                checkpoint_identity_match=True,
                checkpoint_state_hash="sha256:" + "2" * 64,
            ),
            FastForwardPlan.CHECKPOINT_JUMP,
            "EXACT_CHECKPOINT_IDENTITY",
        ),
        (
            _context(optimization_enabled=False, tail_event_count=0),
            FastForwardPlan.FULL_EVENT_SCAN,
            "OPTIMIZATION_DISABLED",
        ),
    ),
)
def test_fast_forward_planner_four_modes_are_explainable(
    context: FastForwardContext,
    expected: FastForwardPlan,
    reason: str,
) -> None:
    payload = FastForwardPlanner().plan(context).to_dict()
    assert payload["plan"] == expected.value
    assert payload["mode"] == expected.value
    assert reason in payload["reason_codes"]
    assert payload["explanation"]
    assert payload["streaming"] == {
        "page_bounded": True,
        "resident_pages": 1,
        "prefetch_pages": 1,
        "backpressure": "ACTOR_ACK_BOUNDARY",
        "full_history_materialization": False,
    }
    assert payload["equivalence"]["reference_plan"] == "FULL_EVENT_SCAN"  # type: ignore[index]
    assert payload["equivalence"]["proof"] == (  # type: ignore[index]
        "CURSOR_SOURCE_EVENT_CHAIN_COMPONENT_STATE_HASH"
    )


async def test_projection_coalescing_preserves_source_chain_and_component_hash() -> None:
    events = event_fixture(count=128, step_ms=10)

    async def run(
        *,
        session_id: str,
        command_type: CommandType | InternalCommandType,
        payload: dict[str, object],
    ) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
        reducer = CountingReducer()
        actor = ReplaySessionActor(
            session_id=session_id,
            config=session_config(),
            source_factory=source_factory(events),
            initial_virtual_time_ms=1_000,
            command_queue_size=8,
            event_buffer_size=128,
            max_emit_fps=30,
            controller_ttl_seconds=60,
            checkpoint_event_interval=10_000,
            checkpoint_virtual_ms=300_000,
            reducer=reducer,
        )
        await actor.start()
        try:
            acquired = await actor.submit(
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=f"{session_id}-acquire",
                    client_instance_id="phase8-client",
                    expected_revision=0,
                    type=CommandType.ACQUIRE_CONTROLLER,
                    payload={},
                )
            )
            result = await actor.submit(
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=f"{session_id}-advance",
                    client_instance_id="phase8-client",
                    expected_revision=acquired.revision,
                    type=command_type,
                    payload=payload,
                )
            )
            snapshot = (await actor.snapshot()).to_dict()
            return snapshot, dict(reducer.snapshot()), dict(result.data)
        finally:
            await actor.shutdown(step_timeout=1.0)

    optimized, reference = await asyncio.gather(
        run(
            session_id="phase8-optimized",
            command_type=InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT,
            payload={"count": 128, "tail_events": 32},
        ),
        run(
            session_id="phase8-reference",
            command_type=CommandType.STEP,
            payload={"count": 128},
        ),
    )
    assert optimized[2]["coalesced_projection_events"] == 96
    assert int(optimized[0]["sequence"]) < int(reference[0]["sequence"])
    assert optimized[0]["cursor"] == reference[0]["cursor"]
    assert optimized[1] == reference[1]
    # The state hash includes the source event-chain hash, so this proves that
    # coalescing only changes delivery and not the ordered reducer path.
    assert optimized[0]["state_hash"] == reference[0]["state_hash"]


async def test_final_state_scan_keeps_interactions_and_matches_step_reference() -> None:
    events = event_fixture(count=128, step_ms=10)
    target = events[95].event_time_ms

    class InteractionReducer(CountingReducer):
        def __init__(self) -> None:
            super().__init__(trading_state=True)

        def apply_source_event(self, event: FixtureEvent) -> dict[str, object]:
            projection = dict(super().apply_source_event(event))
            if self.count == 40:
                projection["orders"] = [{"order_id": "interaction-40"}]
            return projection

    async def run(
        *,
        session_id: str,
        final_state: bool,
    ) -> tuple[dict[str, object], dict[str, object], dict[str, object], dict[str, object]]:
        reducer = InteractionReducer()
        actor = ReplaySessionActor(
            session_id=session_id,
            config=session_config(),
            source_factory=source_factory(events),
            initial_virtual_time_ms=1_000,
            command_queue_size=8,
            event_buffer_size=128,
            max_emit_fps=30,
            controller_ttl_seconds=60,
            checkpoint_event_interval=10_000,
            checkpoint_virtual_ms=300_000,
            reducer=reducer,
        )
        await actor.start()
        try:
            acquired = await actor.submit(
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=f"{session_id}-acquire",
                    client_instance_id="phase8-final-client",
                    expected_revision=0,
                    type=CommandType.ACQUIRE_CONTROLLER,
                    payload={},
                )
            )
            result = await actor.submit(
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=f"{session_id}-advance",
                    client_instance_id="phase8-final-client",
                    expected_revision=acquired.revision,
                    type=(
                        InternalCommandType.FAST_FORWARD_FINAL_STATE
                        if final_state
                        else CommandType.STEP
                    ),
                    payload=(
                        {
                            "target_virtual_time_ms": target,
                            "max_events": 128,
                            "require_empty_account": False,
                            "snapshot_only": False,
                        }
                        if final_state
                        else {"count": 96}
                    ),
                )
            )
            return (
                (await actor.snapshot()).to_dict(),
                dict(reducer.snapshot()),
                dict(result.data),
                actor.diagnostics(),
            )
        finally:
            await actor.shutdown(step_timeout=1.0)

    final_state, reference = await asyncio.gather(
        run(session_id="phase8-final-state", final_state=True),
        run(session_id="phase8-final-reference", final_state=False),
    )

    assert final_state[2]["consumed"] == 96
    assert final_state[2]["published_projection_events"] == 1
    assert final_state[2]["coalesced_projection_events"] == 95
    assert final_state[2]["snapshot_published"] is True
    assert final_state[0]["cursor"] == reference[0]["cursor"]
    assert final_state[1] == reference[1]
    assert final_state[0]["state_hash"] == reference[0]["state_hash"]
    assert int(final_state[0]["sequence"]) < int(reference[0]["sequence"])
    assert int(final_state[3]["component_snapshot_materializations"]) < int(
        reference[3]["component_snapshot_materializations"]
    )


async def test_final_state_scan_stops_at_first_interaction_boundary() -> None:
    events = event_fixture(count=5, step_ms=10)

    class SparseInteractionReducer(CountingReducer):
        def __init__(self) -> None:
            super().__init__(trading_state=True)

        def apply_source_event(self, event: FixtureEvent) -> dict[str, object]:
            projection = dict(super().apply_source_event(event))
            if event.value == 3:
                projection["orders"] = [{"order_id": "interaction-3"}]
            return projection

        def supports_final_state_batch(self) -> bool:
            return False

        @staticmethod
        def final_state_safe_prefix_length(
            candidates: tuple[FixtureEvent, ...],
        ) -> int:
            return next(
                (
                    index
                    for index, candidate in enumerate(candidates)
                    if candidate.value == 3
                ),
                len(candidates),
            )

        def apply_source_events_final_state(
            self,
            candidates: tuple[FixtureEvent, ...],
        ) -> dict[str, object]:
            for candidate in candidates:
                super().apply_source_event(candidate)
            return {}

    reducer = SparseInteractionReducer()
    actor = ReplaySessionActor(
        session_id="phase8-sparse-interaction",
        config=session_config(),
        source_factory=source_factory(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=8,
        event_buffer_size=32,
        max_emit_fps=30,
        controller_ttl_seconds=60,
        checkpoint_event_interval=10_000,
        checkpoint_virtual_ms=300_000,
        reducer=reducer,
    )
    await actor.start()
    try:
        result = await actor.submit(
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="phase8-sparse-acquire",
                client_instance_id="phase8-sparse-client",
                expected_revision=0,
                type=CommandType.ACQUIRE_CONTROLLER,
                payload={},
            )
        )
        parts: list[dict[str, object]] = []
        for index in range(3):
            result = await actor.submit(
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=f"phase8-sparse-part-{index}",
                    client_instance_id="phase8-sparse-client",
                    expected_revision=result.revision,
                    type=InternalCommandType.FAST_FORWARD_FINAL_STATE,
                    payload={
                        "target_virtual_time_ms": events[-1].event_time_ms,
                        "max_events": len(events),
                        "require_empty_account": False,
                        "snapshot_only": False,
                    },
                )
            )
            parts.append(dict(result.data))

        assert [part["consumed"] for part in parts] == [2, 1, 2]
        assert [part["batch_reducer_events"] for part in parts] == [2, 0, 2]
        assert [part["published_projection_events"] for part in parts] == [0, 1, 0]
        assert [part["target_reached"] for part in parts] == [False, False, True]
        assert reducer.snapshot() == {"count": 5, "total": 15}
        assert (await actor.snapshot()).cursor.source_sequence == 5
        interaction_projections = [
            event
            for event in actor.event_buffer_after(0) or ()
            if event.type is ReplayEventType.FINAL_STATE
            and event.data["status_reason"]
            == "fast_forward_final_state_interaction"
        ]
        assert len(interaction_projections) == 1
        assert interaction_projections[0].data["cursor"][
            "source_sequence"
        ] == 3
        completion_projections = [
            event
            for event in actor.event_buffer_after(0) or ()
            if event.type is ReplayEventType.FINAL_STATE
            and event.data["status_reason"]
            == "fast_forward_final_state_complete"
        ]
        assert len(completion_projections) == 1
        assert completion_projections[0].data["source_sequence_from"] == 4
        assert completion_projections[0].data["source_sequence_to"] == 5
        assert completion_projections[0].data["cursor"]["source_sequence"] == 5
        assert not [
            event
            for event in actor.event_buffer_after(0) or ()
            if event.type is ReplayEventType.SNAPSHOT
            and event.data["snapshot"]["status_reason"].startswith(
                "fast_forward_final_state"
            )
        ]
    finally:
        await actor.shutdown(step_timeout=1.0)


async def test_final_state_cancel_snapshot_does_not_consume_same_time_event() -> None:
    events = (
        FixtureEvent(event_time_ms=1_010, value=1),
        FixtureEvent(event_time_ms=1_010, value=2),
        FixtureEvent(event_time_ms=1_020, value=3),
    )
    actor = ReplaySessionActor(
        session_id="phase8-final-cancel",
        config=session_config(),
        source_factory=source_factory(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=8,
        event_buffer_size=16,
        max_emit_fps=30,
        controller_ttl_seconds=60,
        checkpoint_event_interval=10_000,
        checkpoint_virtual_ms=300_000,
        reducer=CountingReducer(),
    )
    await actor.start()
    try:
        acquired = await actor.submit(
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="phase8-cancel-acquire",
                client_instance_id="phase8-final-client",
                expected_revision=0,
                type=CommandType.ACQUIRE_CONTROLLER,
                payload={},
            )
        )
        stepped = await actor.submit(
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="phase8-cancel-step",
                client_instance_id="phase8-final-client",
                expected_revision=acquired.revision,
                type=CommandType.STEP,
                payload={"count": 1},
            )
        )
        synchronized = await actor.submit(
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="phase8-cancel-snapshot",
                client_instance_id="phase8-final-client",
                expected_revision=stepped.revision,
                type=InternalCommandType.FAST_FORWARD_FINAL_STATE,
                payload={
                    "target_virtual_time_ms": stepped.cursor.virtual_time_ms,
                    "max_events": 1,
                    "require_empty_account": False,
                    "snapshot_only": True,
                },
            )
        )

        assert synchronized.data["consumed"] == 0
        assert synchronized.data["snapshot_published"] is True
        assert synchronized.cursor == stepped.cursor
        assert synchronized.sequence == stepped.sequence + 1
        public = await actor.public_snapshot()
        assert public["status_reason"] == "fast_forward_final_state_cancelled"
        emitted = actor.event_buffer_after(stepped.sequence) or ()
        assert len(emitted) == 1
        assert emitted[0].type is ReplayEventType.FINAL_STATE
        assert emitted[0].data["source_sequence_from"] == 1
        assert emitted[0].data["source_sequence_to"] == 1
    finally:
        await actor.shutdown(step_timeout=1.0)


async def _create_trade_run(
    service: ReplayService,
    *,
    acquire_id: str,
) -> tuple[str, str]:
    assert service.training is not None
    created = await service.training.create_run(await _trade_request(service))
    run = created["run"]
    run_id = str(run["run_id"])
    session_id = str(run["adapter_session_id"])
    await _acquire(
        service,
        run_id=run_id,
        selected_session_id=session_id,
        command_id=acquire_id,
    )
    return run_id, session_id


async def _advance_to(
    service: ReplayService,
    *,
    run_id: str,
    session_id: str,
    command_id: str,
    target: int,
) -> dict[str, object]:
    assert service.training is not None
    session = await service.get_session(session_id)
    return await service.training.command(
        run_id,
        _command(
            run_id,
            command_id,
            ReplayV2CommandType.ADVANCE_TO,
            session,
            {"virtual_time_ms": target},
        ),
    )


async def test_optimized_empty_account_matches_full_event_reference(
    tmp_path: Path,
) -> None:
    optimized = await _trade_service(
        tmp_path / "optimized.db",
        archive_root=tmp_path / "optimized-archive",
        symbols=("BTCUSDT",),
    )
    reference = await _trade_service(
        tmp_path / "reference.db",
        archive_root=tmp_path / "reference-archive",
        symbols=("BTCUSDT",),
    )
    optimized.settings = replace(
        optimized.settings,
        replay_fast_forward_optimization_enabled=True,
    )
    try:
        optimized_run, optimized_session = await _create_trade_run(
            optimized, acquire_id="optimized-acquire"
        )
        reference_run, reference_session = await _create_trade_run(
            reference, acquire_id="reference-acquire"
        )
        initial = await optimized.get_session(optimized_session)
        target = (
            int(initial["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
            + 8 * INTERVAL_MS
        )
        optimized_result = await _advance_to(
            optimized,
            run_id=optimized_run,
            session_id=optimized_session,
            command_id="optimized-advance",
            target=target,
        )
        reference_result = await _advance_to(
            reference,
            run_id=reference_run,
            session_id=reference_session,
            command_id="reference-advance",
            target=target,
        )
        assert optimized_result["data"]["plan"]["mode"] == "AGGREGATE_SCAN"  # type: ignore[index]
        assert reference_result["data"]["plan"]["mode"] == "FULL_EVENT_SCAN"  # type: ignore[index]
        assert optimized_result["data"]["plan"]["equivalence"]["status"] == (  # type: ignore[index]
            "VERIFIED_BY_EXACT_REDUCER_PATH"
        )
        assert optimized.training is not None
        terminal_progress = await optimized.training.get_advance_progress(
            optimized_run,
            "optimized-advance",
        )
        assert terminal_progress["progress"]["status"] == "COMPLETED"  # type: ignore[index]
        assert terminal_progress["progress"]["cancelable"] is False  # type: ignore[index]
        assert terminal_progress["progress"]["plan"]["mode"] == "AGGREGATE_SCAN"  # type: ignore[index]
        optimized_snapshot = await optimized.get_session(optimized_session)
        reference_snapshot = await reference.get_session(reference_session)
        assert optimized_snapshot["snapshot"]["cursor"] == reference_snapshot["snapshot"]["cursor"]  # type: ignore[index]
        assert optimized_snapshot["snapshot"]["components"] == reference_snapshot["snapshot"]["components"]  # type: ignore[index]
        assert optimized_snapshot["snapshot"]["state_hash"] == reference_snapshot["snapshot"]["state_hash"]  # type: ignore[index]
    finally:
        await optimized.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)


async def test_cancelled_optimized_scan_resumes_to_full_reference_hash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    optimized = await _trade_service(
        tmp_path / "optimized-cancel.db",
        archive_root=tmp_path / "optimized-cancel-archive",
        symbols=("BTCUSDT",),
    )
    reference = await _trade_service(
        tmp_path / "cancel-reference.db",
        archive_root=tmp_path / "cancel-reference-archive",
        symbols=("BTCUSDT",),
    )
    optimized.settings = replace(
        optimized.settings,
        replay_fast_forward_optimization_enabled=True,
    )
    try:
        optimized_run, optimized_session = await _create_trade_run(
            optimized, acquire_id="optimized-cancel-acquire"
        )
        reference_run, reference_session = await _create_trade_run(
            reference, acquire_id="cancel-reference-acquire"
        )
        initial = await optimized.get_session(optimized_session)
        target = (
            int(initial["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
            + 8 * INTERVAL_MS
        )
        original_plan = optimized.plan_source_chunk
        second_plan_entered = asyncio.Event()
        release_second_plan = asyncio.Event()
        calls = 0

        async def one_event_plan(*args: object, **kwargs: object) -> dict[str, object]:
            nonlocal calls
            calls += 1
            if calls == 2:
                second_plan_entered.set()
                await release_second_plan.wait()
            planned = await original_plan(*args, **kwargs)  # type: ignore[arg-type]
            if int(planned["event_count"]) > 1:
                return {
                    **planned,
                    "event_count": 1,
                    "has_more_before_target": True,
                }
            return planned

        monkeypatch.setattr(optimized, "plan_source_chunk", one_event_plan)
        advance_task = asyncio.create_task(
            _advance_to(
                optimized,
                run_id=optimized_run,
                session_id=optimized_session,
                command_id="optimized-cancel-advance",
                target=target,
            )
        )
        await asyncio.wait_for(second_plan_entered.wait(), timeout=2)
        assert optimized.training is not None
        current = await optimized.get_session(optimized_session)
        cancel = await optimized.training.command(
            optimized_run,
            _command(
                optimized_run,
                "optimized-cancel-request",
                ReplayV2CommandType.CANCEL_ADVANCE,
                current,
                {"advance_command_id": "optimized-cancel-advance"},
            ),
        )
        assert cancel["data"]["cancel_requested"] is True  # type: ignore[index]
        release_second_plan.set()
        cancelled = await advance_task
        assert cancelled["data"]["cancelled"] is True  # type: ignore[index]
        assert cancelled["data"]["consumed"] == 1  # type: ignore[index]
        assert cancelled["data"]["plan"]["mode"] == "AGGREGATE_SCAN"  # type: ignore[index]

        monkeypatch.setattr(optimized, "plan_source_chunk", original_plan)
        resumed = await _advance_to(
            optimized,
            run_id=optimized_run,
            session_id=optimized_session,
            command_id="optimized-resume-advance",
            target=target,
        )
        await _advance_to(
            reference,
            run_id=reference_run,
            session_id=reference_session,
            command_id="cancel-reference-advance",
            target=target,
        )
        assert resumed["data"]["plan"]["mode"] == "AGGREGATE_SCAN"  # type: ignore[index]
        optimized_snapshot = await optimized.get_session(optimized_session)
        reference_snapshot = await reference.get_session(reference_session)
        assert optimized_snapshot["snapshot"]["cursor"] == reference_snapshot["snapshot"]["cursor"]  # type: ignore[index]
        assert optimized_snapshot["snapshot"]["components"] == reference_snapshot["snapshot"]["components"]  # type: ignore[index]
        assert optimized_snapshot["snapshot"]["state_hash"] == reference_snapshot["snapshot"]["state_hash"]  # type: ignore[index]
    finally:
        await optimized.shutdown(step_timeout=1.0)
        await reference.shutdown(step_timeout=1.0)


async def test_multi_track_full_scan_reports_progress_and_cancels_on_wave_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _trade_service(
        tmp_path / "multi-cancel.db",
        archive_root=tmp_path / "multi-cancel-archive",
        symbols=("BTCUSDT", "ETHUSDT"),
    )
    try:
        assert service.training is not None
        created = await service.training.create_run(await _trade_request(service))
        run_id = str(created["run"]["run_id"])
        selected_session = str(created["run"]["adapter_session_id"])
        selected = await service.get_session(selected_session)
        await service.training.command(
            run_id,
            _command(
                run_id,
                "phase8-add-eth-full",
                ReplayV2CommandType.ADD_TRACK,
                selected,
                {
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "ETHUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "FULL",
                },
            ),
        )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=selected_session,
            command_id="phase8-multi-acquire",
        )
        authoritative = await service.get_session(selected_session)
        target = (
            int(authoritative["snapshot"]["cursor"]["virtual_time_ms"])  # type: ignore[index]
            + 3 * INTERVAL_MS
        )
        original_plan = service.plan_source_chunk
        next_wave_entered = asyncio.Event()
        release_next_wave = asyncio.Event()
        one_event_plans = 0

        async def gated_plan(*args: object, **kwargs: object) -> dict[str, object]:
            nonlocal one_event_plans
            if kwargs.get("max_events") == 1:
                one_event_plans += 1
                if one_event_plans == 3:
                    next_wave_entered.set()
                    await release_next_wave.wait()
            return await original_plan(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(service, "plan_source_chunk", gated_plan)
        advance_task = asyncio.create_task(
            service.training.command(
                run_id,
                _command(
                    run_id,
                    "phase8-multi-advance",
                    ReplayV2CommandType.ADVANCE_TO,
                    authoritative,
                    {"virtual_time_ms": target},
                ),
            )
        )
        await asyncio.wait_for(next_wave_entered.wait(), timeout=2)
        progress = await service.training.get_advance_progress(
            run_id,
            "phase8-multi-advance",
        )
        assert progress["progress"]["plan"]["mode"] == "FULL_EVENT_SCAN"  # type: ignore[index]
        assert "MULTI_TRACK_GLOBAL_ORDER" in progress["progress"]["plan"]["reason_codes"]  # type: ignore[index]
        current = await service.get_session(selected_session)
        cancelled_request = await service.training.command(
            run_id,
            _command(
                run_id,
                "phase8-multi-cancel",
                ReplayV2CommandType.CANCEL_ADVANCE,
                current,
                {"advance_command_id": "phase8-multi-advance"},
            ),
        )
        assert cancelled_request["data"]["cancel_requested"] is True  # type: ignore[index]
        release_next_wave.set()
        cancelled = await advance_task
        assert cancelled["data"]["cancelled"] is True  # type: ignore[index]
        assert cancelled["data"]["progress"]["status"] == "CANCELLED"  # type: ignore[index]
        assert cancelled["data"]["progress"]["cancelable"] is False  # type: ignore[index]
        assert cancelled["data"]["progress"]["commit_boundary"] == (  # type: ignore[index]
            "COMPLETE_ACTOR_COMMAND"
        )
        terminal = await service.training.get_advance_progress(
            run_id,
            "phase8-multi-advance",
        )
        assert terminal["progress"]["status"] == "CANCELLED"  # type: ignore[index]
        assert terminal["progress"]["cancelable"] is False  # type: ignore[index]
        tracks = await service.training.get_market_tracks(run_id)
        assert len(
            {
                track["cursor"]["virtual_time_ms"]
                for track in tracks["tracks"]  # type: ignore[union-attr]
            }
        ) == 1
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_open_order_forces_full_event_scan(
    tmp_path: Path,
) -> None:
    service = await _trade_service(
        tmp_path / "order.db",
        archive_root=tmp_path / "order-archive",
        symbols=("BTCUSDT",),
    )
    service.settings = replace(
        service.settings,
        replay_fast_forward_optimization_enabled=True,
    )
    try:
        run_id, session_id = await _create_trade_run(service, acquire_id="order-acquire")
        assert service.training is not None
        initial = await service.get_session(session_id)
        target = int(initial["snapshot"]["cursor"]["virtual_time_ms"]) + INTERVAL_MS  # type: ignore[index]
        initial_plan = await service.training.get_fast_forward_plan(
            run_id,
            target_virtual_time_ms=target,
        )
        assert initial_plan["plan"]["mode"] == "AGGREGATE_SCAN"  # type: ignore[index]
        await _place_limit(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="resting-limit",
            client_order_id="phase8-resting-limit",
            quantity="1",
            limit_price="1",
        )
        current = await service.get_session(session_id)
        target = int(current["snapshot"]["cursor"]["virtual_time_ms"]) + INTERVAL_MS  # type: ignore[index]
        planned = await service.training.get_fast_forward_plan(
            run_id,
            target_virtual_time_ms=target,
        )
        assert planned["plan"]["mode"] == "FULL_EVENT_SCAN"  # type: ignore[index]
        assert "OPEN_ORDER" in planned["plan"]["reason_codes"]  # type: ignore[index]
        viewer = await service.training.get_viewer_state(run_id)
        advanced = await service.training.command(
            run_id,
            _command(
                run_id,
                "resting-order-display-step",
                ReplayV2CommandType.ADVANCE,
                current,
                {
                    "basis": "DISPLAY_BAR",
                    "count": 1,
                    "display_interval": viewer["display_interval"],
                    "viewer_revision": viewer["semantic_view_revision"],
                },
            ),
        )
        assert advanced["data"]["plan"]["mode"] == "FULL_EVENT_SCAN"  # type: ignore[index]
        assert advanced["data"]["plan"]["projection_delivery"] == "FINAL_STATE"  # type: ignore[index]
        assert advanced["data"]["plan"]["path_execution"] == "SPARSE_INTERACTION"  # type: ignore[index]
        assert advanced["data"]["plan"]["interaction_boundary_stop"] is True  # type: ignore[index]
        assert advanced["data"]["plan"]["chunk_event_limit"] > 32  # type: ignore[index]
        assert advanced["data"]["coalesced_projection_events"] > 0  # type: ignore[index]
        assert advanced["data"]["published_projection_events"] == 0  # type: ignore[index]
        assert advanced["data"]["batch_reducer_events"] == advanced["data"]["consumed"]  # type: ignore[index]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_trade_flow_reads_only_revealed_prefix_with_bounded_resync_pages(
    tmp_path: Path,
) -> None:
    service = await _trade_service(
        tmp_path / "flow.db",
        archive_root=tmp_path / "flow-archive",
        symbols=("BTCUSDT",),
    )
    try:
        run_id, session_id = await _create_trade_run(service, acquire_id="flow-acquire")
        assert service.training is not None
        current = await service.get_session(session_id)
        await service.training.command(
            run_id,
            _command(
                run_id,
                "reveal-three-trades",
                ReplayV2CommandType.STEP_EVENT,
                current,
                {"count": 3},
            ),
        )
        first = await service.training.trade_flow_page(
            run_id,
            track_id="track-1",
            after_sequence=0,
            limit=2,
        )
        assert first["fidelity"] == "AGGREGATE_TRADE_NOT_RAW_TRADE"
        assert [item["source_sequence"] for item in first["tape"]] == [1, 2]
        assert [item["aggressor_side"] for item in first["tape"]] == ["SELL", "BUY"]
        assert first["has_more"] is True
        assert first["continuity"]["revealed_sequence"] == 3
        second = await service.training.trade_flow_page(
            run_id,
            track_id="track-1",
            after_sequence=2,
            limit=2,
        )
        assert [item["source_sequence"] for item in second["tape"]] == [3]
        assert second["has_more"] is False
        tail = await service.training.trade_flow_page(
            run_id,
            track_id=None,
            after_sequence=None,
            limit=2,
        )
        assert [item["source_sequence"] for item in tail["tape"]] == [2, 3]
        assert tail["streaming"]["page_rows"] == 2
        with pytest.raises(TrainingRunError, match="ahead") as resync:
            await service.training.trade_flow_page(
                run_id,
                track_id="track-1",
                after_sequence=4,
                limit=2,
            )
        assert resync.value.details["clear_projection"] is True
    finally:
        await service.shutdown(step_timeout=1.0)


def test_trade_flow_gap_requires_clear_and_resync() -> None:
    page = {
        "data_epoch": "sha256:" + "3" * 64,
        "after_sequence": 0,
        "next_sequence": 2,
        "revealed_sequence": 2,
        "has_more": False,
        "streaming": {},
        "events": [
            {
                "source_sequence": 1,
                "agg_trade_id": 10,
                "first_trade_id": 100,
                "last_trade_id": 100,
                "price": "100",
                "quantity": "1",
                "quote_quantity": "100",
                "trade_time_ms": 1_000,
                "is_buyer_maker": False,
            },
            {
                "source_sequence": 2,
                "agg_trade_id": 12,
                "first_trade_id": 102,
                "last_trade_id": 102,
                "price": "101",
                "quantity": "1",
                "quote_quantity": "101",
                "trade_time_ms": 1_001,
                "is_buyer_maker": True,
            },
        ],
    }
    with pytest.raises(TrainingRunError) as degraded:
        ReplayTradeFlowAdapter().project(
            run_id="run-1",
            track_id="track-1",
            source_page=page,
        )
    assert degraded.value.code == "REPLAY_TRADE_FLOW_RESYNC_REQUIRED"
