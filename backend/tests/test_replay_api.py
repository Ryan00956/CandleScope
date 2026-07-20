from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api.v1.replay import MAX_REPLAY_REQUEST_BYTES, router
from app.replay.constants import REPLAY_PROTOCOL
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.service import ReplayService, SYNTHETIC_TIME_ANCHOR_MS
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_config_payload,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


class FakeReplayService:
    def capabilities(self) -> dict[str, object]:
        return {"protocol": REPLAY_PROTOCOL, "enabled": True, "available": True}

    async def catalog(self, **kwargs: object) -> dict[str, object]:
        return {"protocol": REPLAY_PROTOCOL, "query": kwargs, "entries": []}

    async def create_session(self, config) -> dict[str, object]:
        return {
            "protocol": REPLAY_PROTOCOL,
            "session_id": "session-1",
            "snapshot": {"config": config.to_dict()},
        }

    async def get_session(self, session_id: str) -> dict[str, object]:
        return {"protocol": REPLAY_PROTOCOL, "session_id": session_id}

    async def command(self, session_id: str, command) -> dict[str, object]:
        if command.expected_revision == 99:
            raise ReplayDomainError(
                ReplayErrorCode.REVISION_CONFLICT,
                "revision does not match",
                details={"latest_revision": 3},
            )
        return {
            "protocol": REPLAY_PROTOCOL,
            "session_id": session_id,
            "command_id": command.command_id,
        }

    async def fork_session(self, session_id: str) -> dict[str, object]:
        return {"protocol": REPLAY_PROTOCOL, "session_id": f"{session_id}-fork"}

    async def report(self, session_id: str) -> dict[str, object]:
        return {"protocol": REPLAY_PROTOCOL, "session_id": session_id, "report": {}}

    async def journal(self, session_id: str) -> dict[str, object]:
        return {"protocol": REPLAY_PROTOCOL, "session_id": session_id, "entries": []}


def _app(service: Any = None) -> FastAPI:
    app = FastAPI()
    if service is not None:
        app.state.replay_service = service
    app.include_router(router, prefix="/api/v1")
    return app


def _command(*, revision: int = 0) -> dict[str, object]:
    return {
        "protocol": REPLAY_PROTOCOL,
        "command_id": "command-1",
        "client_instance_id": "browser-tab-1",
        "expected_revision": revision,
        "type": "step",
        "payload": {"count": 1},
    }


async def _request(app: FastAPI, method: str, url: str, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, url, **kwargs)


async def test_disabled_capability_is_stable_and_mutations_fail_closed() -> None:
    app = _app()
    capability = await _request(app, "GET", "/api/v1/replay/capabilities")
    assert capability.status_code == 200
    assert capability.json()["protocol"] == REPLAY_PROTOCOL
    assert capability.json()["enabled"] is False
    assert capability.json()["persistence"]["opened"] is False

    create = await _request(
        app,
        "POST",
        "/api/v1/replay/sessions",
        json=replay_config_payload(),
    )
    assert create.status_code == 503
    assert create.json()["error"]["code"] == "REPLAY_DISABLED"


async def test_http_routes_parse_strict_models_and_map_domain_errors() -> None:
    app = _app(FakeReplayService())
    created = await _request(
        app,
        "POST",
        "/api/v1/replay/sessions",
        json=replay_config_payload(blind_mode=True),
    )
    assert created.status_code == 201
    assert created.json()["snapshot"]["config"]["blind_mode"] is True

    conflict = await _request(
        app,
        "POST",
        "/api/v1/replay/sessions/session-1/commands",
        json=_command(revision=99),
    )
    assert conflict.status_code == 409
    assert conflict.json() == {
        "protocol": REPLAY_PROTOCOL,
        "error": {
            "code": "REVISION_CONFLICT",
            "message": "revision does not match",
            "details": {"latest_revision": 3},
        },
    }

    unknown = await _request(
        app,
        "POST",
        "/api/v1/replay/sessions/session-1/commands",
        json={**_command(), "future_field": True},
    )
    assert unknown.status_code == 422
    assert unknown.json()["protocol"] == REPLAY_PROTOCOL
    assert unknown.json()["error"]["code"] == "INVALID_STATE_TRANSITION"


async def test_request_size_limit_and_openapi_examples_are_frozen() -> None:
    app = _app(FakeReplayService())
    oversized = await _request(
        app,
        "POST",
        "/api/v1/replay/sessions/session-1/commands",
        headers={"content-length": str(MAX_REPLAY_REQUEST_BYTES + 1)},
        json=_command(),
    )
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "SCAN_LIMIT_EXCEEDED"

    oversized_body = json.dumps(
        {
            **_command(),
            "payload": {"padding": "x" * MAX_REPLAY_REQUEST_BYTES},
        }
    )
    lying_length = await _request(
        app,
        "POST",
        "/api/v1/replay/sessions/session-1/commands",
        headers={
            "content-type": "application/json",
            "content-length": "1",
        },
        content=oversized_body,
    )
    assert lying_length.status_code == 413
    assert lying_length.json()["error"]["code"] == "SCAN_LIMIT_EXCEEDED"

    async def chunked_body():
        encoded = oversized_body.encode("utf-8")
        for offset in range(0, len(encoded), 4_096):
            yield encoded[offset : offset + 4_096]

    chunked = await _request(
        app,
        "POST",
        "/api/v1/replay/sessions/session-1/commands",
        headers={"content-type": "application/json"},
        content=chunked_body(),
    )
    assert chunked.status_code == 413
    assert chunked.json()["error"]["code"] == "SCAN_LIMIT_EXCEEDED"

    schema = app.openapi()
    paths = schema["paths"]
    assert {
        "/api/v1/replay/capabilities",
        "/api/v1/replay/catalog",
        "/api/v1/replay/sessions",
        "/api/v1/replay/sessions/{session_id}",
        "/api/v1/replay/sessions/{session_id}/commands",
        "/api/v1/replay/sessions/{session_id}/fork",
        "/api/v1/replay/sessions/{session_id}/report",
        "/api/v1/replay/sessions/{session_id}/journal",
    }.issubset(paths)
    create_schema = schema["components"]["schemas"]["ReplaySessionCreatePayload"]
    command_schema = schema["components"]["schemas"]["ReplayCommandPayload"]
    assert create_schema["examples"][0]["protocol"] == REPLAY_PROTOCOL
    assert command_schema["examples"][0]["type"] == "step"


async def test_api_blind_snapshot_contains_only_synthetic_time_and_no_paths(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    service = ReplayService(
        settings=replay_settings(path),
        store=store,
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("blind-api"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    response = await _request(
        _app(service),
        "POST",
        "/api/v1/replay/sessions",
        json=replay_config_payload(blind_mode=True),
    )
    assert response.status_code == 201
    payload = response.json()
    serialized = json.dumps(payload, sort_keys=True)
    assert str(START_MS + 4 * INTERVAL_MS) not in serialized
    assert str(tmp_path) not in serialized
    assert payload["snapshot"]["cursor"]["virtual_time_ms"] == SYNTHETIC_TIME_ANCHOR_MS
    await service.shutdown(step_timeout=0.2)


async def test_blind_api_redacts_unexpected_data_dependency_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "blind-unexpected-errors.db"
    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("blind-unexpected"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    sentinel = "H:\\secret\\bars.db @ 1700000123456"
    original_build = service._catalog.build

    def broken_catalog(*args, **kwargs):
        raise ValueError(sentinel)

    monkeypatch.setattr(service._catalog, "build", broken_catalog)
    try:
        catalog = await _request(
            _app(service),
            "GET",
            "/api/v1/replay/catalog",
            params={
                "warmup_bars": 2,
                "horizon_ms": 5 * INTERVAL_MS,
                "quality_mode": "exact",
                "blind_mode": "true",
            },
        )
        assert catalog.status_code == 422
        assert catalog.json()["error"] == {
            "code": "DATASET_INCOMPLETE",
            "message": "blind replay dataset validation failed",
            "details": {"blind_redacted": True},
        }
        assert sentinel not in catalog.text

        monkeypatch.setattr(service._catalog, "build", original_build)

        def broken_materialization(*args, **kwargs):
            raise TypeError(sentinel)

        monkeypatch.setattr(service._dataset_builder, "create", broken_materialization)
        created = await _request(
            _app(service),
            "POST",
            "/api/v1/replay/sessions",
            json=replay_config_payload(blind_mode=True),
        )
        assert created.status_code == 422
        assert created.json()["error"] == {
            "code": "DATASET_INCOMPLETE",
            "message": "blind replay dataset validation failed",
            "details": {"blind_redacted": True},
        }
        assert sentinel not in created.text
        assert service.diagnostics()["pending_session_reservations"] == 0
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_debug_snapshot_adds_redacted_replay_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.main import app as main_app
    from app.main import debug_snapshot

    class DiagnosticsService:
        def diagnostics(self, *, redact_paths: bool = False) -> dict[str, object]:
            assert redact_paths is True
            return {
                "sessions": {"session-1": {"queue_size": 0}},
                "persistence": {"path": "<redacted>"},
                "dataset_pins": {"active_sessions": 1},
            }

    monkeypatch.setattr(main_app.state, "data_manager", None, raising=False)
    monkeypatch.setattr(main_app.state, "replay_runtime", None, raising=False)
    monkeypatch.setattr(
        main_app.state,
        "replay_service",
        DiagnosticsService(),
        raising=False,
    )
    snapshot = await debug_snapshot()
    assert snapshot["replay"]["persistence"]["path"] == "<redacted>"
    assert snapshot["replay"]["sessions"]["session-1"]["queue_size"] == 0
