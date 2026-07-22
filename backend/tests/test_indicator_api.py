from __future__ import annotations

import asyncio
import contextlib
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.api.v1 import stream_indicator_payloads as payload_api
from app.api.v1 import stream_indicators as stream_api
from app.api.v1 import stream_pyne_subscriptions as pyne_stream_api
from app.api.v1.indicators import ComputeRequest, CustomIndicatorPayload
from app.indicator import create_engine
from app.data_engine.data_manager.models import BarData, DataEventType
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
from app.indicator.engine import indicator_code_hash
from app.indicator.script_identity import script_hash, short_script_hash
from app.indicator.types import IndicatorKey
from app.indicator.range_result_service import IndicatorRangeRevisionChangedError


class _QueryResult:
    def __init__(self, bars: list[BarData], missing_ranges: list[object] | None = None) -> None:
        self.bars = bars
        self.missing_ranges = missing_ranges or []


class _RangeDataManager:
    def __init__(self, bars: list[BarData], missing_ranges: list[object] | None = None) -> None:
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


def test_indicator_range_http_allows_more_than_5000_builtin_bars() -> None:
    bars = [BarData.from_dict(item) for item in _bars(6005)]
    client = _indicator_client(_RangeDataManager(bars))

    response = client.post("/api/v1/indicators/range", json={
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
    })

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
    closed_bars = [BarData.from_dict(item).with_closed_state(True) for item in _bars(80)]
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
    assert payload["range"] == {"start": closed_bars[-2].time, "end": closed_bars[-1].time}
    returned_times = [
        point["time"]
        for line in payload["lines"]
        for point in line["data"]
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


def test_pyne_range_patch_reports_only_actual_target_bar_coverage() -> None:
    all_bars = [BarData.from_dict(item).with_closed_state(True) for item in _bars(10)]
    available_tail = all_bars[-3:]

    payload = payload_api._compute_pyne_range_patch_from_bars(
        "script-1",
        {
            "kind": "script",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "Close",
            "script": 'plot(close, title="Close")',
            "params": {},
            "indicatorId": "script-1",
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

    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ma-1",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    })

    payload = response.json()
    assert response.status_code == 202
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_NOT_READY"
    assert payload["detail"]["retryMode"] == "event"
    assert payload["detail"]["backfillRequestIds"] == []
    assert "retryAfterMs" not in payload["detail"]
    assert payload["dataRevision"]["revisionToken"]


def test_indicator_range_runtime_failure_is_not_misreported_as_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bars = [BarData.from_dict(item) for item in _bars(5)]

    async def _fail_compute(**_kwargs):
        raise RuntimeError("indicator execution failed")

    monkeypatch.setattr(
        indicators_api,
        "compute_indicator_range_payload_async",
        _fail_compute,
    )
    client = _indicator_client(_RangeDataManager(bars))
    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ma-runtime-error",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    })

    payload = response.json()
    assert response.status_code == 200
    assert payload["code"] == "INDICATOR_RANGE_COMPUTE_FAILED"
    assert payload["ok"] is False
    assert "retryMode" not in payload.get("detail", {})


def test_indicator_range_revision_race_is_event_driven_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bars = [BarData.from_dict(item) for item in _bars(5)]

    async def _revision_changed(**_kwargs):
        raise IndicatorRangeRevisionChangedError("revision changed during compute")

    monkeypatch.setattr(
        indicators_api,
        "compute_indicator_range_payload_async",
        _revision_changed,
    )
    client = _indicator_client(_RangeDataManager(bars))
    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ma-revision-race",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    })

    payload = response.json()
    assert response.status_code == 202
    assert payload["code"] == "INDICATOR_RANGE_NOT_READY"
    assert payload["detail"]["retryMode"] == "event"
    assert "retryAfterMs" not in payload["detail"]
    assert payload["dataRevision"]["revisionToken"]


@pytest.mark.parametrize(("interval", "step_seconds"), [("1m", 60), ("89m", 5_340)])
def test_indicator_range_warmup_gap_is_read_only_and_does_not_block_target(
    interval: str,
    step_seconds: int,
) -> None:
    bars = [
        BarData.from_dict({
            **item,
            "time": 1_700_000_000 + index * step_seconds,
        })
        for index, item in enumerate(_bars(10))
    ]

    class MissingWarmup:
        start_ms = (bars[0].time - 2 * step_seconds) * 1000
        end_ms = (bars[0].time - step_seconds) * 1000

    class DataManager:
        def __init__(self) -> None:
            self.query_kwargs: list[dict] = []

        def query(self, *args, **kwargs):
            self.query_kwargs.append(dict(kwargs))
            return _QueryResult(bars, [MissingWarmup()])

    data_manager = DataManager()
    client = _indicator_client(data_manager)
    response = client.post("/api/v1/indicators/range", json={
        "clientId": f"ma-warmup-{interval}",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": interval,
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    })

    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert len(data_manager.query_kwargs) == 1
    query = data_manager.query_kwargs[0]
    assert query["auto_backfill"] is False
    assert "backfill_metadata" not in query
    assert query["start_ms"] == MissingWarmup.start_ms
    assert query["end_ms"] == bars[-1].time * 1000


def test_indicator_range_http_reports_empty_for_forming_only_target_range() -> None:
    closed_bars = [BarData.from_dict(item).with_closed_state(True) for item in _bars(5)]
    forming_bar = BarData.from_dict(_bars(6)[-1]).with_closed_state(False)
    client = _indicator_client(_RangeDataManager([*closed_bars, forming_bar]))

    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ma-1",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": forming_bar.time,
        "end": forming_bar.time,
    })

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_EMPTY"
    assert "retryAfterMs" not in payload.get("detail", {})


def test_indicator_range_http_enforces_pyne_runtime_bar_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    bars = [BarData.from_dict(item) for item in _bars(10)]
    monkeypatch.setattr(indicators_api.config, "PYNE_MAX_BARS", 5)
    client = _indicator_client(_RangeDataManager(bars))

    response = client.post("/api/v1/indicators/range", json={
        "clientId": "custom-1",
        "kind": "script",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "script": 'plot(close, title="Close")',
        "params": {},
        "start": bars[0].time,
        "end": bars[-1].time,
    })

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_LIMIT"
    assert "Too many Pyne bars" in payload["error"]


def test_indicator_range_http_rejects_oversized_pyne_before_query(monkeypatch: pytest.MonkeyPatch) -> None:
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

    response = client.post("/api/v1/indicators/range", json={
        "clientId": "custom-1",
        "kind": "script",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "script": 'plot(close, title="Close")',
        "params": {},
        "start": 1_700_000_000,
        "end": 1_700_000_000 + 9 * 60,
    })

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_LIMIT"
    assert dm.query_calls == 0


def test_indicator_range_http_rejects_extreme_builtin_warmup_before_query() -> None:
    class CountingRangeDataManager(_RangeDataManager):
        def __init__(self) -> None:
            super().__init__([])
            self.query_calls = 0

        def query(self, *args, **kwargs):
            self.query_calls += 1
            raise AssertionError("oversized builtin warmup must not query K-lines")

    dm = CountingRangeDataManager()
    client = _indicator_client(dm)
    start = 1_700_000_000
    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ema-extreme-warmup",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "EMA",
        "params": {"period": 10_000},
        "start": start,
        "end": start + 59 * 60,
    })

    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RANGE_LIMIT"
    assert "Too many indicator bars" in payload["error"]
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
        point["time"]: point["color"]
        for point in histogram.color_data or []
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
    binance_key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20}, exchange="binance")
    okx_key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20}, exchange="okx")

    assert binance_key != okx_key
    assert binance_key.uid.startswith("binance:spot:BTCUSDT:1m:MA:")
    assert okx_key.uid.startswith("okx:spot:BTCUSDT:1m:MA:")
    assert binance_key.series_topic == "BTCUSDT@1m"
    assert okx_key.series_topic == "okx:BTCUSDT@1m"


def test_indicator_key_includes_backend_code_hash_in_identity() -> None:
    code_hash = indicator_code_hash("MA")
    key = create_engine().compute(
        symbol="BTCUSDT",
        interval="1m",
        market_type="spot",
        indicator_name="MA",
        params={"period": 3},
        bars=[BarData.from_dict(item) for item in _bars(5)],
    ).key

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
    assert preview_events[-1].detail["bar"]["close"] == 1000
    assert engine._instances[key].get_latest() == {"ma": 101.0}

    engine.on_bar_closed("BTCUSDT", "1m", closed_bar)
    update_events = [event for event in events if event.event_type == IndicatorEventType.INDICATOR_UPDATED]
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
def test_indicator_seed_excludes_forming_latest_bar_for_preview(indicator_name: str, params: dict) -> None:
    bars = [BarData.from_dict(item) for item in _bars(60)]
    closed_history = [bar.with_closed_state(True) for bar in bars[:-1]]
    forming_bar = bars[-1].with_closed_state(False)
    clean_closed_bars = [*closed_history, forming_bar.with_closed_state(True)]

    seed_bars = payload_api.confirmed_indicator_seed_bars([*closed_history, forming_bar])
    assert seed_bars == closed_history

    expected = create_engine().compute(
        symbol="BTCUSDT",
        interval="1m",
        market_type="spot",
        indicator_name=indicator_name,
        params=params,
        bars=clean_closed_bars,
    ).get_latest()

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
    _assert_indicator_values_close(engine._instances[key].get_latest(), committed_before_preview)

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


def test_pyne_ws_snapshot_message_runs_script() -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.auto_backfill = None

        def query_latest(
            self, symbol, interval, limit, exchange="binance",
            market_type="spot", auto_backfill=None,
        ):
            self.auto_backfill = auto_backfill
            class Result:
                bars = [BarData.from_dict(item) for item in _bars(30)]

            return Result()

    dm = FakeDataManager()

    msg = payload_api._compute_pyne_snapshot_message(
        "custom-1",
        dm,
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
    assert dm.auto_backfill is False


def test_incremental_pyne_ws_seed_is_read_only() -> None:
    script = """
indicator("Inc Close", mode="incremental", overlay=True)

def init(ctx):
    pass

def on_bar(ctx, bar):
    ctx.plot("Close", bar.close)
"""

    class FakeDataManager:
        def __init__(self) -> None:
            self.auto_backfill = None

        def query_latest(
            self, symbol, interval, limit, exchange="binance",
            market_type="spot", auto_backfill=None,
        ):
            self.auto_backfill = auto_backfill
            return type("Result", (), {
                "bars": [BarData.from_dict(item) for item in _bars(5)],
            })()

    dm = FakeDataManager()
    message = payload_api._compute_incremental_pyne_snapshot_message(
        "incremental-1",
        dm,
        {
            "kind": "script",
            "scriptMode": "incremental",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "Inc Close",
            "indicatorId": "pyne:incremental-1",
            "script": script,
            "params": {},
            "securityMode": "safe",
            "historyLimit": 100,
            "pyneSession": PyneIncrementalSession(
                script=script,
                params={},
                security_mode="safe",
            ),
        },
    )

    assert message["ok"] is True
    assert dm.auto_backfill is False


def test_pyne_ws_tick_snapshot_clamps_recompute_history(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.limits: list[int] = []

        def query_latest(
            self, symbol, interval, limit, exchange="binance",
            market_type="spot", auto_backfill=None,
        ):
            self.limits.append(limit)

            class Result:
                bars = [BarData.from_dict(item) for item in _bars(30)]

            return Result()

    dm = FakeDataManager()
    monkeypatch.setattr(payload_api.config, "PYNE_TICK_RECOMPUTE_MAX_BARS", 5)

    payload_api._compute_pyne_snapshot_message(
        "custom-1",
        dm,
        {
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": "Custom",
            "script": 'plot(close, title="Close")',
            "params": {},
            "securityMode": "safe",
            "historyLimit": 100,
        },
        bar_time=1_700_000_000,
    )

    assert dm.limits == [5]


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
        def query_latest(
            self, symbol, interval, limit, exchange="binance",
            market_type="spot", auto_backfill=None,
        ):
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
            self.query_auto_backfill: list[object] = []

        async def ensure_stream(self, *args, **kwargs):
            self.ensure_stream_calls.append({"args": args, "kwargs": kwargs})
            return None

        def query_latest(
            self, symbol, interval, limit, exchange="binance",
            market_type="spot", auto_backfill=None,
        ):
            self.query_auto_backfill.append(auto_backfill)
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

    assert sent[0]["type"] == "indicator.subscribed"
    assert sent[0]["kind"] == "script"
    assert sent[0]["clientId"] == "saved-1"
    assert sent[0]["name"] == "Saved Double"
    assert sent[0]["customId"] == saved["id"]
    assert dm.ensure_stream_calls[0]["kwargs"]["consumer_id"] == (
        "ws:indicator:binance:spot:BTCUSDT:1m:saved-1:test"
    )
    assert client_meta["saved-1"]["streamConsumerId"] == (
        "ws:indicator:binance:spot:BTCUSDT:1m:saved-1:test"
    )


@pytest.mark.anyio
async def test_pyne_correction_burst_uses_parent_barriers_and_bounded_flushes(
    monkeypatch,
) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.callback = None

        async def ensure_stream(self, *args, **kwargs):
            return None

        def subscribe(self, **kwargs):
            self.callback = kwargs["callback"]
            return "handle-parent"

    class FakeCoordinator:
        def __init__(self) -> None:
            self.releases = {
                "pyne-parent-request": asyncio.Event(),
                "pyne-next-request": asyncio.Event(),
            }
            self.started: asyncio.Queue[str] = asyncio.Queue()
            self.wait_calls: list[str] = []

        async def wait_for_request(self, request_id: str):
            self.wait_calls.append(request_id)
            self.started.put_nowait(request_id)
            await self.releases[request_id].wait()
            return SimpleNamespace(
                bars_loaded=4,
                verified_contiguous=True,
                retryable=False,
            )

    class FakeRangeService:
        def __init__(self) -> None:
            self.revision = 0
            self.correction_calls: list[dict] = []
            self.put_calls: list[dict] = []

        def data_revision_for_meta(self, _meta):
            return {
                "serverEpoch": "test",
                "correctionRevision": self.revision,
                "closedThrough": 600,
                "revisionToken": f"test:{self.revision}",
            }

        def note_correction(self, **kwargs):
            self.revision += 1
            self.correction_calls.append(kwargs)
            return {
                "serverEpoch": "test",
                "correctionRevision": self.revision,
                "closedThrough": 600,
                "dirtyRange": {
                    "start": kwargs["start"],
                    "end": kwargs["end"],
                },
                "revisionToken": f"test:{self.revision}",
            }

        def put_payload(
            self,
            _meta,
            _payload,
            *,
            start,
            end,
            revision_token,
        ):
            self.put_calls.append({
                "start": start,
                "end": end,
                "revision_token": revision_token,
            })

    class FakeSessions:
        def __init__(self) -> None:
            self.reset_calls: list[tuple[str, object]] = []

        def acquire(self, _key, _factory):
            return object()

        def reset_once(self, key, reset_key, _factory):
            self.reset_calls.append((key, reset_key))
            return object()

    snapshot_calls: list[str] = []

    async def fake_snapshot(client_id, _dm, _meta, bar_time=0):
        snapshot_calls.append(client_id)
        assert bar_time == 0
        return {
            "type": "indicator.snapshot",
            "ok": True,
            "range": {"start": 0, "end": 600},
            "lines": [],
        }

    sessions = FakeSessions()
    monkeypatch.setattr(
        pyne_stream_api,
        "is_incremental_pyne_script",
        lambda _script: True,
    )
    monkeypatch.setattr(
        pyne_stream_api,
        "_compute_pyne_snapshot_message_async",
        fake_snapshot,
    )
    monkeypatch.setattr(
        pyne_stream_api,
        "_pyne_incremental_sessions",
        sessions,
    )

    dm = FakeDataManager()
    coordinator = FakeCoordinator()
    range_service = FakeRangeService()
    custom_handles = {}
    custom_tasks = {}
    client_meta = {}
    sent: list[dict] = []
    queued: list[dict] = []

    async def send_json(payload: dict) -> bool:
        sent.append(payload)
        return True

    async def unsubscribe_client(_client_id: str) -> None:
        return None

    await pyne_stream_api.handle_pyne_indicator_subscribe(
        dm=dm,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        queue=asyncio.Queue(),
        client_meta=client_meta,
        client_id="pyne-parent",
        symbol="BTCUSDT",
        interval="3m",
        exchange="binance",
        market_type="spot",
        name="Incremental",
        custom_id="",
        script="incremental-test-script",
        params={},
        security_mode="safe",
        history_limit=100,
        send_json=send_json,
        stream_consumer_id="ws:indicator:pyne-parent:test",
        unsubscribe_client=unsubscribe_client,
        queue_message=lambda _queue, payload: queued.append(payload),
        range_service=range_service,
        backfill_coordinator=coordinator,
        data_revision={
            "serverEpoch": "test",
            "correctionRevision": 0,
            "closedThrough": 600,
            "revisionToken": "test:0",
        },
    )

    def chunk_event(
        *,
        request_id: str,
        earliest: int,
        latest: int,
        request_start: int,
        request_end: int,
    ) -> SimpleNamespace:
        return SimpleNamespace(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=SimpleNamespace(
                exchange="binance",
                market_type="spot",
                symbol="BTCUSDT",
                interval="3m",
            ),
            detail={
                "request_id": request_id,
                "bars_count": 2,
                "earliest": earliest,
                "latest": latest,
                "range_start_ms": earliest * 1000,
                "range_end_ms": latest * 1000,
                "request_start_ms": request_start * 1000,
                "request_end_ms": request_end * 1000,
            },
            timestamp_ms=123_456,
        )

    assert dm.callback is not None
    first_chunk = chunk_event(
        request_id="pyne-parent-request",
        earliest=0,
        latest=120,
        request_start=0,
        request_end=600,
    )
    second_chunk = chunk_event(
        request_id="pyne-parent-request",
        earliest=300,
        latest=600,
        request_start=0,
        request_end=600,
    )
    await dm.callback(first_chunk)
    assert await asyncio.wait_for(coordinator.started.get(), timeout=1) == (
        "pyne-parent-request"
    )
    await dm.callback(second_chunk)

    assert snapshot_calls == ["pyne-parent"]
    assert coordinator.wait_calls == ["pyne-parent-request"]
    assert range_service.correction_calls == [{
        "series_key": "binance:spot:BTCUSDT:3m",
        "start": 0,
        "end": 600,
        "event_id": "backfill:pyne-parent-request:3m",
    }]

    next_parent = chunk_event(
        request_id="pyne-next-request",
        earliest=1200,
        latest=1500,
        request_start=1200,
        request_end=1800,
    )
    first_amendment = SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=next_parent.key,
        bar=SimpleNamespace(time=900),
        detail={},
        timestamp_ms=900_000,
    )
    second_amendment = SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=next_parent.key,
        bar=SimpleNamespace(time=2100),
        detail={},
        timestamp_ms=2_100_000,
    )
    await dm.callback(next_parent)
    await dm.callback(first_amendment)
    await dm.callback(second_amendment)

    # Four distinct corrections are retained immediately, but the three-event
    # burst behind the active parent occupies one successor batch.
    assert len(range_service.correction_calls) == 4
    assert range_service.revision == 4

    coordinator.releases["pyne-parent-request"].set()
    assert await asyncio.wait_for(coordinator.started.get(), timeout=1) == (
        "pyne-next-request"
    )
    assert snapshot_calls == ["pyne-parent", "pyne-parent"]
    assert coordinator.wait_calls == [
        "pyne-parent-request",
        "pyne-next-request",
    ]

    coordinator.releases["pyne-next-request"].set()
    await custom_tasks["pyne-parent"]

    assert snapshot_calls == ["pyne-parent", "pyne-parent", "pyne-parent"]
    assert len(sessions.reset_calls) == 3
    assert sessions.reset_calls[0][1] == ("seed-state", "test:0", 600)
    assert sessions.reset_calls[1][1] == (
        "backfill:pyne-parent-request:3m",
        "correction-snapshot",
        0,
    )
    assert sessions.reset_calls[2][1] == (
        "bar.amended:binance:spot:BTCUSDT:3m:2100:2100:2100000",
        "correction-snapshot",
        0,
    )
    assert len(queued) == 2
    assert queued[0]["type"] == "indicator.recomputed"
    assert queued[0]["dirtyRange"] == {"start": 0, "end": 600}
    assert queued[1]["dirtyRange"] == {"start": 900, "end": 2100}
    assert queued[1]["dataRevision"]["correctionRevision"] == 4
    assert range_service.put_calls[-1] == {
        "start": 0,
        "end": 600,
        "revision_token": "test:4",
    }

    await dm.callback(second_chunk)
    await dm.callback(next_parent)
    await asyncio.sleep(0)
    assert coordinator.wait_calls == [
        "pyne-parent-request",
        "pyne-next-request",
    ]
    assert len(snapshot_calls) == 3
    assert len(queued) == 2


@pytest.mark.anyio
async def test_pyne_seed_retries_closed_race_and_routes_derived_left_correction(
    monkeypatch,
) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.subscriptions: list[dict] = []

        async def ensure_stream(self, *args, **kwargs):
            return None

        def subscribe(self, **kwargs):
            self.subscriptions.append(kwargs)
            return f"handle-{len(self.subscriptions)}"

        def unsubscribe(self, _handle):
            return None

    class FakeRangeService:
        def __init__(self) -> None:
            self.closed_through = 19_000
            self.revision = 0
            self.corrections: list[dict] = []
            self.put_calls: list[str] = []

        def data_revision_for_meta(self, _meta):
            return {
                "serverEpoch": "test",
                "correctionRevision": self.revision,
                "closedThrough": self.closed_through,
                "revisionToken": f"test:{self.revision}",
            }

        def note_correction(self, **kwargs):
            self.revision += 1
            self.corrections.append(kwargs)
            return {
                **self.data_revision_for_meta({}),
                "dirtyRange": {
                    "start": kwargs["start"],
                    "end": kwargs["end"],
                },
            }

        def put_payload(self, _meta, _payload, **kwargs):
            self.put_calls.append(kwargs["revision_token"])

    class FakeCoordinator:
        def __init__(self) -> None:
            self.wait_calls: list[str] = []

        async def wait_for_request(self, request_id: str):
            self.wait_calls.append(request_id)
            return SimpleNamespace(
                bars_loaded=4,
                verified_contiguous=True,
                retryable=False,
            )

    class FakeSessions:
        def __init__(self) -> None:
            self.reset_calls: list[object] = []

        def acquire(self, _key, _factory):
            return object()

        def reset_once(self, _key, reset_key, _factory):
            self.reset_calls.append(reset_key)
            return object()

    dm = FakeDataManager()
    range_service = FakeRangeService()
    coordinator = FakeCoordinator()
    sessions = FakeSessions()
    snapshot_calls = 0

    async def fake_snapshot(_client_id, _dm, _meta, bar_time=0):
        nonlocal snapshot_calls
        snapshot_calls += 1
        assert bar_time == 0
        if snapshot_calls == 1:
            range_service.closed_through = 20_000
            end = 19_000
        else:
            end = 20_000
        return {
            "type": "indicator.snapshot",
            "ok": True,
            "range": {"start": 10_000, "end": end},
            "lines": [],
        }

    monkeypatch.setattr(
        pyne_stream_api,
        "is_incremental_pyne_script",
        lambda _script: True,
    )
    monkeypatch.setattr(
        pyne_stream_api,
        "_compute_pyne_snapshot_message_async",
        fake_snapshot,
    )
    monkeypatch.setattr(
        pyne_stream_api,
        "_pyne_incremental_sessions",
        sessions,
    )

    custom_handles = {}
    custom_tasks = {}
    client_meta = {}
    sent: list[dict] = []
    queued: list[dict] = []

    async def send_json(payload: dict) -> bool:
        sent.append(payload)
        return True

    await pyne_stream_api.handle_pyne_indicator_subscribe(
        dm=dm,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        queue=asyncio.Queue(),
        client_meta=client_meta,
        client_id="pyne-89m",
        symbol="BTCUSDT",
        interval="89m",
        exchange="binance",
        market_type="spot",
        name="Incremental 89m",
        custom_id="",
        script="incremental-test-script",
        params={},
        security_mode="safe",
        history_limit=2_000,
        send_json=send_json,
        stream_consumer_id="ws:indicator:pyne-89m:test",
        unsubscribe_client=lambda _client_id: asyncio.sleep(0),
        queue_message=lambda _queue, payload: queued.append(payload),
        range_service=range_service,
        backfill_coordinator=coordinator,
        data_revision={
            "serverEpoch": "test",
            "correctionRevision": 0,
            "closedThrough": 19_000,
            "revisionToken": "test:0",
        },
    )

    assert snapshot_calls == 2
    assert sessions.reset_calls[:2] == [
        ("seed-state", "test:0", 19_000),
        ("seed-state", "test:0", 20_000),
    ]
    assert sent[0]["seeded"] is True
    assert sent[0]["dataRevision"]["closedThrough"] == 20_000
    assert client_meta["pyne-89m"]["seedRange"] == {
        "start": 10_000,
        "end": 20_000,
    }
    assert custom_handles["pyne-89m"] == "handle-1"
    assert len(dm.subscriptions) == 2

    correction_callback = dm.subscriptions[1]["callback"]
    await correction_callback(SimpleNamespace(
        event_type=DataEventType.BACKFILL_COMPLETED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
        ),
        detail={
            "request_id": "base-to-89m",
            "bars_count": 100,
            "request_start_ms": 1_000_000,
            "request_end_ms": 2_000_000,
            "derived_repair_targets": [{
                "interval": "89m",
                "start_ms": 1_000_000,
                "end_ms": 2_000_000,
            }, {
                "interval": "89m",
                "start_ms": 3_000_000,
                "end_ms": 4_000_000,
            }],
        },
        timestamp_ms=123_456,
    ))
    await custom_tasks["pyne-89m"]

    assert coordinator.wait_calls == ["base-to-89m"]
    assert snapshot_calls == 2
    assert len(sessions.reset_calls) == 2
    assert range_service.corrections == [{
        "series_key": "binance:spot:BTCUSDT:89m",
        "start": 1_000,
        "end": 4_000,
        "event_id": "backfill:base-to-89m:89m",
    }]
    assert queued[0]["dirtyRange"] == {"start": 1_000, "end": 4_000}

    await correction_callback(SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
        ),
        bar=SimpleNamespace(time=21_000),
        detail={},
        timestamp_ms=21_000_000,
    ))
    await custom_tasks["pyne-89m"]

    assert snapshot_calls == 3
    assert range_service.corrections[-1]["series_key"] == (
        "binance:spot:BTCUSDT:89m"
    )
    assert range_service.corrections[-1]["start"] == 16_020
    assert range_service.corrections[-1]["end"] == 16_020
    assert queued[-1]["dirtyRange"] == {"start": 16_020, "end": 16_020}


@pytest.mark.anyio
async def test_pyne_connection_uses_one_correction_wildcard_for_many_clients(
    monkeypatch,
) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.subscriptions: list[dict] = []
            self.unsubscribed: list[str] = []

        async def ensure_stream(self, *args, **kwargs):
            return None

        def subscribe(self, **kwargs):
            self.subscriptions.append(kwargs)
            return f"handle-{len(self.subscriptions)}"

        def unsubscribe(self, handle):
            self.unsubscribed.append(handle)

    monkeypatch.setattr(
        pyne_stream_api,
        "is_incremental_pyne_script",
        lambda _script: False,
    )
    dm = FakeDataManager()
    custom_handles: dict[str, object] = {}
    custom_tasks: dict[str, asyncio.Task] = {}
    client_meta: dict[str, dict] = {}
    correction_state = {"handle": None, "callbacks": {}}

    async def send_json(_payload: dict) -> bool:
        return True

    for index in range(7):
        client_id = f"pyne-{index}"
        await pyne_stream_api.handle_pyne_indicator_subscribe(
            dm=dm,
            custom_handles=custom_handles,
            custom_tasks=custom_tasks,
            queue=asyncio.Queue(),
            client_meta=client_meta,
            client_id=client_id,
            symbol="BTCUSDT",
            interval="89m",
            exchange="binance",
            market_type="spot",
            name=client_id,
            custom_id="",
            script="plot(close)",
            params={},
            security_mode="safe",
            history_limit=2_000,
            send_json=send_json,
            stream_consumer_id=f"consumer-{index}",
            unsubscribe_client=lambda _client_id: asyncio.sleep(0),
            queue_message=lambda _queue, _payload: None,
            pyne_correction_state=correction_state,
        )

    wildcard_subscriptions = [
        item for item in dm.subscriptions
        if "symbol" not in item
    ]
    assert len(wildcard_subscriptions) == 1
    assert len(dm.subscriptions) == 8
    assert len(correction_state["callbacks"]) == 7
    assert all(not isinstance(handle, (tuple, list)) for handle in custom_handles.values())

    for index in range(7):
        await stream_api._unsubscribe_indicator_client(
            f"pyne-{index}",
            dm=dm,
            indicator_engine=None,
            subscribed={},
            custom_handles=custom_handles,
            custom_tasks=custom_tasks,
            client_meta=client_meta,
        )

    assert correction_state["callbacks"] == {}
    assert correction_state["handle"] is None
    assert wildcard_subscriptions[0] is not None
    assert "handle-2" in dm.unsubscribed


@pytest.mark.anyio
async def test_pyne_initial_seed_query_is_shared_per_connection(monkeypatch) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.query_calls: list[dict] = []
            self.subscriptions: list[dict] = []
            self.bars = [BarData.from_dict(row) for row in _bars(100)]

        async def ensure_stream(self, *args, **kwargs):
            return None

        def query_latest(self, *args, **kwargs):
            self.query_calls.append(dict(kwargs))
            return SimpleNamespace(
                bars=self.bars,
                missing_ranges=[],
                retryable=False,
                complete=True,
            )

        def subscribe(self, **kwargs):
            self.subscriptions.append(kwargs)
            return f"handle-{len(self.subscriptions)}"

    dm = FakeDataManager()
    engine = create_engine()
    custom_handles: dict[str, object] = {}
    custom_tasks: dict[str, asyncio.Task] = {}
    client_meta: dict[str, dict] = {}
    correction_state = {"handle": None, "callbacks": {}}
    seed_cache: dict = {}
    sent: list[dict] = []

    async def send_json(payload: dict) -> bool:
        sent.append(payload)
        return True

    for client_id in ("pyne-a", "pyne-b"):
        await pyne_stream_api.handle_pyne_indicator_subscribe(
            dm=dm,
            custom_handles=custom_handles,
            custom_tasks=custom_tasks,
            queue=asyncio.Queue(),
            client_meta=client_meta,
            client_id=client_id,
            symbol="BTCUSDT",
            interval="89m",
            exchange="binance",
            market_type="spot",
            name=client_id,
            custom_id="",
            script='''
indicator("Shared", mode="incremental", overlay=True)
def init(ctx):
    ctx.state("count", 0)
def on_bar(ctx, bar):
    counter = ctx.state("count")
    counter.value += 1
    ctx.plot("Count", counter.value)
''',
            params={},
            security_mode="safe",
            history_limit=100,
            send_json=send_json,
            stream_consumer_id=f"consumer-{client_id}",
            unsubscribe_client=lambda _client_id: asyncio.sleep(0),
            queue_message=lambda _queue, _payload: None,
            pyne_correction_state=correction_state,
            seed_query_cache=seed_cache,
            range_service=getattr(engine, "indicator_range_service", None),
        )

    assert len(dm.query_calls) == 1
    assert dm.query_calls[0]["limit"] == 101
    assert len([
        payload for payload in sent
        if payload.get("type") == "indicator.subscribed"
    ]) == 2

    correction_callback = next(
        item["callback"] for item in dm.subscriptions
        if "symbol" not in item
    )
    await correction_callback(SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="89m",
        ),
        bar=SimpleNamespace(time=dm.bars[-1].time),
        detail={},
        timestamp_ms=dm.bars[-1].time * 1000,
    ))
    await asyncio.gather(*tuple(custom_tasks.values()))

    assert len(dm.query_calls) == 2
    assert dm.query_calls[-1]["limit"] == 101


@pytest.mark.anyio
async def test_pyne_closed_finality_is_not_cancelled_by_following_preview(
    monkeypatch,
) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.subscriptions: list[dict] = []

        async def ensure_stream(self, *args, **kwargs):
            return None

        def subscribe(self, **kwargs):
            self.subscriptions.append(kwargs)
            return f"handle-{len(self.subscriptions)}"

    class FakeSessions:
        def acquire(self, _key, _factory):
            return object()

    async def fake_snapshot(_client_id, _dm, _meta, bar_time=0):
        return {
            "type": "indicator.snapshot",
            "ok": True,
            "range": {"start": 300, "end": 600},
            "lines": [],
        }

    close_started = asyncio.Event()
    release_close = asyncio.Event()
    bar_calls: list[bool] = []

    async def fake_bar(_client_id, _meta, bar, *, preview):
        bar_calls.append(preview)
        if not preview:
            close_started.set()
            await release_close.wait()
        return {
            "type": "indicator.patch",
            "reason": "bar_update" if preview else "bar_closed",
            "range": {"start": bar["time"], "end": bar["time"]},
        }

    monkeypatch.setattr(pyne_stream_api, "is_incremental_pyne_script", lambda _s: True)
    monkeypatch.setattr(pyne_stream_api, "_compute_pyne_snapshot_message_async", fake_snapshot)
    monkeypatch.setattr(pyne_stream_api, "_compute_incremental_pyne_bar_message_async", fake_bar)
    monkeypatch.setattr(pyne_stream_api, "_pyne_incremental_sessions", FakeSessions())

    dm = FakeDataManager()
    custom_handles: dict[str, object] = {}
    custom_tasks: dict[str, asyncio.Task] = {}
    client_meta: dict[str, dict] = {}
    queued: list[dict] = []

    async def queue_critical(_queue, payload):
        queued.append(payload)

    await pyne_stream_api.handle_pyne_indicator_subscribe(
        dm=dm,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        queue=asyncio.Queue(maxsize=1),
        client_meta=client_meta,
        client_id="pyne-finality",
        symbol="BTCUSDT",
        interval="3m",
        exchange="binance",
        market_type="spot",
        name="Finality",
        custom_id="",
        script="incremental-test-script",
        params={},
        security_mode="safe",
        history_limit=100,
        send_json=lambda _payload: asyncio.sleep(0, result=True),
        stream_consumer_id="consumer-finality",
        unsubscribe_client=lambda _client_id: asyncio.sleep(0),
        queue_message=lambda _queue, payload: queued.append(payload),
        queue_critical_message=queue_critical,
    )
    realtime_callback = dm.subscriptions[0]["callback"]
    closed_bar = BarData.from_dict({**_bars(1)[0], "time": 780})
    await realtime_callback(SimpleNamespace(
        event_type=DataEventType.BAR_CLOSED,
        bar=closed_bar,
    ))
    await asyncio.wait_for(close_started.wait(), timeout=1)
    await realtime_callback(SimpleNamespace(
        event_type=DataEventType.BAR_UPDATED,
        bar=BarData.from_dict({**_bars(1)[0], "time": 960, "is_closed": False}),
    ))
    release_close.set()
    await custom_tasks["pyne-finality"]

    assert bar_calls == [False]
    assert queued[-1]["reason"] == "bar_closed"

    close_started.clear()
    release_close.clear()
    queued.clear()
    await realtime_callback(SimpleNamespace(
        event_type=DataEventType.BAR_CLOSED,
        bar=BarData.from_dict({**_bars(1)[0], "time": 960}),
    ))
    first_close_task = custom_tasks["pyne-finality"]
    await asyncio.wait_for(close_started.wait(), timeout=1)
    await realtime_callback(SimpleNamespace(
        event_type=DataEventType.BAR_CLOSED,
        bar=BarData.from_dict({**_bars(1)[0], "time": 1_140}),
    ))
    await stream_api._unsubscribe_indicator_client(
        "pyne-finality",
        dm=dm,
        indicator_engine=None,
        subscribed={},
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        client_meta=client_meta,
    )
    release_close.set()
    await first_close_task
    await asyncio.sleep(0)

    assert bar_calls == [False, False]
    assert queued == []
    assert "pyne-finality" not in custom_tasks


@pytest.mark.anyio
async def test_pyne_correction_snapshot_does_not_double_commit_included_close(
    monkeypatch,
) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.subscriptions: list[dict] = []

        async def ensure_stream(self, *args, **kwargs):
            return None

        def subscribe(self, **kwargs):
            self.subscriptions.append(kwargs)
            return f"handle-{len(self.subscriptions)}"

    class FakeSessions:
        def acquire(self, _key, _factory):
            return object()

        def reset_once(self, _key, _reset_key, _factory):
            return object()

    snapshot_started = asyncio.Event()
    release_snapshot = asyncio.Event()
    snapshot_calls = 0

    async def fake_snapshot(_client_id, _dm, _meta, bar_time=0):
        nonlocal snapshot_calls
        snapshot_calls += 1
        if snapshot_calls == 2:
            snapshot_started.set()
            await release_snapshot.wait()
            end = 600
        else:
            end = 780 if snapshot_calls >= 3 else 600
        return {
            "type": "indicator.snapshot",
            "ok": True,
            "range": {"start": 300, "end": end},
            "lines": [],
        }

    bar_calls: list[bool] = []

    async def fake_bar(_client_id, _meta, _bar, *, preview):
        bar_calls.append(preview)
        return {"type": "indicator.patch", "reason": "bar_closed"}

    monkeypatch.setattr(pyne_stream_api, "is_incremental_pyne_script", lambda _s: True)
    monkeypatch.setattr(pyne_stream_api, "_compute_pyne_snapshot_message_async", fake_snapshot)
    monkeypatch.setattr(pyne_stream_api, "_compute_incremental_pyne_bar_message_async", fake_bar)
    monkeypatch.setattr(pyne_stream_api, "_pyne_incremental_sessions", FakeSessions())

    dm = FakeDataManager()
    custom_tasks: dict[str, asyncio.Task] = {}
    queued: list[dict] = []

    async def queue_critical(_queue, payload):
        queued.append(payload)

    await pyne_stream_api.handle_pyne_indicator_subscribe(
        dm=dm,
        custom_handles={},
        custom_tasks=custom_tasks,
        queue=asyncio.Queue(),
        client_meta={},
        client_id="pyne-correction-close",
        symbol="BTCUSDT",
        interval="3m",
        exchange="binance",
        market_type="spot",
        name="Correction Close",
        custom_id="",
        script="incremental-test-script",
        params={},
        security_mode="safe",
        history_limit=100,
        send_json=lambda _payload: asyncio.sleep(0, result=True),
        stream_consumer_id="consumer-correction-close",
        unsubscribe_client=lambda _client_id: asyncio.sleep(0),
        queue_message=lambda _queue, payload: queued.append(payload),
        queue_critical_message=queue_critical,
    )
    realtime_callback = dm.subscriptions[0]["callback"]
    correction_callback = dm.subscriptions[1]["callback"]
    await correction_callback(SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="3m",
        ),
        bar=SimpleNamespace(time=300),
        detail={},
        timestamp_ms=300_000,
    ))
    correction_task = custom_tasks["pyne-correction-close"]
    await asyncio.wait_for(snapshot_started.wait(), timeout=1)
    await realtime_callback(SimpleNamespace(
        event_type=DataEventType.BAR_CLOSED,
        bar=BarData.from_dict({**_bars(1)[0], "time": 780}),
    ))
    release_snapshot.set()
    await correction_task

    assert snapshot_calls == 3
    assert bar_calls == []
    recomputed = [item for item in queued if item.get("type") == "indicator.recomputed"]
    assert len(recomputed) == 1
    assert recomputed[0]["dirtyRange"] == {"start": 780, "end": 780}


@pytest.mark.anyio
async def test_pyne_failed_correction_emits_retryable_invalidation(
    monkeypatch,
) -> None:
    class FakeDataManager:
        def __init__(self) -> None:
            self.subscriptions: list[dict] = []

        async def ensure_stream(self, *args, **kwargs):
            return None

        def subscribe(self, **kwargs):
            self.subscriptions.append(kwargs)
            return f"handle-{len(self.subscriptions)}"

    class FailedCoordinator:
        def __init__(self) -> None:
            self.calls = 0

        async def wait_for_request(self, _request_id):
            self.calls += 1
            return SimpleNamespace(
                bars_loaded=0,
                verified_contiguous=False,
                retryable=True,
            )

    monkeypatch.setattr(
        pyne_stream_api,
        "is_incremental_pyne_script",
        lambda _script: False,
    )
    dm = FakeDataManager()
    coordinator = FailedCoordinator()
    custom_tasks: dict[str, asyncio.Task] = {}
    queued: list[dict] = []

    async def queue_critical(_queue, payload):
        queued.append(payload)

    await pyne_stream_api.handle_pyne_indicator_subscribe(
        dm=dm,
        custom_handles={},
        custom_tasks=custom_tasks,
        queue=asyncio.Queue(),
        client_meta={},
        client_id="pyne-failed-correction",
        symbol="BTCUSDT",
        interval="3m",
        exchange="binance",
        market_type="spot",
        name="Failed Correction",
        custom_id="",
        script="plot(close)",
        params={},
        security_mode="safe",
        history_limit=100,
        send_json=lambda _payload: asyncio.sleep(0, result=True),
        stream_consumer_id="consumer-failed-correction",
        unsubscribe_client=lambda _client_id: asyncio.sleep(0),
        queue_message=lambda _queue, payload: queued.append(payload),
        queue_critical_message=queue_critical,
        backfill_coordinator=coordinator,
    )
    correction_callback = dm.subscriptions[1]["callback"]
    event = SimpleNamespace(
        event_type=DataEventType.BACKFILL_COMPLETED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval="3m",
        ),
        detail={
            "request_id": "failed-parent",
            "bars_count": 3,
            "request_start_ms": 300_000,
            "request_end_ms": 600_000,
        },
        timestamp_ms=600_000,
    )
    await correction_callback(event)
    await custom_tasks["pyne-failed-correction"]

    assert queued[-1]["type"] == "indicator.recomputed"
    assert queued[-1]["ok"] is False
    assert queued[-1]["invalidated"] is True
    assert queued[-1]["retryMode"] == "event"

    await correction_callback(event)
    await custom_tasks["pyne-failed-correction"]
    assert coordinator.calls == 2
    assert len(queued) == 2


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
