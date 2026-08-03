from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.canonical import canonical_sha256
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import ReplayLaunchContext
from tests.test_replay_v2_training_phase1 import _request, _service


pytestmark = pytest.mark.anyio


def _live_launch_context() -> ReplayLaunchContext:
    return ReplayLaunchContext.from_dict(
        {
            "schema_version": "replay.launch-context.v1",
            "source": "LIVE_PAGE",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "display_interval": "1m",
            "watchlist_snapshot": {
                "schema_version": "replay.watchlist-snapshot.v1",
                "groups": [
                    {
                        "id": "majors",
                        "name": "主流币",
                        "color": "#3b82f6",
                        "items": [
                            {
                                "exchange": "binance",
                                "market_type": "spot",
                                "symbol": "BTCUSDT",
                            },
                            {
                                "exchange": "binance",
                                "market_type": "spot",
                                "symbol": "ETHUSDT",
                            },
                        ],
                    },
                    {
                        "id": "hedges",
                        "name": "跨市场观察",
                        "color": "#8b5cf6",
                        "items": [
                            {
                                "exchange": "okx",
                                "market_type": "swap",
                                "symbol": "BTC-USDT-SWAP",
                            }
                        ],
                    },
                ],
            },
        }
    )


async def test_live_launch_context_is_atomic_hashed_and_projected(
    tmp_path: Path,
) -> None:
    path = tmp_path / "phase11.db"
    service = await _service(path, run_prefix="phase11")
    try:
        request = replace(
            await _request(service),
            launch_context=_live_launch_context(),
        )
        created = await service.training.create_run(request)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        projection = await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        context = projection["launch_context"]
        assert context == _live_launch_context().to_dict()
        assert projection["tracks"][0]["subscription_tier"] == "FULL"
        assert len(projection["tracks"]) == 1

        with sqlite3.connect(path) as connection:
            stored = connection.execute(
                """
                SELECT context_json, context_hash
                FROM replay_training_launch_context
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            rule_json = connection.execute(
                """
                SELECT rule_json FROM replay_training_rule
                WHERE run_id = ? AND revision = 1
                """,
                (run_id,),
            ).fetchone()[0]
        assert stored is not None
        decoded = json.loads(stored[0])
        assert stored[1] == canonical_sha256(decoded)
        assert "launch_context" not in json.loads(rule_json)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_launch_context_primary_identity_cannot_drift_from_create_request(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "identity.db", run_prefix="phase11")
    try:
        with pytest.raises(ValueError, match="primary identity"):
            replace(
                await _request(service),
                launch_context=replace(_live_launch_context(), symbol="ETHUSDT"),
            )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_launch_context_accepts_hyphenated_market_symbols(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "hyphenated.db", run_prefix="phase11")
    try:
        context = ReplayLaunchContext.from_dict(
            {
                "schema_version": "replay.launch-context.v1",
                "source": "LIVE_PAGE",
                "exchange": "okx",
                "market_type": "futures",
                "symbol": "BTC-USDT-SWAP",
                "display_interval": "15m",
                "watchlist_snapshot": {
                    "schema_version": "replay.watchlist-snapshot.v1",
                    "groups": [],
                },
            }
        )
        request = replace(
            await _request(service),
            exchange="okx",
            market_type="futures",
            symbol="BTC-USDT-SWAP",
            display_interval="15m",
            launch_context=context,
        )
        assert request.symbol == "BTC-USDT-SWAP"
        assert request.resolved_launch_context() == context
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize("damage", ("missing", "invalid_json", "invalid_hash"))
async def test_launch_context_storage_damage_fails_closed(
    tmp_path: Path,
    damage: str,
) -> None:
    path = tmp_path / f"context-{damage}.db"
    service = await _service(path, run_prefix="phase11")
    try:
        request = replace(
            await _request(service),
            launch_context=_live_launch_context(),
        )
        created = await service.training.create_run(request)  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        with sqlite3.connect(path) as connection:
            if damage == "missing":
                connection.execute(
                    "DELETE FROM replay_training_launch_context WHERE run_id = ?",
                    (run_id,),
                )
            elif damage == "invalid_json":
                connection.execute(
                    """
                    UPDATE replay_training_launch_context
                    SET context_json = '{'
                    WHERE run_id = ?
                    """,
                    (run_id,),
                )
            else:
                connection.execute(
                    """
                    UPDATE replay_training_launch_context
                    SET context_hash = ?
                    WHERE run_id = ?
                    """,
                    (f"sha256:{'0' * 64}", run_id),
                )
            connection.commit()

        with pytest.raises(TrainingRunError) as degraded:
            await service.training.get_market_tracks(run_id)  # type: ignore[union-attr]
        assert degraded.value.code == "TRAINING_RUN_STORAGE_DEGRADED"
        assert degraded.value.status_code == 503
    finally:
        await service.shutdown(step_timeout=1.0)
