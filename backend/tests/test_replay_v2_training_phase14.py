from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.commands import ReplayV2Command
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import (
    ReplayV2CommandType,
    TrainingCursor,
    TrainingRunCreateRequest,
)
from app.replay.training.schema import TRAINING_SCHEMA_VERSION, data_policy_hash
from app.replay.training.segments import resolve_history_policy
from tests.fixtures.replay.fakes import FixtureIdentity, make_bar
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    ROW_COUNT,
    START_MS,
    SessionIdFactory,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


async def _service(
    path: Path,
    *,
    random_seed: int = 42,
    extra_symbols: tuple[str, ...] = (),
) -> ReplayService:
    repository = replay_repository()
    for offset, symbol in enumerate(extra_symbols, start=1):
        repository.add_rows(
            FixtureIdentity("binance", "spot", symbol),
            "1m",
            [
                make_bar(
                    START_MS + index * INTERVAL_MS,
                    price=str(100 * (offset + 1) + index),
                )
                for index in range(ROW_COUNT)
            ],
        )
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=repository,
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory("run"),
        training_random_seed_factory=lambda: random_seed,
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


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
    revision = int(snapshot["revision"])
    return ReplayV2Command(
        protocol="replay.v2",
        run_id=run_id,
        command_id=command_id,
        client_instance_id="phase14-browser",
        expected_revision=revision,
        expected_cursor=TrainingCursor(
            virtual_time_ms=int(cursor["virtual_time_ms"]),
            source_sequence=int(cursor["source_sequence"]),
            revision=revision,
        ),
        type=command_type,
        payload=payload,
    )


async def _request(
    service: ReplayService,
    *,
    start_mode: str = "MANUAL",
    disclosure: str = "NONE",
    indicator_warmup_bars: int = 2,
    visible_mode: str = "DURATION",
    visible_duration_ms: int | None = INTERVAL_MS,
    forward_cache_ms: int = 5 * INTERVAL_MS,
) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=indicator_warmup_bars,
        horizon_ms=forward_cache_ms,
        quality_mode="exact",
        blind_mode=disclosure != "NONE",
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 14 history policy",
            "source_kind": "BAR",
            "start_mode": start_mode,
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": (
                START_MS + 4 * INTERVAL_MS
                if start_mode == "MANUAL"
                else None
            ),
            "indicator_warmup_bars": indicator_warmup_bars,
            "visible_history_lookback": {
                "mode": visible_mode,
                "duration_ms": visible_duration_ms,
            },
            "forward_cache_ms": forward_cache_ms,
            "random_seed": None,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": disclosure,
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "funding_mode": "OFF",
            "allow_rule_changes": False,
        }
    )


def _legacy_payload() -> dict[str, object]:
    return {
        "protocol": "replay.v2",
        "catalog_epoch": f"sha256:{'a' * 64}",
        "name": "Legacy alias",
        "source_kind": "BAR",
        "start_mode": "MANUAL",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "settlement_asset": "USDT",
        "base_interval": "1m",
        "display_interval": "1m",
        "requested_start_ms": START_MS + 4 * INTERVAL_MS,
        "warmup_bars": 2,
        "forward_cache_ms": 5 * INTERVAL_MS,
        "random_seed": None,
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


async def test_phase14_create_contract_canonicalizes_legacy_warmup_alias() -> None:
    legacy = TrainingRunCreateRequest.from_dict(_legacy_payload())
    canonical = legacy.to_dict()
    assert "warmup_bars" not in canonical
    assert canonical["indicator_warmup_bars"] == 2
    assert canonical["visible_history_lookback"] == {
        "mode": "DURATION",
        "duration_ms": 2 * INTERVAL_MS,
    }

    with pytest.raises(ValueError, match="exactly one"):
        TrainingRunCreateRequest.from_dict(
            {
                **_legacy_payload(),
                "indicator_warmup_bars": 2,
            }
        )
    with pytest.raises(ValueError, match="cannot include"):
        TrainingRunCreateRequest.from_dict(
            {
                **_legacy_payload(),
                "visible_history_lookback": {
                    "mode": "ALL_AVAILABLE",
                    "duration_ms": INTERVAL_MS,
                },
            }
        )


async def test_phase14_history_policy_resolves_roles_gaps_and_budget(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "policy.db")
    try:
        request = await _request(
            service,
            visible_duration_ms=4 * INTERVAL_MS,
        )
        selection = {
            "interval_ms": INTERVAL_MS,
            "selected_start_ms": START_MS + 4 * INTERVAL_MS,
            "continuous_history_start_ms": START_MS,
        }
        policy = resolve_history_policy(
            request,
            selection,
            max_dataset_rows=10,
        )
        assert policy.indicator_warmup_bars == 2
        assert policy.visible_history_rows == 4
        assert policy.effective_warmup_bars == 4
        assert policy.actual_visible_history_start_ms == START_MS

        all_available = resolve_history_policy(
            await _request(
                service,
                visible_mode="ALL_AVAILABLE",
                visible_duration_ms=None,
            ),
            selection,
            max_dataset_rows=10,
        )
        assert all_available.visible_history_rows == 4
        assert all_available.effective_warmup_bars == 2
        assert all_available.actual_visible_history_start_ms == START_MS
        lazy_all_available = resolve_history_policy(
            await _request(
                service,
                visible_mode="ALL_AVAILABLE",
                visible_duration_ms=None,
            ),
            {
                **selection,
                "selected_start_ms": START_MS + 100_000 * INTERVAL_MS,
            },
            max_dataset_rows=8,
        )
        assert lazy_all_available.visible_history_rows == 100_000
        assert lazy_all_available.effective_warmup_bars == 2

        with pytest.raises(
            TrainingRunError,
            match="contiguous visible history",
        ):
            resolve_history_policy(
                request,
                {**selection, "continuous_history_start_ms": START_MS + INTERVAL_MS},
                max_dataset_rows=10,
            )
        with pytest.raises(TrainingRunError) as exceeded:
            resolve_history_policy(
                request,
                selection,
                max_dataset_rows=9,
            )
        assert exceeded.value.code == "VISIBLE_HISTORY_BUDGET_EXCEEDED"
    finally:
        await service.shutdown()


async def test_phase14_random_selection_occurs_once_then_freezes_exact_start(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "random.db")
    try:
        public_calls = 0
        original_public = service._catalog.select_random

        def counted_public(*args: object, **kwargs: object):
            nonlocal public_calls
            public_calls += 1
            return original_public(*args, **kwargs)

        def forbidden_internal(*_args: object, **_kwargs: object):
            pytest.fail("expanded training catalog re-randomized the selected start")

        monkeypatch.setattr(service._catalog, "select_random", counted_public)
        monkeypatch.setattr(
            service._training_history_catalog,
            "select_random",
            forbidden_internal,
        )
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                start_mode="RANDOM",
                disclosure="HIDE_ALL",
                visible_duration_ms=2 * INTERVAL_MS,
            )
        )
        assert public_calls == 1
        run_id = str(created["run"]["run_id"])
        with sqlite3.connect(service.store.path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                SELECT selection.actual_start_ms, dataset.actual_replay_start_ms,
                       selection.seed_source
                FROM replay_training_start_selection AS selection
                JOIN replay_training_run AS run USING(run_id)
                JOIN replay_dataset_ref AS dataset
                  ON dataset.session_id = run.adapter_session_id
                WHERE selection.run_id = ?
                """,
                (run_id,),
            ).fetchone()
        assert row is not None
        assert row["seed_source"] == "SERVER"
        assert row["actual_start_ms"] == row["actual_replay_start_ms"]
    finally:
        await service.shutdown()


async def test_phase14_history_boundary_hides_indicator_only_rows_and_blinds_time(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "history.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, visible_duration_ms=INTERVAL_MS)
        )
        session_id = str(created["run"]["adapter_session_id"])
        snapshot = (await service.get_session(session_id))["snapshot"]
        cursor = snapshot["cursor"]
        page = await service.training.history_page(  # type: ignore[union-attr]
            session_id,
            track_id="track-1",
            before_ms=int(cursor["virtual_time_ms"]) + 1,
            revealed_boundary_ms=int(cursor["virtual_time_ms"]),
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=None,
        )
        assert page["history_boundary_ms"] == START_MS + 3 * INTERVAL_MS
        assert [bar["open_time_ms"] for bar in page["bars"]] == [
            START_MS + 3 * INTERVAL_MS
        ]
        assert "actual_replay_start_ms" not in page["history_policy"]
        assert "actual_visible_history_start_ms" not in page["history_policy"]

        blind_created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                disclosure="HIDE_ALL",
                visible_duration_ms=INTERVAL_MS,
            )
        )
        blind_session_id = str(blind_created["run"]["adapter_session_id"])
        blind_snapshot = (await service.get_session(blind_session_id))["snapshot"]
        blind_cursor = blind_snapshot["cursor"]
        blind_page = await service.training.history_page(  # type: ignore[union-attr]
            blind_session_id,
            track_id="track-1",
            before_ms=int(blind_cursor["virtual_time_ms"]) + 1,
            revealed_boundary_ms=int(blind_cursor["virtual_time_ms"]),
            limit=10,
            data_epoch=str(blind_snapshot["data_epoch"]),
            history_epoch=None,
        )
        assert blind_page["history_boundary_ms"] == (
            int(blind_cursor["virtual_time_ms"]) - INTERVAL_MS
        )
        assert str(START_MS) not in json.dumps(blind_page, sort_keys=True)
    finally:
        await service.shutdown()


async def test_phase14_none_tier_rejects_before_snapshot_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "none.db")
    try:
        loads = 0

        async def binding(**_kwargs: object) -> dict[str, object]:
            return {"subscription_tier": "NONE"}

        async def load_dataset(_session_id: str) -> None:
            nonlocal loads
            loads += 1
            return None

        monkeypatch.setattr(service.training.store, "history_binding", binding)  # type: ignore[union-attr]
        monkeypatch.setattr(service.store, "load_dataset", load_dataset)
        with pytest.raises(TrainingRunError) as rejected:
            await service.training.history_page(  # type: ignore[union-attr]
                "adapter-none",
                track_id="track-none",
                before_ms=1,
                revealed_boundary_ms=0,
                limit=1,
                data_epoch=f"sha256:{'a' * 64}",
                history_epoch=None,
            )
        assert rejected.value.code == "HISTORY_SUBSCRIPTION_REQUIRED"
        assert loads == 0
    finally:
        await service.shutdown()


async def test_phase14_warm_secondary_track_uses_its_own_frozen_epoch(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "warm-secondary.db",
        extra_symbols=("ETHUSDT",),
    )
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, visible_duration_ms=4 * INTERVAL_MS)
        )
        run_id = str(created["run"]["run_id"])
        primary_session_id = str(created["run"]["adapter_session_id"])
        primary = await service.get_session(primary_session_id)
        added = await service.training.command(  # type: ignore[union-attr]
            run_id,
            _command(
                run_id,
                "phase14-add-warm-secondary",
                ReplayV2CommandType.ADD_TRACK,
                primary,
                {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "ETHUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "WARM",
                },
            ),
        )
        track = added["data"]["track"]
        assert isinstance(track, dict)
        secondary_session_id = str(track["adapter_session_id"])
        assert secondary_session_id != primary_session_id
        secondary = await service.get_session(secondary_session_id)
        primary_snapshot = primary["snapshot"]
        secondary_snapshot = secondary["snapshot"]
        assert isinstance(primary_snapshot, dict)
        assert isinstance(secondary_snapshot, dict)
        assert secondary_snapshot["data_epoch"] != primary_snapshot["data_epoch"]
        cursor = secondary_snapshot["cursor"]
        assert isinstance(cursor, dict)

        page = await service.training.history_page(  # type: ignore[union-attr]
            secondary_session_id,
            track_id=str(track["track_id"]),
            before_ms=int(cursor["virtual_time_ms"]) + 1,
            revealed_boundary_ms=int(cursor["virtual_time_ms"]),
            limit=10,
            data_epoch=str(secondary_snapshot["data_epoch"]),
            history_epoch=None,
        )
        assert page["data_epoch"] == secondary_snapshot["data_epoch"]
        assert page["history_policy"]["visible_history_rows"] == 4
        assert len(page["bars"]) == 4
    finally:
        await service.shutdown()


async def test_phase14_segment_covers_full_frozen_history_and_policy_roles(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "segment.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                visible_duration_ms=4 * INTERVAL_MS,
            )
        )
        run_id = str(created["run"]["run_id"])
        with sqlite3.connect(service.store.path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                SELECT segment.range_start_ms, segment.range_end_ms,
                       segment.rehydration_manifest_json,
                       dataset.actual_replay_start_ms
                FROM replay_data_segment AS segment
                JOIN replay_data_segment_ref AS ref USING(segment_id)
                JOIN replay_training_run AS run USING(run_id)
                JOIN replay_dataset_ref AS dataset
                  ON dataset.session_id = run.adapter_session_id
                WHERE ref.run_id = ? AND ref.owner_kind = 'RUN_ARCHIVE'
                """,
                (run_id,),
            ).fetchone()
        assert row is not None
        assert row["range_start_ms"] == (
            row["actual_replay_start_ms"] - 4 * INTERVAL_MS
        )
        manifest = json.loads(str(row["rehydration_manifest_json"]))
        assert manifest["range"]["start_ms"] == row["range_start_ms"]
        assert manifest["history_policy"]["visible_history_rows"] == 4
        assert manifest["history_policy"]["effective_warmup_bars"] == 4
        assert manifest["history_policy"]["dataset_history_start_ms"] == (
            row["range_start_ms"]
        )
    finally:
        await service.shutdown()


async def test_phase14_v9_additive_policy_table_backfills_and_keeps_rollback_version(
    tmp_path: Path,
) -> None:
    path = tmp_path / "additive.db"
    service = await _service(path)
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                indicator_warmup_bars=2,
                visible_duration_ms=2 * INTERVAL_MS,
            )
        )
        run_id = str(created["run"]["run_id"])
    finally:
        await service.shutdown()

    with sqlite3.connect(path) as connection:
        connection.execute("DROP TABLE replay_training_data_policy")
        connection.commit()

    restarted = await _service(path)
    try:
        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            version = connection.execute(
                """
                SELECT version FROM replay_training_schema_version
                WHERE singleton = 1
                """
            ).fetchone()
            policy = connection.execute(
                """
                SELECT * FROM replay_training_data_policy
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            quick_check = connection.execute("PRAGMA quick_check").fetchone()
            foreign_key_check = connection.execute(
                "PRAGMA foreign_key_check"
            ).fetchall()
        assert version is not None
        assert version["version"] == TRAINING_SCHEMA_VERSION == 9
        assert policy is not None
        assert policy["indicator_warmup_bars"] == 2
        assert policy["visible_history_mode"] == "DURATION"
        assert policy["visible_history_rows"] == 2
        assert policy["effective_warmup_bars"] == 2
        assert policy["policy_hash"] == data_policy_hash(
            indicator_warmup_bars=policy["indicator_warmup_bars"],
            visible_history_mode=policy["visible_history_mode"],
            visible_history_lookback_ms=policy["visible_history_lookback_ms"],
            visible_history_rows=policy["visible_history_rows"],
            actual_visible_history_start_ms=policy[
                "actual_visible_history_start_ms"
            ],
            actual_replay_start_ms=policy["actual_replay_start_ms"],
            effective_warmup_bars=policy["effective_warmup_bars"],
            forward_cache_ms=policy["forward_cache_ms"],
            interval_ms=policy["interval_ms"],
        )
        assert quick_check is not None
        assert quick_check[0] == "ok"
        assert foreign_key_check == []
    finally:
        await restarted.shutdown()
