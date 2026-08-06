from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.api.v1.replay as replay_api
from app.api.v1.replay import router as replay_router
from app.api.v1.stream import router as stream_router
from app.core.config import load_replay_settings
from app.replay.training.commands import ReplayV2Command
from app.replay.training.events import ReplayV2Event
from app.replay.training.models import (
    REPLAY_V2_ENUMS,
    REPLAY_V2_PROTOCOL,
    ADAPTER_STORAGE_CONTRACT,
    MarketTrackContract,
    TimeDisclosurePolicy,
    TrainingRunContract,
    ensure_time_disclosure_not_weakened,
    validate_track_source,
)


ROOT = Path(__file__).parents[2]
GOLDEN_PATH = Path(__file__).parent / "fixtures" / "replay" / "v2_contract_golden.json"


def _golden() -> dict[str, object]:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(replay_router, prefix="/api/v1")
    app.include_router(stream_router, prefix="/api/v1")
    return app


def test_replay_v2_golden_matches_python_enum_and_schema_registry() -> None:
    golden = _golden()
    assert golden["protocol"] == REPLAY_V2_PROTOCOL
    assert golden["enums"] == {
        name: list(values) for name, values in REPLAY_V2_ENUMS.items()
    }
    assert golden["adapter_storage_contract"] == ADAPTER_STORAGE_CONTRACT


def test_replay_v2_phase8_package_keeps_optimization_inside_training() -> None:
    training_root = ROOT / "backend" / "app" / "replay" / "training"
    assert {path.name for path in training_root.glob("*.py")} == {
        "__init__.py",
        "account.py",
        "account_history.py",
        "anchor_codec.py",
        "commands.py",
        "control.py",
        "disclosure.py",
        "errors.py",
        "events.py",
        "fast_forward.py",
        "hedge_simulation_contract.py",
        "historical_book.py",
        "history.py",
        "models.py",
        "multitrack.py",
        "review.py",
        "schema.py",
        "segments.py",
        "service.py",
        "storage.py",
        "storage_governance.py",
        "trade_flow.py",
    }


def test_replay_v2_run_track_command_and_event_golden_round_trip() -> None:
    golden = _golden()
    run = TrainingRunContract.from_dict(golden["sample_run"])
    track = MarketTrackContract.from_dict(golden["sample_track"])
    command = ReplayV2Command.from_dict(golden["sample_command"])
    event = ReplayV2Event.from_dict(
        golden["sample_event"],
        authoritative_time_disclosure_policy=run.time_disclosure_policy,
    )

    validate_track_source(run, track)
    assert run.to_dict() == golden["sample_run"]
    assert track.to_dict() == golden["sample_track"]
    assert command.to_dict() == golden["sample_command"]
    assert event.to_dict() == golden["sample_event"]


@pytest.mark.parametrize(
    ("section", "path", "bad_value"),
    [
        ("sample_run", ("protocol",), "replay.v1"),
        ("sample_run", ("run_id",), "bad id"),
        ("sample_run", ("state",), "RUNNING"),
        ("sample_run", ("source_kind",), "RAW_TRADE"),
        ("sample_run", ("integrity_mode",), "CHEAT"),
        ("sample_run", ("time_disclosure_policy",), "CLIENT_ONLY"),
        ("sample_run", ("initial_equity",), "NaN"),
        ("sample_run", ("initial_equity",), 10000.0),
        ("sample_run", ("active_rule_revision",), -1),
        ("sample_run", ("cursor", "virtual_time_ms"), -1),
        ("sample_run", ("cursor", "source_sequence"), True),
        ("sample_track", ("subscription_tier",), "LIVE"),
        ("sample_track", ("capabilities", "ORDER_BOOK"), "AVAILABLE"),
        ("sample_track", ("capabilities", "FUTURE_CAPABILITY"), "AVAILABLE_EXACT"),
        ("sample_command", ("type",), "skip_everything"),
        ("sample_command", ("expected_revision",), -1),
        ("sample_event", ("type",), "FUTURE_EVENT"),
        ("sample_event", ("sequence",), -1),
    ],
)
def test_replay_v2_contract_rejects_invalid_wire_values(
    section: str,
    path: tuple[str, ...],
    bad_value: object,
) -> None:
    payload = deepcopy(_golden()[section])
    target = payload
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = bad_value

    parser = {
        "sample_run": TrainingRunContract.from_dict,
        "sample_track": MarketTrackContract.from_dict,
        "sample_command": ReplayV2Command.from_dict,
        "sample_event": ReplayV2Event.from_dict,
    }[section]
    with pytest.raises((TypeError, ValueError)):
        parser(payload)


def test_replay_v2_source_mix_and_silent_disclosure_downgrade_fail_closed() -> None:
    golden = _golden()
    run = TrainingRunContract.from_dict(golden["sample_run"])
    track_payload = deepcopy(golden["sample_track"])
    track_payload["source_kind"] = "AGG_TRADE"
    track = MarketTrackContract.from_dict(track_payload)
    with pytest.raises(ValueError, match="source_kind"):
        validate_track_source(run, track)

    ensure_time_disclosure_not_weakened(
        TimeDisclosurePolicy.HIDE_DAY,
        TimeDisclosurePolicy.HIDE_ALL,
    )
    ensure_time_disclosure_not_weakened(
        TimeDisclosurePolicy.HIDE_DAY,
        TimeDisclosurePolicy.HIDE_DAY,
    )
    with pytest.raises(ValueError, match="downgrade"):
        ensure_time_disclosure_not_weakened(
            TimeDisclosurePolicy.HIDE_ALL,
            TimeDisclosurePolicy.HIDE_DAY,
        )

    event_payload = deepcopy(golden["sample_event"])
    event_payload["time_disclosure_policy"] = "NONE"
    with pytest.raises(ValueError, match="downgrade"):
        ReplayV2Event.from_dict(
            event_payload,
            authoritative_time_disclosure_policy=TimeDisclosurePolicy.HIDE_DAY,
        )


def test_replay_has_one_strict_core_gate_and_optional_capabilities(
    tmp_path: Path,
) -> None:
    default = load_replay_settings(
        {}, data_dir=tmp_path, klines_db_path=tmp_path / "candlescope.db"
    )
    assert default.enabled is False
    assert default.replay_segment_download_worker_enabled is False
    assert default.replay_segment_auto_gc_enabled is False
    assert default.replay_fast_forward_optimization_enabled is False
    assert default.replay_agg_trade_enabled is False
    assert default.replay_account_history_enabled is False
    assert default.replay_account_history_max_archive_bytes == 128 * 1024**3

    enabled = load_replay_settings(
        {"REPLAY_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
    )
    assert enabled.enabled is True

    for retired_value in ("0", "1", "sometimes"):
        with pytest.raises(ValueError, match="REPLAY_PRODUCT_V2_ENABLED was removed"):
            load_replay_settings(
                {"REPLAY_PRODUCT_V2_ENABLED": retired_value},
                data_dir=tmp_path,
                klines_db_path=tmp_path / "candlescope.db",
            )
    for variable in (
        "REPLAY_SEGMENT_DOWNLOAD_WORKER_ENABLED",
        "REPLAY_SEGMENT_AUTO_GC_ENABLED",
        "REPLAY_FAST_FORWARD_OPTIMIZATION_ENABLED",
        "REPLAY_AGG_TRADE_ENABLED",
        "REPLAY_ACCOUNT_HISTORY_ENABLED",
    ):
        with pytest.raises(ValueError, match=variable):
            load_replay_settings(
                {variable: "sometimes"},
                data_dir=tmp_path,
                klines_db_path=tmp_path / "candlescope.db",
            )


@pytest.mark.anyio
async def test_training_http_paths_fail_closed_without_a_started_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        replay_api,
        "REPLAY_SETTINGS",
        replace(
            replay_api.REPLAY_SETTINGS,
            enabled=False,
        ),
    )
    app = _app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for method in ("GET", "POST"):
            response = await client.request(method, "/api/v1/replay/runs", json={})
            assert response.status_code == 503
            assert response.json() == {
                    "protocol": "replay.v3",
                "error": {
                    "code": "REPLAY_TRAINING_UNAVAILABLE",
                    "message": "Replay training runtime is unavailable",
                    "details": {},
                },
            }
    assert not hasattr(app.state, "replay_v2_runtime")
    assert not hasattr(app.state, "replay_v2_service")


@pytest.mark.anyio
async def test_enabled_replay_without_started_runtime_fails_closed(
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
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/replay/runs")
    assert response.status_code == 503
    assert response.json()["error"] == {
        "code": "REPLAY_TRAINING_UNAVAILABLE",
        "message": "Replay training runtime is unavailable",
        "details": {},
    }


def test_training_websocket_path_fails_without_a_started_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        replay_api,
        "REPLAY_SETTINGS",
        replace(
            replay_api.REPLAY_SETTINGS,
            enabled=False,
        ),
    )
    with TestClient(_app()) as client:
        with client.websocket_connect(
            "/api/v1/stream/replay/run-1?protocol=replay.v3"
        ) as websocket:
            assert websocket.receive_json() == {
                "protocol": "replay.v3",
                "error": {
                    "code": "REPLAY_TRAINING_UNAVAILABLE",
                    "message": "Replay training runtime is unavailable",
                    "details": {},
                },
            }
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()
            assert closed.value.code == 1013


def test_phase0_contract_does_not_freeze_retired_v1_product_assets() -> None:
    golden = _golden()
    assert golden["protocol"] == REPLAY_V2_PROTOCOL
    assert set(golden) == {
        "protocol",
        "schema_version",
        "enums",
        "adapter_storage_contract",
        "sample_command",
        "sample_event",
        "sample_run",
        "sample_track",
    }
    assert set(golden).isdisjoint(
        {"baseline_head", "v1_protocol", "golden", "performance", "rollback"}
    )
    adapter = golden["adapter_storage_contract"]
    assert isinstance(adapter, dict)
    assert adapter["ownership"] == "V2_INTERNAL_ADAPTER"
    assert adapter["public_legacy_import"] is False
