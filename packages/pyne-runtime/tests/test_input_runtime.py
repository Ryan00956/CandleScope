from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]


def test_input_schema_and_param_overrides() -> None:
    result = pn.run(
        """
length = input.int(20, "Length", minval=1, maxval=100)
mult = input.float(2.0, "Multiplier", minval=0.1)
show = input.bool(True, "Show")
kind = input.string("EMA", "Type", options=["SMA", "EMA"])
col = input.color("#f59e0b", "Color")
src = input.source(close, "Source")
plot(src * mult, kind, color=col)
""",
        _bars(),
        params={"Length": 5, "Multiplier": 3.0, "Show": False, "Type": "SMA"},
        executor_mode="inline",
    )

    assert result.ok
    names = {item["key"] for item in result.param_schema}
    assert names == {"Length", "Multiplier", "Show", "Type", "Color", "Source"}
    assert {item["id"] for item in result.param_schema} == names
    assert result.lines[0]["name"] == "SMA"
    assert result.lines[0]["data"][-1]["value"] == 10.5


def test_input_schema_includes_ui_metadata_and_current_values() -> None:
    result = pn.run(
        """
length = input.int(
    20,
    "Length",
    minval=1,
    maxval=100,
    step=5,
    tooltip="Moving average length",
    group="MA",
    inline="ma",
    confirm=True,
)
mult = input.float(2.0, "Multiplier", minval=0.5, maxval=5.0, step=0.25, group="MA")
show = input.bool(True, "Show", inline="display")
kind = input.string("EMA", "Type", options=["SMA", "EMA"], group="MA")
col = input.color("#f59e0b", "Color", inline="display")
src = input.source(close, "Source", group="Data")
plot(src * mult, kind, color=col)
""",
        _bars(),
        params={
            "Length": 25,
            "Multiplier": 3,
            "Show": False,
            "Type": "SMA",
            "Color": "#00ff00",
            "Source": "hl2",
        },
        executor_mode="inline",
    )

    assert result.ok, result.error
    schema = {item["key"]: item for item in result.param_schema}
    assert schema["Length"] == {
        "id": "Length",
        "key": "Length",
        "type": "int",
        "default": 20,
        "title": "Length",
        "tooltip": "Moving average length",
        "group": "MA",
        "step": 5,
        "inline": "ma",
        "confirm": True,
        "min": 1,
        "minval": 1,
        "max": 100,
        "maxval": 100,
        "current": 25,
    }
    assert schema["Multiplier"]["minval"] == 0.5
    assert schema["Multiplier"]["maxval"] == 5.0
    assert schema["Multiplier"]["current"] == 3.0
    assert schema["Show"]["inline"] == "display"
    assert schema["Show"]["current"] is False
    assert schema["Type"]["options"] == ["SMA", "EMA"]
    assert schema["Type"]["current"] == "SMA"
    assert schema["Color"]["current"] == "#00ff00"
    assert schema["Source"]["options"] == [
        "open",
        "high",
        "low",
        "close",
        "hl2",
        "hlc3",
        "ohlc4",
        "hlcc4",
    ]
    assert schema["Source"]["current"] == "hl2"


def test_input_duplicate_titles_get_stable_unique_keys() -> None:
    result = pn.run(
        """
fast = input.int(12, "Length")
slow = input.int(26, "Length")
kind = input.string("EMA", "Length", options=["SMA", "EMA"])
plot(fast, "Fast")
plot(slow, "Slow")
plot(1 if kind == "SMA" else 0, "Kind")
""",
        _bars(),
        params={"Length": 10, "Length_2": 30, "Length_3": "SMA"},
        executor_mode="inline",
    )

    assert result.ok, result.error
    schema = result.param_schema
    assert [item["key"] for item in schema] == ["Length", "Length_2", "Length_3"]
    assert [item["id"] for item in schema] == ["Length", "Length_2", "Length_3"]
    assert [item["title"] for item in schema] == ["Length", "Length", "Length"]
    assert [item["current"] for item in schema] == [10, 30, "SMA"]
    assert result.values("Fast") == [10.0, 10.0, 10.0]
    assert result.values("Slow") == [30.0, 30.0, 30.0]
    assert result.values("Kind") == [1.0, 1.0, 1.0]


def test_input_timeframe_symbol_session_and_time_schema() -> None:
    result = pn.run(
        """
tf = input.timeframe("60", "Higher TF", options=["15", "60", "1D"], group="Context")
symbol = input.symbol("NASDAQ:AAPL", "Symbol", group="Context", confirm=True)
session_value = input.session("0930-1600", "Session", options=["0930-1600", "0000-2359"])
start_time = input.time(1710000000, "Start Time", tooltip="Unix seconds")
plot(1 if tf == "1D" else 0, "Daily Selected")
plot(1 if symbol == "NASDAQ:MSFT" else 0, "Symbol Selected")
plot(1 if session_value == "0000-2359" else 0, "Session Selected")
plot(start_time, "Start Time")
""",
        _bars(),
        params={
            "Higher TF": "1D",
            "Symbol": "NASDAQ:MSFT",
            "Session": "0000-2359",
            "Start Time": 1710000600,
        },
        executor_mode="inline",
    )

    assert result.ok, result.error
    schema = {item["key"]: item for item in result.param_schema}
    assert schema["Higher TF"] == {
        "id": "Higher TF",
        "key": "Higher TF",
        "type": "timeframe",
        "default": "60",
        "title": "Higher TF",
        "tooltip": "",
        "group": "Context",
        "options": ["15", "60", "1D"],
        "current": "1D",
    }
    assert schema["Symbol"]["type"] == "symbol"
    assert schema["Symbol"]["confirm"] is True
    assert schema["Symbol"]["current"] == "NASDAQ:MSFT"
    assert schema["Session"]["type"] == "session"
    assert schema["Session"]["options"] == ["0930-1600", "0000-2359"]
    assert schema["Session"]["current"] == "0000-2359"
    assert schema["Start Time"]["type"] == "time"
    assert schema["Start Time"]["tooltip"] == "Unix seconds"
    assert schema["Start Time"]["current"] == 1710000600
    assert result.values("Daily Selected") == [1.0, 1.0, 1.0]
    assert result.values("Symbol Selected") == [1.0, 1.0, 1.0]
    assert result.values("Session Selected") == [1.0, 1.0, 1.0]
    assert result.values("Start Time") == [1710000600.0, 1710000600.0, 1710000600.0]


def test_input_context_options_reject_invalid_overrides() -> None:
    result = pn.run(
        """
tf = input.timeframe("60", "Higher TF", options=["15", "60"])
symbol = input.symbol("NASDAQ:AAPL", "Symbol", options=["NASDAQ:AAPL"])
session_value = input.session("0930-1600", "Session", options=["0930-1600"])
plot(1 if tf == "60" else 0, "TF")
plot(1 if symbol == "NASDAQ:AAPL" else 0, "Symbol")
plot(1 if session_value == "0930-1600" else 0, "Session")
""",
        _bars(),
        params={
            "Higher TF": "1D",
            "Symbol": "NASDAQ:MSFT",
            "Session": "0000-2359",
        },
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_PARAM"
    assert "Higher TF" in str(result.error)
    assert "expected one of" in str(result.error)


def test_input_numeric_and_bool_overrides_reject_invalid_values() -> None:
    result = pn.run(
        """
length = input.int(20, "Length", minval=1, maxval=100)
mult = input.float(2.0, "Multiplier", minval=0.5)
show = input.bool(True, "Show")
plot(length * mult if show else 0, "Value")
""",
        _bars(),
        params={"Length": 101, "Multiplier": 2.0, "Show": True},
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_PARAM"
    assert "Length" in str(result.error)
    assert "must be <= 100" in str(result.error)

    result = pn.run(
        """
length = input.int(20, "Length", minval=1, maxval=100)
plot(length, "Length")
""",
        _bars(),
        params={"Length": 2.5},
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_PARAM"
    assert "expected an integer" in str(result.error)

    result = pn.run(
        """
show = input.bool(True, "Show")
plot(1 if show else 0, "Show")
""",
        _bars(),
        params={"Show": "sometimes"},
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_PARAM"
    assert "expected a boolean" in str(result.error)


def test_input_source_and_time_reject_invalid_overrides() -> None:
    result = pn.run(
        """
src = input.source(close, "Source")
plot(src, "Selected")
""",
        _bars(),
        params={"Source": "median"},
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_PARAM"
    assert "Source" in str(result.error)

    result = pn.run(
        """
start_time = input.time(1710000000, "Start Time")
plot(start_time, "Start Time")
""",
        _bars(),
        params={"Start Time": -1},
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_INVALID_PARAM"
    assert "non-negative" in str(result.error)


def test_params_namespace_is_read_only_and_separate_from_input_params() -> None:
    result = pn.run(
        """
try:
    params["Length"] = 9
    readonly = 0
except Exception:
    readonly = 1
length = input.int(2, "Length")
plot(readonly, "Read Only")
plot(length, "Length")
""",
        _bars(),
        params={"Length": 5},
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Read Only") == [1.0, 1.0, 1.0]
    assert result.values("Length") == [5.0, 5.0, 5.0]


def test_input_source_identifies_named_derived_series() -> None:
    result = pn.run(
        """
src = input.source(hlcc4, "Source")
plot(src, "Selected")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.param_schema[0]["default"] == "hlcc4"
    assert result.values("Selected")[-1] == (4 + 2.5 + 3.5 + 3.5) / 4
