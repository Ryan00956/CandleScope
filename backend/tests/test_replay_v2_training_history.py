from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import TrainingRunCreateRequest
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


async def _service(path: Path) -> tuple[ReplayService, object]:
    repository = replay_repository()
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=repository,
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory("run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service, repository


async def _create_run(
    service: ReplayService,
    *,
    disclosure: str = "NONE",
) -> tuple[dict[str, object], dict[str, object]]:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=5 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=disclosure != "NONE",
    )
    request = TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Phase 2 history",
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
            "random_seed": 42,
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
    training = service.training
    assert training is not None
    created = await training.create_run(request)
    session = await service.get_session("adapter-1")
    return created, session["snapshot"]  # type: ignore[return-value]


async def test_history_pages_are_snapshot_bound_revealed_only_and_repository_free(
    tmp_path: Path,
) -> None:
    service, repository = await _service(tmp_path / "history.db")
    try:
        _created, snapshot = await _create_run(service)
        training = service.training
        assert training is not None
        boundary = snapshot["cursor"]["virtual_time_ms"]  # type: ignore[index]
        data_epoch = snapshot["data_epoch"]
        repository_calls = len(repository.calls)  # type: ignore[attr-defined]

        first = await training.history_page(
            "adapter-1",
            track_id="track-1",
            before_ms=boundary + 1,
            revealed_boundary_ms=boundary,
            limit=1,
            data_epoch=data_epoch,
            history_epoch=None,
        )

        assert first["protocol"] == "replay.v2"
        assert first["schema_version"] == "replay.history.v1"
        assert first["track_id"] == "track-1"
        assert first["data_epoch"] == data_epoch
        assert first["revealed_boundary_ms"] == boundary
        assert len(first["bars"]) == 1
        assert max(bar["close_time_ms"] for bar in first["bars"]) <= boundary
        assert len(repository.calls) == repository_calls  # type: ignore[attr-defined]

        second = await training.history_page(
            "adapter-1",
            track_id="track-1",
            before_ms=first["next_before_ms"],
            revealed_boundary_ms=boundary,
            limit=10,
            data_epoch=data_epoch,
            history_epoch=first["history_epoch"],
        )
        assert second["history_epoch"] == first["history_epoch"]
        assert {bar["open_time_ms"] for bar in first["bars"]}.isdisjoint(
            {bar["open_time_ms"] for bar in second["bars"]}
        )
        assert second["has_more"] is False
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_history_rejects_epoch_boundary_and_source_identity_drift(
    tmp_path: Path,
) -> None:
    path = tmp_path / "drift.db"
    service, _repository = await _service(path)
    try:
        _created, snapshot = await _create_run(service)
        training = service.training
        assert training is not None
        boundary = snapshot["cursor"]["virtual_time_ms"]  # type: ignore[index]
        data_epoch = snapshot["data_epoch"]
        page = await training.history_page(
            "adapter-1",
            track_id="track-1",
            before_ms=boundary + 1,
            revealed_boundary_ms=boundary,
            limit=10,
            data_epoch=data_epoch,
            history_epoch=None,
        )

        checks = (
            ({"data_epoch": f"sha256:{'f' * 64}"}, "HISTORY_DATA_EPOCH_MISMATCH"),
            ({"history_epoch": f"sha256:{'e' * 64}"}, "HISTORY_EPOCH_MISMATCH"),
            ({"revealed_boundary_ms": boundary + 1}, "HISTORY_BOUNDARY_AHEAD"),
        )
        for overrides, expected_code in checks:
            arguments = {
                "track_id": "track-1",
                "before_ms": boundary + 1,
                "revealed_boundary_ms": boundary,
                "limit": 10,
                "data_epoch": data_epoch,
                "history_epoch": page["history_epoch"],
                **overrides,
            }
            with pytest.raises(TrainingRunError) as failure:
                await training.history_page("adapter-1", **arguments)
            assert failure.value.code == expected_code

        with sqlite3.connect(path) as connection:
            connection.execute(
                "UPDATE replay_training_track SET symbol = 'ETHUSDT' WHERE run_id = 'run-1'"
            )
            connection.commit()
        with pytest.raises(TrainingRunError) as drift:
            await training.history_page(
                "adapter-1",
                track_id="track-1",
                before_ms=boundary + 1,
                revealed_boundary_ms=boundary,
                limit=10,
                data_epoch=data_epoch,
                history_epoch=page["history_epoch"],
            )
        assert drift.value.code == "HISTORY_SOURCE_IDENTITY_DRIFT"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_blind_history_uses_only_the_public_synthetic_timeline(
    tmp_path: Path,
) -> None:
    service, _repository = await _service(tmp_path / "blind-history.db")
    try:
        _created, snapshot = await _create_run(service, disclosure="HIDE_ALL")
        training = service.training
        assert training is not None
        boundary = snapshot["cursor"]["virtual_time_ms"]  # type: ignore[index]
        page = await training.history_page(
            "adapter-1",
            track_id="track-1",
            before_ms=boundary + 1,
            revealed_boundary_ms=boundary,
            limit=10,
            data_epoch=snapshot["data_epoch"],
            history_epoch=None,
        )
        encoded = json.dumps(page, sort_keys=True)
        assert str(START_MS) not in encoded
        assert "actual_replay" not in encoded
        assert all(bar["close_time_ms"] <= boundary for bar in page["bars"])
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_agg_trade_training_history_decodes_the_frozen_bundle(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "trade-archive")
    path = tmp_path / "trade-history.db"
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
        store=ReplaySQLiteStore(path, now_ms=lambda: TRADE_NOW_MS),
        repository=trade_replay_repository(),
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory("run"),
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
                "name": "Trade history",
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
        training = service.training
        assert training is not None
        await training.create_run(request)
        session = await service.get_session("adapter-1")
        snapshot = session["snapshot"]
        boundary = snapshot["cursor"]["virtual_time_ms"]
        page = await training.history_page(
            "adapter-1",
            track_id="track-1",
            before_ms=boundary + 1,
            revealed_boundary_ms=boundary,
            limit=10,
            data_epoch=snapshot["data_epoch"],
            history_epoch=None,
        )
        assert page["identity"]["source_kind"] == "AGG_TRADE"
        assert page["bars"]
        assert all(bar["close_time_ms"] <= boundary for bar in page["bars"])
    finally:
        await service.shutdown(step_timeout=1.0)
