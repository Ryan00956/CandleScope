from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.disclosure import project_public_time
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import TimeDisclosurePolicy, TrainingRunCreateRequest
from app.replay.training.schema import TRAINING_SCHEMA_VERSION, start_selection_hash
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


def _seed_factory(values: tuple[int, ...]) -> tuple[Iterator[int], object]:
    source = iter(values)

    def next_seed() -> int:
        return next(source)

    return source, next_seed


async def _service(
    path: Path,
    *,
    seeds: tuple[int, ...] = (7, 11, 13, 17, 19, 23, 29, 31, 37),
    prefix: str = "phase12-run",
) -> ReplayService:
    _source, next_seed = _seed_factory(seeds)
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory(f"{prefix}-adapter"),
        training_run_id_factory=SessionIdFactory(prefix),
        training_random_seed_factory=next_seed,
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _request(
    service: ReplayService,
    *,
    disclosure: str,
    start_mode: str = "RANDOM",
    client_seed: int | None = None,
    warmup_bars: int = 2,
    display_interval: str = "1m",
) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=warmup_bars,
        horizon_ms=8 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=start_mode == "RANDOM" and disclosure != "NONE",
    )
    payload: dict[str, object] = {
        "protocol": "replay.v2",
        "catalog_epoch": catalog["catalog_epoch"],
        "name": f"Phase 12 {disclosure}",
        "source_kind": "BAR",
        "start_mode": start_mode,
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "settlement_asset": "USDT",
        "base_interval": "1m",
        "display_interval": display_interval,
        "requested_start_ms": (
            START_MS + 4 * INTERVAL_MS if start_mode == "MANUAL" else None
        ),
        "warmup_bars": warmup_bars,
        "forward_cache_ms": 8 * INTERVAL_MS,
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
        "allowed_mutations": [],
    }
    if client_seed is not None:
        payload["random_seed"] = client_seed
    return TrainingRunCreateRequest.from_dict(payload)


async def test_random_start_seed_is_server_owned_private_and_durably_committed(
    tmp_path: Path,
) -> None:
    path = tmp_path / "server-seed.db"
    service = await _service(path, seeds=(887_766_551,))
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                disclosure="HIDE_ALL",
                client_seed=42,
            )
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        public_session = await service.get_session(session_id)
        public_config = public_session["snapshot"]["config"]
        assert public_config["random_seed"] == 0

        integrity = await service.training.integrity(run_id)  # type: ignore[union-attr]
        assert integrity["active_rule"]["random_seed"] is None
        selection = integrity["start_selection"]
        assert selection["seed_source"] == "SERVER"
        assert selection["seed_disclosed"] is False
        assert selection["random_seed"] is None
        assert selection["selection_hash"].startswith("sha256:")

        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            stored = connection.execute(
                """
                SELECT selection.seed_source, selection.random_seed,
                       selection.actual_start_ms, selection.actual_end_ms,
                       selection.dataset_epoch, selection.selection_hash,
                       session.config_json
                FROM replay_training_start_selection AS selection
                JOIN replay_training_run AS run USING(run_id)
                JOIN replay_session AS session
                  ON session.session_id = run.adapter_session_id
                WHERE selection.run_id = ?
                """,
                (run_id,),
            ).fetchone()
        assert stored is not None
        assert stored["seed_source"] == "SERVER"
        assert stored["random_seed"] == 887_766_551
        assert json.loads(stored["config_json"])["random_seed"] == 887_766_551
        assert stored["dataset_epoch"] == selection["dataset_epoch"]
        assert stored["selection_hash"] == selection["selection_hash"]
        assert str(stored["actual_start_ms"]) not in json.dumps(integrity)
    finally:
        await service.shutdown(step_timeout=1.0)

    recovered = await _service(path, seeds=(1,), prefix="phase12-recovered")
    try:
        session = await recovered.get_session(session_id)
        assert session["snapshot"]["config"]["random_seed"] == 0
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                """
                SELECT random_seed FROM replay_training_start_selection
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone() == (887_766_551,)
    finally:
        await recovered.shutdown(step_timeout=1.0)


@pytest.mark.parametrize(
    "policy",
    (
        "NONE",
        "HIDE_YEAR",
        "HIDE_MONTH",
        "HIDE_DAY",
        "HIDE_HOUR",
        "HIDE_MINUTE",
        "HIDE_ALL",
    ),
)
async def test_public_time_batch_uses_exact_server_projection_for_every_policy(
    tmp_path: Path,
    policy: str,
) -> None:
    service = await _service(tmp_path / f"public-{policy}.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, disclosure=policy, start_mode="MANUAL")
        )
        run_id = str(created["run"]["run_id"])
        session = await service.get_session(str(created["run"]["adapter_session_id"]))
        cursor_ms = int(session["snapshot"]["cursor"]["virtual_time_ms"])
        response = await service.training.public_times(  # type: ignore[union-attr]
            run_id,
            timeline_ms=(cursor_ms, cursor_ms + INTERVAL_MS),
        )
        assert response["policy"] == policy
        assert [item["input_timeline_ms"] for item in response["items"]] == [
            cursor_ms,
            cursor_ms + INTERVAL_MS,
        ]
        with sqlite3.connect(tmp_path / f"public-{policy}.db") as connection:
            row = connection.execute(
                """
                SELECT d.actual_replay_start_ms, d.synthetic_origin_ms
                FROM replay_training_run AS r
                JOIN replay_dataset_ref AS d
                  ON d.session_id = r.adapter_session_id
                WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()
        assert row is not None
        actual_origin = int(row[0])
        public_origin = actual_origin if policy == "NONE" else int(row[1])
        for index, item in enumerate(response["items"]):
            public_ms = cursor_ms + index * INTERVAL_MS
            actual_ms = actual_origin + public_ms - public_origin
            expected = project_public_time(
                actual_time_ms=actual_ms,
                public_time_ms=public_ms,
                actual_origin_ms=actual_origin,
                public_origin_ms=public_origin,
                policy=TimeDisclosurePolicy(policy),
                sequence=index,
            )
            assert item["public_time"] == expected
        if policy != "NONE":
            assert "2024" not in json.dumps(response)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_v8_start_selection_backfill_is_additive_and_does_not_rewrite_v1(
    tmp_path: Path,
) -> None:
    path = tmp_path / "v8-backfill.db"
    service = await _service(path, seeds=(123_456,))
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, disclosure="HIDE_DAY")
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
    finally:
        await service.shutdown(step_timeout=1.0)

    with sqlite3.connect(path) as connection:
        config_before = connection.execute(
            "SELECT config_json FROM replay_session WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        assert config_before is not None
        connection.execute("DROP TABLE replay_training_start_selection")
        connection.execute(
            """
            UPDATE replay_training_schema_version
            SET version = 8
            WHERE singleton = 1
            """
        )
        connection.commit()

    migrated = await _service(path, seeds=(999,), prefix="phase12-migrated")
    try:
        assert TRAINING_SCHEMA_VERSION == 9
        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            version = connection.execute(
                """
                SELECT version FROM replay_training_schema_version
                WHERE singleton = 1
                """
            ).fetchone()
            selection = connection.execute(
                """
                SELECT * FROM replay_training_start_selection
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            config_after = connection.execute(
                "SELECT config_json FROM replay_session WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        assert version is not None and version["version"] == 9
        assert selection is not None
        assert selection["seed_source"] == "LEGACY_CLIENT"
        assert selection["random_seed"] == 123_456
        assert selection["selection_hash"].startswith("sha256:")
        assert config_after is not None
        assert config_after["config_json"] == config_before[0]
    finally:
        await migrated.shutdown(step_timeout=1.0)


async def test_public_time_batch_allows_display_bucket_alignment_but_not_dataset_escape(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "display-alignment.db"
    service = await _service(database_path)
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(
                service,
                disclosure="HIDE_ALL",
                warmup_bars=2,
                display_interval="1h",
            )
        )
        run_id = str(created["run"]["run_id"])
        session = await service.get_session(str(created["run"]["adapter_session_id"]))
        origin = int(session["snapshot"]["cursor"]["virtual_time_ms"])
        projected = await service.training.public_times(  # type: ignore[union-attr]
            run_id,
            timeline_ms=(origin - 60 * INTERVAL_MS, origin),
        )
        assert len(projected["items"]) == 2
        with pytest.raises(TrainingRunError, match="outside the pinned"):
            await service.training.public_times(  # type: ignore[union-attr]
                run_id,
                timeline_ms=(origin - 62 * INTERVAL_MS,),
            )
        with sqlite3.connect(database_path) as connection:
            bounds = connection.execute(
                """
                SELECT d.actual_replay_start_ms, d.actual_replay_end_ms,
                       d.synthetic_origin_ms
                FROM replay_training_run AS r
                JOIN replay_dataset_ref AS d
                  ON d.session_id = r.adapter_session_id
                WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()
        assert bounds is not None
        actual_start_ms = int(bounds[0])
        actual_end_open_ms = int(bounds[1])
        public_origin_ms = int(bounds[2])
        public_last_open_ms = (
            public_origin_ms + actual_end_open_ms - actual_start_ms
        )
        public_last_close_ms = public_last_open_ms + INTERVAL_MS - 1
        projected_end = await service.training.public_times(  # type: ignore[union-attr]
            run_id,
            timeline_ms=(public_last_open_ms, public_last_close_ms),
        )
        assert [
            item["input_timeline_ms"] for item in projected_end["items"]
        ] == [public_last_open_ms, public_last_close_ms]
        with pytest.raises(TrainingRunError, match="outside the pinned"):
            await service.training.public_times(  # type: ignore[union-attr]
                run_id,
                timeline_ms=(public_last_close_ms + 1,),
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_integrity_fails_closed_when_start_selection_commitment_or_bounds_drift(
    tmp_path: Path,
) -> None:
    path = tmp_path / "selection-integrity.db"
    service = await _service(path, seeds=(777_888_999,))
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, disclosure="HIDE_ALL")
        )
        run_id = str(created["run"]["run_id"])
        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            selection = connection.execute(
                """
                SELECT * FROM replay_training_start_selection
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            assert selection is not None
            connection.execute(
                """
                UPDATE replay_training_start_selection
                SET selection_hash = ?
                WHERE run_id = ?
                """,
                (f"sha256:{'0' * 64}", run_id),
            )
            connection.commit()

        with pytest.raises(TrainingRunError, match="commitment"):
            await service.training.integrity(run_id)  # type: ignore[union-attr]

        drifted_end_ms = int(selection["actual_end_ms"]) + INTERVAL_MS
        drifted_hash = start_selection_hash(
            run_id=run_id,
            start_mode=str(selection["start_mode"]),
            seed_source=str(selection["seed_source"]),
            random_seed=int(selection["random_seed"]),
            actual_start_ms=int(selection["actual_start_ms"]),
            actual_end_ms=drifted_end_ms,
            dataset_epoch=str(selection["dataset_epoch"]),
            parent_selection_hash=None,
        )
        with sqlite3.connect(path) as connection:
            connection.execute(
                """
                UPDATE replay_training_start_selection
                SET actual_end_ms = ?, selection_hash = ?
                WHERE run_id = ?
                """,
                (drifted_end_ms, drifted_hash, run_id),
            )
            connection.commit()

        with pytest.raises(TrainingRunError, match="dataset bounds disagree"):
            await service.training.integrity(run_id)  # type: ignore[union-attr]
    finally:
        await service.shutdown(step_timeout=1.0)
