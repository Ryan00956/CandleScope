from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.api.v1 import stream as stream_api
from app.core import config
from app.data_engine.data_manager.models import (
    BarData,
    DataEvent,
    DataEventType,
    SeriesKey,
)
from app.indicator import create_engine
from app.indicator.range_result_service import IndicatorRangeResultService


FIXTURE_PATH = (
    Path(__file__).parent
    / "fixtures"
    / "plugin_runtime"
    / "pyne_transport_v1.json"
)


class _QueryResult:
    def __init__(self, bars: list[BarData]) -> None:
        self.bars = bars
        self.missing_ranges: list[object] = []


class _CompatibilityDataManager:
    def __init__(self, bars: list[BarData], *, emit_realtime: bool = False) -> None:
        self.bars = bars
        self.emit_realtime = emit_realtime

    def query(self, *args: Any, **kwargs: Any) -> _QueryResult:
        return _QueryResult(self.bars)

    def query_latest(self, *args: Any, **kwargs: Any) -> _QueryResult:
        return _QueryResult(self.bars)

    async def ensure_stream(self, *args: Any, **kwargs: Any) -> None:
        return None

    def subscribe(self, **kwargs: Any) -> Any:
        callback = kwargs["callback"]
        if self.emit_realtime:
            event = DataEvent(
                event_type=DataEventType.BAR_CLOSED,
                key=SeriesKey(
                    str(kwargs["symbol"]),
                    str(kwargs["interval"]),
                    exchange=str(kwargs["exchange"]),
                    market_type=str(kwargs["market_type"]),
                ),
                bar=self.bars[-1],
                timestamp_ms=self.bars[-1].time * 1000,
            )

            def dispatch() -> None:
                asyncio.create_task(callback(event))

            asyncio.get_running_loop().call_soon(dispatch)
        return callback

    def unsubscribe(self, handle: Any) -> None:
        return None

    async def release_stream(self, *args: Any, **kwargs: Any) -> None:
        return None


@pytest.fixture(scope="module")
def compatibility_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _bar_models(fixture: dict[str, Any]) -> list[BarData]:
    return [
        BarData.from_dict(item).with_closed_state(True)
        for item in fixture["bars"]
    ]


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _assert_frozen_payload(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    assert sorted(actual) == expected["topLevelKeys"]
    assert _canonical_sha256(actual) == expected["canonicalSha256"]


def test_pyne_http_compute_matches_pre_plugin_transport_baseline(
    compatibility_fixture: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "PYNE_EXECUTOR_MODE", "inline")
    spec = compatibility_fixture["httpCompute"]
    request_payload = {
        **spec["request"],
        "script": compatibility_fixture["script"],
        "ohlcv": compatibility_fixture["bars"],
    }
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")

    with TestClient(app) as client:
        response = client.post(spec["path"], json=request_payload)

    assert response.status_code == spec["expected"]["statusCode"]
    payload = response.json()
    _assert_frozen_payload(payload, spec["expected"])
    assert payload["ok"] is True
    assert payload["schemaVersion"] == 1
    assert payload["outputSchemaVersion"] == 2
    assert payload["scriptHash"] == compatibility_fixture["identity"]["scriptHash"]
    assert payload["meta"] == {
        "overlay": False,
        "securityMode": "safe",
        "title": "Plugin Baseline",
    }
    assert payload["lines"][0]["data"][-1] == {
        "time": 1700000240,
        "value": 210.0,
    }


def test_pyne_http_range_matches_pre_plugin_history_baseline(
    compatibility_fixture: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "PYNE_EXECUTOR_MODE", "inline")
    spec = compatibility_fixture["httpRange"]
    request_payload = {
        **spec["request"],
        "script": compatibility_fixture["script"],
    }
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = _CompatibilityDataManager(
        _bar_models(compatibility_fixture)
    )
    app.state.indicator_range_service = IndicatorRangeResultService(
        server_epoch=compatibility_fixture["serverEpoch"]
    )

    with TestClient(app) as client:
        response = client.post(spec["path"], json=request_payload)

    assert response.status_code == spec["expected"]["statusCode"]
    payload = response.json()
    _assert_frozen_payload(payload, spec["expected"])
    assert payload["type"] == "indicator.replace_range"
    assert payload["indicatorId"] == compatibility_fixture["identity"][
        "rangeIndicatorId"
    ]
    assert payload["range"] == {"start": 1700000060, "end": 1700000180}
    assert payload["targetBars"] == 3
    assert payload["warmupBars"] == 200
    assert payload["dataRevision"] == {
        "serverEpoch": compatibility_fixture["serverEpoch"],
        "correctionRevision": 0,
        "closedThrough": 1700000180,
        "revisionToken": f"{compatibility_fixture['serverEpoch']}:0",
    }
    assert [point["time"] for point in payload["lines"][0]["data"]] == [
        1700000060,
        1700000120,
        1700000180,
    ]


def test_pyne_websocket_matches_pre_plugin_realtime_baseline(
    compatibility_fixture: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "PYNE_EXECUTOR_MODE", "inline")
    monkeypatch.setattr(config, "INDICATOR_WS_HEARTBEAT_SECONDS", 5.0)
    spec = compatibility_fixture["websocket"]
    subscribe = {
        **spec["subscribe"],
        "script": compatibility_fixture["script"],
    }
    app = FastAPI()
    app.include_router(stream_api.router, prefix="/api/v1")
    app.state.data_manager = _CompatibilityDataManager(
        _bar_models(compatibility_fixture),
        emit_realtime=True,
    )
    engine = create_engine()
    app.state.indicator_engine = engine
    frames: list[dict[str, Any]] = []

    try:
        with TestClient(app) as client:
            with client.websocket_connect(spec["path"]) as websocket:
                frames.append(websocket.receive_json())
                websocket.send_json(subscribe)
                frames.append(websocket.receive_json())
                frames.append(websocket.receive_json())
                websocket.send_json(spec["unsubscribe"])
                frames.append(websocket.receive_json())
    finally:
        engine.stop()

    expected = spec["expected"]
    assert [frame["type"] for frame in frames] == expected["frameTypes"]
    assert [frame["seq"] for frame in frames] == [1, 2, 3, 4]
    assert [_canonical_sha256(frame) for frame in frames] == expected[
        "frameSha256"
    ]
    assert _canonical_sha256(frames) == expected["canonicalSha256"]

    subscribed = frames[1]
    assert subscribed["indicatorId"] == compatibility_fixture["identity"][
        "websocketIndicatorId"
    ]
    assert subscribed["subscriptionStatus"] == "accepted"
    assert subscribed["realtimeStatus"] == "live"
    assert subscribed["seeded"] is False

    patch = frames[2]
    assert patch["range"] == {"start": 1700000240, "end": 1700000240}
    assert patch["reason"] == "bar_update"
    assert patch["lines"][0]["data"] == [
        {"time": 1700000240, "value": 210.0}
    ]
