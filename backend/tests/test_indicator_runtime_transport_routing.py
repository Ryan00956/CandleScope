from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from candlescope_plugin_sdk import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_HISTOGRAM_SERIES_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_RENDER_STRUCTURED_OUTPUT_V1,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    RenderCollections,
    RenderOutput,
    RuntimeDescriptor,
)

from app.api.v1 import indicators as indicators_api
from app.api.v1 import stream as stream_api
from app.api.v1 import stream_indicator_payloads as payload_api
from app.api.v1 import stream_pyne_subscriptions as pyne_stream_api
from app.core import config
from app.data_engine.data_manager.models import (
    BarData,
    DataEvent,
    DataEventType,
    SeriesKey,
)
from app.indicator import create_engine
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.runtime_routes import (
    IndicatorRuntimeRoute,
    IndicatorRuntimeRoutes,
)
from app.indicator.runtime_service import IndicatorRuntimeService
from app.plugin_runtime.errors import PluginTransportError


FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "plugin_runtime" / "pyne_transport_v1.json"
)


class _QueryResult:
    def __init__(self, bars: list[BarData]) -> None:
        self.bars = bars
        self.missing_ranges: list[object] = []


class _DataManager:
    def __init__(self, bars: list[BarData], *, emit_realtime: bool = False) -> None:
        self.bars = bars
        self.emit_realtime = emit_realtime
        self.query_calls = 0

    def query(self, *args: Any, **kwargs: Any) -> _QueryResult:
        self.query_calls += 1
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
                    kwargs["symbol"],
                    kwargs["interval"],
                    exchange=kwargs["exchange"],
                    market_type=kwargs["market_type"],
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


class _CloseRuntimeHost:
    def __init__(self, *, languages: tuple[str, ...] = ("pyne",)) -> None:
        self.requests: list[ExecuteBatchRequest] = []
        self.fail = False
        self.languages = languages

    async def descriptor(self, runtime_id: str) -> RuntimeDescriptor:
        assert runtime_id == "test.pyne"
        return RuntimeDescriptor(
            id="test.pyne",
            name="Test Pyne",
            version="1.0.0",
            package="test-pyne",
            languages=tuple(
                LanguageDescriptor(id=language, name=language.title())
                for language in self.languages
            ),
            features=(
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
            required_host_features=(),
        )

    async def execute_batch(
        self,
        runtime_id: str,
        request: ExecuteBatchRequest,
    ) -> ExecuteBatchResult:
        assert runtime_id == "test.pyne"
        self.requests.append(request)
        if self.fail:
            raise PluginTransportError(
                code="PLUGIN_PROCESS_EXITED",
                message="private sidecar failure",
                runtime_id=runtime_id,
            )
        return ExecuteBatchResult(
            ok=True,
            output=RenderOutput(
                series=(
                    LineSeries(
                        id="double-close",
                        title="Double Close",
                        pane="separate",
                        style={
                            "color": "#22c55e",
                            "lineWidth": 2,
                            "id": "plugin-must-not-override-id",
                            "data": [],
                            "type": "plugin-must-not-override-type",
                        },
                        points=tuple(
                            LinePoint(time=bar.time, value=bar.close * 2)
                            for bar in request.bars
                        ),
                    ),
                ),
                meta={"title": "Plugin Output", "overlay": False},
            ),
        )


class _FrozenPyneHost(_CloseRuntimeHost):
    async def descriptor(self, runtime_id: str) -> RuntimeDescriptor:
        descriptor = await super().descriptor(runtime_id)
        return RuntimeDescriptor(
            id=descriptor.id,
            name=descriptor.name,
            version=descriptor.version,
            package=descriptor.package,
            languages=descriptor.languages,
            features=(
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
                FEATURE_RENDER_HISTOGRAM_SERIES_V1,
                FEATURE_RENDER_STRUCTURED_OUTPUT_V1,
            ),
            required_host_features=(),
        )

    async def execute_batch(
        self,
        runtime_id: str,
        request: ExecuteBatchRequest,
    ) -> ExecuteBatchResult:
        assert runtime_id == "test.pyne"
        self.requests.append(request)
        raw_points = [
            {"time": bar.time, "value": bar.close * 2} for bar in request.bars
        ]
        marker_points = [
            {
                "time": bar.time,
                "shape": "circle",
                "color": "#3b82f6",
                "text": "UP",
                "position": "above",
                "size": "normal",
                "pane": "separate",
            }
            for bar in request.bars
            if bar.close > bar.open
        ]
        output_meta = {"title": "Plugin Baseline", "overlay": False}
        return ExecuteBatchResult(
            ok=True,
            output=RenderOutput(
                series=(
                    LineSeries(
                        id="plot_1",
                        title="Double Close",
                        pane="separate",
                        style={
                            "color": "#22c55e",
                            "lineWidth": 2,
                            "lineStyle": 0,
                        },
                        points=tuple(
                            LinePoint(time=point["time"], value=point["value"])
                            for point in raw_points
                        ),
                    ),
                ),
                collections=RenderCollections(
                    lines=(
                        {
                            "id": "plot_1",
                            "title": "Double Close",
                            "color": "#22c55e",
                            "linewidth": 2,
                            "style": "solid",
                            "pane": "separate",
                            "data": raw_points,
                        },
                    ),
                    hlines=(
                        {
                            "price": 210.0,
                            "title": "Threshold",
                            "color": "#f59e0b",
                            "linestyle": "dashed",
                            "linewidth": 1,
                            "pane": "separate",
                        },
                    ),
                    markers=(
                        {
                            "shape": "circle",
                            "text": "UP",
                            "position": "above",
                            "size": "normal",
                            "color": "#3b82f6",
                            "pane": "separate",
                            "data": marker_points,
                        },
                    ),
                ),
                meta=output_meta,
            ),
            meta={**output_meta, "securityMode": "safe"},
        )


def _service(
    mode: str,
    *,
    language: str = "pyne",
) -> tuple[IndicatorRuntimeService, _CloseRuntimeHost]:
    host = _CloseRuntimeHost(languages=(language,))
    routes = [
        IndicatorRuntimeRoute(
            language="pyne",
            mode=(mode if language == "pyne" else "legacy"),
            runtime_id=("test.pyne" if language == "pyne" else None),
        )
    ]
    if language != "pyne":
        routes.append(
            IndicatorRuntimeRoute(
                language=language,
                mode=mode,
                runtime_id="test.pyne",
            )
        )
    service = IndicatorRuntimeService(
        IndicatorRuntimeRoutes(tuple(routes)),
        host=host,
    )
    return service, host


def _frozen_service(mode: str) -> tuple[IndicatorRuntimeService, _FrozenPyneHost]:
    host = _FrozenPyneHost()
    service = IndicatorRuntimeService(
        IndicatorRuntimeRoutes(
            (
                IndicatorRuntimeRoute(
                    language="pyne",
                    mode=mode,
                    runtime_id="test.pyne",
                ),
            )
        ),
        host=host,
    )
    return service, host


def _fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _bars(fixture: dict[str, Any]) -> list[BarData]:
    return [BarData.from_dict(item).with_closed_state(True) for item in fixture["bars"]]


def _forbid_legacy(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("sidecar route must not execute legacy Pyne")


def test_sidecar_routes_http_compute_without_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, host = _service("sidecar")
    monkeypatch.setattr(indicators_api, "execute_pyne_script", _forbid_legacy)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.indicator_runtime_service = service

    request = {
        **fixture["httpCompute"]["request"],
        "script": fixture["script"],
        "ohlcv": fixture["bars"],
    }
    with TestClient(app) as client:
        response = client.post("/api/v1/indicators/compute", json=request)

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["lines"][0]["id"] == "double-close"
    assert payload["lines"][0]["type"] == "line"
    assert payload["lines"][0]["data"][-1] == {
        "time": 1700000240,
        "value": 210.0,
    }
    assert payload["scriptHash"] == fixture["identity"]["scriptHash"]
    assert host.requests[0].context.symbol == "BTCUSDT"
    assert host.requests[0].options == {"securityMode": "safe"}


def test_community_language_can_use_sidecar_without_a_private_adapter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, host = _service("sidecar", language="community-lang")
    monkeypatch.setattr(indicators_api, "execute_pyne_script", _forbid_legacy)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.indicator_runtime_service = service
    request = {
        **fixture["httpCompute"]["request"],
        "language": "community-lang",
        "script": "community source",
        "ohlcv": fixture["bars"],
    }

    with TestClient(app) as client:
        payload = client.post("/api/v1/indicators/compute", json=request).json()

    assert payload["ok"] is True
    assert host.requests[0].source == "community source"
    assert host.requests[0].context.symbol == "BTCUSDT"


def test_unconfigured_language_has_consistent_range_and_batch_errors() -> None:
    fixture = _fixture()
    service, host = _service("sidecar")
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.indicator_runtime_service = service
    app.state.data_manager = _DataManager(_bars(fixture))
    app.state.indicator_range_service = IndicatorRangeResultService(
        server_epoch="unconfigured-language-epoch"
    )
    request = {
        **fixture["httpRange"]["request"],
        "language": "community-lang",
        "script": "community source",
    }

    with TestClient(app) as client:
        single = client.post("/api/v1/indicators/range", json=request).json()
        batch = client.post(
            "/api/v1/indicators/range/batch",
            json={"requests": [request]},
        ).json()

    assert single["code"] == "INDICATOR_LANGUAGE_UNAVAILABLE"
    assert batch["results"][0]["payload"]["code"] == ("INDICATOR_LANGUAGE_UNAVAILABLE")
    assert host.requests == []


def test_unconfigured_language_has_a_terminal_websocket_error() -> None:
    fixture = _fixture()
    service, host = _service("sidecar")
    app = FastAPI()
    app.include_router(stream_api.router, prefix="/api/v1")
    app.state.data_manager = _DataManager(_bars(fixture))
    app.state.indicator_runtime_service = service
    engine = create_engine()
    app.state.indicator_engine = engine
    subscribe = {
        **fixture["websocket"]["subscribe"],
        "language": "community-lang",
        "script": "community source",
    }

    try:
        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/stream/indicators") as websocket:
                assert websocket.receive_json()["type"] == "connected"
                websocket.send_json(subscribe)
                failure = websocket.receive_json()
    finally:
        engine.stop()

    assert failure["type"] == "indicator.subscribed"
    assert failure["ok"] is False
    assert failure["code"] == "INDICATOR_LANGUAGE_UNAVAILABLE"
    assert failure["subscriptionStatus"] == "failed"
    assert host.requests == []


def test_sidecar_routes_http_range_and_preserves_transport_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, host = _service("sidecar")
    monkeypatch.setattr(payload_api, "execute_pyne_script", _forbid_legacy)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.indicator_runtime_service = service
    app.state.data_manager = _DataManager(_bars(fixture))
    app.state.indicator_range_service = IndicatorRangeResultService(
        server_epoch="sidecar-range-epoch"
    )
    request = {
        **fixture["httpRange"]["request"],
        "script": fixture["script"],
    }

    with TestClient(app) as client:
        response = client.post("/api/v1/indicators/range", json=request)

    payload = response.json()
    assert response.status_code == 200
    assert payload["type"] == "indicator.replace_range"
    assert payload["kind"] == "script"
    assert payload["indicatorId"] == fixture["identity"]["rangeIndicatorId"]
    assert payload["range"] == {"start": 1700000060, "end": 1700000180}
    assert payload["warmupBars"] == 200
    assert payload["targetBars"] == 3
    assert [point["time"] for point in payload["lines"][0]["data"]] == [
        1700000060,
        1700000120,
        1700000180,
    ]
    assert len(host.requests) == 1


def test_sidecar_routes_range_batch_with_one_shared_bar_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, host = _service("sidecar")
    monkeypatch.setattr(payload_api, "execute_pyne_script", _forbid_legacy)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    dm = _DataManager(_bars(fixture))
    app.state.indicator_runtime_service = service
    app.state.data_manager = dm
    app.state.indicator_range_service = IndicatorRangeResultService(
        server_epoch="sidecar-batch-epoch"
    )
    first = {
        **fixture["httpRange"]["request"],
        "script": fixture["script"],
    }
    second = {**first, "clientId": "baseline-script-2"}

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/indicators/range/batch",
            json={"requests": [first, second]},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload["type"] == "indicator.range_batch"
    assert payload["ok"] is True
    assert [item["payload"]["type"] for item in payload["results"]] == [
        "indicator.replace_range",
        "indicator.replace_range",
    ]
    assert dm.query_calls == 1
    assert len(host.requests) == 1
    assert [item["payload"]["indicatorId"] for item in payload["results"]] == [
        fixture["identity"]["rangeIndicatorId"],
        "pyne:binance:spot:BTCUSDT:1m:5eda0d7ae01a:baseline-script-2",
    ]
    second_payload = payload["results"][1]["payload"]
    assert second_payload["series"][0]["indicatorId"] == second_payload["indicatorId"]
    assert second_payload["series"][0]["id"].startswith(
        f"{second_payload['indicatorId']}:"
    )


def test_sidecar_range_host_failure_is_not_cached_or_fallbacked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, host = _service("sidecar")
    host.fail = True
    monkeypatch.setattr(payload_api, "execute_pyne_script", _forbid_legacy)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    dm = _DataManager(_bars(fixture))
    cache = IndicatorRangeResultService(server_epoch="sidecar-failure-epoch")
    app.state.indicator_runtime_service = service
    app.state.data_manager = dm
    app.state.indicator_range_service = cache
    request = {
        **fixture["httpRange"]["request"],
        "script": fixture["script"],
    }

    with TestClient(app) as client:
        first = client.post("/api/v1/indicators/range", json=request).json()
        second = client.post("/api/v1/indicators/range", json=request).json()

    assert first["code"] == "INDICATOR_RUNTIME_UNAVAILABLE"
    assert second["code"] == "INDICATOR_RUNTIME_UNAVAILABLE"
    assert "private sidecar failure" not in str(first)
    assert dm.query_calls == 2
    assert len(host.requests) == 2
    assert cache.snapshot()["entries"] == 0


def test_sidecar_routes_websocket_realtime_without_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, host = _service("sidecar")
    monkeypatch.setattr(payload_api, "execute_pyne_script", _forbid_legacy)
    monkeypatch.setattr(pyne_stream_api, "is_incremental_pyne_script", _forbid_legacy)
    monkeypatch.setattr(config, "INDICATOR_WS_HEARTBEAT_SECONDS", 5.0)
    app = FastAPI()
    app.include_router(stream_api.router, prefix="/api/v1")
    app.state.data_manager = _DataManager(_bars(fixture), emit_realtime=True)
    app.state.indicator_runtime_service = service
    engine = create_engine()
    app.state.indicator_engine = engine
    subscribe = {
        **fixture["websocket"]["subscribe"],
        "script": fixture["script"],
    }

    try:
        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/stream/indicators") as websocket:
                assert websocket.receive_json()["type"] == "connected"
                websocket.send_json(subscribe)
                subscribed = websocket.receive_json()
                patch = websocket.receive_json()
                websocket.send_json(fixture["websocket"]["unsubscribe"])
                unsubscribed = websocket.receive_json()
    finally:
        engine.stop()

    assert subscribed["type"] == "indicator.subscribed"
    assert subscribed["seeded"] is False
    assert patch["type"] == "indicator.patch"
    assert patch["range"] == {"start": 1700000240, "end": 1700000240}
    assert patch["lines"][0]["data"] == [{"time": 1700000240, "value": 210.0}]
    assert unsubscribed["type"] == "indicator.unsubscribed"
    assert len(host.requests) == 1


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


@pytest.mark.anyio
async def test_shadow_matches_the_frozen_http_compute_payload_exactly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, _ = _frozen_service("shadow")
    monkeypatch.setattr(config, "PYNE_EXECUTOR_MODE", "inline")
    request = indicators_api.ComputeRequest.model_validate(
        {
            **fixture["httpCompute"]["request"],
            "script": fixture["script"],
            "ohlcv": fixture["bars"],
        }
    )

    payload = await indicators_api._compute_script(
        request,
        runtime_service=service,
    )
    await service.drain_shadow()

    assert (
        _canonical_sha256(payload)
        == fixture["httpCompute"]["expected"]["canonicalSha256"]
    )
    snapshot = service.snapshot()
    assert snapshot["counts"]["shadow"] == 1
    assert snapshot["counts"]["shadowMatched"] == 1
    assert snapshot["counts"]["shadowMismatched"] == 0
    assert snapshot["recent"][-1]["status"] == "matched"


def test_pyne_sidecar_http_compute_matches_the_phase0_golden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, _ = _frozen_service("sidecar")
    monkeypatch.setattr(indicators_api, "execute_pyne_script", _forbid_legacy)
    request = {
        **fixture["httpCompute"]["request"],
        "script": fixture["script"],
        "ohlcv": fixture["bars"],
    }
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.indicator_runtime_service = service

    with TestClient(app) as client:
        response = client.post(fixture["httpCompute"]["path"], json=request)

    payload = response.json()
    expected = fixture["httpCompute"]["expected"]
    assert response.status_code == expected["statusCode"]
    assert sorted(payload) == expected["topLevelKeys"]
    assert _canonical_sha256(payload) == expected["canonicalSha256"]


def test_pyne_sidecar_http_range_matches_the_phase0_golden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, _ = _frozen_service("sidecar")
    monkeypatch.setattr(payload_api, "execute_pyne_script", _forbid_legacy)
    request = {
        **fixture["httpRange"]["request"],
        "script": fixture["script"],
    }
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.indicator_runtime_service = service
    app.state.data_manager = _DataManager(_bars(fixture))
    app.state.indicator_range_service = IndicatorRangeResultService(
        server_epoch=fixture["serverEpoch"]
    )

    with TestClient(app) as client:
        response = client.post(fixture["httpRange"]["path"], json=request)

    payload = response.json()
    expected = fixture["httpRange"]["expected"]
    assert response.status_code == expected["statusCode"]
    assert sorted(payload) == expected["topLevelKeys"]
    assert _canonical_sha256(payload) == expected["canonicalSha256"]


def test_pyne_sidecar_websocket_matches_the_phase0_golden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    service, _ = _frozen_service("sidecar")
    monkeypatch.setattr(payload_api, "execute_pyne_script", _forbid_legacy)
    monkeypatch.setattr(pyne_stream_api, "is_incremental_pyne_script", _forbid_legacy)
    monkeypatch.setattr(config, "INDICATOR_WS_HEARTBEAT_SECONDS", 5.0)
    subscribe = {
        **fixture["websocket"]["subscribe"],
        "script": fixture["script"],
    }
    app = FastAPI()
    app.include_router(stream_api.router, prefix="/api/v1")
    app.state.data_manager = _DataManager(_bars(fixture), emit_realtime=True)
    app.state.indicator_runtime_service = service
    engine = create_engine()
    app.state.indicator_engine = engine
    frames: list[dict[str, Any]] = []

    try:
        with TestClient(app) as client:
            with client.websocket_connect(fixture["websocket"]["path"]) as websocket:
                frames.append(websocket.receive_json())
                websocket.send_json(subscribe)
                frames.append(websocket.receive_json())
                frames.append(websocket.receive_json())
                websocket.send_json(fixture["websocket"]["unsubscribe"])
                frames.append(websocket.receive_json())
    finally:
        engine.stop()

    expected = fixture["websocket"]["expected"]
    assert [frame["type"] for frame in frames] == expected["frameTypes"]
    assert [_canonical_sha256(frame) for frame in frames] == expected["frameSha256"]
    assert _canonical_sha256(frames) == expected["canonicalSha256"]
