from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

import app.api.v1.replay as replay_api
from app.api.v1.replay import router
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


async def _service(path: Path) -> ReplayService:
    service = ReplayService(
        settings=replace(replay_settings(path), product_v2_enabled=True),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory("run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


def _app(service: ReplayService | None = None) -> FastAPI:
    app = FastAPI()
    if service is not None:
        app.state.replay_service = service
    app.include_router(router, prefix="/api/v1")
    return app


async def _request(app: FastAPI, method: str, path: str, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


async def _payload(service: ReplayService) -> dict[str, object]:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=5 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=True,
    )
    return {
        "protocol": "replay.v2",
        "catalog_epoch": catalog["catalog_epoch"],
        "name": "API 训练",
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
        "time_disclosure_policy": "HIDE_ALL",
        "book_mode": "OFF",
        "margin_mode": "CROSS",
        "funding_mode": "OFF",
        "allow_rule_changes": False,
    }


async def test_v2_routes_are_disabled_without_both_runtime_flags() -> None:
    response = await _request(_app(), "GET", "/api/v1/replay/runs")
    assert response.status_code == 503
    assert response.json() == {
        "protocol": "replay.v2",
        "error": {
            "code": "REPLAY_PRODUCT_V2_DISABLED",
            "message": "Replay training v2 is disabled",
            "details": {},
        },
    }


async def test_v2_http_create_list_detail_and_return_to_hub(tmp_path: Path) -> None:
    service = await _service(tmp_path / "api.db")
    app = _app(service)
    try:
        empty = await _request(app, "GET", "/api/v1/replay/runs?limit=10")
        assert empty.status_code == 200
        assert empty.json()["items"] == []

        created = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=await _payload(service),
        )
        assert created.status_code == 201
        assert created.json()["run"]["run_id"] == "run-1"
        assert created.json()["run"]["adapter_session_id"] == "adapter-1"

        listed = await _request(
            app,
            "GET",
            "/api/v1/replay/runs?limit=10&state=PAUSED&source_kind=BAR&compatibility=READY",
        )
        assert [item["run_id"] for item in listed.json()["items"]] == ["run-1"]
        detail = await _request(app, "GET", "/api/v1/replay/runs/run-1")
        assert detail.status_code == 200
        assert detail.json()["run_id"] == "run-1"

        returned = await _request(
            app,
            "POST",
            "/api/v1/replay/runs/session/adapter-1/return-to-hub",
        )
        assert returned.status_code == 200
        assert returned.json()["checkpointed"] is True
        assert returned.json()["state"] == "PAUSED"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_v2_history_route_binds_track_epoch_and_public_cursor(tmp_path: Path) -> None:
    service = await _service(tmp_path / "history-api.db")
    app = _app(service)
    try:
        created = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=await _payload(service),
        )
        assert created.status_code == 201
        snapshot_response = await _request(
            app,
            "GET",
            "/api/v1/replay/sessions/adapter-1",
        )
        snapshot = snapshot_response.json()["snapshot"]
        boundary = snapshot["cursor"]["virtual_time_ms"]
        page = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/session/adapter-1/history",
            params={
                "track_id": "track-1",
                "before_ms": boundary + 1,
                "revealed_boundary_ms": boundary,
                "limit": 10,
                "data_epoch": snapshot["data_epoch"],
            },
        )
        assert page.status_code == 200
        payload = page.json()
        assert payload["schema_version"] == "replay.history.v1"
        assert payload["session_id"] == "adapter-1"
        assert payload["track_id"] == "track-1"
        assert all(bar["close_time_ms"] <= boundary for bar in payload["bars"])

        stale = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/session/adapter-1/history",
            params={
                "track_id": "track-1",
                "before_ms": boundary + 1,
                "revealed_boundary_ms": boundary,
                "limit": 10,
                "data_epoch": snapshot["data_epoch"],
                "history_epoch": f"sha256:{'f' * 64}",
            },
        )
        assert stale.status_code == 409
        assert stale.json()["protocol"] == "replay.v2"
        assert stale.json()["error"]["code"] == "HISTORY_EPOCH_MISMATCH"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_v2_viewer_and_command_routes_keep_display_outside_domain_state(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase3-api.db")
    app = _app(service)
    try:
        create_payload = await _payload(service)
        create_payload["display_interval"] = "15m"
        created = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=create_payload,
        )
        run = created.json()["run"]
        snapshot_response = await _request(
            app,
            "GET",
            f"/api/v1/replay/sessions/{run['adapter_session_id']}",
        )
        before = snapshot_response.json()["snapshot"]
        assert before["config"]["display_interval"] == "1m"

        viewer = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/session/{run['adapter_session_id']}/viewer",
        )
        assert viewer.json()["viewer_state"]["display_interval"] == "15m"

        command = {
            "protocol": "replay.v2",
            "run_id": run["run_id"],
            "command_id": "phase3-api-viewer",
            "client_instance_id": "phase3-api",
            "expected_revision": before["revision"],
            "expected_cursor": {
                "virtual_time_ms": before["cursor"]["virtual_time_ms"],
                "source_sequence": before["cursor"]["source_sequence"],
                "revision": before["revision"],
            },
            "type": "set_display_interval",
            "payload": {
                "display_interval": "1h",
                "expected_viewer_revision": 0,
            },
        }
        changed = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run['run_id']}/commands",
            json=command,
        )
        assert changed.status_code == 200
        assert changed.json()["viewer_state"]["display_interval"] == "1h"
        assert changed.json()["data"]["source_events_consumed"] == 0
        after = (
            await _request(
                app,
                "GET",
                f"/api/v1/replay/sessions/{run['adapter_session_id']}",
            )
        ).json()["snapshot"]
        assert after["cursor"] == before["cursor"]
        assert after["state_hash"] == before["state_hash"]

        malformed = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run['run_id']}/commands",
            json={**command, "future_field": True},
        )
        assert malformed.status_code == 422
        assert malformed.json()["protocol"] == "replay.v2"
        assert malformed.json()["error"]["code"] == "TRAINING_RUN_INVALID"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_phase5_market_track_routes_expose_replay_only_portfolio_contract(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase5-tracks-api.db")
    app = _app(service)
    try:
        created = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=await _payload(service),
        )
        run = created.json()["run"]
        by_session = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/session/{run['adapter_session_id']}/tracks",
        )
        by_run = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run['run_id']}/tracks",
        )
        assert by_session.status_code == by_run.status_code == 200
        assert by_session.json() == by_run.json()
        payload = by_run.json()
        assert payload["protocol"] == "replay.v2"
        assert payload["ordering_version"] == "replay.global-order.v1"
        assert payload["tracks"][0]["subscription_tier"] == "FULL"
        assert payload["tracks"][0]["forced_full_reasons"] == ["VIEWED"]
        assert payload["portfolio"]["settlement_account_shared"] is True
        assert payload["portfolio"]["equity"] == "10000"
        assert "live_price" not in by_run.text
        assert "actual_event_time_ms" not in by_run.text
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_phase4_http_boundaries_expose_only_public_time_and_exact_review_fork(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase4-api.db")
    app = _app(service)
    try:
        created = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=await _payload(service),
        )
        assert created.status_code == 201
        run = created.json()["run"]
        run_id = run["run_id"]
        actual_start = START_MS + 4 * INTERVAL_MS

        integrity = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/integrity",
        )
        assert integrity.status_code == 200
        integrity_payload = integrity.json()
        assert integrity_payload["start_time_known"] is True
        assert integrity_payload["strict_eligible"] is False
        assert integrity_payload["public_time"]["policy"] == "HIDE_ALL"
        assert str(actual_start) not in json.dumps(integrity_payload)

        equity = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/equity",
            params={"resolution": "AUTO", "limit": 100},
        )
        assert equity.status_code == 200
        assert equity.json()["bounded"] is True
        assert equity.json()["samples"][0]["public_time"]["policy"] == "HIDE_ALL"
        assert str(actual_start) not in equity.text

        journal = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/journal",
        )
        report = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/report",
        )
        assert journal.status_code == report.status_code == 200
        assert "actual_history" not in report.json()
        assert str(actual_start) not in journal.text
        assert str(actual_start) not in report.text

        review = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/review",
            json={"event_id": None},
        )
        assert review.status_code == 200
        reviewed = review.json()
        assert reviewed["read_only"] is True
        assert str(actual_start) not in review.text

        forked = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/fork",
            json={"event_id": reviewed["selected_event_id"]},
        )
        assert forked.status_code == 201
        assert forked.json()["run"]["dataset_epoch"] == reviewed["dataset_epoch"]
        assert forked.json()["run"]["state_hash"] == reviewed["selected_state_hash"]
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_v2_validation_and_catalog_drift_use_v2_error_envelopes(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "errors.db")
    app = _app(service)
    try:
        invalid = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json={**await _payload(service), "future_field": True},
        )
        assert invalid.status_code == 422
        assert invalid.json()["protocol"] == "replay.v2"
        assert invalid.json()["error"]["code"] == "TRAINING_RUN_INVALID"

        stale_payload = await _payload(service)
        stale_payload["catalog_epoch"] = f"sha256:{'f' * 64}"
        stale = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json=stale_payload,
        )
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "CATALOG_EPOCH_MISMATCH"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_legacy_migration_route_is_additive_and_idempotent(tmp_path: Path) -> None:
    service = await _service(tmp_path / "migration.db")
    app = _app(service)
    try:
        legacy = await service.create_session(replay_config())
        session_id = str(legacy["session_id"])
        first = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{session_id}/migrate",
            json={"protocol": "replay.v2", "name": "迁移存档"},
        )
        assert first.status_code == 201
        assert first.json()["migrated"] is True
        second = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{session_id}/migrate",
            json={"protocol": "replay.v2", "name": None},
        )
        assert second.status_code == 200
        assert second.json()["created"] is False
        assert second.json()["run"]["run_id"] == first.json()["run"]["run_id"]
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_enabled_flags_without_a_started_training_service_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        replay_api,
        "REPLAY_SETTINGS",
        replace(
            replay_api.REPLAY_SETTINGS,
            enabled=True,
            product_v2_enabled=True,
        ),
    )
    response = await _request(_app(), "GET", "/api/v1/replay/runs")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "REPLAY_PRODUCT_V2_UNAVAILABLE"
