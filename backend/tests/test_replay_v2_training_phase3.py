from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.storage import REPLAY_SCHEMA_VERSION, ReplaySQLiteStore
from app.replay.training.commands import ReplayV2Command
from app.replay.training.control import aligned_step_target_ms
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import (
    ReplayV2CommandType,
    TrainingCursor,
    TrainingRunCreateRequest,
    ViewerState,
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
from tests.fixtures.replay.trade_service_fakes import (
    TRADE_NOW_MS,
    TRADE_REPLAY_MINUTES,
    TRADE_REPLAY_START_MS,
    trade_replay_repository,
    verified_trade_archive,
)


pytestmark = pytest.mark.anyio


async def _service(path: Path, *, prefix: str = "run") -> ReplayService:
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
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
    display_interval: str = "15m",
) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=18 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=False,
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 3 controls",
            "source_kind": "BAR",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": display_interval,
            "requested_start_ms": START_MS + 4 * INTERVAL_MS,
            "warmup_bars": 2,
            "forward_cache_ms": 18 * INTERVAL_MS,
            "random_seed": 42,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "NONE",
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "funding_mode": "OFF",
            "allow_rule_changes": False,
        }
    )


def _v2_command(
    *,
    run_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    snapshot: dict[str, object],
    payload: dict[str, object],
    client_instance_id: str = "phase3-browser",
) -> ReplayV2Command:
    cursor = snapshot["snapshot"]["cursor"]  # type: ignore[index]
    revision = snapshot["snapshot"]["revision"]  # type: ignore[index]
    return ReplayV2Command(
        protocol="replay.v2",
        run_id=run_id,
        command_id=command_id,
        client_instance_id=client_instance_id,
        expected_revision=revision,  # type: ignore[arg-type]
        expected_cursor=TrainingCursor(
            virtual_time_ms=cursor["virtual_time_ms"],  # type: ignore[index,arg-type]
            source_sequence=cursor["source_sequence"],  # type: ignore[index,arg-type]
            revision=revision,  # type: ignore[arg-type]
        ),
        type=command_type,
        payload=payload,
    )


@pytest.mark.parametrize(
    ("display_interval", "expected_delta_ms"),
    (("1m", 59_999), ("5m", 299_999), ("15m", 899_999), ("1h", 3_599_999)),
)
def test_aligned_step_target_matrix_starts_at_current_bucket_close(
    display_interval: str,
    expected_delta_ms: int,
) -> None:
    current = 1_710_000_000_000
    bucket_offset = current % (expected_delta_ms + 1)
    target = aligned_step_target_ms(
        current_virtual_time_ms=current,
        base_interval="1m",
        step_interval=display_interval,
        count=1,
    )
    assert target - current == expected_delta_ms - bucket_offset


def test_aligned_step_finishes_forming_bucket_then_advances_full_buckets() -> None:
    bucket_start = 1_710_000_000_000 - (1_710_000_000_000 % 900_000)
    after_one_minute = bucket_start + 59_999
    assert aligned_step_target_ms(
        current_virtual_time_ms=after_one_minute,
        base_interval="1m",
        step_interval="15m",
        count=1,
    ) == bucket_start + 899_999
    assert aligned_step_target_ms(
        current_virtual_time_ms=bucket_start + 899_999,
        base_interval="1m",
        step_interval="15m",
        count=2,
    ) == bucket_start + 2_699_999


def test_aligned_step_supports_calendar_intervals_and_rejects_inexact_intervals() -> None:
    january_midpoint_ms = 1_705_276_800_000  # 2024-01-15T12:00:00Z
    assert aligned_step_target_ms(
        current_virtual_time_ms=january_midpoint_ms,
        base_interval="1m",
        step_interval="1M",
        count=1,
    ) == 1_706_745_599_999  # 2024-01-31T23:59:59.999Z
    assert aligned_step_target_ms(
        current_virtual_time_ms=1_706_745_599_999,
        base_interval="1m",
        step_interval="1M",
        count=1,
    ) == 1_709_251_199_999  # 2024-02-29T23:59:59.999Z
    with pytest.raises(TrainingRunError, match="exactly tileable"):
        aligned_step_target_ms(
            current_virtual_time_ms=START_MS,
            base_interval="5m",
            step_interval="7m",
            count=1,
        )


def test_viewer_state_is_strict_and_semantic_revision_is_separate() -> None:
    viewer = ViewerState.from_dict(
        {
            "run_id": "run-1",
            "selected_track_id": "track-1",
            "display_interval": "15m",
            "chart_type": "candles",
            "visible_range": None,
            "pane_layout": {},
            "rail_layout": {},
            "semantic_view_revision": 3,
        }
    )
    assert viewer.to_dict()["display_interval"] == "15m"
    assert viewer.semantic_view_revision == 3
    with pytest.raises(ValueError, match="unknown field"):
        ViewerState.from_dict({**viewer.to_dict(), "domain_hash": "forbidden"})


async def test_create_run_uses_base_adapter_and_persists_initial_viewer(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "replay.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, display_interval="15m")
        )
        session = await service.get_session(created["run"]["adapter_session_id"])
        assert session["snapshot"]["config"]["display_interval"] == "1m"
        viewer = await service.training.get_viewer_state(created["run"]["run_id"])  # type: ignore[union-attr]
        assert viewer["display_interval"] == "15m"
        assert viewer["semantic_view_revision"] == 0
        history_binding = await service.training.store.history_binding(  # type: ignore[union-attr]
            session_id=created["run"]["adapter_session_id"],
            track_id="track-1",
        )
        assert history_binding["display_interval"] == "1m"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_create_and_viewer_switch_support_calendar_but_reject_inexact_intervals(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "intervals.db")
    try:
        monthly = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, display_interval="1M")
        )
        monthly_viewer = await service.training.get_viewer_state(  # type: ignore[union-attr]
            monthly["run"]["run_id"]
        )
        assert monthly_viewer["display_interval"] == "1M"

        with pytest.raises(TrainingRunError):
            await service.training.create_run(  # type: ignore[union-attr]
                await _request(service, display_interval="90s")
            )

        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        snapshot = await service.get_session(created["run"]["adapter_session_id"])
        switched = await service.training.command(  # type: ignore[union-attr]
            created["run"]["run_id"],
            _v2_command(
                run_id=created["run"]["run_id"],
                command_id="calendar-view",
                command_type=ReplayV2CommandType.SET_DISPLAY_INTERVAL,
                snapshot=snapshot,
                payload={
                    "display_interval": "1M",
                    "expected_viewer_revision": 0,
                },
            ),
        )
        assert switched["viewer_state"]["display_interval"] == "1M"

        with pytest.raises(TrainingRunError):
            await service.training.command(  # type: ignore[union-attr]
                created["run"]["run_id"],
                _v2_command(
                    run_id=created["run"]["run_id"],
                    command_id="invalid-view",
                    command_type=ReplayV2CommandType.SET_DISPLAY_INTERVAL,
                    snapshot=snapshot,
                    payload={
                        "display_interval": "90s",
                        "expected_viewer_revision": 1,
                    },
                ),
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_schema_v1_upgrade_backfills_viewer_state_without_touching_v1(
    tmp_path: Path,
) -> None:
    path = tmp_path / "upgrade.db"
    service = await _service(path)
    created = await service.training.create_run(  # type: ignore[union-attr]
        await _request(service, display_interval="15m")
    )
    run_id = created["run"]["run_id"]
    await service.shutdown(step_timeout=1.0)

    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE replay_training_command")
        connection.execute("DROP TABLE replay_training_viewer_event")
        connection.execute("DROP TABLE replay_training_viewer_state")
        connection.execute(
            "UPDATE replay_training_schema_version SET version = 1 WHERE singleton = 1"
        )

    restored = await _service(path, prefix="unused")
    try:
        viewer = await restored.training.get_viewer_state(run_id)  # type: ignore[union-attr]
        assert viewer["display_interval"] == "15m"
        assert viewer["semantic_view_revision"] == 0
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT version FROM replay_schema_version WHERE singleton = 1"
            ).fetchone() == (REPLAY_SCHEMA_VERSION,)
            assert connection.execute(
                "SELECT version FROM replay_training_schema_version WHERE singleton = 1"
                ).fetchone() == (TRAINING_SCHEMA_VERSION,)
            assert connection.execute(
                "SELECT event_type FROM replay_training_viewer_event WHERE run_id = ?",
                (run_id,),
            ).fetchone() == ("INITIAL_VIEWER_STATE",)
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_display_switch_is_persistent_and_does_not_move_domain_state(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    service = await _service(path)
    created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
    run_id = created["run"]["run_id"]
    session_id = created["run"]["adapter_session_id"]
    before = await service.get_session(session_id)
    command = _v2_command(
        run_id=run_id,
        command_id="viewer-15m-to-1h",
        command_type=ReplayV2CommandType.SET_DISPLAY_INTERVAL,
        snapshot=before,
        payload={"display_interval": "1h", "expected_viewer_revision": 0},
    )
    result = await service.training.command(run_id, command)  # type: ignore[union-attr]
    replayed = await service.training.command(run_id, command)  # type: ignore[union-attr]
    after = await service.get_session(session_id)
    assert replayed == result
    assert result["viewer_state"]["display_interval"] == "1h"
    assert result["viewer_state"]["semantic_view_revision"] == 1
    assert after["snapshot"]["cursor"] == before["snapshot"]["cursor"]
    assert after["snapshot"]["state_hash"] == before["snapshot"]["state_hash"]
    with pytest.raises(TrainingRunError, match="command_id was reused"):
        await service.training.command(  # type: ignore[union-attr]
            run_id,
            _v2_command(
                run_id=run_id,
                command_id="viewer-15m-to-1h",
                command_type=ReplayV2CommandType.SET_DISPLAY_INTERVAL,
                snapshot=before,
                payload={"display_interval": "15m", "expected_viewer_revision": 0},
            ),
        )
    await service.shutdown(step_timeout=1.0)

    restored = await _service(path, prefix="unused")
    try:
        viewer = await restored.training.get_viewer_state(run_id)  # type: ignore[union-attr]
        assert viewer["display_interval"] == "1h"
        assert viewer["semantic_view_revision"] == 1
    finally:
        await restored.shutdown(step_timeout=1.0)


async def test_bar_step_display_matches_exact_base_steps_and_stale_view_binding(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "replay.db")
    try:
        first = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        second = await service.training.create_run(await _request(service))  # type: ignore[union-attr]

        async def acquire(run: dict[str, object], command_id: str) -> dict[str, object]:
            snapshot = await service.get_session(run["adapter_session_id"])  # type: ignore[arg-type]
            await service.training.command(  # type: ignore[union-attr]
                run["run_id"],  # type: ignore[arg-type]
                _v2_command(
                    run_id=run["run_id"],  # type: ignore[arg-type]
                    command_id=command_id,
                    command_type=ReplayV2CommandType.ACQUIRE_CONTROLLER,
                    snapshot=snapshot,
                    payload={"takeover": False},
                ),
            )
            return await service.get_session(run["adapter_session_id"])  # type: ignore[arg-type]

        run_a = first["run"]
        run_b = second["run"]
        snapshot_a = await acquire(run_a, "acquire-a")
        snapshot_b = await acquire(run_b, "acquire-b")

        one_base = await service.training.command(  # type: ignore[union-attr]
            run_a["run_id"],  # type: ignore[arg-type]
            _v2_command(
                run_id=run_a["run_id"],  # type: ignore[arg-type]
                command_id="a-base-one",
                command_type=ReplayV2CommandType.STEP_BASE,
                snapshot=snapshot_a,
                payload={"count": 1},
            ),
        )
        after_one = await service.get_session(run_a["adapter_session_id"])  # type: ignore[arg-type]
        switched = await service.training.command(  # type: ignore[union-attr]
            run_a["run_id"],  # type: ignore[arg-type]
            _v2_command(
                run_id=run_a["run_id"],  # type: ignore[arg-type]
                command_id="a-view-one-hour",
                command_type=ReplayV2CommandType.SET_DISPLAY_INTERVAL,
                snapshot=after_one,
                payload={"display_interval": "1h", "expected_viewer_revision": 0},
            ),
        )
        assert switched["viewer_state"]["semantic_view_revision"] == 1

        # The already-bound 15m command remains 15m even though the current viewer is 1h.
        display = await service.training.command(  # type: ignore[union-attr]
            run_a["run_id"],  # type: ignore[arg-type]
            _v2_command(
                run_id=run_a["run_id"],  # type: ignore[arg-type]
                command_id="a-step-bound-15m",
                command_type=ReplayV2CommandType.STEP_DISPLAY,
                snapshot=after_one,
                payload={
                    "count": 1,
                    "display_interval": "15m",
                    "viewer_revision": 0,
                },
            ),
        )
        display_consumed = display["data"]["consumed"]
        assert display_consumed >= 1

        await service.training.command(  # type: ignore[union-attr]
            run_b["run_id"],  # type: ignore[arg-type]
            _v2_command(
                run_id=run_b["run_id"],  # type: ignore[arg-type]
                command_id="b-base-reference",
                command_type=ReplayV2CommandType.STEP_BASE,
                snapshot=snapshot_b,
                payload={"count": 1 + display_consumed},
            ),
        )
        final_a = await service.get_session(run_a["adapter_session_id"])  # type: ignore[arg-type]
        final_b = await service.get_session(run_b["adapter_session_id"])  # type: ignore[arg-type]
        assert final_a["snapshot"]["cursor"] == final_b["snapshot"]["cursor"]
        assert final_a["snapshot"]["state_hash"] == final_b["snapshot"]["state_hash"]
        assert final_a["snapshot"]["components"]["account"] == final_b["snapshot"]["components"]["account"]
        assert final_a["snapshot"]["components"]["ledger"] == final_b["snapshot"]["components"]["ledger"]
        assert one_base["data"]["consumed"] == 1

        with pytest.raises(TrainingRunError, match="AGG_TRADE"):
            latest = await service.get_session(run_a["adapter_session_id"])  # type: ignore[arg-type]
            await service.training.command(  # type: ignore[union-attr]
                run_a["run_id"],  # type: ignore[arg-type]
                _v2_command(
                    run_id=run_a["run_id"],  # type: ignore[arg-type]
                    command_id="bar-step-event",
                    command_type=ReplayV2CommandType.STEP_EVENT,
                    snapshot=latest,
                    payload={"count": 1},
                ),
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_cancel_advance_stops_on_a_committed_source_event_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "cancel.db")
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run = created["run"]
        snapshot = await service.get_session(run["adapter_session_id"])
        await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="cancel-acquire",
                command_type=ReplayV2CommandType.ACQUIRE_CONTROLLER,
                snapshot=snapshot,
                payload={"takeover": False},
            ),
        )
        authoritative = await service.get_session(run["adapter_session_id"])
        original_plan = service.plan_source_chunk
        second_plan_entered = asyncio.Event()
        release_second_plan = asyncio.Event()
        calls = 0

        async def one_event_plan(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                second_plan_entered.set()
                await release_second_plan.wait()
            planned = await original_plan(*args, **kwargs)
            if int(planned["event_count"]) > 1:
                planned = {**planned, "event_count": 1, "has_more_before_target": True}
            return planned

        monkeypatch.setattr(service, "plan_source_chunk", one_event_plan)
        advance = _v2_command(
            run_id=run["run_id"],
            command_id="cancelable-advance",
            command_type=ReplayV2CommandType.ADVANCE_BY,
            snapshot=authoritative,
            payload={"ms": 15 * INTERVAL_MS},
        )
        advance_task = asyncio.create_task(
            service.training.command(run["run_id"], advance)  # type: ignore[union-attr]
        )
        await second_plan_entered.wait()
        switched = await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="viewer-switch-during-advance",
                command_type=ReplayV2CommandType.SET_DISPLAY_INTERVAL,
                # This cursor is intentionally stale after the first committed
                # source event; ViewerState remains independently mutable.
                snapshot=authoritative,
                payload={"display_interval": "1h", "expected_viewer_revision": 0},
            ),
        )
        assert switched["viewer_state"]["display_interval"] == "1h"
        with pytest.raises(TrainingRunError, match="only the client"):
            await service.training.command(  # type: ignore[union-attr]
                run["run_id"],
                _v2_command(
                    run_id=run["run_id"],
                    command_id="foreign-cancel-request",
                    command_type=ReplayV2CommandType.CANCEL_ADVANCE,
                    snapshot=authoritative,
                    payload={"advance_command_id": "cancelable-advance"},
                    client_instance_id="other-browser",
                ),
            )
        cancel_result = await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="cancel-request",
                command_type=ReplayV2CommandType.CANCEL_ADVANCE,
                snapshot=authoritative,
                payload={"advance_command_id": "cancelable-advance"},
            ),
        )
        assert cancel_result["data"]["cancel_requested"] is True
        release_second_plan.set()
        cancelled = await advance_task
        assert cancelled["data"]["cancelled"] is True
        assert cancelled["data"]["consumed"] == 1
        assert cancelled["cursor"]["source_sequence"] == 1
        assert cancelled["data"]["progress"]["status"] == "CANCELLED"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_agg_trade_supports_event_base_display_and_arbitrary_time_controls(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "trade-archive")
    database = tmp_path / "trade.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            product_v2_enabled=True,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: TRADE_NOW_MS),
        repository=trade_replay_repository(),
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("trade-adapter"),
        training_run_id_factory=SessionIdFactory("trade-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=TRADE_REPLAY_MINUTES * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v2",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Trade controls",
                "source_kind": "AGG_TRADE",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "futures",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "requested_start_ms": TRADE_REPLAY_START_MS,
                "warmup_bars": 2,
                "forward_cache_ms": TRADE_REPLAY_MINUTES * INTERVAL_MS,
                "random_seed": 7,
                "initial_equity": "10000",
                "max_leverage": "3",
                "maker_fee_bps": "2",
                "taker_fee_bps": "5",
                "market_slippage_bps": "1",
                "integrity_mode": "CHALLENGE",
                "time_disclosure_policy": "NONE",
                "book_mode": "OFF",
                "margin_mode": "CROSS",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        run = (await service.training.create_run(request))["run"]  # type: ignore[union-attr]
        snapshot = await service.get_session(run["adapter_session_id"])
        await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="trade-acquire",
                command_type=ReplayV2CommandType.ACQUIRE_CONTROLLER,
                snapshot=snapshot,
                payload={"takeover": False},
            ),
        )
        authoritative = await service.get_session(run["adapter_session_id"])
        event = await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="trade-event",
                command_type=ReplayV2CommandType.STEP_EVENT,
                snapshot=authoritative,
                payload={"count": 1},
            ),
        )
        assert event["cursor"]["last_agg_trade_id"] == 1_000

        after_event = await service.get_session(run["adapter_session_id"])
        base = await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="trade-base",
                command_type=ReplayV2CommandType.STEP_BASE,
                snapshot=after_event,
                payload={"count": 1},
            ),
        )
        assert base["data"]["consumed"] == 1
        assert base["cursor"]["virtual_time_ms"] % INTERVAL_MS == INTERVAL_MS - 1

        after_base = await service.get_session(run["adapter_session_id"])
        arbitrary = await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="trade-arbitrary-time",
                command_type=ReplayV2CommandType.ADVANCE_BY,
                snapshot=after_base,
                payload={"ms": 500},
            ),
        )
        assert arbitrary["cursor"]["virtual_time_ms"] == (
            after_base["snapshot"]["cursor"]["virtual_time_ms"] + 500
        )

        after_arbitrary = await service.get_session(run["adapter_session_id"])
        advance_target_ms = (
            after_arbitrary["snapshot"]["cursor"]["virtual_time_ms"] + 500
        )
        advanced_to = await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="trade-advance-to",
                command_type=ReplayV2CommandType.ADVANCE_TO,
                snapshot=after_arbitrary,
                payload={"virtual_time_ms": advance_target_ms},
            ),
        )
        assert advanced_to["cursor"]["virtual_time_ms"] == advance_target_ms

        after_advance_to = await service.get_session(run["adapter_session_id"])
        display = await service.training.command(  # type: ignore[union-attr]
            run["run_id"],
            _v2_command(
                run_id=run["run_id"],
                command_id="trade-display",
                command_type=ReplayV2CommandType.STEP_DISPLAY,
                snapshot=after_advance_to,
                payload={
                    "count": 1,
                    "display_interval": "1m",
                    "viewer_revision": 0,
                },
            ),
        )
        assert display["data"]["plan"]["grain"] == "DISPLAY"
        assert display["cursor"]["last_agg_trade_id"] == 1_003
    finally:
        await service.shutdown(step_timeout=1.0)
