from __future__ import annotations

import asyncio
import contextlib

import pytest
from fastapi import HTTPException

from app.api.v1 import indicators as indicators_api
from app.api.v1 import stream_indicator_payloads as payload_api
from app.api.v1 import stream_indicators as stream_api
from app.api.v1 import stream_pyne_subscriptions as pyne_stream_api
from app.api.v1.indicators import ComputeRequest, CustomIndicatorPayload
from app.indicator import create_engine
from app.data_engine.data_manager.models import BarData
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.pyne import (
    PyneIncrementalSession,
    PyneIncrementalSessionManager,
    PyneRuntime,
    execute_pyne_script,
)
from app.indicator.pyne.cache import pyne_cache
from app.indicator.pyne.executor import execute_pyne_script_in_process
from app.indicator.pyne import security as pyne_security
from app.indicator.types import IndicatorKey


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
async def test_pyne_add_line_accepts_extended_args() -> None:
    script = """
add_line(close, title="Close", color="#ff0000", overlay=False, line_width=3, line_style=2)
"""

    payload = await indicators_api.compute(
        ComputeRequest(mode="script", script=script, ohlcv=_bars())
    )

    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "Close"
    assert payload["lines"][0]["pane"] == "separate"
    assert payload["lines"][0]["lineWidth"] == 3
    assert payload["lines"][0]["lineStyle"] == 2


@pytest.mark.anyio
async def test_pyne_add_line_histogram_output_with_color_data() -> None:
    script = """
colors = ["#00ff00" for _ in range(len(volume))]
add_line(volume, title="VOL", type="histogram", pane="volume", colorData=colors)
"""

    payload = await indicators_api.compute(
        ComputeRequest(mode="script", script=script, ohlcv=_bars())
    )

    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "VOL"
    assert payload["lines"][0]["type"] == "histogram"
    assert payload["lines"][0]["pane"] == "volume"
    assert payload["lines"][0]["data"][0]["color"] == "#00ff00"


@pytest.mark.anyio
async def test_pyne_package_execute_export_runs_new_runtime_plot_script() -> None:
    script = """
plot(close * 2, title="Double close", color=color.green)
"""
    result = execute_pyne_script(script=script, ohlcv=_bars(5), executor_mode="inline")

    assert result.error is None
    line = result.lines[0]
    assert line["name"] == "Double close"
    assert [point["value"] for point in line["data"][-3:]] == [204, 206, 208]


@pytest.mark.anyio
async def test_compute_mode_script_runs_script_even_when_name_is_present() -> None:
    script = 'plot(close * 2, title="Script Close", color="#00ff00")'

    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            name="MA",
            script=script,
            ohlcv=_bars(),
            params={"period": 20},
        )
    )

    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "Script Close"


@pytest.mark.anyio
async def test_builtin_reference_templates_run_as_custom_pyne_scripts() -> None:
    for name, script in indicators_api._PRESET_SCRIPTS.items():
        custom_script = script
        if custom_script.startswith(indicators_api._ENGINE_SCRIPT_MARKER):
            custom_script = custom_script.split("\n", 1)[1]

        payload = await indicators_api.compute(
            ComputeRequest(mode="script", script=custom_script, ohlcv=_bars(120))
        )

        assert payload["ok"] is True, (name, payload.get("error"))
        assert payload["lines"], name
        assert payload.get("param_schema"), name


def test_pyne_inline_timeout_skips_sigalrm_when_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(pyne_security.signal, "SIGALRM", raising=False)

    result = PyneRuntime().execute(
        script='plot(close, title="Close")',
        ohlcv=_bars(),
        params={},
    )

    assert result.ok is True
    assert result.lines[0]["name"] == "Close"


@pytest.mark.anyio
async def test_pyne_safe_mode_blocks_imports() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            securityMode="safe",
            script='import os\nplot(close, title="Close")',
            ohlcv=_bars(),
        )
    )

    assert payload["ok"] is False
    assert payload["code"] == "PYNE_IMPORT_BLOCKED"
    assert payload["errorDetail"]["code"] == "PYNE_IMPORT_BLOCKED"
    assert "安全模式" in payload["errorDetail"]["hint"]
    assert "Import statements are not allowed in safe mode" in payload["error"]


@pytest.mark.anyio
async def test_pyne_research_mode_allows_whitelisted_imports() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            securityMode="research",
            script='import numpy as npx\nplot(npx.ones(len(close)), title="Ones")',
            ohlcv=_bars(),
        )
    )

    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "Ones"
    assert payload["meta"]["securityMode"] == "research"


@pytest.mark.anyio
async def test_pyne_research_mode_blocks_unlisted_imports() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            securityMode="research",
            script='import os\nplot(close, title="Close")',
            ohlcv=_bars(),
        )
    )

    assert payload["ok"] is False
    assert payload["code"] == "PYNE_IMPORT_BLOCKED"
    assert "Import 'os' is not allowed in research mode" in payload["error"]


@pytest.mark.anyio
async def test_pyne_syntax_error_has_structured_location() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            script='plot(close, title="Broken"\n',
            ohlcv=_bars(),
        )
    )

    assert payload["ok"] is False
    assert payload["code"] == "PYNE_SYNTAX_ERROR"
    assert payload["errorDetail"]["line"] == 1
    assert "语法错误" in payload["errorDetail"]["hint"]


@pytest.mark.anyio
async def test_pyne_input_schema_exposes_ui_param_types() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            script="""
length = input.int(20, "Length", minval=1, maxval=200)
ratio = input.float(2.0, "Ratio", step=0.25)
show = input.bool(true, "Show")
mode = input.string("SMA", "Mode", options=["SMA", "EMA"])
src = input.source(close, "Source")
line_color = input.color(color.orange, "Line Color")
plot(src, "Source", color=line_color)
""",
            ohlcv=_bars(),
        )
    )

    schema = {item["key"]: item for item in payload["param_schema"]}

    assert payload["ok"] is True
    assert schema["Length"]["type"] == "int"
    assert schema["Length"]["min"] == 1
    assert schema["Ratio"]["type"] == "float"
    assert schema["Show"]["type"] == "bool"
    assert schema["Mode"]["options"] == ["SMA", "EMA"]
    assert schema["Source"]["type"] == "source"
    assert schema["Line Color"]["type"] == "color"


def test_pyne_process_executor_kills_infinite_loop() -> None:
    result = execute_pyne_script_in_process(
        script="while true:\n    pass",
        ohlcv=_bars(),
        params={},
        security_mode="safe",
        timeout_seconds=0.1,
    )

    assert result.ok is False
    assert result.code == "PYNE_TIMEOUT"
    assert "timeout" in result.error


def test_pyne_process_executor_runs_incremental_script() -> None:
    script = """
indicator("Inc EMA", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.ema("ema", period=3)

def on_bar(ctx, bar):
    ctx.plot("EMA3", ctx.ta.ema("ema").update(bar.close))
"""
    result = execute_pyne_script_in_process(
        script=script,
        ohlcv=_bars(5),
        params={},
        security_mode="safe",
        timeout_seconds=2,
    )

    assert result.ok is True
    assert result.meta["mode"] == "incremental"
    assert result.lines[0]["name"] == "EMA3"
    assert result.lines[0]["data"][-1] == {"time": 1_700_000_240, "value": 103.0}


def test_pyne_process_executor_reads_large_result_before_join_timeout() -> None:
    script = indicators_api._PRESET_SCRIPTS["MACD"].split("\n", 1)[1]
    bars = _bars(5000)

    result = execute_pyne_script_in_process(
        script=script,
        ohlcv=bars,
        params={},
        security_mode="safe",
        timeout_seconds=5,
    )

    assert result.ok is True
    assert len(result.lines) == 3
    assert sum(len(line["data"]) for line in result.lines) > 4000


def test_pyne_cache_reuses_loader_value_in_inline_runtime() -> None:
    pyne_cache.clear()
    runtime = PyneRuntime()
    script = """
counter = pyne.cache("unit-test-counter", lambda: {"count": 0})
counter["count"] += 1
plot(close + counter["count"], title="Cached")
"""

    first = runtime.execute(script, _bars(), {})
    second = runtime.execute(script, _bars(), {})

    assert first.ok is True
    assert second.ok is True
    assert first.lines[0]["data"][0]["value"] == 101
    assert second.lines[0]["data"][0]["value"] == 102
    assert pyne_cache.stats()["size"] == 1
    pyne_cache.clear()


def test_pyne_cache_ttl_reloads_expired_value() -> None:
    pyne_cache.clear()
    runtime = PyneRuntime()
    calls = {"n": 0}

    def load_next() -> int:
        calls["n"] += 1
        return calls["n"]

    script = """
value = pyne.cache("ttl-test", params["loader"], ttl=-1)
plot(close + value, title="Cached")
"""

    first = runtime.execute(script, _bars(), {"loader": load_next})
    second = runtime.execute(script, _bars(), {"loader": load_next})

    assert first.ok is True
    assert second.ok is True
    assert first.lines[0]["data"][0]["value"] == 101
    assert second.lines[0]["data"][0]["value"] == 102
    assert calls["n"] == 2
    pyne_cache.clear()


@pytest.mark.anyio
async def test_pyne_emit_signal_and_alertcondition_outputs_structured_signals() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            script="""
buy = close >= open
emit_signal(buy, name="Buy", side="buy", message="long setup", price=close)
alertcondition(close <= open, title="Sell Alert", message="short setup", side="sell")
plot(close, title="Close")
""",
            ohlcv=_bars(5),
        )
    )

    signal_annotations = [item for item in payload["annotations"] if item["type"] == "signal"]

    assert payload["ok"] is True
    assert payload["signals"][0]["side"] == "buy"
    assert payload["signals"][0]["data"][0]["message"] == "long setup"
    assert payload["signals"][0]["data"][0]["price"] == 100
    assert signal_annotations[0]["style"]["side"] == "buy"


@pytest.mark.anyio
async def test_pyne_unsafe_mode_allows_imports() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            securityMode="unsafe",
            script='import math\nplot(close + math.sqrt(4), title="Unsafe")',
            ohlcv=_bars(),
        )
    )

    assert payload["ok"] is True
    assert payload["lines"][0]["name"] == "Unsafe"
    assert payload["meta"]["securityMode"] == "unsafe"


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


def test_indicator_diagnostics_snapshot_reports_runtime_state(tmp_path) -> None:
    store = CustomIndicatorStore(tmp_path / "custom_indicators.json")
    store.upsert({
        "name": "Diag Script",
        "script": "plot(close)",
    })
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
    assert payload["pyne"]["runtimeBackend"]["package"] == "pyne_runtime"
    assert payload["pyne"]["runtimeBackend"]["active"] == "external"
    assert "packages" in payload["pyne"]["runtimeBackend"]["sourcePath"]
    assert "pyne-runtime" in payload["pyne"]["runtimeBackend"]["sourcePath"]
    assert payload["pyne"]["security"]["mode"] in {"safe", "research", "unsafe"}
    assert payload["pyne"]["executor"]["mode"] in {"inline", "process"}
    assert payload["pyne"]["cache"]["maxItems"] >= 1
    assert payload["websocket"]["maxSubscriptions"] >= 1
    assert "heartbeat_delay" in payload["websocket"]["metrics"]
    assert payload["executors"]["indicator"]["max_workers"] >= 1
    assert payload["executors"]["pyne_wait"]["max_workers"] >= 1
    assert payload["executors"]["storage"]["max_workers"] >= 1


def test_indicator_ws_event_message_shape() -> None:
    key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20})
    event = IndicatorEvent(
        event_type=IndicatorEventType.INDICATOR_UPDATED,
        key=key,
        values={"MA": 123.45},
        bar_timestamp=1_700_000_000,
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


def test_indicator_ws_recomputed_message_replaces_range() -> None:
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

    assert msg["type"] == "indicator.replace_range"
    assert msg["reason"] == "recompute"
    assert msg["range"] == {"start": bars[0].time, "end": bars[-1].time}
    assert msg["clientId"] == "client-1"
    assert msg["lines"][0]["data"][0]["time"] >= bars[0].time
    assert msg["lines"][0]["data"][-1]["time"] == bars[-1].time


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
    binance_key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20}, exchange="binance")
    okx_key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20}, exchange="okx")

    assert binance_key != okx_key
    assert binance_key.uid.startswith("binance:spot:BTCUSDT:1m:MA:")
    assert okx_key.uid.startswith("okx:spot:BTCUSDT:1m:MA:")
    assert binance_key.series_topic == "BTCUSDT@1m"
    assert okx_key.series_topic == "okx:BTCUSDT@1m"


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

    updated = [event for event in events if event.event_type == IndicatorEventType.INDICATOR_UPDATED]
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
    preview_events = [event for event in events if event.event_type == IndicatorEventType.INDICATOR_PREVIEW]
    assert preview_events[-1].key == key
    assert preview_events[-1].values == {"ma": 401.0}
    assert engine._instances[key].get_latest() == {"ma": 101.0}

    engine.on_bar_closed("BTCUSDT", "1m", closed_bar)
    update_events = [event for event in events if event.event_type == IndicatorEventType.INDICATOR_UPDATED]
    assert update_events[-1].values == {"ma": 102.0}
    assert engine._instances[key].get_latest() == {"ma": 102.0}


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


def test_pyne_ws_snapshot_message_runs_script() -> None:
    class FakeDataManager:
        def query_latest(self, symbol, interval, limit, exchange="binance", market_type="spot"):
            class Result:
                bars = [BarData.from_dict(item) for item in _bars(30)]

            return Result()

    msg = payload_api._compute_pyne_snapshot_message(
        "custom-1",
        FakeDataManager(),
        {
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "Custom",
            "script": 'plot(close * 2, title="Double")\nmarker(close > 0, text="X")',
            "params": {},
            "securityMode": "safe",
            "historyLimit": 100,
        },
    )

    assert msg["type"] == "indicator.snapshot"
    assert msg["kind"] == "script"
    assert msg["schemaVersion"] == 1
    assert msg["outputSchemaVersion"] == 2
    assert msg["ok"] is True
    assert msg["lines"][0]["name"] == "Double"
    assert msg["series"][0]["indicatorId"] == msg["indicatorId"]
    assert msg["series"][0]["id"].startswith(f"{msg['indicatorId']}:")
    assert msg["annotations"][0]["type"] == "marker"
    assert msg["markers"][0]["data"][0]["text"] == "X"


def test_indicator_range_command_supports_load_before_and_clamps_bars() -> None:
    start_s, end_s, bars = payload_api._range_from_indicator_command(
        action="load_before",
        msg={"before": 1_700_000_000, "bars": payload_api.INDICATOR_MAX_RANGE_BARS + 100},
        interval="1h",
    )

    assert bars == payload_api.INDICATOR_MAX_RANGE_BARS
    assert end_s == 1_700_000_000 - 3600
    assert start_s == end_s - (bars - 1) * 3600


def test_indicator_patch_from_snapshot_filters_time_series_payloads() -> None:
    payload = {
        "type": "indicator.snapshot",
        "lines": [
            {
                "name": "MA",
                "data": [{"time": 10, "value": 1}, {"time": 20, "value": 2}, {"time": 30, "value": 3}],
                "colorData": [{"time": 20, "color": "#fff"}, {"time": 30, "color": "#000"}],
            }
        ],
        "series": [
            {
                "id": "s1",
                "data": [{"time": 10, "value": 1}, {"time": 20, "value": 2}],
                "style": {"colorData": [{"time": 20, "color": "#fff"}, {"time": 30, "color": "#000"}]},
            }
        ],
        "markers": [{"id": "m1", "data": [{"time": 10}, {"time": 20}]}],
        "annotations": [
            {"id": "marker", "type": "marker", "data": [{"time": 10}, {"time": 20}]},
            {"id": "hline", "type": "hline", "data": [{"value": 5}]},
        ],
    }

    patch = payload_api._patch_from_snapshot(payload, reason="load_range", start_s=20, end_s=20)

    assert patch["type"] == "indicator.patch"
    assert patch["range"] == {"start": 20, "end": 20}
    assert patch["lines"][0]["data"] == [{"time": 20, "value": 2}]
    assert patch["lines"][0]["colorData"] == [{"time": 20, "color": "#fff"}]
    assert patch["series"][0]["data"] == [{"time": 20, "value": 2}]
    assert patch["series"][0]["style"]["colorData"] == [{"time": 20, "color": "#fff"}]
    assert patch["markers"][0]["data"] == [{"time": 20}]
    assert patch["annotations"][0]["data"] == [{"time": 20}]
    assert patch["annotations"][1]["data"] == [{"value": 5}]


def test_pyne_ws_bar_update_sends_single_bar_patch() -> None:
    bars = [BarData.from_dict(item) for item in _bars(30)]
    bar_time = bars[-1].time

    class FakeDataManager:
        def query_latest(self, symbol, interval, limit, exchange="binance", market_type="spot"):
            class Result:
                pass

            result = Result()
            result.bars = bars
            return result

    msg = payload_api._compute_pyne_snapshot_message(
        "custom-1",
        FakeDataManager(),
        {
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "Custom",
            "script": 'plot(close * 2, title="Double")',
            "params": {},
            "securityMode": "safe",
            "historyLimit": 100,
        },
        bar_time=bar_time,
    )

    assert msg["type"] == "indicator.patch"
    assert msg["reason"] == "bar_update"
    assert msg["range"] == {"start": bar_time, "end": bar_time}
    assert msg["lines"][0]["data"] == [{"time": bar_time, "value": bars[-1].close * 2}]


def test_pyne_incremental_runtime_seeds_history_with_stateful_sma() -> None:
    script = """
indicator("Inc MA", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.sma("ma", period=3)

def on_bar(ctx, bar):
    ctx.plot("MA3", ctx.ta.sma("ma").update(bar.close))
"""

    result = PyneRuntime().execute(
        script=script,
        ohlcv=_bars(5),
        params={},
        security_mode="safe",
    )

    assert result.ok is True
    assert result.meta["mode"] == "incremental"
    assert result.lines[0]["name"] == "MA3"
    assert result.lines[0]["data"] == [
        {"time": 1_700_000_120, "value": 101.0},
        {"time": 1_700_000_180, "value": 102.0},
        {"time": 1_700_000_240, "value": 103.0},
    ]


def test_pyne_incremental_preview_does_not_commit_state() -> None:
    script = """
indicator("Inc MA", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.sma("ma", period=3)

def on_bar(ctx, bar):
    ctx.plot("MA3", ctx.ta.sma("ma").update(bar.close))
"""
    session = PyneIncrementalSession(script=script, params={}, security_mode="safe")
    session.seed(_bars(3))

    preview_bar = {**_bars(4)[-1], "close": 1000}
    preview = session.on_bar_updated(preview_bar)
    closed = session.on_bar_closed(_bars(4)[-1])

    assert preview.lines[0]["data"] == [{"time": 1_700_000_180, "value": 401.0}]
    assert closed.lines[0]["data"] == [{"time": 1_700_000_180, "value": 102.0}]


def test_pyne_ws_incremental_bar_update_uses_session_patch() -> None:
    script = """
indicator("Inc MA", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.sma("ma", period=3)

def on_bar(ctx, bar):
    ctx.plot("MA3", ctx.ta.sma("ma").update(bar.close))
"""
    session = PyneIncrementalSession(script=script, params={}, security_mode="safe")
    session.seed(_bars(3))
    bar = _bars(4)[-1]
    meta = {
        "kind": "script",
        "scriptMode": "incremental",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "Inc MA",
        "indicatorId": "pyne:binance:spot:BTCUSDT:1m:inc-1",
        "script": script,
        "params": {},
        "securityMode": "safe",
        "historyLimit": 100,
        "pyneSession": session,
    }

    msg = payload_api._compute_incremental_pyne_bar_message(
        "inc-1",
        meta,
        bar,
        preview=False,
    )

    assert msg["type"] == "indicator.patch"
    assert msg["reason"] == "bar_closed"
    assert msg["range"] == {"start": bar["time"], "end": bar["time"]}
    assert msg["lines"][0]["data"] == [{"time": bar["time"], "value": 102.0}]


def test_pyne_incremental_ta_helpers_cover_common_indicators() -> None:
    script = """
indicator("Inc Helpers", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.boll("bb", period=3, multiplier=2)
    ctx.ta.macd("macd", fast=2, slow=3, signal=2)
    ctx.ta.rsi("rsi", period=3)
    ctx.ta.atr("atr", period=3)
    ctx.ta.highest("highest", period=3)
    ctx.ta.lowest("lowest", period=3)

def on_bar(ctx, bar):
    upper, mid, lower = ctx.ta.boll("bb").update(bar.close)
    ctx.plot("BB Upper", upper)
    ctx.plot("BB Mid", mid)
    ctx.plot("BB Lower", lower)

    dif, dea, hist = ctx.ta.macd("macd").update(bar.close)
    ctx.plot("MACD DIF", dif)
    ctx.plot("MACD DEA", dea)
    ctx.plot("MACD HIST", hist, type="histogram", pane="separate")

    ctx.plot("RSI", ctx.ta.rsi("rsi").update(bar.close), pane="separate")
    ctx.plot("ATR", ctx.ta.atr("atr").update(bar), pane="separate")
    ctx.plot("Highest", ctx.ta.highest("highest").update(bar.high))
    ctx.plot("Lowest", ctx.ta.lowest("lowest").update(bar.low))
"""

    result = PyneRuntime().execute(
        script=script,
        ohlcv=_bars(5),
        params={},
        security_mode="safe",
    )
    by_name = {line["name"]: line["data"] for line in result.lines}

    assert result.ok is True
    assert by_name["BB Mid"][0] == {"time": 1_700_000_120, "value": 101.0}
    assert by_name["BB Upper"][0] == {"time": 1_700_000_120, "value": 102.63299316}
    assert by_name["BB Lower"][0] == {"time": 1_700_000_120, "value": 99.36700684}
    assert by_name["MACD DIF"][-1] == {"time": 1_700_000_240, "value": 0.5}
    assert by_name["MACD DEA"][-1] == {"time": 1_700_000_240, "value": 0.5}
    assert by_name["MACD HIST"][-1] == {"time": 1_700_000_240, "value": 0.0}
    assert by_name["RSI"][-1] == {"time": 1_700_000_240, "value": 100.0}
    assert by_name["ATR"][0] == {"time": 1_700_000_120, "value": 2.0}
    assert by_name["Highest"][0] == {"time": 1_700_000_120, "value": 103.0}
    assert by_name["Lowest"][0] == {"time": 1_700_000_120, "value": 99.0}


def test_pyne_incremental_safe_mode_limits_windows_and_state_keys() -> None:
    huge_window_script = """
indicator("Huge Window", mode="incremental")

def init(ctx):
    ctx.window("huge", size=10001)

def on_bar(ctx, bar):
    pass
"""
    unsafe_result = PyneRuntime().execute(
        script=huge_window_script,
        ohlcv=_bars(1),
        params={},
        security_mode="unsafe",
    )
    safe_result = PyneRuntime().execute(
        script=huge_window_script,
        ohlcv=_bars(1),
        params={},
        security_mode="safe",
    )

    assert unsafe_result.ok is True
    assert safe_result.ok is False
    assert safe_result.code == "PYNE_SECURITY_ERROR"
    assert "safe-mode limit" in safe_result.error

    many_states_script = """
indicator("Many States", mode="incremental")

def init(ctx):
    for i in range(101):
        ctx.state(f"s{i}", 0)

def on_bar(ctx, bar):
    pass
"""
    state_result = PyneRuntime().execute(
        script=many_states_script,
        ohlcv=_bars(1),
        params={},
        security_mode="safe",
    )
    assert state_result.ok is False
    assert state_result.code == "PYNE_SECURITY_ERROR"
    assert "state keys" in state_result.error


def test_pyne_incremental_session_manager_shares_duplicate_bar_results() -> None:
    script = """
indicator("Shared Counter", mode="incremental")

def init(ctx):
    ctx.state("count", 0)

def on_bar(ctx, bar):
    counter = ctx.state("count")
    counter.value += 1
    ctx.plot("Count", counter.value)
"""
    manager = PyneIncrementalSessionManager()
    shared = manager.acquire(
        "shared-key",
        lambda: PyneIncrementalSession(script=script, params={}, security_mode="safe"),
    )
    manager.acquire(
        "shared-key",
        lambda: PyneIncrementalSession(script=script, params={}, security_mode="safe"),
    )

    manager.seed_or_snapshot(shared, _bars(1))
    bar = _bars(2)[-1]
    first = manager.process_bar(shared, bar, preview=False)
    second = manager.process_bar(shared, bar, preview=False)

    assert first.lines[0]["data"] == [{"time": bar["time"], "value": 2.0}]
    assert second.lines[0]["data"] == [{"time": bar["time"], "value": 2.0}]
    assert manager.snapshot()["keys"]["shared-key"]["refCount"] == 2

    manager.release("shared-key")
    assert manager.snapshot()["keys"]["shared-key"]["refCount"] == 1
    manager.release("shared-key")
    assert manager.snapshot()["sessions"] == 0


@pytest.mark.anyio
async def test_pyne_ws_subscription_loads_saved_custom_indicator(tmp_path, monkeypatch) -> None:
    store = CustomIndicatorStore(tmp_path / "custom_indicators.json")
    saved = store.upsert({
        "name": "Saved Double",
        "script": 'plot(close * 2, title="Saved")',
        "params": {"length": 5},
        "securityMode": "safe",
    })
    monkeypatch.setattr(pyne_stream_api, "_stream_custom_store", store)

    class FakeDataManager:
        def __init__(self) -> None:
            self.ensure_stream_calls: list[dict] = []

        async def ensure_stream(self, *args, **kwargs):
            self.ensure_stream_calls.append({"args": args, "kwargs": kwargs})
            return None

        def query_latest(self, symbol, interval, limit, exchange="binance", market_type="spot"):
            class Result:
                bars = [BarData.from_dict(item) for item in _bars(30)]

            return Result()

        def subscribe(self, **kwargs):
            return "handle-1"

    sent: list[dict] = []

    async def send_json(payload: dict) -> bool:
        sent.append(payload)
        return True

    custom_handles = {}
    custom_tasks = {}
    client_meta = {}
    queue = asyncio.Queue()

    dm = FakeDataManager()

    async def unsubscribe_client(_client_id: str) -> None:
        return None

    await pyne_stream_api.handle_pyne_indicator_subscribe(
        dm=dm,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        queue=queue,
        client_meta=client_meta,
        client_id="saved-1",
        symbol="BTCUSDT",
        interval="1m",
        exchange="binance",
        market_type="spot",
        name="",
        custom_id=saved["id"],
        script="",
        params={},
        security_mode=None,
        history_limit=100,
        send_json=send_json,
        stream_consumer_id="ws:indicator:binance:spot:BTCUSDT:1m:saved-1:test",
        unsubscribe_client=unsubscribe_client,
        queue_message=stream_api._queue_indicator_message,
    )

    assert sent[0]["type"] == "indicator.snapshot"
    assert sent[0]["ok"] is True
    assert sent[0]["lines"][0]["name"] == "Saved"
    assert sent[0]["params"] == {"length": 5}
    assert dm.ensure_stream_calls[0]["kwargs"]["consumer_id"] == (
        "ws:indicator:binance:spot:BTCUSDT:1m:saved-1:test"
    )
    assert client_meta["saved-1"]["streamConsumerId"] == (
        "ws:indicator:binance:spot:BTCUSDT:1m:saved-1:test"
    )


@pytest.mark.anyio
async def test_pyne_overlay_false_routes_hline_and_marker_to_separate_pane() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            script="""
indicator("Pane Signals", overlay=false)
r = ta.rsi(close, 14)
plot(r, "RSI")
hline(70, "OB")
marker(r > 50, text="M", location=location.top)
""",
            ohlcv=_bars(40),
        )
    )

    assert payload["ok"] is True
    assert payload["lines"][0]["pane"] == "separate"
    assert payload["series"][0]["pane"] == "separate"
    assert payload["hlines"][0]["pane"] == "separate"
    assert any(item["type"] == "hline" and item["pane"] == "separate" for item in payload["annotations"])
    assert payload["markers"][0]["pane"] == "separate"
    assert payload["markers"][0]["data"][0]["pane"] == "separate"


@pytest.mark.anyio
async def test_unified_output_scopes_fill_series_ids() -> None:
    payload = await indicators_api.compute(
        ComputeRequest(
            mode="script",
            script="""
indicator("Bands", overlay=true)
upper = close + 1
lower = close - 1
p1 = plot(upper, "Upper")
p2 = plot(lower, "Lower")
fill(p1, p2, color="rgba(59,130,246,0.2)")
""",
            ohlcv=_bars(),
        )
    )

    assert payload["ok"] is True
    assert payload["legacyFills"][0]["pane"] == "main"
    assert payload["series"][0]["id"] == "plot_1"
    assert payload["fills"][0]["seriesIds"] == ["plot_1", "plot_2"]
    assert payload["fills"][0]["pane"] == "main"
