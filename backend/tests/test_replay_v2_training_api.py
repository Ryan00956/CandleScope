from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

import app.api.v1.replay as replay_api
from app.api.v1.replay import router
from app.replay.canonical import canonical_sha256
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.errors import TrainingRunError
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
        settings=replay_settings(path),
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


def _setup_payload(payload: dict[str, object]) -> dict[str, object]:
    indicator_warmup_bars = payload.get(
        "indicator_warmup_bars",
        payload.get("warmup_bars"),
    )
    return {
        "protocol": payload["protocol"],
        "name": payload["name"],
        "source_kind": payload["source_kind"],
        "start_mode": payload["start_mode"],
        "settlement_asset": payload["settlement_asset"],
        "requested_start_ms": payload["requested_start_ms"],
        "random_range_start_ms": (
            START_MS + 4 * INTERVAL_MS
            if payload["start_mode"] == "RANDOM"
            else None
        ),
        "random_range_end_ms": (
            START_MS + 8 * INTERVAL_MS
            if payload["start_mode"] == "RANDOM"
            else None
        ),
        "indicator_warmup_bars": indicator_warmup_bars,
        "visible_history_lookback": payload.get("visible_history_lookback", {
            "mode": "DURATION",
            "duration_ms": 4 * INTERVAL_MS,
        }),
        "forward_cache_ms": payload["forward_cache_ms"],
        "random_seed": payload["random_seed"],
        "initial_equity": payload["initial_equity"],
        "max_leverage": payload["max_leverage"],
        "maker_fee_bps": payload["maker_fee_bps"],
        "taker_fee_bps": payload["taker_fee_bps"],
        "market_slippage_bps": payload["market_slippage_bps"],
        "integrity_mode": payload["integrity_mode"],
        "time_disclosure_policy": payload["time_disclosure_policy"],
        "book_mode": payload["book_mode"],
        "margin_mode": payload["margin_mode"],
        "funding_mode": payload["funding_mode"],
        "account_data_mode": payload.get("account_data_mode", "APPROX_PROXY"),
        "fixed_funding_rate": payload.get("fixed_funding_rate"),
        "funding_interval_ms": payload.get("funding_interval_ms"),
        "allow_rule_changes": payload["allow_rule_changes"],
        "allowed_mutations": payload.get("allowed_mutations", []),
    }


async def _create_empty_run(
    app: FastAPI,
    service: ReplayService,
    payload: dict[str, object] | None = None,
):
    full_payload = await _payload(service) if payload is None else payload
    return await _request(
        app,
        "POST",
        "/api/v1/replay/runs",
        json=_setup_payload(full_payload),
    )


async def _select_initial_market(
    app: FastAPI,
    run_id: str,
    payload: dict[str, object],
):
    catalog = await _request(
        app,
        "GET",
        f"/api/v1/replay/runs/{run_id}/market-catalog",
    )
    assert catalog.status_code == 200
    return await _request(
        app,
        "POST",
        f"/api/v1/replay/runs/{run_id}/markets",
        json={
            "catalog_epoch": catalog.json()["catalog_epoch"],
            "exchange": payload["exchange"],
            "market_type": payload["market_type"],
            "symbol": payload["symbol"],
            "base_interval": payload["base_interval"],
            "display_interval": payload["display_interval"],
            "account_history_ref": payload.get("account_history_ref"),
        },
    )


async def _create_initialized_run(
    app: FastAPI,
    service: ReplayService,
    payload: dict[str, object] | None = None,
):
    full_payload = await _payload(service) if payload is None else payload
    created = await _create_empty_run(app, service, full_payload)
    assert created.status_code == 201
    run_id = str(created.json()["run"]["run_id"])
    return await _select_initial_market(app, run_id, full_payload)


async def test_v2_http_create_list_detail_and_return_to_hub(tmp_path: Path) -> None:
    service = await _service(tmp_path / "api.db")
    app = _app(service)
    try:
        empty = await _request(app, "GET", "/api/v1/replay/runs?limit=10")
        assert empty.status_code == 200
        assert empty.json()["items"] == []

        created = await _create_initialized_run(app, service)
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
        records = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/run-1/account-records"
            "?record_type=ORDERS&order_scope=HISTORY&limit=50",
        )
        assert records.status_code == 200
        assert records.json() == {
            "protocol": "replay.v2",
            "schema_version": "replay.training.account-record-page.v1",
            "run_id": "run-1",
            "record_type": "ORDERS",
            "order_scope": "HISTORY",
            "track_id": None,
            "items": [],
            "total_count": 0,
            "next_cursor": None,
        }
        invalid_scope = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/run-1/account-records"
            "?record_type=FILLS&order_scope=HISTORY",
        )
        assert invalid_scope.status_code == 422

        returned = await _request(
            app,
            "POST",
            "/api/v1/replay/runs/run-1/return-to-hub",
        )
        assert returned.status_code == 200
        assert returned.json()["checkpointed"] is True
        assert returned.json()["state"] == "PAUSED"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_v2_http_failed_preparation_can_retry_same_commitment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "retry-api.db")
    app = _app(service)
    payload = await _payload(service)
    payload.update(
        {
            "start_mode": "RANDOM",
            "requested_start_ms": None,
        }
    )
    original_create = service._dataset_builder.create
    original_select = service.select_training_window
    attempts = 0
    selection_attempts = 0

    async def track_selection(*args, **kwargs):
        nonlocal selection_attempts
        selection_attempts += 1
        return await original_select(*args, **kwargs)

    def fail_first_materialization(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "injected remote download failure",
            )
        return original_create(*args, **kwargs)

    monkeypatch.setattr(
        service._dataset_builder,
        "create",
        fail_first_materialization,
    )
    monkeypatch.setattr(service, "select_training_window", track_selection)
    try:
        created = await _create_empty_run(app, service, payload)
        assert created.status_code == 201
        run_id = str(created.json()["run"]["run_id"])
        failed = await _select_initial_market(app, run_id, payload)
        assert failed.status_code == 409
        shell = await _request(app, "GET", f"/api/v1/replay/runs/{run_id}")
        assert shell.json()["state"] == "AWAITING_MARKET"
        assert shell.json()["adapter_session_id"] is None

        retried = await _select_initial_market(app, run_id, payload)
        assert retried.status_code == 201, retried.text
        assert retried.json()["run"]["run_id"] == run_id
        assert retried.json()["run"]["adapter_session_id"] == "adapter-1"
        assert selection_attempts == 1
        with sqlite3.connect(tmp_path / "retry-api.db") as connection:
            assert connection.execute(
                "SELECT status, retry_count FROM replay_training_selection_preparation"
            ).fetchall() == [("READY", 1)]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_v2_http_delete_archive_removes_run_and_adapter_session(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "delete-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        assert created.json()["run"]["run_id"] == "run-1"
        assert created.json()["run"]["adapter_session_id"] == "adapter-1"

        deleted = await _request(app, "DELETE", "/api/v1/replay/runs/run-1")
        assert deleted.status_code == 200
        assert deleted.json() == {
            "protocol": "replay.v2",
            "deleted": True,
            "run_id": "run-1",
            "session_ids": ["adapter-1"],
        }

        listed = await _request(app, "GET", "/api/v1/replay/runs?limit=10")
        assert listed.status_code == 200
        assert listed.json()["items"] == []
        missing = await _request(app, "GET", "/api/v1/replay/runs/run-1")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "TRAINING_RUN_NOT_FOUND"
        assert await service.store.get_session("adapter-1") is None
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_archive_delete_fences_lazy_recovery_until_sqlite_commits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "delete-recovery-fence.db")
    app = _app(service)
    recovery_task: asyncio.Task[dict[str, object]] | None = None
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        assert service.training is not None
        original_delete = service.training.store.delete_run

        async def delete_with_recovery_probe(
            run_id: str,
            *,
            expected_session_ids: tuple[str, ...],
        ) -> tuple[str, ...]:
            nonlocal recovery_task
            recovery_task = asyncio.create_task(service.get_session("adapter-1"))
            await asyncio.sleep(0)
            assert recovery_task.done() is False
            assert service.diagnostics()["pending_session_deletions"] == (
                "adapter-1",
            )
            return await original_delete(
                run_id,
                expected_session_ids=expected_session_ids,
            )

        monkeypatch.setattr(
            service.training.store,
            "delete_run",
            delete_with_recovery_probe,
        )
        deleted = await _request(app, "DELETE", "/api/v1/replay/runs/run-1")
        assert deleted.status_code == 200
        assert recovery_task is not None
        with pytest.raises(ReplayDomainError) as missing:
            await asyncio.wait_for(recovery_task, timeout=1)
        assert missing.value.code is ReplayErrorCode.SESSION_NOT_FOUND
        assert "adapter-1" not in service._sessions
        assert await service.store.get_session("adapter-1") is None
    finally:
        if recovery_task is not None and not recovery_task.done():
            recovery_task.cancel()
            await asyncio.gather(recovery_task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)


async def test_archive_delete_invalidates_record_read_before_fence_claim(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "delete-stale-record.db")
    app = _app(service)
    recovery_task: asyncio.Task[dict[str, object]] | None = None
    release_record = asyncio.Event()
    record_read = asyncio.Event()
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        await service.release_session_to_hub("adapter-1")
        original_get_session = service.store.get_session
        delayed = True

        async def get_session_with_stale_read(
            session_id: str,
        ) -> dict[str, object] | None:
            nonlocal delayed
            record = await original_get_session(session_id)
            if delayed and session_id == "adapter-1":
                delayed = False
                record_read.set()
                await release_record.wait()
            return record

        monkeypatch.setattr(
            service.store,
            "get_session",
            get_session_with_stale_read,
        )
        recovery_task = asyncio.create_task(service.get_session("adapter-1"))
        await asyncio.wait_for(record_read.wait(), timeout=1)

        deleted = await _request(app, "DELETE", "/api/v1/replay/runs/run-1")
        assert deleted.status_code == 200
        release_record.set()
        with pytest.raises(ReplayDomainError) as missing:
            await asyncio.wait_for(recovery_task, timeout=1)
        assert missing.value.code is ReplayErrorCode.SESSION_NOT_FOUND
        assert "adapter-1" not in service._sessions
    finally:
        release_record.set()
        if recovery_task is not None and not recovery_task.done():
            recovery_task.cancel()
            await asyncio.gather(recovery_task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)


async def test_cancelled_archive_delete_resolves_sqlite_before_releasing_fence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "delete-cancelled.db")
    delete_task: asyncio.Task[dict[str, object]] | None = None
    delete_started = asyncio.Event()
    release_delete = asyncio.Event()
    try:
        assert service.training is not None
        created = await _create_initialized_run(_app(service), service)
        assert created.status_code == 201
        original_delete = service.training.store.delete_run

        async def delete_with_barrier(
            run_id: str,
            *,
            expected_session_ids: tuple[str, ...],
        ) -> tuple[str, ...]:
            delete_started.set()
            await release_delete.wait()
            return await original_delete(
                run_id,
                expected_session_ids=expected_session_ids,
            )

        monkeypatch.setattr(
            service.training.store,
            "delete_run",
            delete_with_barrier,
        )
        delete_task = asyncio.create_task(service.training.delete_run("run-1"))
        await asyncio.wait_for(delete_started.wait(), timeout=1)
        delete_task.cancel()
        await asyncio.sleep(0)
        assert delete_task.done() is False

        release_delete.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(delete_task, timeout=1)
        assert service.diagnostics()["pending_session_deletions"] == ()
        assert await service.store.get_session("adapter-1") is None
        with pytest.raises(ReplayDomainError) as missing:
            await service.get_session("adapter-1")
        assert missing.value.code is ReplayErrorCode.SESSION_NOT_FOUND
    finally:
        release_delete.set()
        if delete_task is not None and not delete_task.done():
            delete_task.cancel()
            await asyncio.gather(delete_task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)


async def test_archive_delete_remains_available_for_evicted_degraded_session(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "delete-degraded.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        await service.release_session_to_hub("adapter-1")
        service._unavailable_sessions["adapter-1"] = ReplayDomainError(
            ReplayErrorCode.PERSISTENCE_DEGRADED,
            "forced unavailable archive",
        )
        service.store._degraded_reason = "forced sticky degradation"

        deleted = await _request(app, "DELETE", "/api/v1/replay/runs/run-1")
        assert deleted.status_code == 200
        assert deleted.json()["session_ids"] == ["adapter-1"]
        assert "adapter-1" not in service._unavailable_sessions
        assert await service.store.get_session("adapter-1") is None
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_archive_delete_rejects_session_target_drift_atomically(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "delete-target-drift.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        assert service.training is not None

        with pytest.raises(TrainingRunError) as changed:
            await service.training.store.delete_run(
                "run-1",
                expected_session_ids=("stale-adapter",),
            )
        assert changed.value.code == "TRAINING_RUN_CHANGED"
        assert (await service.training.store.get_run("run-1"))["run_id"] == "run-1"
        assert await service.store.get_session("adapter-1") is not None
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_archive_delete_fails_closed_while_adapter_is_in_use(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "delete-busy.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201

        async with service._lease_handle("adapter-1"):
            deleted = await _request(
                app,
                "DELETE",
                "/api/v1/replay/runs/run-1",
            )
        assert deleted.status_code == 409
        assert deleted.json()["error"]["code"] == "TRAINING_RUN_BUSY"
        assert await service.store.get_session("adapter-1") is not None
        assert service.training is not None
        assert (await service.training.store.get_run("run-1"))["run_id"] == "run-1"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase17_rules_drawing_marker_review_control_and_fork_routes(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase17-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        run = created.json()["run"]
        run_id = run["run_id"]
        session_id = run["adapter_session_id"]

        rules = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/rules",
        )
        assert rules.status_code == 200
        assert rules.json()["schema_version"] == "replay.run-rules.v1"
        assert rules.json()["instrument_rules"][0]["immutable_exchange_rule"] is True
        empty_drawing = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/drawings/current",
        )
        assert empty_drawing.status_code == 200
        assert empty_drawing.json()["document"] is None
        assert empty_drawing.json()["revision"] == 0

        document = {
            "documentSchemaVersion": 1,
            "scopeKey": f"replay-run:{run_id}",
            "documentRevision": 1,
            "updatedAt": 1,
            "entities": [],
        }
        invalid_drawing = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/drawings",
            json={
                "protocol": "replay.v2",
                "command_id": "phase17-api-drawing-invalid",
                "document_hash": canonical_sha256(document),
                "document": document,
                "entity_count": 0,
            },
        )
        assert invalid_drawing.status_code == 422
        binary_float_drawing = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/drawings",
            json={
                "protocol": "replay.review.drawing-document.v1",
                "command_id": "phase17-api-drawing-float",
                "document_hash": "sha256:" + ("0" * 64),
                "document": {
                    **document,
                    "entities": [
                        {
                            "id": "line-float",
                            "kind": "line",
                            "geometryRevision": 1,
                            "styleRevision": 1,
                            "geometry": {"kind": "line"},
                            "style": {"kind": "line", "lineWidth": 2.5},
                            "bounds": {"kind": "deferred"},
                        }
                    ],
                },
                "entity_count": 1,
            },
        )
        assert binary_float_drawing.status_code == 422
        assert binary_float_drawing.json()["error"]["code"] == (
            "REVIEW_DRAWING_INVALID"
        )
        drawing = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/drawings",
            json={
                "protocol": "replay.review.drawing-document.v1",
                "command_id": "phase17-api-drawing",
                "document_hash": canonical_sha256(document),
                "document": document,
                "entity_count": 0,
            },
        )
        assert drawing.status_code == 200
        assert drawing.json()["schema_version"] == (
            "replay.review.drawing-document.v1"
        )
        hydrated_drawing = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/drawings/current",
        )
        assert hydrated_drawing.status_code == 200
        assert hydrated_drawing.json()["document"] == document
        assert hydrated_drawing.json()["document_hash"] == canonical_sha256(document)

        marker = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/markers",
            json={
                "protocol": "replay.review.marker.v1",
                "command_id": "phase17-api-marker",
                "text": "API review marker",
            },
        )
        assert marker.status_code == 200
        assert marker.json()["timeline_sequence"] > 0

        before = await service.get_session(session_id)
        review = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/review",
            json={"event_id": None},
        )
        assert review.status_code == 200
        review_body = review.json()
        assert review_body["read_only"] is True
        assert review_body["immutability_proof"]["verified"] is True
        assert "archive_id" not in json.dumps(review_body)

        previous = await _request(
            app,
            "POST",
            (
                f"/api/v1/replay/runs/{run_id}/reviews/"
                f"{review_body['review_id']}/cursor"
            ),
            json={
                "action": "PREVIOUS",
                "event_id": None,
                "expected_cursor_revision": review_body["cursor_revision"],
                "playback_rate": None,
            },
        )
        assert previous.status_code == 200
        assert previous.json()["read_only"] is True
        assert previous.json()["cursor_revision"] == 2

        playing = await _request(
            app,
            "POST",
            (
                f"/api/v1/replay/runs/{run_id}/reviews/"
                f"{review_body['review_id']}/cursor"
            ),
            json={
                "action": "PLAY",
                "event_id": None,
                "expected_cursor_revision": previous.json()["cursor_revision"],
                "playback_rate": "2",
            },
        )
        assert playing.status_code == 200
        assert playing.json()["playback_state"] == "PLAYING"

        forked = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/fork",
            json={"event_id": review_body["selected_event_id"]},
        )
        assert forked.status_code == 201
        assert forked.json()["parent_run_id"] == run_id
        assert forked.json()["parent_timeline_sequence"] == (
            review_body["selected_timeline_sequence"]
        )
        assert len(forked.json()["tracks"]) == 1
        after = await service.get_session(session_id)
        assert after["snapshot"]["state_hash"] == before["snapshot"]["state_hash"]
        assert after["snapshot"]["cursor"] == before["snapshot"]["cursor"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase17_drawing_route_uses_the_canonical_document_budget(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase17-large-drawing-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        run_id = str(created.json()["run"]["run_id"])
        document = {
            "documentSchemaVersion": 1,
            "scopeKey": f"replay-run:{run_id}",
            "documentRevision": 1,
            "updatedAt": 1,
            "entities": [
                {
                    "id": "large-text",
                    "kind": "text",
                    "geometryRevision": 1,
                    "styleRevision": 1,
                    "geometry": {"kind": "text"},
                    "style": {"kind": "text", "text": "x" * 70_000},
                    "bounds": {"kind": "deferred"},
                }
            ],
        }
        response = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/drawings",
            json={
                "protocol": "replay.review.drawing-document.v1",
                "command_id": "phase17-large-drawing",
                "document_hash": canonical_sha256(document),
                "document": document,
                "entity_count": 1,
            },
        )
        assert response.status_code == 200
        assert response.json()["entity_count"] == 1
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase8_plan_and_trade_flow_routes_fail_closed_by_source(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase8-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        run = created.json()["run"]
        session = await service.get_session(run["adapter_session_id"])
        current = session["snapshot"]["cursor"]["virtual_time_ms"]
        planned = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run['run_id']}/fast-forward-plan",
            params={"target_virtual_time_ms": current + INTERVAL_MS},
        )
        assert planned.status_code == 200
        assert planned.json()["plan"]["mode"] == "FULL_EVENT_SCAN"
        assert planned.json()["plan"]["reason_codes"] == ["OPTIMIZATION_DISABLED"]

        unsupported = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run['run_id']}/trade-flow",
            params={"track_id": "track-1", "after_sequence": 0, "limit": 200},
        )
        assert unsupported.status_code == 409
        body = unsupported.json()
        assert body["error"]["code"] == "REPLAY_TRADE_FLOW_UNSUPPORTED_SOURCE"
        assert body["error"]["details"] == {
            "tape": "UNSUPPORTED_SOURCE_MODE",
            "order_flow": "UNSUPPORTED_SOURCE_MODE",
        }
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_v2_history_route_binds_track_epoch_and_public_cursor(tmp_path: Path) -> None:
    service = await _service(tmp_path / "history-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        assert created.status_code == 201
        snapshot_response = await _request(
            app,
            "GET",
            "/api/v1/replay/runs/session/adapter-1",
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
        assert payload["schema_version"] == "replay.history.v3"
        assert payload["excluded_ranges"] == []
        assert payload["history_boundary_ms"] <= payload["revealed_boundary_ms"]
        assert (
            payload["history_policy"]["schema_version"]
            == "replay.data-policy.v1"
        )
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
        await service.shutdown(step_timeout=1.0)


async def test_v2_viewer_and_command_routes_keep_display_outside_domain_state(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase3-api.db")
    app = _app(service)
    try:
        create_payload = await _payload(service)
        create_payload["display_interval"] = "15m"
        created = await _create_initialized_run(app, service, create_payload)
        run = created.json()["run"]
        snapshot_response = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/session/{run['adapter_session_id']}",
        )
        before = snapshot_response.json()["snapshot"]
        assert before["config"]["display_interval"] == "1m"

        viewer = await _request(
            app,
            "GET",
            f"/api/v1/replay/runs/session/{run['adapter_session_id']}/viewer",
        )
        viewer_state = viewer.json()["viewer_state"]
        assert viewer_state["display_interval"] == "15m"

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
                "expected_viewer_revision": viewer_state["semantic_view_revision"],
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
                f"/api/v1/replay/runs/session/{run['adapter_session_id']}",
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
        await service.shutdown(step_timeout=1.0)


async def test_phase5_market_track_routes_expose_replay_only_portfolio_contract(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase5-tracks-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
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
        await service.shutdown(step_timeout=1.0)


async def test_phase4_http_boundaries_expose_only_public_time_and_exact_review_fork(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "phase4-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
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
        await service.shutdown(step_timeout=1.0)


async def test_v2_validation_and_catalog_drift_use_v2_error_envelopes(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "errors.db")
    app = _app(service)
    try:
        payload = await _payload(service)
        invalid = await _request(
            app,
            "POST",
            "/api/v1/replay/runs",
            json={**_setup_payload(payload), "future_field": True},
        )
        assert invalid.status_code == 422
        assert invalid.json()["protocol"] == "replay.v2"
        assert invalid.json()["error"]["code"] == "TRAINING_RUN_INVALID"

        created = await _create_empty_run(app, service, payload)
        assert created.status_code == 201
        run_id = str(created.json()["run"]["run_id"])
        stale = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/markets",
            json={
                "catalog_epoch": f"sha256:{'f' * 64}",
                "exchange": payload["exchange"],
                "market_type": payload["market_type"],
                "symbol": payload["symbol"],
                "base_interval": payload["base_interval"],
                "display_interval": payload["display_interval"],
                "account_history_ref": None,
            },
        )
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "CATALOG_EPOCH_MISMATCH"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_unowned_adapter_session_has_no_training_migration_or_delete_surface(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "retired-legacy-surface.db")
    app = _app(service)
    try:
        adapter = await service.create_session(replay_config())
        session_id = str(adapter["session_id"])

        migration = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{session_id}/migrate",
            json={"protocol": "replay.v2", "name": "retired"},
        )
        assert migration.status_code == 404

        deleted = await _request(app, "DELETE", f"/api/v1/replay/runs/{session_id}")
        assert deleted.status_code == 404
        assert deleted.json()["error"]["code"] == "TRAINING_RUN_NOT_FOUND"
        assert await service.store.get_session(session_id) is not None
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_order_preview_route_is_strict_cursor_bound_and_read_only(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "order-preview-api.db")
    app = _app(service)
    try:
        created = await _create_initialized_run(app, service)
        run = created.json()["run"]
        session_path = f"/api/v1/replay/runs/session/{run['adapter_session_id']}"
        before = (await _request(app, "GET", session_path)).json()["snapshot"]
        preview_payload = {
            "protocol": "replay.v2",
            "expected_revision": before["revision"],
            "expected_cursor": {
                "virtual_time_ms": before["cursor"]["virtual_time_ms"],
                "source_sequence": before["cursor"]["source_sequence"],
                "revision": before["revision"],
            },
            "position_intent": "OPEN",
            "order": {
                "client_order_id": "api-preview-order",
                "side": "BUY",
                "order_type": "MARKET",
                "quantity": "1",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
                "leverage": "2",
            },
        }
        capacity_payload = {
            "protocol": "replay.v2",
            "expected_revision": before["revision"],
            "expected_cursor": preview_payload["expected_cursor"],
            "position_intent": "OPEN",
            "context": {
                "side": "BUY",
                "order_type": "MARKET",
                "reduce_only": False,
                "limit_price": None,
                "stop_price": None,
                "leverage": "2",
            },
        }
        capacity = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run['run_id']}/order-capacity",
            json=capacity_payload,
        )
        assert capacity.status_code == 200, capacity.text
        assert capacity.json()["schema_version"] == "replay.order-capacity.v1"
        assert capacity.json()["context"] == capacity_payload["context"]
        assert Decimal(capacity.json()["max_quantity"]) > 0
        preview = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run['run_id']}/order-preview",
            json=preview_payload,
        )
        assert preview.status_code == 200
        assert preview.json()["schema_version"] == "replay.order-preview.v1"
        assert preview.json()["position_intent"] == "OPEN"
        assert preview.json()["order"] == preview_payload["order"]
        assert float(preview.json()["reserved_margin"]) > 0
        after = (await _request(app, "GET", session_path)).json()["snapshot"]
        assert after["revision"] == before["revision"]
        assert after["state_hash"] == before["state_hash"]

        oversized = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run['run_id']}/order-preview",
            json={
                **preview_payload,
                "order": {**preview_payload["order"], "quantity": "999999999"},
            },
        )
        assert oversized.status_code in {409, 422}
        capacity_after_rejection = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run['run_id']}/order-capacity",
            json=capacity_payload,
        )
        assert capacity_after_rejection.status_code == 200
        assert capacity_after_rejection.json()["max_quantity"] == capacity.json()["max_quantity"]

        malformed = await _request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run['run_id']}/order-preview",
            json={**preview_payload, "future_field": True},
        )
        assert malformed.status_code == 422
        assert malformed.json()["error"]["code"] == "TRAINING_RUN_INVALID"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_enabled_flags_without_a_started_training_service_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        replay_api,
        "REPLAY_SETTINGS",
        replace(
            replay_api.REPLAY_SETTINGS,
            enabled=True,
        ),
    )
    response = await _request(_app(), "GET", "/api/v1/replay/runs")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "REPLAY_TRAINING_UNAVAILABLE"
