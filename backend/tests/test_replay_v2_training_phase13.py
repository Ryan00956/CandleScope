from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.replay.training.control import (
    MAX_PLAYBACK_BATCH_UNITS,
    discrete_playback_units,
    supported_advance_bases,
    supported_playback_bases,
    virtual_duration_ms,
)
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import AdvanceBasis, ReplayV2CommandType
from tests.fixtures.replay.service_fakes import INTERVAL_MS
from tests.fixtures.replay.trade_service_fakes import TRADE_REPLAY_START_MS
from tests.test_replay_v2_training_phase5 import (
    _acquire,
    _add_track,
    _command,
    _request,
    _service,
    _trade_request,
    _trade_service,
)


pytestmark = pytest.mark.anyio


def test_phase13_basis_capabilities_and_discrete_cadence_are_explicit() -> None:
    assert supported_advance_bases(
        source_kind="BAR",
        full_track_count=1,
    ) == (
        AdvanceBasis.DISPLAY_BAR,
        AdvanceBasis.BASE_BAR,
        AdvanceBasis.SOURCE_EVENT,
        AdvanceBasis.VIRTUAL_TIME,
    )
    assert supported_playback_bases(
        source_kind="BAR",
        full_track_count=1,
    ) == (
        AdvanceBasis.DISPLAY_BAR,
        AdvanceBasis.BASE_BAR,
        AdvanceBasis.SOURCE_EVENT,
    )
    assert supported_advance_bases(
        source_kind="AGG_TRADE",
        full_track_count=2,
    ) == (
        AdvanceBasis.DISPLAY_BAR,
        AdvanceBasis.BASE_BAR,
        AdvanceBasis.VIRTUAL_TIME,
    )
    assert discrete_playback_units(0.099, rate=10) == 0
    assert discrete_playback_units(0.1, rate=10) == 1
    assert discrete_playback_units(100, rate=10_000) == MAX_PLAYBACK_BATCH_UNITS
    assert virtual_duration_ms(
        INTERVAL_MS,
        source_kind="BAR",
        base_interval="1m",
    ) == INTERVAL_MS
    with pytest.raises(TrainingRunError, match="multiple"):
        virtual_duration_ms(
            500,
            source_kind="BAR",
            base_interval="1m",
        )
    assert virtual_duration_ms(
        500,
        source_kind="AGG_TRADE",
        base_interval="1m",
    ) == 500


async def _create_and_acquire(service, *, command_suffix: str):
    created = await service.training.create_run(await _request(service))
    run = created["run"]
    await _acquire(
        service,
        run_id=str(run["run_id"]),
        selected_session_id=str(run["adapter_session_id"]),
        command_id=f"acquire-{command_suffix}",
    )
    return run


async def test_phase13_bar_canonical_advance_matches_reference_paths(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "bar-contract.db")
    try:
        source_run = await _create_and_acquire(service, command_suffix="source")
        base_run = await _create_and_acquire(service, command_suffix="base")
        source_before = await service.get_session(source_run["adapter_session_id"])
        base_before = await service.get_session(base_run["adapter_session_id"])
        slow_profile = await service.training.command(
            source_run["run_id"],
            _command(
                source_run["run_id"],
                "source-rate-one",
                ReplayV2CommandType.SET_SPEED,
                source_before,
                {"basis": "BASE_BAR", "rate": 1},
            ),
        )
        fast_profile = await service.training.command(
            base_run["run_id"],
            _command(
                base_run["run_id"],
                "base-rate-six-hundred",
                ReplayV2CommandType.SET_SPEED,
                base_before,
                {"basis": "BASE_BAR", "rate": 600},
            ),
        )
        assert slow_profile["state_hash"] == fast_profile["state_hash"]
        source_before = await service.get_session(source_run["adapter_session_id"])
        base_before = await service.get_session(base_run["adapter_session_id"])

        source_result = await service.training.command(
            source_run["run_id"],
            _command(
                source_run["run_id"],
                "canonical-source-two",
                ReplayV2CommandType.ADVANCE,
                source_before,
                {"basis": "SOURCE_EVENT", "count": 2},
            ),
        )
        base_result = await service.training.command(
            base_run["run_id"],
            _command(
                base_run["run_id"],
                "canonical-base-two",
                ReplayV2CommandType.ADVANCE,
                base_before,
                {"basis": "BASE_BAR", "count": 2},
            ),
        )
        assert source_result["data"]["plan"] == {
            "contract": "replay.advance.v1",
            "mode": "DIRECT_ADAPTER",
            "cancelable": False,
            "source_kind": "BAR",
            "basis": "SOURCE_EVENT",
            "count": 2,
        }
        assert base_result["data"]["plan"]["basis"] == "BASE_BAR"
        source_final = await service.get_session(source_run["adapter_session_id"])
        base_final = await service.get_session(base_run["adapter_session_id"])
        assert source_final["snapshot"]["cursor"] == base_final["snapshot"]["cursor"]
        assert (
            source_final["snapshot"]["state_hash"]
            == base_final["snapshot"]["state_hash"]
        )

        switched = await service.training.command(
            source_run["run_id"],
            _command(
                source_run["run_id"],
                "phase13-view-15m",
                ReplayV2CommandType.SET_DISPLAY_INTERVAL,
                source_final,
                {
                    "display_interval": "15m",
                    "expected_viewer_revision": 0,
                },
            ),
        )
        assert switched["viewer_state"]["semantic_view_revision"] == 1
        display = await service.training.command(
            source_run["run_id"],
            _command(
                source_run["run_id"],
                "canonical-display",
                ReplayV2CommandType.ADVANCE,
                source_final,
                {
                    "basis": "DISPLAY_BAR",
                    "count": 1,
                    "display_interval": "15m",
                    "viewer_revision": 1,
                },
            ),
        )
        assert display["data"]["plan"]["basis"] == "DISPLAY_BAR"
        assert display["cursor"]["virtual_time_ms"] % (15 * INTERVAL_MS) == (
            15 * INTERVAL_MS - 1
        )

        latest = await service.get_session(source_run["adapter_session_id"])
        with pytest.raises(TrainingRunError, match="multiple"):
            await service.training.command(
                source_run["run_id"],
                _command(
                    source_run["run_id"],
                    "canonical-bad-bar-duration",
                    ReplayV2CommandType.ADVANCE,
                    latest,
                    {"basis": "VIRTUAL_TIME", "duration_ms": 500},
                ),
            )
        advanced = await service.training.command(
            source_run["run_id"],
            _command(
                source_run["run_id"],
                "canonical-bar-duration",
                ReplayV2CommandType.ADVANCE,
                latest,
                {"basis": "VIRTUAL_TIME", "duration_ms": INTERVAL_MS},
            ),
        )
        assert advanced["data"]["plan"]["basis"] == "VIRTUAL_TIME"
        assert advanced["data"]["plan"]["contract"] == "replay.advance.v1"

        alias_before = await service.get_session(base_run["adapter_session_id"])
        alias = await service.training.command(
            base_run["run_id"],
            _command(
                base_run["run_id"],
                "legacy-base-alias",
                ReplayV2CommandType.STEP_BASE,
                alias_before,
                {"count": 1},
            ),
        )
        assert alias["data"]["plan"]["legacy_alias"] == "step_base"
        assert alias["data"]["plan"]["basis"] == "BASE_BAR"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase13_agg_trade_keeps_exact_event_and_millisecond_time(
    tmp_path: Path,
) -> None:
    service = await _trade_service(
        tmp_path / "agg-contract.db",
        archive_root=tmp_path / "agg-archive",
        symbols=("BTCUSDT",),
    )
    try:
        created = await service.training.create_run(await _trade_request(service))
        run = created["run"]
        await _acquire(
            service,
            run_id=str(run["run_id"]),
            selected_session_id=str(run["adapter_session_id"]),
            command_id="acquire-agg-phase13",
        )
        before = await service.get_session(run["adapter_session_id"])
        event = await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "agg-source-one",
                ReplayV2CommandType.ADVANCE,
                before,
                {"basis": "SOURCE_EVENT", "count": 1},
            ),
        )
        assert event["cursor"]["last_agg_trade_id"] == 100_000
        after_event = await service.get_session(run["adapter_session_id"])
        timed = await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "agg-time-500ms",
                ReplayV2CommandType.ADVANCE,
                after_event,
                {"basis": "VIRTUAL_TIME", "duration_ms": 500},
            ),
        )
        assert timed["cursor"]["virtual_time_ms"] == (
            after_event["snapshot"]["cursor"]["virtual_time_ms"] + 500
        )
        assert timed["data"]["plan"]["basis"] == "VIRTUAL_TIME"
        assert timed["data"]["plan"]["duration_ms"] == 500
        tracks = await service.training.get_market_tracks(run["run_id"])
        assert tracks["global_clock"]["supported_bases"] == [
            "DISPLAY_BAR",
            "BASE_BAR",
            "SOURCE_EVENT",
            "VIRTUAL_TIME",
        ]
        assert tracks["global_clock"]["playback_bases"] == [
            "DISPLAY_BAR",
            "BASE_BAR",
            "SOURCE_EVENT",
            "VIRTUAL_TIME",
        ]
        assert event["cursor"]["virtual_time_ms"] == TRADE_REPLAY_START_MS + 1_000
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase13_multi_track_source_event_fails_closed(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "multi-source.db",
        symbols=("ETHUSDT",),
    )
    try:
        run = await _create_and_acquire(service, command_suffix="multi")
        await _add_track(
            service,
            run_id=str(run["run_id"]),
            selected_session_id=str(run["adapter_session_id"]),
            symbol="ETHUSDT",
            tier="FULL",
            command_id="add-phase13-full",
        )
        before = await service.get_session(run["adapter_session_id"])
        projection = await service.training.get_market_tracks(run["run_id"])
        assert "SOURCE_EVENT" not in projection["global_clock"]["supported_bases"]
        assert "SOURCE_EVENT" not in projection["global_clock"]["playback_bases"]
        with pytest.raises(TrainingRunError, match="cohort"):
            await service.training.command(
                run["run_id"],
                _command(
                    run["run_id"],
                    "forbidden-multi-source",
                    ReplayV2CommandType.ADVANCE,
                    before,
                    {"basis": "SOURCE_EVENT", "count": 1},
                ),
            )
        after = await service.get_session(run["adapter_session_id"])
        assert after["snapshot"]["cursor"] == before["snapshot"]["cursor"]
        assert after["snapshot"]["state_hash"] == before["snapshot"]["state_hash"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase13_canonical_play_rate_pause_barrier_and_restart_defaults(
    tmp_path: Path,
) -> None:
    path = tmp_path / "playback.db"
    service = await _service(path)
    run = None
    try:
        run = await _create_and_acquire(service, command_suffix="play")
        before = await service.get_session(run["adapter_session_id"])
        profiled = await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "profile-base-forty",
                ReplayV2CommandType.SET_SPEED,
                before,
                {"basis": "BASE_BAR", "rate": 40},
            ),
        )
        assert profiled["data"]["profile_only"] is True
        assert profiled["data"]["global_clock"]["basis"] == "BASE_BAR"
        assert profiled["data"]["global_clock"]["rate"] == 40
        after_profile = await service.get_session(run["adapter_session_id"])
        assert (
            after_profile["snapshot"]["state_hash"]
            == before["snapshot"]["state_hash"]
        )

        playing = await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "play-base-forty",
                ReplayV2CommandType.PLAY,
                after_profile,
                {"basis": "BASE_BAR", "rate": 40},
            ),
        )
        assert playing["state"] == "PLAYING"
        assert playing["data"]["global_clock"]["contract"] == "replay.playback.v1"
        await asyncio.sleep(0.08)
        paused = await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "pause-base-forty",
                ReplayV2CommandType.PAUSE,
                after_profile,
                {},
            ),
        )
        assert paused["state"] == "PAUSED"
        at_barrier = await service.get_session(run["adapter_session_id"])
        assert at_barrier["snapshot"]["cursor"]["source_sequence"] >= 1
        barrier_cursor = dict(at_barrier["snapshot"]["cursor"])
        await asyncio.sleep(0.05)
        stable = await service.get_session(run["adapter_session_id"])
        assert stable["snapshot"]["cursor"] == barrier_cursor

        repeated = await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "pause-base-forty",
                ReplayV2CommandType.PAUSE,
                after_profile,
                {},
            ),
        )
        assert repeated == paused
    finally:
        await service.shutdown(step_timeout=1.0)

    assert run is not None
    restored = await _service(path)
    try:
        projection = await restored.training.get_market_tracks(run["run_id"])
        clock = projection["global_clock"]
        assert clock["state"] == "PAUSED"
        assert clock["basis"] == "BASE_BAR"
        assert clock["rate"] == 1
        assert clock["profile_revision"] == 0
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_phase13_pause_interrupts_high_rate_batch_at_committed_wave(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "playback-pause-barrier.db")
    pause_task: asyncio.Task[dict[str, object]] | None = None
    release_first_wave = asyncio.Event()
    never_release_second_wave = asyncio.Event()
    try:
        run = await _create_and_acquire(service, command_suffix="pause-barrier")
        before = await service.get_session(run["adapter_session_id"])
        await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "profile-pause-barrier",
                ReplayV2CommandType.SET_SPEED,
                before,
                {"basis": "BASE_BAR", "rate": 10_000},
            ),
        )
        after_profile = await service.get_session(run["adapter_session_id"])

        original_advance = service.training._advance_adapter_to
        first_wave_advanced = asyncio.Event()
        second_wave_started = asyncio.Event()
        advance_calls = 0

        async def controlled_advance(**kwargs):
            nonlocal advance_calls
            advance_calls += 1
            if advance_calls > 1:
                second_wave_started.set()
                await never_release_second_wave.wait()
            result = await original_advance(**kwargs)
            first_wave_advanced.set()
            await release_first_wave.wait()
            return result

        monkeypatch.setattr(
            service.training,
            "_advance_adapter_to",
            controlled_advance,
        )
        monkeypatch.setattr(
            "app.replay.training.service.discrete_playback_units",
            lambda _elapsed_seconds, *, rate: 100,
        )

        playing = await service.training.command(
            run["run_id"],
            _command(
                run["run_id"],
                "play-pause-barrier",
                ReplayV2CommandType.PLAY,
                after_profile,
                {"basis": "BASE_BAR", "rate": 10_000},
            ),
        )
        assert playing["state"] == "PLAYING"
        await asyncio.wait_for(first_wave_advanced.wait(), timeout=1.0)

        pause_task = asyncio.create_task(
            service.training.command(
                run["run_id"],
                _command(
                    run["run_id"],
                    "pause-in-flight-batch",
                    ReplayV2CommandType.PAUSE,
                    after_profile,
                    {},
                ),
            )
        )
        actor = service.training._run_actors[str(run["run_id"])]
        for _attempt in range(100):
            if actor._playback_stop.is_set():
                break
            await asyncio.sleep(0)
        assert actor._playback_stop.is_set()
        release_first_wave.set()

        paused = await asyncio.wait_for(pause_task, timeout=1.0)
        pause_task = None
        assert paused["state"] == "PAUSED"
        assert advance_calls == 1
        assert second_wave_started.is_set() is False

        at_barrier = await service.get_session(run["adapter_session_id"])
        barrier_cursor = dict(at_barrier["snapshot"]["cursor"])
        assert barrier_cursor["source_sequence"] == 1
        await asyncio.sleep(0.02)
        stable = await service.get_session(run["adapter_session_id"])
        assert stable["snapshot"]["cursor"] == barrier_cursor
    finally:
        release_first_wave.set()
        never_release_second_wave.set()
        if pause_task is not None:
            pause_task.cancel()
            await asyncio.gather(pause_task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)
