from __future__ import annotations

import json
from pathlib import Path
import sqlite3

import httpx
import pytest
from fastapi import FastAPI

from app.api.v1.replay import router
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.models import (
    TrainingRunMarketSelectionRequest,
    TrainingRunSetupRequest,
)
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


async def _service(path: Path, *, random_seed: int = 1) -> ReplayService:
    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory("run"),
        training_random_seed_factory=lambda: random_seed,
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


def _app(service: ReplayService) -> FastAPI:
    app = FastAPI()
    app.state.replay_service = service
    app.include_router(router, prefix="/api/v1")
    return app


async def _request(app: FastAPI, method: str, path: str, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


def _setup_payload() -> dict[str, object]:
    return {
        "protocol": "replay.v3",
        "name": "不绑定商品的训练",
        "source_kind": "BAR",
        "start_mode": "MANUAL",
        "settlement_asset": "USDT",
        "requested_start_ms": START_MS + 4 * INTERVAL_MS,
        "indicator_warmup_bars": 2,
        "visible_history_lookback": {
            "mode": "DURATION",
            "duration_ms": 2 * INTERVAL_MS,
        },
        "forward_cache_ms": 5 * INTERVAL_MS,
        "random_seed": None,
        "initial_equity": "10000",
        "max_leverage": "3",
        "maker_fee_bps": "2",
        "taker_fee_bps": "5",
        "market_slippage_bps": "1",
        "integrity_mode": "CHALLENGE",
        "time_disclosure_policy": "HIDE_ALL",
        "book_mode": "OFF",
        "margin_mode": "CROSS",
        "position_mode": "ONE_WAY",
        "funding_mode": "OFF",
        "account_data_mode": "APPROX_PROXY",
        "fixed_funding_rate": None,
        "funding_interval_ms": None,
        "allow_rule_changes": False,
        "allowed_mutations": [],
        "market_selection_hint": None,
    }


def test_live_market_hint_preserves_watchlist_without_binding_the_first_symbol() -> None:
    payload = _setup_payload()
    payload["market_selection_hint"] = {
        "schema_version": "replay.launch-context.v1",
        "source": "LIVE_PAGE",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "display_interval": "15m",
        "watchlist_snapshot": {
            "schema_version": "replay.watchlist-snapshot.v1",
            "groups": [{
                "id": "majors",
                "name": "主流币",
                "color": "#38bdf8",
                "items": [{
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "ETHUSDT",
                }],
            }],
        },
    }
    setup = TrainingRunSetupRequest.from_dict(payload)
    request = setup.for_market(TrainingRunMarketSelectionRequest(
        catalog_epoch="sha256:" + "a" * 64,
        exchange="binance",
        market_type="spot",
        symbol="ETHUSDT",
        base_interval="1m",
        display_interval="1m",
    ))

    assert request.symbol == "ETHUSDT"
    assert request.launch_context is not None
    assert request.launch_context.symbol == "ETHUSDT"
    assert request.launch_context.display_interval == "1m"
    assert request.launch_context.source == "LIVE_PAGE"
    assert request.launch_context.watchlist_snapshot.groups[0].items[0].symbol == "ETHUSDT"


async def test_empty_run_is_initialized_by_first_market_without_changing_identity(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "run-centric.db")
    app = _app(service)
    try:
        created = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=_setup_payload(),
        )
        assert created.status_code == 201, created.text
        shell = created.json()["run"]
        assert shell["run_id"] == "run-1"
        assert shell["state"] == "AWAITING_MARKET"
        assert shell["resume_action"] == "SELECT_MARKET"
        assert shell["last_symbol"] is None
        assert shell["adapter_session_id"] is None

        viewer = await _request(app, "GET", "/api/v1/replay/runs/run-1/viewer")
        assert viewer.status_code == 200
        assert viewer.json()["viewer_state"]["selected_track_id"] is None
        tracks = await _request(app, "GET", "/api/v1/replay/runs/run-1/tracks")
        assert tracks.status_code == 200, tracks.text
        assert tracks.json()["tracks"] == []
        assert tracks.json()["launch_context"] is None

        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        initialized = await _request(
            app,
            "POST",
            "/api/v1/replay/runs/run-1/markets",
            json={
                "catalog_epoch": catalog["catalog_epoch"],
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "account_history_ref": None,
            },
        )
        assert initialized.status_code == 201, initialized.text
        run = initialized.json()["run"]
        assert run["run_id"] == "run-1"
        assert run["state"] == "PAUSED"
        assert run["last_symbol"] == "BTCUSDT"
        assert run["adapter_session_id"] == "adapter-1"
        assert run["resume_action"] == "OPEN_ADAPTER"

        initialized_tracks = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/run-1/tracks",
        )
        assert initialized_tracks.status_code == 200
        assert [item["symbol"] for item in initialized_tracks.json()["tracks"]] == [
            "BTCUSDT"
        ]
        assert initialized_tracks.json()["viewer_state"]["selected_track_id"] == "track-1"

        post_init_catalog = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/run-1/market-catalog",
        )
        assert post_init_catalog.status_code == 200
        assert post_init_catalog.json()["catalog_epoch"] == catalog["catalog_epoch"]
        public_catalog = post_init_catalog.json()
        assert public_catalog["blind_mode"] is True
        assert public_catalog["entries"][0]["identity"]["symbol"] == "BTCUSDT"
        assert public_catalog["entries"][0]["bounds"] is None
        assert public_catalog["entries"][0]["eligible_ranges"] == []
        serialized_public_catalog = json.dumps(public_catalog, sort_keys=True)
        assert "source_fingerprint" not in serialized_public_catalog
        assert str(START_MS) not in serialized_public_catalog
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_failed_first_market_selection_leaves_run_empty(tmp_path: Path) -> None:
    service = await _service(tmp_path / "run-centric-failure.db")
    app = _app(service)
    try:
        created = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=_setup_payload(),
        )
        assert created.status_code == 201

        failed = await _request(
            app,
            "POST",
            "/api/v1/replay/runs/run-1/markets",
            json={
                "catalog_epoch": "sha256:" + "f" * 64,
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "account_history_ref": None,
            },
        )
        assert failed.status_code == 409
        detail = await _request(app, "GET", "/api/v1/replay/runs/run-1")
        assert detail.status_code == 200
        assert detail.json()["state"] == "AWAITING_MARKET"
        assert detail.json()["adapter_session_id"] is None
        tracks = await _request(app, "GET", "/api/v1/replay/runs/run-1/tracks")
        assert tracks.status_code == 200
        assert tracks.json()["tracks"] == []
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_unsupported_market_never_moves_the_committed_start(tmp_path: Path) -> None:
    database = tmp_path / "immutable-start.db"
    service = await _service(database)
    app = _app(service)
    payload = _setup_payload()
    payload["requested_start_ms"] = START_MS - INTERVAL_MS
    try:
        created = await _request(app, "POST", "/api/v1/replay/runs", json=payload)
        assert created.status_code == 201, created.text
        catalog = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/run-1/market-catalog",
        )
        assert catalog.status_code == 200, catalog.text
        body = catalog.json()
        assert body["time_commitment"]["committed_start_ms"] is None
        assert body["entries"][0]["start_compatibility"] == {
            "state": "UNSUPPORTED",
            "code": "MARKET_NOT_LISTED_AT_START",
            "message": "本局开始时该商品尚未上市或尚无历史数据。",
        }
        rejected = await _request(
            app,
            "POST",
            "/api/v1/replay/runs/run-1/markets",
            json={
                "catalog_epoch": body["catalog_epoch"],
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "account_history_ref": None,
            },
        )
        assert rejected.status_code == 409
        assert rejected.json()["error"]["code"] == "MARKET_NOT_LISTED_AT_START"
        assert rejected.json()["error"]["details"]["requires_new_run"] is True
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT committed_start_ms FROM replay_training_time_commitment"
            ).fetchone() == (START_MS - INTERVAL_MS,)
            assert connection.execute(
                "SELECT state, virtual_time_ms FROM replay_training_run"
            ).fetchone() == ("AWAITING_MARKET", START_MS - INTERVAL_MS)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_range_random_commits_once_before_market_selection(tmp_path: Path) -> None:
    database = tmp_path / "range-random.db"
    service = await _service(database, random_seed=1)
    app = _app(service)
    payload = _setup_payload()
    payload.update({
        "start_mode": "RANDOM",
        "requested_start_ms": None,
        "random_range_start_ms": START_MS + 3 * INTERVAL_MS,
        "random_range_end_ms": START_MS + 5 * INTERVAL_MS,
    })
    try:
        created = await _request(app, "POST", "/api/v1/replay/runs", json=payload)
        assert created.status_code == 201, created.text
        catalog = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/run-1/market-catalog",
        )
        body = catalog.json()
        assert body["time_commitment"]["committed_start_ms"] is None
        assert body["time_commitment"]["random_range_start_ms"] is None
        assert body["entries"][0]["start_compatibility"]["state"] == "READY"
        initialized = await _request(
            app,
            "POST",
            "/api/v1/replay/runs/run-1/markets",
            json={
                "catalog_epoch": body["catalog_epoch"],
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "account_history_ref": None,
            },
        )
        assert initialized.status_code == 201, initialized.text
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT random_seed, committed_start_ms FROM replay_training_time_commitment"
            ).fetchone() == (1, START_MS + 4 * INTERVAL_MS)
            assert connection.execute(
                "SELECT random_seed, actual_start_ms FROM replay_training_start_selection"
            ).fetchone() == (1, START_MS + 4 * INTERVAL_MS)
    finally:
        await service.shutdown(step_timeout=1.0)
