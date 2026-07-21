from __future__ import annotations

import asyncio
import contextlib

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.api.v1 import stream_indicator_payloads as payload_api
from app.api.v1 import stream_indicators as stream_api
from app.api.v1.indicators import ComputeRequest, CustomIndicatorPayload
from app.indicator import create_engine
from app.data_engine.data_manager.models import BarData
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.engine import indicator_code_hash
from app.indicator.script_identity import script_hash, short_script_hash
from app.indicator.types import IndicatorKey


class _QueryResult:
    def __init__(
        self, bars: list[BarData], missing_ranges: list[object] | None = None
    ) -> None:
        self.bars = bars
        self.missing_ranges = missing_ranges or []


class _RangeDataManager:
    def __init__(
        self, bars: list[BarData], missing_ranges: list[object] | None = None
    ) -> None:
        self.bars = bars
        self.missing_ranges = missing_ranges or []

    def query(self, *args, **kwargs):
        return _QueryResult(self.bars, self.missing_ranges)


def _indicator_client(data_manager) -> TestClient:
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = data_manager
    return TestClient(app)


def _bars(count: int = 30) -> list[dict]:
    return [
        {
            "time": 1_700_000_000 + i * 60,
            "open": 100 + i,
            "high": 101 + i,
            "low": 99 + i,
            "close": 100 + i,
            "volume": 10 + i,
        }
        for i in range(count)
    ]


@pytest.mark.anyio
async def test_compute_mode_builtin_uses_engine() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="builtin",
            name="MA",
            script='plot(close * 999, title="Wrong")',
            ohlcv=_bars(),
            params={"period": 5},
        )
    )

    assert payload["ok"] is True
    assert payload["schemaVersion"] == 1
    assert payload["outputSchemaVersion"] == 2
    assert payload["series"][0]["localId"] == "ma"
    assert payload["series"][0]["pane"] == "main"
    assert payload["paneLayout"][0]["id"] == "main"
    assert payload["lines"][0]["name"] == "MA(5)"
    assert payload["lines"][0]["outputName"] == "ma"


@pytest.mark.anyio
async def test_compute_builtin_invalid_ohlcv_has_structured_error() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="builtin",
            name="MA",
            ohlcv=[],
            params={"period": 5},
        )
    )

    assert payload["ok"] is False
    assert payload["schemaVersion"] == 1
    assert payload["code"] == "INVALID_OHLCV"
    assert payload["errorDetail"]["code"] == "INVALID_OHLCV"


@pytest.mark.anyio
async def test_compute_mode_builtin_accepts_engine_marker_without_name() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="builtin",
            script="# __ENGINE__:MA\n",
            ohlcv=_bars(),
            params={"period": 7},
        )
    )

    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "MA(7)"


@pytest.mark.anyio
async def test_custom_indicator_crud_roundtrip(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        indicators_api,
        "_custom_store",
        CustomIndicatorStore(tmp_path / "custom_indicators.json"),
    )

    created = await indicators_api.save_custom_indicator(
        CustomIndicatorPayload(
            name="My Script",
            script="plot(close)",
            params={"length": 20},
            paramSchema=[{"key": "length", "type": "int", "default": 20}],
        )
    )

    assert created["schemaVersion"] == 1
    assert created["id"].startswith("custom-")
    assert created["kind"] == "script"

    items = await indicators_api.list_custom_indicators()
    assert items[0]["id"] == created["id"]

    deleted = await indicators_api.delete_custom_indicator(created["id"])
    assert deleted == {"ok": True, "id": created["id"]}

    with pytest.raises(HTTPException) as exc_info:
        await indicators_api.delete_custom_indicator(created["id"])
    assert exc_info.value.status_code == 404


@pytest.mark.anyio
async def test_pyne_security_policy_endpoint() -> None:
    policy = await indicators_api.get_pyne_security_policy()

    assert policy["mode"] in {"safe", "research", "unsafe"}
    assert "numpy" in policy["allowedImports"]
    assert policy["owner"] == "candlescope.pyne"
    assert policy["boundary"] == "sidecar"


def test_indicator_diagnostics_snapshot_reports_runtime_state(tmp_path) -> None:
    store = CustomIndicatorStore(tmp_path / "custom_indicators.json")
    store.upsert(
        {
            "name": "Diag Script",
            "script": "plot(close)",
        }
    )
    engine = create_engine()
    engine.subscribe(
        "BTCUSDT",
        "1m",
        "spot",
        "MA",
        {"period": 3},
        [BarData.from_dict(item) for item in _bars(5)],
        exchange="binance",
    )

    payload = indicators_api._build_diagnostics_snapshot(engine=engine, store=store)

    assert payload["ok"] is True
    assert payload["schemaVersion"] == 1
    assert payload["registry"]["count"] >= 1
    assert payload["engine"]["instance_count"] == 1
    assert payload["customIndicators"]["count"] == 1
    assert payload["pyne"]["runtimeBackend"] == {
        "package": "candlescope-plugin-pyne",
        "active": "sidecar",
        "runtimeId": "candlescope.pyne",
    }
    assert payload["pyne"]["security"]["mode"] in {"safe", "research", "unsafe"}
    assert payload["pyne"]["executor"]["mode"] == "sidecar"
    assert payload["pyne"]["cache"] == {
        "scope": "sidecar",
        "availableToHost": False,
    }
    assert payload["websocket"]["maxSubscriptions"] >= 1
    assert "heartbeat_delay" in payload["websocket"]["metrics"]
    assert payload["executors"]["indicator"]["max_workers"] >= 1
    assert payload["executors"]["pyne_wait"]["max_workers"] >= 1
    assert payload["executors"]["storage"]["max_workers"] >= 1


def test_indicator_range_http_allows_more_than_5000_builtin_bars() -> None:
    bars = [BarData.from_dict(item) for item in _bars(6005)]
    client = _indicator_client(_RangeDataManager(bars))

    response = client.post(
        "/api/v1/indicators/range",
        json={
            "clientId": "ma-1",
            "kind": "builtin",
            "exchange": "binance",
            "marketType": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "MA",
            "params": {"period": 3},
            "start": bars[0].time,
            "end": bars[-1].time,
            "reason": "unit-test",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "indicator.replace_range"
    assert payload["range"] == {"start": bars[0].time, "end": bars[-1].time}
    assert payload["targetBars"] > 5000
    assert payload["lines"][0]["data"][-1]["time"] == bars[-1].time


@pytest.mark.parametrize(
    ("indicator_name", "params"),
    [
        ("BOLL", {"period": 20, "mult": 2.0, "source": "close"}),
        ("MACD", {"fast": 12, "slow": 26, "signal": 9, "source": "close"}),
    ],
)
def test_indicator_range_patch_stops_before_forming_latest_bar(
    indicator_name: str,
    params: dict,
) -> None:
    closed_bars = [
        BarData.from_dict(item).with_closed_state(True) for item in _bars(80)
    ]
    forming_bar = BarData.from_dict(_bars(81)[-1]).with_closed_state(False)
    bars = [*closed_bars, forming_bar]

    payload = payload_api._compute_builtin_range_patch(
        "indicator-1",
        _RangeDataManager(bars),
        {
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": indicator_name,
            "params": params,
            "indicatorId": "indicator-1",
        },
        closed_bars[-2].time,
        forming_bar.time,
        "auto-right-catchup",
        3,
    )

    assert payload["type"] == "indicator.replace_range"
    assert payload["range"] == {
        "start": closed_bars[-2].time,
        "end": closed_bars[-1].time,
    }
    returned_times = [
        point["time"] for line in payload["lines"] for point in line["data"]
    ]
    assert returned_times
    assert max(returned_times) == closed_bars[-1].time
    assert forming_bar.time not in returned_times


def test_builtin_range_patch_reports_only_actual_target_bar_coverage() -> None:
    all_bars = [BarData.from_dict(item).with_closed_state(True) for item in _bars(10)]
    available_tail = all_bars[-3:]

    payload = payload_api._compute_builtin_range_patch_from_bars(
        "vol-1",
        {
            "kind": "builtin",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "VOL",
            "params": {},
            "indicatorId": "vol-1",
        },
        all_bars[0].time,
        all_bars[-1].time,
        available_tail,
        "unit-test",
        len(all_bars),
    )

    assert payload["range"] == {
        "start": available_tail[0].time,
        "end": available_tail[-1].time,
    }
    assert payload["lines"][0]["data"][0]["time"] == available_tail[0].time


def test_indicator_range_http_reports_not_ready_for_missing_target_range() -> None:
    bars = [BarData.from_dict(item) for item in _bars(5)]

    class Missing:
        start_ms = bars[0].time * 1000
        end_ms = bars[-1].time * 1000

    client = _indicator_client(_RangeDataManager(bars, [Missing()]))

    response = client.post(
        "/api/v1/indicators/range",
        json={
            "clientId": "ma-1",
            "kind": "builtin",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "MA",
            "params": {"period": 3},
            "start": bars[0].time,
            "end": bars[-1].time,
        },
    )

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_NOT_READY"
    assert payload["detail"]["retryAfterMs"] == 3000


def test_indicator_range_http_reports_empty_for_forming_only_target_range() -> None:
    closed_bars = [BarData.from_dict(item).with_closed_state(True) for item in _bars(5)]
    forming_bar = BarData.from_dict(_bars(6)[-1]).with_closed_state(False)
    client = _indicator_client(_RangeDataManager([*closed_bars, forming_bar]))

    response = client.post(
        "/api/v1/indicators/range",
        json={
            "clientId": "ma-1",
            "kind": "builtin",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "MA",
            "params": {"period": 3},
            "start": forming_bar.time,
            "end": forming_bar.time,
        },
    )

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_EMPTY"
    assert "retryAfterMs" not in payload.get("detail", {})


def test_indicator_range_http_enforces_pyne_runtime_bar_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bars = [BarData.from_dict(item) for item in _bars(10)]
    monkeypatch.setattr(indicators_api.config, "PYNE_MAX_BARS", 5)
    client = _indicator_client(_RangeDataManager(bars))

    response = client.post(
        "/api/v1/indicators/range",
        json={
            "clientId": "custom-1",
            "kind": "script",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "script": 'plot(close, title="Close")',
            "params": {},
            "start": bars[0].time,
            "end": bars[-1].time,
        },
    )

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_LIMIT"
    assert "Too many Pyne bars" in payload["error"]


def test_indicator_range_http_rejects_oversized_pyne_before_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CountingRangeDataManager(_RangeDataManager):
        def __init__(self) -> None:
            super().__init__([])
            self.query_calls = 0

        def query(self, *args, **kwargs):
            self.query_calls += 1
            raise AssertionError("oversized Pyne range must not query K-lines")

    dm = CountingRangeDataManager()
    monkeypatch.setattr(indicators_api.config, "PYNE_MAX_BARS", 5)
    client = _indicator_client(dm)

    response = client.post(
        "/api/v1/indicators/range",
        json={
            "clientId": "custom-1",
            "kind": "script",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "script": 'plot(close, title="Close")',
            "params": {},
            "start": 1_700_000_000,
            "end": 1_700_000_000 + 9 * 60,
        },
    )

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_LIMIT"
    assert dm.query_calls == 0


def test_indicator_ws_event_message_shape() -> None:
    key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20})
    event = IndicatorEvent(
        event_type=IndicatorEventType.INDICATOR_UPDATED,
        key=key,
        values={"MA": 123.45},
        bar_timestamp=1_700_000_000,
        detail={
            "bar": {
                "time": 1_700_000_000,
                "open": 101,
                "high": 102,
                "low": 98,
                "close": 99,
                "volume": 10,
            },
        },
    )

    msg = payload_api._indicator_event_to_ws_message(
        "client-1",
        event,
        {"exchange": "binance"},
    )

    assert msg["type"] == "indicator.update"
    assert msg["clientId"] == "client-1"
    assert msg["exchange"] == "binance"
    assert msg["symbol"] == "BTCUSDT"
    assert msg["values"] == {"MA": 123.45}
    assert msg["bar"]["close"] == 99


def test_macd_histogram_colors_follow_value_sign() -> None:
    closes = [1, 2, 3, 4, 5, 4, 3, 2, 3, 4, 5, 4, 3]
    bars = [
        BarData(
            time=1_700_000_000 + index * 60,
            open=close,
            high=close + 1,
            low=close - 1,
            close=close,
            volume=10,
        )
        for index, close in enumerate(closes)
    ]
    result = create_engine().compute(
        symbol="BTCUSDT",
        interval="1m",
        market_type="spot",
        indicator_name="MACD",
        params={
            "fast": 2,
            "slow": 3,
            "signal": 2,
            "hist_up_color": "#positive",
            "hist_down_color": "#negative",
        },
        bars=bars,
    )

    histogram = result.outputs["hist"]
    values_by_time = {
        point.timestamp: point.value
        for point in histogram.data
        if point.value is not None
    }
    colors_by_time = {
        point["time"]: point["color"] for point in histogram.color_data or []
    }

    assert set(colors_by_time) == set(values_by_time)
    assert "#positive" in colors_by_time.values()
    assert "#negative" in colors_by_time.values()
    for timestamp, value in values_by_time.items():
        assert colors_by_time[timestamp] == ("#positive" if value >= 0 else "#negative")


def test_indicator_ws_error_message_has_structured_detail() -> None:
    key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20})
    event = IndicatorEvent(
        event_type=IndicatorEventType.INDICATOR_ERROR,
        key=key,
        detail={"error": "bad params"},
        bar_timestamp=1_700_000_000,
    )

    msg = payload_api._indicator_event_to_ws_message(
        "client-1",
        event,
        {"exchange": "binance"},
    )

    assert msg["type"] == "indicator.error"
    assert msg["code"] == "INDICATOR_COMPUTE_ERROR"
    assert msg["errorDetail"]["code"] == "INDICATOR_COMPUTE_ERROR"


def test_indicator_ws_recomputed_message_notifies_range_refresh() -> None:
    bars = [BarData.from_dict(item) for item in _bars(30)]
    params = {"period": 3}
    result = create_engine().compute(
        symbol="BTCUSDT",
        interval="1m",
        market_type="spot",
        indicator_name="MA",
        params=params,
        bars=bars,
    )
    key = IndicatorKey("BTCUSDT", "1m", "MA", params)
    event = IndicatorEvent(
        event_type=IndicatorEventType.INDICATOR_RECOMPUTED,
        key=key,
        full_result=result,
        detail={"range": {"start": bars[0].time, "end": bars[-1].time}},
    )

    msg = payload_api._indicator_event_to_ws_message(
        "client-1",
        event,
        {"exchange": "binance"},
    )

    assert msg["type"] == "indicator.recomputed"
    assert msg["clientId"] == "client-1"
    assert msg["indicatorId"] == key.uid
    assert msg["reason"] == "backfill-recomputed"
    assert msg["range"] == {"start": bars[0].time, "end": bars[-1].time}


def test_indicator_ws_queue_coalesces_preview_when_full() -> None:
    queue: asyncio.Queue = asyncio.Queue(maxsize=2)
    stream_api._queue_indicator_message(
        queue,
        {"type": "indicator.preview", "clientId": "a", "values": {"old": 1}},
    )
    stream_api._queue_indicator_message(
        queue,
        {"type": "indicator.update", "clientId": "b", "values": {"keep": 1}},
    )
    stream_api._queue_indicator_message(
        queue,
        {"type": "indicator.preview", "clientId": "a", "values": {"new": 2}},
    )

    items = [queue.get_nowait(), queue.get_nowait()]

    assert items[0]["type"] == "indicator.update"
    assert items[1]["type"] == "indicator.preview"
    assert items[1]["values"] == {"new": 2}


def test_indicator_key_includes_exchange_in_identity_and_topic() -> None:
    binance_key = IndicatorKey(
        "BTCUSDT", "1m", "MA", {"period": 20}, exchange="binance"
    )
    okx_key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20}, exchange="okx")

    assert binance_key != okx_key
    assert binance_key.uid.startswith("binance:spot:BTCUSDT:1m:MA:")
    assert okx_key.uid.startswith("okx:spot:BTCUSDT:1m:MA:")
    assert binance_key.series_topic == "BTCUSDT@1m"
    assert okx_key.series_topic == "okx:BTCUSDT@1m"


def test_indicator_key_includes_backend_code_hash_in_identity() -> None:
    code_hash = indicator_code_hash("MA")
    key = (
        create_engine()
        .compute(
            symbol="BTCUSDT",
            interval="1m",
            market_type="spot",
            indicator_name="MA",
            params={"period": 3},
            bars=[BarData.from_dict(item) for item in _bars(5)],
        )
        .key
    )

    assert code_hash
    assert key.code_hash == code_hash
    assert f":MA:{code_hash}:" in key.uid


def test_range_meta_includes_pyne_script_hash_in_identity() -> None:
    script_a = 'plot(close, title="Close A")'
    script_b = 'plot(close + 1, title="Close B")'
    req_a = indicators_api.IndicatorRangeRequest(
        clientId="script-1",
        kind="script",
        symbol="BTCUSDT",
        interval="1m",
        script=script_a,
        start=1,
        end=2,
    )
    req_b = req_a.model_copy(update={"script": script_b})

    meta_a = indicators_api._build_range_meta(req_a)
    meta_b = indicators_api._build_range_meta(req_b)

    assert meta_a["scriptHash"] == script_hash(script_a)
    assert f":{short_script_hash(script_a)}:" in meta_a["indicatorId"]
    assert meta_a["indicatorId"] != meta_b["indicatorId"]


def test_range_meta_builtin_indicator_id_matches_ws_key_with_params_hash() -> None:
    params_a = {"period": 20}
    params_b = {"period": 50}
    req_a = indicators_api.IndicatorRangeRequest(
        clientId="ma-20",
        kind="builtin",
        symbol="BTCUSDT",
        interval="1m",
        name="MA",
        params=params_a,
        start=1,
        end=2,
    )
    req_b = req_a.model_copy(update={"clientId": "ma-50", "params": params_b})

    meta_a = indicators_api._build_range_meta(req_a)
    meta_b = indicators_api._build_range_meta(req_b)
    expected_key = IndicatorKey(
        "BTCUSDT",
        "1m",
        "MA",
        params_a,
        code_hash=indicator_code_hash("MA"),
    )

    assert meta_a["indicatorId"] == expected_key.uid
    assert meta_a["paramsHash"] == expected_key.params_hash
    assert meta_a["indicatorId"] != meta_b["indicatorId"]


@pytest.mark.parametrize(
    ("requested", "canonical"),
    [
        ("45m", "45m"),
        ("47m", "47m"),
        ("60m", "1h"),
        ("1M", "1M"),
    ],
)
@pytest.mark.parametrize("kind", ["builtin", "script"])
def test_range_meta_canonicalizes_custom_intervals_for_builtin_and_pyne(
    requested: str,
    canonical: str,
    kind: str,
) -> None:
    request_kwargs = {
        "clientId": f"{kind}-{requested}",
        "kind": kind,
        "symbol": "BTCUSDT",
        "interval": requested,
        "start": 1,
        "end": 2,
    }
    if kind == "builtin":
        request_kwargs["name"] = "MA"
        request_kwargs["params"] = {"period": 2}
    else:
        request_kwargs["script"] = 'plot(close, title="Close")'

    meta = indicators_api._build_range_meta(
        indicators_api.IndicatorRangeRequest(**request_kwargs),
    )

    assert meta["interval"] == canonical
    assert f":{canonical}:" in meta["indicatorId"]


def test_indicator_engine_routes_exchange_scoped_updates() -> None:
    engine = create_engine()
    events: list[IndicatorEvent] = []
    engine.add_listener(events.append)

    bars = [BarData.from_dict(item) for item in _bars(25)]
    binance_key, _ = engine.subscribe(
        "BTCUSDT",
        "1m",
        "spot",
        "MA",
        {"period": 3},
        bars,
        exchange="binance",
    )
    okx_key, _ = engine.subscribe(
        "BTCUSDT",
        "1m",
        "spot",
        "MA",
        {"period": 3},
        bars,
        exchange="okx",
    )
    events.clear()

    next_bar = BarData(
        time=bars[-1].time + 60,
        open=bars[-1].open,
        high=max(bars[-1].high, 200),
        low=bars[-1].low,
        close=200,
        volume=bars[-1].volume,
    )

    engine.on_bar_closed(
        "BTCUSDT",
        "1m",
        next_bar,
        market_type="spot",
        exchange="okx",
    )

    updated = [
        event
        for event in events
        if event.event_type == IndicatorEventType.INDICATOR_UPDATED
    ]
    assert [event.key for event in updated] == [okx_key]
    assert binance_key != okx_key


def test_builtin_indicator_engine_preview_does_not_commit_state() -> None:
    engine = create_engine()
    events: list[IndicatorEvent] = []
    engine.add_listener(events.append)

    bars = [BarData.from_dict(item) for item in _bars(3)]
    key, result = engine.subscribe(
        "BTCUSDT",
        "1m",
        "spot",
        "MA",
        {"period": 3},
        bars,
        exchange="binance",
    )
    assert result.outputs["ma"].latest_value == 101.0
    events.clear()

    preview_bar = BarData(
        time=bars[-1].time + 60,
        open=bars[-1].open,
        high=1000,
        low=bars[-1].low,
        close=1000,
        volume=bars[-1].volume,
    )
    closed_bar = BarData(
        time=bars[-1].time + 60,
        open=bars[-1].open,
        high=bars[-1].high,
        low=bars[-1].low,
        close=103,
        volume=bars[-1].volume,
    )

    engine.on_bar_updated("BTCUSDT", "1m", preview_bar)
    preview_events = [
        event
        for event in events
        if event.event_type == IndicatorEventType.INDICATOR_PREVIEW
    ]
    assert preview_events[-1].key == key
    assert preview_events[-1].values == {"ma": 401.0}
    assert preview_events[-1].detail["bar"]["close"] == 1000
    assert engine._instances[key].get_latest() == {"ma": 101.0}

    engine.on_bar_closed("BTCUSDT", "1m", closed_bar)
    update_events = [
        event
        for event in events
        if event.event_type == IndicatorEventType.INDICATOR_UPDATED
    ]
    assert update_events[-1].values == {"ma": 102.0}
    assert engine._instances[key].get_latest() == {"ma": 102.0}


def _assert_indicator_values_close(actual: dict, expected: dict) -> None:
    assert set(actual) == set(expected)
    for key, expected_value in expected.items():
        actual_value = actual[key]
        if expected_value is None:
            assert actual_value is None
        else:
            assert actual_value == pytest.approx(expected_value)


@pytest.mark.parametrize(
    ("indicator_name", "params"),
    [
        ("BOLL", {"period": 20, "mult": 2.0, "source": "close"}),
        ("MACD", {"fast": 12, "slow": 26, "signal": 9, "source": "close"}),
    ],
)
def test_indicator_seed_excludes_forming_latest_bar_for_preview(
    indicator_name: str, params: dict
) -> None:
    bars = [BarData.from_dict(item) for item in _bars(60)]
    closed_history = [bar.with_closed_state(True) for bar in bars[:-1]]
    forming_bar = bars[-1].with_closed_state(False)
    clean_closed_bars = [*closed_history, forming_bar.with_closed_state(True)]

    seed_bars = payload_api.confirmed_indicator_seed_bars(
        [*closed_history, forming_bar]
    )
    assert seed_bars == closed_history

    expected = (
        create_engine()
        .compute(
            symbol="BTCUSDT",
            interval="1m",
            market_type="spot",
            indicator_name=indicator_name,
            params=params,
            bars=clean_closed_bars,
        )
        .get_latest()
    )

    engine = create_engine()
    key, result = engine.subscribe(
        "BTCUSDT",
        "1m",
        "spot",
        indicator_name,
        params,
        seed_bars,
        exchange="binance",
    )
    committed_before_preview = engine._instances[key].get_latest()

    engine.on_bar_updated("BTCUSDT", "1m", forming_bar)
    _assert_indicator_values_close(engine._instances[key].get_preview(), expected)
    _assert_indicator_values_close(
        engine._instances[key].get_latest(), committed_before_preview
    )

    engine.on_bar_closed("BTCUSDT", "1m", forming_bar.with_closed_state(True))
    _assert_indicator_values_close(engine._instances[key].get_latest(), expected)


@pytest.mark.anyio
async def test_indicator_unsubscribe_releases_stream_consumer() -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.unsubscribed: list[object] = []
            self.release_stream_calls: list[dict] = []

        def unsubscribe(self, handle) -> None:
            self.unsubscribed.append(handle)

        async def release_stream(self, *args, **kwargs) -> None:
            self.release_stream_calls.append({"args": args, "kwargs": kwargs})

    class FakeIndicatorEngine:
        def __init__(self) -> None:
            self.unsubscribed: list[object] = []

        def unsubscribe(self, key) -> None:
            self.unsubscribed.append(key)

    async def wait_forever() -> None:
        await asyncio.sleep(60)

    dm = FakeDataManager()
    indicator_engine = FakeIndicatorEngine()
    task = asyncio.create_task(wait_forever())
    subscribed = {"client-1": "indicator-key"}
    custom_handles = {"client-1": "dm-handle"}
    custom_tasks = {"client-1": task}
    client_meta = {
        "client-1": {
            "kind": "builtin",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "market_type": "spot",
            "streamConsumerId": "ws:indicator:binance:spot:BTCUSDT:1m:client-1:test",
        }
    }

    await stream_api._unsubscribe_indicator_client(
        "client-1",
        dm=dm,
        indicator_engine=indicator_engine,
        subscribed=subscribed,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        client_meta=client_meta,
    )

    assert indicator_engine.unsubscribed == ["indicator-key"]
    assert dm.unsubscribed == ["dm-handle"]
    assert task.cancelled() or task.cancelling()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert client_meta == {}
    assert dm.release_stream_calls == [
        {
            "args": ("BTCUSDT", "1m"),
            "kwargs": {
                "exchange": "binance",
                "market_type": "spot",
                "focus_scope": "websocket",
                "subscription_tier": "indicator",
                "consumer_id": "ws:indicator:binance:spot:BTCUSDT:1m:client-1:test",
            },
        }
    ]


def test_indicator_range_command_supports_load_before_without_5000_clamp() -> None:
    start_s, end_s, bars = payload_api._range_from_indicator_command(
        action="load_before",
        msg={"before": 1_700_000_000, "bars": 6000},
        interval="1h",
    )

    assert bars == 6000
    assert end_s == 1_700_000_000 - 3600
    assert start_s == end_s - (bars - 1) * 3600


def test_indicator_patch_from_snapshot_filters_time_series_payloads() -> None:
    payload = {
        "type": "indicator.snapshot",
        "lines": [
            {
                "name": "MA",
                "data": [
                    {"time": 10, "value": 1},
                    {"time": 20, "value": 2},
                    {"time": 30, "value": 3},
                ],
                "colorData": [
                    {"time": 20, "color": "#fff"},
                    {"time": 30, "color": "#000"},
                ],
            }
        ],
        "series": [
            {
                "id": "s1",
                "data": [{"time": 10, "value": 1}, {"time": 20, "value": 2}],
                "style": {
                    "colorData": [
                        {"time": 20, "color": "#fff"},
                        {"time": 30, "color": "#000"},
                    ]
                },
            }
        ],
        "markers": [{"id": "m1", "data": [{"time": 10}, {"time": 20}]}],
        "annotations": [
            {"id": "marker", "type": "marker", "data": [{"time": 10}, {"time": 20}]},
            {"id": "hline", "type": "hline", "data": [{"value": 5}]},
        ],
    }

    patch = payload_api._patch_from_snapshot(
        payload, reason="load_range", start_s=20, end_s=20
    )

    assert patch["type"] == "indicator.patch"
    assert patch["range"] == {"start": 20, "end": 20}
    assert patch["lines"][0]["data"] == [{"time": 20, "value": 2}]
    assert patch["lines"][0]["colorData"] == [{"time": 20, "color": "#fff"}]
    assert patch["series"][0]["data"] == [{"time": 20, "value": 2}]
    assert patch["series"][0]["style"]["colorData"] == [{"time": 20, "color": "#fff"}]
    assert patch["markers"][0]["data"] == [{"time": 20}]
    assert patch["annotations"][0]["data"] == [{"time": 20}]
    assert patch["annotations"][1]["data"] == [{"value": 5}]
