from __future__ import annotations

import json
from pathlib import Path
import sqlite3

import httpx
import pytest
from fastapi import FastAPI

import app.replay.training.service as training_service_module
from app.api.v1.replay import (
    TrainingRunPreparationPayload,
    TrainingRunSetupPayload,
    router,
)
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.models import (
    TrainingRunCreateRequest,
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
from tests.fixtures.replay.trade_service_fakes import (
    TRADE_NOW_MS,
    TRADE_REPLAY_START_MS,
    trade_replay_repository,
    verified_trade_archive,
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


async def _trade_service(path: Path, archive_root: Path, *, random_seed: int = 1):
    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: TRADE_NOW_MS),
        repository=trade_replay_repository(),
        raw_trade_archive=verified_trade_archive(archive_root),
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("trade-adapter"),
        training_run_id_factory=SessionIdFactory("trade-run"),
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


def test_omitted_position_policy_defaults_to_selectable_one_way() -> None:
    payload = _setup_payload()
    payload.pop("position_mode")
    payload.pop("account_data_mode")
    api_payload = TrainingRunSetupPayload.model_validate(payload).model_dump(mode="json")
    setup = TrainingRunSetupRequest.from_dict(api_payload)

    assert setup.to_dict()["position_mode"] == "ONE_WAY"
    assert setup.to_dict()["account_data_mode"] == "APPROX_PROXY"
    assert setup.to_dict()["funding_mode"] == "OFF"

    preparation_payload = {
        **payload,
        "catalog_epoch": "sha256:" + "a" * 64,
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "base_interval": "1m",
        "display_interval": "1m",
        "launch_context": None,
    }
    preparation_payload.pop("market_selection_hint")
    preparation_api_payload = TrainingRunPreparationPayload.model_validate(
        preparation_payload
    ).model_dump(mode="json")
    preparation = TrainingRunCreateRequest.from_dict(preparation_api_payload)

    assert preparation.position_mode.value == "ONE_WAY"
    assert preparation.account_data_mode.value == "APPROX_PROXY"
    assert preparation.account_fidelity is None
    assert preparation.insurance_adl_fidelity is None


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


async def test_agg_run_creation_rejects_dead_manual_start_without_persisting(
    tmp_path: Path,
) -> None:
    database = tmp_path / "agg-dead-start.db"
    service = await _trade_service(database, tmp_path / "agg-dead-start-archive")
    app = _app(service)
    payload = _setup_payload()
    payload.update({
        "source_kind": "AGG_TRADE",
        "requested_start_ms": TRADE_REPLAY_START_MS - INTERVAL_MS,
        "time_disclosure_policy": "NONE",
    })
    try:
        rejected = await _request(app, "POST", "/api/v1/replay/runs", json=payload)
        assert rejected.status_code == 409
        assert rejected.json()["error"]["code"] == (
            "NO_ELIGIBLE_SOURCE_MARKET_AT_START"
        )
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_training_run"
            ).fetchone() == (0,)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_legacy_dead_agg_run_projects_unavailable_without_rewriting(
    tmp_path: Path,
) -> None:
    database = tmp_path / "agg-legacy-dead.db"
    service = await _trade_service(database, tmp_path / "agg-legacy-dead-archive")
    setup = _setup_payload()
    setup.update({
        "source_kind": "AGG_TRADE",
        "requested_start_ms": TRADE_REPLAY_START_MS - INTERVAL_MS,
        "time_disclosure_policy": "NONE",
    })
    try:
        assert service.training is not None
        # Reproduce an archive created before source-aware admission existed.
        await service.training.store.create_empty_run(
            run_id="legacy-dead",
            request=TrainingRunSetupRequest.from_dict(setup),
            committed_start_ms=TRADE_REPLAY_START_MS - INTERVAL_MS,
            random_seed=None,
        )
        with sqlite3.connect(database) as connection:
            before = connection.execute(
                "SELECT compatibility, state FROM replay_training_run WHERE run_id = ?",
                ("legacy-dead",),
            ).fetchone()
        detail = await service.training.get_run("legacy-dead")
        listed = await service.training.list_runs(
            limit=10,
            cursor=None,
            state=None,
            source_kind=None,
            compatibility="UNAVAILABLE",
        )
        with sqlite3.connect(database) as connection:
            after = connection.execute(
                "SELECT compatibility, state FROM replay_training_run WHERE run_id = ?",
                ("legacy-dead",),
            ).fetchone()
        assert before == after == ("READY", "AWAITING_MARKET")
        assert detail["compatibility"] == "UNAVAILABLE"
        assert detail["resume_action"] == "UNAVAILABLE"
        assert detail["status"]["code"] == "NO_COMPATIBLE_SOURCE_MARKET"
        assert [item["run_id"] for item in listed["items"]] == ["legacy-dead"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_source_compatibility_filter_paginates_projected_legacy_runs(
    tmp_path: Path,
) -> None:
    database = tmp_path / "agg-projected-pagination.db"
    service = await _trade_service(
        database,
        tmp_path / "agg-projected-pagination-archive",
    )
    try:
        assert service.training is not None
        for run_id, committed_start_ms in (
            ("z-dead", TRADE_REPLAY_START_MS - INTERVAL_MS),
            ("y-ready", TRADE_REPLAY_START_MS),
            ("x-dead", TRADE_REPLAY_START_MS - INTERVAL_MS),
            ("w-ready", TRADE_REPLAY_START_MS),
        ):
            setup = _setup_payload()
            setup.update({
                "source_kind": "AGG_TRADE",
                "requested_start_ms": committed_start_ms,
                "time_disclosure_policy": "NONE",
            })
            await service.training.store.create_empty_run(
                run_id=run_id,
                request=TrainingRunSetupRequest.from_dict(setup),
                committed_start_ms=committed_start_ms,
                random_seed=None,
            )

        async def projected_pages(compatibility: str) -> tuple[list[str], list[str]]:
            cursor = None
            run_ids: list[str] = []
            cursors: list[str] = []
            while True:
                page = await service.training.list_runs(
                    limit=1,
                    cursor=cursor,
                    state="AWAITING_MARKET",
                    source_kind="AGG_TRADE",
                    compatibility=compatibility,
                )
                run_ids.extend(str(item["run_id"]) for item in page["items"])
                cursor = page["next_cursor"]
                if cursor is None:
                    break
                cursors.append(str(cursor))
            return run_ids, cursors

        unavailable_ids, unavailable_cursors = await projected_pages("UNAVAILABLE")
        ready_ids, ready_cursors = await projected_pages("READY")
        assert unavailable_ids == ["z-dead", "x-dead"]
        assert ready_ids == ["y-ready", "w-ready"]
        assert len(unavailable_cursors) == len(ready_cursors) == 1
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_agg_random_sampling_deduplicates_t0_shared_by_markets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, int]] = []

    def controlled_hash(payload: dict[str, object]) -> str:
        schema = str(payload["schema_version"])
        attempt = int(payload["attempt"])
        calls.append((schema, attempt))
        if schema == "replay.source-time-sample.v1":
            # On retry choose multiset index 3, the unique final timestamp.
            suffix = "3"
        elif attempt == 0:
            # Reject the first draw: seed 1 maps to the duplicated timestamp.
            suffix = "1"
        else:
            suffix = "0"
        return "sha256:" + "0" * 63 + suffix

    monkeypatch.setattr(training_service_module, "canonical_sha256", controlled_hash)
    selected = training_service_module._sample_unique_source_time(
        (
            (0, INTERVAL_MS, 2),
            (INTERVAL_MS, INTERVAL_MS, 2),
        ),
        random_seed=1,
    )
    assert selected == 2 * INTERVAL_MS
    assert calls == [
        ("replay.source-time-deduplication.v1", 0),
        ("replay.source-time-sample.v1", 1),
        ("replay.source-time-deduplication.v1", 1),
    ]


async def test_agg_run_catalog_and_random_commit_use_trade_intersection(
    tmp_path: Path,
) -> None:
    database = tmp_path / "agg-source-aware.db"
    service = await _trade_service(
        database,
        tmp_path / "agg-source-aware-archive",
        random_seed=1,
    )
    app = _app(service)
    payload = _setup_payload()
    payload.update({
        "source_kind": "AGG_TRADE",
        "start_mode": "RANDOM",
        "requested_start_ms": None,
        "random_range_start_ms": TRADE_REPLAY_START_MS - 86_400_000,
        "random_range_end_ms": TRADE_REPLAY_START_MS + 2 * INTERVAL_MS,
        "forward_cache_ms": 4 * INTERVAL_MS,
        "time_disclosure_policy": "NONE",
    })
    try:
        created = await _request(app, "POST", "/api/v1/replay/runs", json=payload)
        assert created.status_code == 201, created.text
        catalog = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/trade-run-1/market-catalog",
        )
        assert catalog.status_code == 200, catalog.text
        body = catalog.json()
        assert [entry["identity"] for entry in body["entries"]] == [{
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
        }]
        assert body["entries"][0]["start_compatibility"]["state"] == "READY"
        with sqlite3.connect(database) as connection:
            committed = connection.execute(
                "SELECT committed_start_ms FROM replay_training_time_commitment"
            ).fetchone()[0]
        assert TRADE_REPLAY_START_MS <= committed <= (
            TRADE_REPLAY_START_MS + 2 * INTERVAL_MS
        )
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
