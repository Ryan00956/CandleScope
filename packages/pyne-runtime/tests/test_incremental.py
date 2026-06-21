from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2, "low": 1, "close": 2.0, "volume": 100},
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 3.0, "volume": 100},
    ]


def test_incremental_runtime_seeds_history() -> None:
    script = """
indicator("Incremental MA", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.sma("ma", period=2)

def on_bar(ctx, bar):
    value = ctx.ta.sma("ma").update(bar.close)
    ctx.plot("MA", value, color=color.orange)
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert result.ok
    assert len(result.lines) == 1
    assert len(result.lines[0]["data"]) == 2


def test_incremental_detection_ignores_invalid_syntax() -> None:
    assert pn.is_incremental_pyne_script("if") is False


def _line_values(result: object, line_id: str) -> list[float]:
    line = next(item for item in result.lines if item["id"] == line_id)
    return [point["value"] for point in line["data"]]


def _line_values_by_name(result: object, name: str) -> list[float]:
    line = next(item for item in result.lines if item["name"] == name)
    return [point["value"] for point in line["data"]]


def _marker_times(result: object, marker_id: str) -> list[int]:
    for marker in result.output.get("markers", []):
        if marker["id"] == marker_id:
            return [point["time"] for point in marker["data"]]
    return []


def _assert_strategy_matches_batch(incremental: object, batch: object) -> None:
    assert _line_values(incremental, "position") == _line_values_by_name(batch, "Position")
    assert _line_values(incremental, "equity") == _line_values_by_name(batch, "Equity")
    assert _line_values(incremental, "net_profit") == _line_values_by_name(batch, "Net Profit")
    assert incremental.output["strategy"]["position"] == batch.output["strategy"]["position"]
    for key in ("initial_capital", "equity", "netprofit", "openprofit", "grossprofit", "grossloss", "commission"):
        assert incremental.output["strategy"]["summary"][key] == batch.output["strategy"]["summary"][key]
    assert incremental.output["strategy"]["orders"] == batch.output["strategy"]["orders"]
    assert incremental.output["strategy"]["closedtrades"] == batch.output["strategy"]["closedtrades"]
    assert incremental.output["strategy"]["opentrades"] == batch.output["strategy"]["opentrades"]


def _assert_full_strategy_matches_batch(incremental: object, batch: object) -> None:
    _assert_strategy_matches_batch(incremental, batch)
    assert incremental.output["strategy"] == batch.output["strategy"]


def test_incremental_seed_exposes_bar_clock_and_barstate() -> None:
    script = """
indicator("Incremental Clock", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    ctx.plot("Index", ctx.bar_index)
    ctx.plot("BarIndex", bar.bar_index)
    ctx.plot("Last", ctx.last_bar_index)
    ctx.marker(ctx.barstate.isfirst, text="First")
    ctx.marker(ctx.barstate.islast, text="Last")
    ctx.marker(ctx.barstate.ishistory, text="History")
    ctx.marker(ctx.barstate.isconfirmed, text="Confirmed")
    ctx.marker(ctx.barstate.islastconfirmedhistory, text="LCH")
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert result.ok
    assert _line_values(result, "index") == [0.0, 1.0, 2.0]
    assert _line_values(result, "barindex") == [0.0, 1.0, 2.0]
    assert _line_values(result, "last") == [2.0, 2.0, 2.0]
    assert _marker_times(result, "first") == [1]
    assert _marker_times(result, "last") == [3]
    assert _marker_times(result, "history") == [1, 2, 3]
    assert _marker_times(result, "confirmed") == [1, 2, 3]
    assert _marker_times(result, "lch") == [3]
    assert result.meta["bar_index"] == 2
    assert result.meta["last_bar_index"] == 2
    assert result.meta["barstate"]["islastconfirmedhistory"] is True


def test_incremental_context_exposes_current_session_flags() -> None:
    script = """
indicator("Incremental Session", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    ctx.plot("Market", 1 if ctx.session.ismarket else 0)
    ctx.marker(ctx.session.isfirstbar, text="First Session")
    ctx.marker(ctx.session.islastbar, text="Last Session")
"""
    bars = [
        {**_bars()[0], "session_ismarket": True, "session_isfirstbar": True},
        {**_bars()[1], "session_ismarket": False},
        {**_bars()[2], "session": {"ismarket": True, "islastbar": True}},
    ]

    result = pn.run(script, bars, executor_mode="inline")

    assert result.ok
    assert _line_values(result, "market") == [1.0, 0.0, 1.0]
    assert _marker_times(result, "first_session") == [1]
    assert _marker_times(result, "last_session") == [3]


def test_incremental_committed_plot_and_marker_match_batch_output() -> None:
    batch_script = """
indicator("Batch Output", overlay=True)
plot(close, "Close")
marker(close > open, shape=shape.square, text="Up", size=size.large)
"""
    incremental_script = """
indicator("Incremental Output", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    ctx.plot("Close", bar.close)
    ctx.marker(
        bar.close > bar.open,
        shape=shape.square,
        text="Up",
        position=location.abovebar,
        size=size.large,
    )
"""

    batch = pn.run(batch_script, _bars(), executor_mode="inline")
    incremental = pn.run(incremental_script, _bars(), executor_mode="inline")

    assert batch.ok, batch.error
    assert incremental.ok, incremental.error
    assert _line_values(incremental, "close") == _line_values_by_name(batch, "Close")
    batch_marker = batch.output["markers"][0]
    incremental_marker = incremental.output["markers"][0]
    assert incremental_marker["shape"] == batch_marker["shape"]
    assert incremental_marker["color"] == batch_marker["color"]
    assert incremental_marker["text"] == batch_marker["text"]
    assert incremental_marker["position"] == batch_marker["position"]
    assert incremental_marker["size"] == batch_marker["size"]
    assert incremental_marker["pane"] == batch_marker["pane"]
    assert incremental_marker["data"] == batch_marker["data"]


def test_incremental_committed_histogram_plot_matches_batch_output() -> None:
    batch_script = """
indicator("Batch Columns", overlay=True)
plot(volume, "Volume Columns", style=plot.style_columns)
"""
    incremental_script = """
indicator("Incremental Columns", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    ctx.plot("Volume Columns", bar.volume, style=plot.style_columns)
"""

    batch = pn.run(batch_script, _bars(), executor_mode="inline")
    incremental = pn.run(incremental_script, _bars(), executor_mode="inline")

    assert batch.ok, batch.error
    assert incremental.ok, incremental.error
    assert _line_values(incremental, "volume_columns") == _line_values_by_name(batch, "Volume Columns")
    assert incremental.lines[0]["type"] == batch.lines[0]["type"] == "histogram"
    assert incremental.output["histograms"] == batch.output["histograms"]
    assert "lines" not in incremental.output


def test_incremental_committed_styled_line_plot_matches_batch_output() -> None:
    batch_script = """
indicator("Batch Styled Line", overlay=True)
plot(close, "Styled Close", color=color.blue, linewidth=3, style="dashed")
"""
    incremental_script = """
indicator("Incremental Styled Line", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    ctx.plot("Styled Close", bar.close, color=color.blue, linewidth=3, style="dashed")
"""

    batch = pn.run(batch_script, _bars(), executor_mode="inline")
    incremental = pn.run(incremental_script, _bars(), executor_mode="inline")

    assert batch.ok, batch.error
    assert incremental.ok, incremental.error
    assert _line_values(incremental, "styled_close") == _line_values_by_name(batch, "Styled Close")
    assert incremental.lines[0]["lineWidth"] == batch.lines[0]["lineWidth"] == 3
    assert incremental.lines[0]["lineStyle"] == batch.lines[0]["lineStyle"] == 2
    incremental_line = incremental.output["lines"][0]
    batch_line = batch.output["lines"][0]
    assert incremental_line["color"] == batch_line["color"]
    assert incremental_line["linewidth"] == batch_line["linewidth"]
    assert incremental_line["style"] == batch_line["style"] == "dashed"
    assert incremental_line["data"] == batch_line["data"]


def test_incremental_overlay_false_defaults_match_batch_panes() -> None:
    batch_script = """
indicator("Batch Pane", overlay=False)
plot(close, "Close")
marker(close > open, text="Up")
"""
    incremental_script = """
indicator("Incremental Pane", mode="incremental", overlay=False)

def on_bar(ctx, bar):
    ctx.plot("Close", bar.close)
    ctx.marker(bar.close > bar.open, text="Up")
"""

    batch = pn.run(batch_script, _bars(), executor_mode="inline")
    incremental = pn.run(incremental_script, _bars(), executor_mode="inline")

    assert batch.ok, batch.error
    assert incremental.ok, incremental.error
    assert incremental.output["lines"][0]["pane"] == batch.output["lines"][0]["pane"] == "separate"
    assert incremental.output["markers"][0]["pane"] == batch.output["markers"][0]["pane"] == "separate"
    assert incremental.output["markers"][0]["data"] == batch.output["markers"][0]["data"]


def test_incremental_stateful_indicator_matches_batch_committed_bars() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 3, "low": 1, "close": 2.0, "volume": 100},
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 1.5, "volume": 100},
        {"time": 4, "open": 1, "high": 4, "low": 1, "close": 1.5, "volume": 100},
        {"time": 5, "open": 1, "high": 4, "low": 1, "close": 2.5, "volume": 100},
    ]
    batch_script = """
trend = state("trend", 0)
updates = where(close > close[1], 1, where(close < close[1], -1, na))
plot(trend.set_each(updates), "Trend")
plot(bar_index, "Index")
"""
    incremental_script = """
indicator("Incremental Trend", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    previous = ctx.state("previous_close")
    trend = ctx.state("trend", 0)
    if previous.value is not None:
        if bar.close > previous.value:
            trend.value = 1
        elif bar.close < previous.value:
            trend.value = -1
    previous.value = bar.close
    ctx.plot("Trend", trend.value)
    ctx.plot("Index", ctx.bar_index)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    assert _line_values(incremental, "trend") == batch.values("Trend")
    assert _line_values(incremental, "index") == batch.values("Index")


def test_incremental_state_collection_history_snapshots_mutation_boundary() -> None:
    script = """
indicator("Collection History", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    array_cell = ctx.state("array_values", array.new())
    map_cell = ctx.state("map_values", map.new())
    matrix_cell = ctx.state("matrix_values", matrix.new_float(1, 1, 0.0))

    previous_array = array_cell[1]
    previous_map = map_cell[1]
    previous_matrix = matrix_cell[1]

    values = array_cell.value
    levels = map_cell.value
    grid = matrix_cell.value

    array.push(values, bar.close)
    map.put(levels, str(bar.bar_index), bar.close)
    matrix.set(grid, 0, 0, bar.close)

    ctx.plot("Array Size", array.size(values))
    ctx.plot("Map Size", map.size(levels))
    ctx.plot("Matrix Cell", matrix.get(grid, 0, 0))
    ctx.plot("Previous Array Size", array.size(previous_array) if previous_array is not None else 0)
    ctx.plot("Previous Map Size", map.size(previous_map) if previous_map is not None else 0)
    ctx.plot(
        "Previous Matrix Cell",
        matrix.get(previous_matrix, 0, 0) if previous_matrix is not None else -1,
    )
    array.push(values, 99)
    ctx.plot(
        "Previous Array After Mutation",
        array.size(previous_array) if previous_array is not None else 0,
    )
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert result.ok, result.error
    assert _line_values(result, "array_size") == [1.0, 3.0, 5.0]
    assert _line_values(result, "map_size") == [1.0, 2.0, 3.0]
    assert _line_values(result, "matrix_cell") == [1.0, 2.0, 3.0]
    assert _line_values(result, "previous_array_size") == [0.0, 2.0, 4.0]
    assert _line_values(result, "previous_map_size") == [0.0, 1.0, 2.0]
    assert _line_values(result, "previous_matrix_cell") == [-1.0, 1.0, 2.0]
    assert _line_values(result, "previous_array_after_mutation") == [0.0, 2.0, 4.0]


def test_incremental_state_nested_collection_history_freezes_inner_values() -> None:
    script = """
indicator("Nested Collection History", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    outer_cell = ctx.state("outer", array.new())
    outer = outer_cell.value
    if array.size(outer) == 0:
        array.push(outer, array.new())

    previous_outer = outer_cell[1]
    previous_inner = (
        array.get(previous_outer, 0)
        if previous_outer is not None and array.size(previous_outer) > 0
        else None
    )
    current_inner = array.get(outer, 0)

    ctx.plot(
        "Previous Inner Before Mutation",
        array.size(previous_inner) if previous_inner is not None else 0,
    )
    array.push(current_inner, bar.close)
    ctx.plot("Current Inner", array.size(current_inner))
    ctx.plot(
        "Previous Inner After Mutation",
        array.size(previous_inner) if previous_inner is not None else 0,
    )
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert result.ok, result.error
    assert _line_values(result, "previous_inner_before_mutation") == [0.0, 1.0, 2.0]
    assert _line_values(result, "current_inner") == [1.0, 2.0, 3.0]
    assert _line_values(result, "previous_inner_after_mutation") == [0.0, 1.0, 2.0]


def test_incremental_ta_helpers_match_batch_committed_bars() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 3, "low": 1, "close": 2.0, "volume": 100},
        {"time": 3, "open": 1, "high": 4, "low": 1, "close": 3.0, "volume": 100},
        {"time": 4, "open": 1, "high": 5, "low": 1, "close": 4.0, "volume": 100},
        {"time": 5, "open": 1, "high": 6, "low": 1, "close": 5.0, "volume": 100},
    ]
    batch_script = """
plot(ta.sma(close, 3), "SMA")
plot(ta.ema(close, 3), "EMA")
"""
    incremental_script = """
indicator("Incremental TA Parity", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.sma("sma", period=3)
    ctx.ta.ema("ema", period=3)

def on_bar(ctx, bar):
    ctx.plot("SMA", ctx.ta.sma("sma").update(bar.close))
    ctx.plot("EMA", ctx.ta.ema("ema").update(bar.close))
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    assert _line_values(incremental, "sma") == batch.values("SMA")
    assert _line_values(incremental, "ema") == batch.values("EMA")


def test_incremental_preview_barstate_does_not_persist() -> None:
    script = """
indicator("Preview", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    seen = ctx.state("seen", 0)
    seen.value += 1
    ctx.plot("Seen", seen.value)
    ctx.marker(ctx.barstate.isconfirmed, text="Confirmed")

def on_preview(ctx, bar):
    seen = ctx.state("seen", 0)
    seen.value += 100
    ctx.plot("PreviewSeen", seen.value)
    ctx.plot("PreviewIndex", ctx.bar_index)
    ctx.marker(ctx.barstate.isrealtime, text="Realtime")
    ctx.marker(ctx.barstate.isnew, text="New")
    ctx.marker(not ctx.barstate.isconfirmed, text="Unconfirmed")
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    seed = session.seed(_bars()[:2])
    first_preview = session.on_bar_updated(
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 2.5, "volume": 100}
    )
    second_preview = session.on_bar_updated(
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 2.75, "volume": 100}
    )
    snapshot = session.snapshot_result()

    assert _line_values(seed, "seen") == [1.0, 2.0]
    assert _line_values(first_preview, "previewseen") == [102.0]
    assert _line_values(first_preview, "previewindex") == [2.0]
    assert _marker_times(first_preview, "realtime") == [3]
    assert _marker_times(first_preview, "new") == [3]
    assert _marker_times(first_preview, "unconfirmed") == [3]
    assert _line_values(second_preview, "previewseen") == [102.0]
    assert _marker_times(second_preview, "new") == []
    assert _line_values(snapshot, "seen") == [1.0, 2.0]
    assert snapshot.meta["bar_index"] == 1


def test_incremental_closed_bar_after_preview_is_confirmed_without_preview_state() -> None:
    script = """
indicator("Closed", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    seen = ctx.state("seen", 0)
    seen.value += 1
    ctx.plot("Seen", seen.value)
    ctx.plot("BarIndex", bar.bar_index)
    ctx.marker(ctx.barstate.isconfirmed, text="Confirmed")
    ctx.marker(ctx.barstate.isrealtime, text="Realtime")
    ctx.marker(ctx.barstate.isnew, text="New")

def on_preview(ctx, bar):
    seen = ctx.state("seen", 0)
    seen.value += 100
    ctx.plot("PreviewSeen", seen.value)
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    session.seed(_bars()[:2])
    session.on_bar_updated({"time": 3, "open": 1, "high": 3, "low": 1, "close": 2.5, "volume": 100})
    closed = session.on_bar_closed({"time": 3, "open": 1, "high": 3, "low": 1, "close": 3.0, "volume": 100})
    snapshot = session.snapshot_result()

    assert _line_values(closed, "seen") == [3.0]
    assert _line_values(closed, "barindex") == [2.0]
    assert _marker_times(closed, "confirmed") == [3]
    assert _marker_times(closed, "realtime") == [3]
    assert _marker_times(closed, "new") == []
    assert _line_values(snapshot, "seen") == [1.0, 2.0, 3.0]
    assert snapshot.meta["bar_index"] == 2
    assert snapshot.meta["barstate"]["isconfirmed"] is True


def test_incremental_varip_persists_within_preview_bar_only() -> None:
    script = """
indicator("Varip Preview", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    ticks = ctx.varip("ticks", 0)
    ticks.value += 1
    state = ctx.state("confirmed", 0)
    state.value += 1
    ctx.plot("Committed Varip", ticks.value)
    ctx.plot("Confirmed State", state.value)

def on_preview(ctx, bar):
    ticks = ctx.varip("ticks", 0)
    ticks.value += 1
    state = ctx.state("confirmed", 0)
    state.value += 100
    ctx.plot("Preview Varip", ticks.value)
    ctx.plot("Preview State", state.value)
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    seed = session.seed(_bars()[:2])
    first_preview = session.on_bar_updated(
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 2.5, "volume": 100}
    )
    second_preview = session.on_bar_updated(
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 2.75, "volume": 100}
    )
    next_preview = session.on_bar_updated(
        {"time": 4, "open": 1, "high": 4, "low": 1, "close": 3.5, "volume": 100}
    )
    closed = session.on_bar_closed(
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 3.0, "volume": 100}
    )
    snapshot = session.snapshot_result()

    assert _line_values(seed, "committed_varip") == [1.0, 1.0]
    assert _line_values(seed, "confirmed_state") == [1.0, 2.0]
    assert _line_values(first_preview, "preview_varip") == [1.0]
    assert _line_values(first_preview, "preview_state") == [102.0]
    assert _line_values(second_preview, "preview_varip") == [2.0]
    assert _line_values(second_preview, "preview_state") == [102.0]
    assert _line_values(next_preview, "preview_varip") == [1.0]
    assert _line_values(closed, "committed_varip") == [1.0]
    assert _line_values(closed, "confirmed_state") == [3.0]
    assert _line_values(snapshot, "committed_varip") == [1.0, 1.0, 1.0]
    assert _line_values(snapshot, "confirmed_state") == [1.0, 2.0, 3.0]


def test_incremental_global_varip_and_pyne_state_use_active_callback_context() -> None:
    script = """
indicator("Varip Namespace", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    committed = state("committed", 0)
    committed.value += 1
    direct = varip("ticks", 0)
    direct.value += 1
    namespaced = pyne.varip("namespaced", 10)
    namespaced.value += 1
    ctx.plot("Committed", committed.value)
    ctx.plot("Direct Varip", direct.value)
    ctx.plot("Namespaced Varip", namespaced.value)

def on_preview(ctx, bar):
    committed = pyne.state("committed", 0)
    committed.value += 100
    direct = varip("ticks", 0)
    direct.value += 1
    namespaced = pyne.varip("namespaced", 10)
    namespaced.value += 1
    ctx.plot("Preview Committed", committed.value)
    ctx.plot("Preview Direct Varip", direct.value)
    ctx.plot("Preview Namespaced Varip", namespaced.value)
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    seed = session.seed(_bars()[:1])
    first_preview = session.on_bar_updated(
        {"time": 2, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100}
    )
    second_preview = session.on_bar_updated(
        {"time": 2, "open": 1, "high": 2, "low": 1, "close": 1.75, "volume": 100}
    )
    closed = session.on_bar_closed(
        {"time": 2, "open": 1, "high": 2, "low": 1, "close": 2.0, "volume": 100}
    )
    snapshot = session.snapshot_result()

    assert _line_values(seed, "committed") == [1.0]
    assert _line_values(seed, "direct_varip") == [1.0]
    assert _line_values(seed, "namespaced_varip") == [11.0]
    assert _line_values(first_preview, "preview_committed") == [101.0]
    assert _line_values(first_preview, "preview_direct_varip") == [1.0]
    assert _line_values(first_preview, "preview_namespaced_varip") == [11.0]
    assert _line_values(second_preview, "preview_committed") == [101.0]
    assert _line_values(second_preview, "preview_direct_varip") == [2.0]
    assert _line_values(second_preview, "preview_namespaced_varip") == [12.0]
    assert _line_values(closed, "committed") == [2.0]
    assert _line_values(closed, "direct_varip") == [1.0]
    assert _line_values(closed, "namespaced_varip") == [11.0]
    assert _line_values(snapshot, "committed") == [1.0, 2.0]


def test_incremental_state_alias_rejects_top_level_use() -> None:
    script = """
indicator("Bad Top State", mode="incremental", overlay=True)

state("ticks", 0)

def on_bar(ctx, bar):
    ctx.plot("Close", bar.close)
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "state() can only be used inside incremental callbacks" in result.error


def test_incremental_varip_alias_rejects_init_use() -> None:
    script = """
indicator("Bad Init Varip", mode="incremental", overlay=True)

def init(ctx):
    pyne.varip("ticks", 0)

def on_bar(ctx, bar):
    ctx.plot("Close", bar.close)
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert not result.ok
    assert result.code == "PYNE_SECURITY_ERROR"
    assert "varip() can only be used inside incremental callbacks" in result.error


def test_incremental_drawing_objects_emit_events_and_snapshot() -> None:
    script = """
indicator("Incremental Objects", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    level = ctx.state("level")
    note = ctx.state("note")
    if ctx.bar_index == 0:
        level.value = line.new(ctx.bar_index, bar.close, ctx.bar_index, bar.close, color=color.orange)
        note.value = label.new(ctx.bar_index, bar.high, "start", color.green)
    elif ctx.bar_index == 1:
        line.set_xy2(level.value, ctx.bar_index, bar.high)
        label.set_text(note.value, "updated")
        label.set_xy(note.value, ctx.bar_index, bar.low)
    else:
        line.delete(level.value)
        label.delete(note.value)
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert result.ok, result.error
    assert "objects" not in result.output
    events = result.output["object_events"]
    assert [(event["action"], event["kind"], event["time"]) for event in events] == [
        ("create", "line", 1),
        ("create", "label", 1),
        ("update", "line", 2),
        ("update", "label", 2),
        ("update", "label", 2),
        ("delete", "line", 3),
        ("delete", "label", 3),
    ]
    assert events[2]["object"]["x2"] == 1
    assert events[2]["object"]["y2"] == 2
    assert events[4]["object"]["text"] == "updated"
    assert events[-1]["confirmed"] is True


def test_incremental_drawing_object_preview_does_not_persist() -> None:
    script = """
indicator("Preview Objects", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    level = ctx.state("level")
    if level.value is None:
        level.value = line.new(ctx.bar_index, bar.close, ctx.bar_index, bar.close, color=color.orange)
    else:
        line.set_xy2(level.value, ctx.bar_index, bar.close)

def on_preview(ctx, bar):
    level = ctx.state("level")
    line.set_color(level.value, color.red)
    line.set_xy2(level.value, ctx.bar_index, bar.close)
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    seed = session.seed(_bars()[:1])
    preview = session.on_bar_updated({"time": 2, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100})
    snapshot = session.snapshot_result()
    closed = session.on_bar_closed({"time": 2, "open": 1, "high": 2, "low": 1, "close": 2.0, "volume": 100})

    assert seed.output["objects"]["lines"][0]["color"] == "#f59e0b"
    assert preview.output["objects"]["lines"][0]["color"] == "#ef5350"
    assert preview.output["object_events"][0]["action"] == "update"
    assert preview.output["object_events"][0]["confirmed"] is False
    assert snapshot.output["objects"]["lines"][0]["color"] == "#f59e0b"
    assert snapshot.output["objects"]["lines"][0]["x2"] == 0
    assert closed.output["objects"]["lines"][0]["color"] == "#f59e0b"
    assert closed.output["objects"]["lines"][0]["x2"] == 1
    assert closed.output["object_events"][0]["confirmed"] is True


def test_incremental_preview_created_drawing_object_is_temporary() -> None:
    script = """
indicator("Preview Created Object", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    level = ctx.state("level")
    if level.value is None:
        level.value = line.new(ctx.bar_index, bar.close, ctx.bar_index, bar.close, color=color.orange)
    else:
        line.set_xy2(level.value, ctx.bar_index, bar.close)

def on_preview(ctx, bar):
    label.new(ctx.bar_index, bar.high, text="preview", color=color.red)
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    seed = session.seed(_bars()[:1])
    preview = session.on_bar_updated({"time": 2, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100})
    snapshot = session.snapshot_result()
    closed = session.on_bar_closed({"time": 2, "open": 1, "high": 2, "low": 1, "close": 2.0, "volume": 100})

    assert len(seed.output["objects"]["lines"]) == 1
    assert "labels" not in seed.output["objects"]
    assert preview.output["objects"]["labels"][0]["text"] == "preview"
    assert preview.output["object_events"] == [
        {
            "action": "create",
            "kind": "label",
            "id": "label_2",
            "object": preview.output["objects"]["labels"][0],
            "time": 2,
            "bar_index": 1,
            "confirmed": False,
            "realtime": True,
        }
    ]
    assert "labels" not in snapshot.output["objects"]
    assert snapshot.output["objects"]["lines"][0]["x2"] == 0
    assert "labels" not in closed.output["objects"]
    assert closed.output["objects"]["lines"][0]["x2"] == 1
    assert closed.output["object_events"][0]["kind"] == "line"
    assert closed.output["object_events"][0]["confirmed"] is True


def test_incremental_strategy_preview_fill_does_not_persist_until_confirmed() -> None:
    script = """
indicator("Preview Strategy", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Confirmed", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)

def on_preview(ctx, bar):
    ctx.strategy.entry("Preview", ctx.strategy.long, qty=1, price=bar.close)
    ctx.plot("Preview Position", ctx.strategy.position_size)
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    seed = session.seed(_bars()[:1])
    preview = session.on_bar_updated({"time": 2, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100})
    snapshot = session.snapshot_result()
    closed = session.on_bar_closed({"time": 2, "open": 1, "high": 2, "low": 1, "close": 2.0, "volume": 100})

    assert _line_values(seed, "position") == [0.0]
    assert _line_values(preview, "preview_position") == [1.0]
    assert preview.output["strategy"]["position"]["size"] == 1.0
    assert preview.output["strategy"]["orders"][0]["id"] == "Preview"
    assert _line_values(snapshot, "position") == [0.0]
    assert "strategy" not in snapshot.output
    assert _line_values(closed, "position") == [1.0]
    assert closed.output["strategy"]["position"]["size"] == 1.0
    assert closed.output["strategy"]["orders"][0]["id"] == "Confirmed"
    assert closed.output["strategy"]["opentrades"][0]["entry_price"] == 2.0


def test_incremental_strategy_preview_pending_order_does_not_persist() -> None:
    script = """
indicator("Preview Pending Strategy", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("ConfirmedPending", ctx.strategy.long, qty=1, stop=3.0, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)

def on_preview(ctx, bar):
    ctx.strategy.entry("PreviewPending", ctx.strategy.long, qty=1, stop=3.0)
    ctx.plot("Preview Position", ctx.strategy.position_size)
"""
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )

    seed = session.seed(_bars()[:1])
    preview = session.on_bar_updated({"time": 2, "open": 1, "high": 2.0, "low": 1, "close": 1.5, "volume": 100})
    snapshot = session.snapshot_result()
    closed = session.on_bar_closed({"time": 2, "open": 1, "high": 2.0, "low": 1, "close": 2.0, "volume": 100})
    triggered = session.on_bar_closed({"time": 3, "open": 2, "high": 3.5, "low": 2, "close": 3.0, "volume": 100})

    assert _line_values(seed, "position") == [0.0]
    assert _line_values(preview, "preview_position") == [0.0]
    assert preview.output["strategy"]["orders"] == []
    assert preview.output["strategy"]["lifecycle"][0]["id"] == "PreviewPending"
    assert preview.output["strategy"]["lifecycle"][0]["status"] == "pending"
    assert _line_values(snapshot, "position") == [0.0]
    assert "strategy" not in snapshot.output
    assert closed.output["strategy"]["orders"] == []
    assert closed.output["strategy"]["lifecycle"][0]["id"] == "ConfirmedPending"
    assert closed.output["strategy"]["lifecycle"][0]["status"] == "pending"
    assert triggered.output["strategy"]["orders"][0]["id"] == "ConfirmedPending"
    assert triggered.output["strategy"]["lifecycle"][0]["id"] == "ConfirmedPending"
    assert triggered.output["strategy"]["lifecycle"][0]["phase"] == "pending_fill"
    assert triggered.output["strategy"]["opentrades"][0]["entry_id"] == "ConfirmedPending"


def test_incremental_box_and_table_objects_emit_events() -> None:
    script = """
indicator("Incremental Box Table", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    zone = ctx.state("zone")
    summary = ctx.state("summary")
    if ctx.bar_index == 0:
        zone.value = box.new(ctx.bar_index, bar.high, ctx.bar_index, bar.low, bgcolor=color.green)
        summary.value = table.new(position.top_right, 1, 1)
        table.cell(summary.value, 0, 0, "start", text_halign=text.align_left)
    else:
        box.set_rightbottom(zone.value, ctx.bar_index, bar.low)
        table.cell(summary.value, 0, 0, bar.close, text_halign=text.align_right)
"""

    result = pn.run(script, _bars()[:2], executor_mode="inline")

    assert result.ok, result.error
    objects = result.output["objects"]
    assert objects["boxes"][0]["right"] == 1
    assert objects["boxes"][0]["bottom"] == 1
    assert objects["tables"][0]["cells"][0]["text"] == "2.0"
    assert objects["tables"][0]["cells"][0]["text_halign"] == "right"
    assert [(event["action"], event["kind"]) for event in result.output["object_events"]] == [
        ("create", "box"),
        ("create", "table"),
        ("update", "table"),
        ("update", "box"),
        ("update", "table"),
    ]


def test_incremental_drawing_object_limit_is_enforced() -> None:
    script = """
indicator("Incremental Object Limit", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    line.new(ctx.bar_index, bar.close, ctx.bar_index, bar.high)
    label.new(ctx.bar_index, bar.high, text="too much")
"""

    result = pn.run(
        script,
        _bars()[:1],
        settings=pn.PyneSettings(max_drawing_objects=1),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "Drawing object limit exceeded" in str(result.error)


def test_incremental_strategy_entry_close_matches_batch_series_and_report() -> None:
    batch_script = """
strategy("Batch Basic", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=2, price=close)
strategy.close("A", when=bar_index == 2, qty=1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Basic", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("A", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.close("A", qty=1, price=bar.close, when=ctx.bar_index == 2)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, _bars(), executor_mode="inline")
    incremental = pn.run(incremental_script, _bars(), executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_short_partial_close_matches_batch_report() -> None:
    bars = [
        *_bars(),
        {"time": 4, "open": 1, "high": 4, "low": 1, "close": 4.0, "volume": 100},
    ]
    batch_script = """
strategy("Short Partial", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "S", strategy.short, qty=3, price=close)
strategy.close("S", when=bar_index == 2, qty_percent=50, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Short Partial", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("S", ctx.strategy.short, qty=3, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.close("S", qty_percent=50, price=bar.close, when=ctx.bar_index == 2)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_reverse_entry_matches_batch_report() -> None:
    bars = [
        *_bars(),
        {"time": 4, "open": 1, "high": 4, "low": 1, "close": 4.0, "volume": 100},
    ]
    batch_script = """
strategy("Reverse", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "L", strategy.long, qty=2, price=close)
strategy.entry_when(bar_index == 2, "S", strategy.short, qty=3, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Reverse", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("L", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.entry("S", ctx.strategy.short, qty=3, price=bar.close, when=ctx.bar_index == 2)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_pending_stop_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 1.5, "low": 0.9, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2.4, "low": 1.0, "close": 2.0, "volume": 100},
        {"time": 3, "open": 2, "high": 3.0, "low": 2.0, "close": 3.0, "volume": 100},
        {"time": 4, "open": 3, "high": 3.2, "low": 2.8, "close": 3.0, "volume": 100},
    ]
    batch_script = """
strategy("Pending Stop", overlay=True, initial_capital=1000)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=2.5)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Pending Stop", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=2.5)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_pending_short_limit_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 1.5, "low": 0.9, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2.4, "low": 1.0, "close": 2.0, "volume": 100},
        {"time": 3, "open": 2, "high": 3.0, "low": 2.0, "close": 3.0, "volume": 100},
        {"time": 4, "open": 3, "high": 3.2, "low": 2.8, "close": 3.0, "volume": 100},
    ]
    batch_script = """
strategy("Short Limit", overlay=True, initial_capital=1000)
strategy.entry("Fade", strategy.short, qty=1, when=bar_index == 0, limit=2.7)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Short Limit", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Fade", ctx.strategy.short, qty=1, when=ctx.bar_index == 0, limit=2.7)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_unfilled_pending_order_matches_batch_lifecycle() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 1.5, "low": 0.9, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2.4, "low": 1.0, "close": 2.0, "volume": 100},
        {"time": 3, "open": 2, "high": 3.0, "low": 2.0, "close": 3.0, "volume": 100},
        {"time": 4, "open": 3, "high": 3.2, "low": 2.8, "close": 3.0, "volume": 100},
    ]
    batch_script = """
strategy("Pending", overlay=True, initial_capital=1000)
strategy.entry("Never", strategy.long, qty=1, when=bar_index == 0, stop=9)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Pending", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Never", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=9)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_cancel_matches_batch_lifecycle() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 1.5, "low": 0.9, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2.4, "low": 1.0, "close": 2.0, "volume": 100},
        {"time": 3, "open": 2, "high": 3.0, "low": 2.0, "close": 3.0, "volume": 100},
    ]
    batch_script = """
strategy("Cancel", overlay=True, initial_capital=1000)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=9)
strategy.cancel("Breakout", when=bar_index == 1, comment="No trade")
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Cancel", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=9)
    ctx.strategy.cancel("Breakout", when=ctx.bar_index == 1, comment="No trade")
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_cancel_all_matches_batch_lifecycle() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 1.5, "low": 0.9, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2.4, "low": 1.0, "close": 2.0, "volume": 100},
        {"time": 3, "open": 2, "high": 3.0, "low": 2.0, "close": 3.0, "volume": 100},
    ]
    batch_script = """
strategy("Cancel All", overlay=True, initial_capital=1000)
strategy.entry("A", strategy.long, qty=1, when=bar_index == 0, stop=9)
strategy.entry("B", strategy.short, qty=1, when=bar_index == 0, limit=9)
strategy.cancel_all(when=bar_index == 1, comment="Flat")
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Cancel All", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("A", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=9)
    ctx.strategy.entry("B", ctx.strategy.short, qty=1, when=ctx.bar_index == 0, limit=9)
    ctx.strategy.cancel_all(when=ctx.bar_index == 1, comment="Flat")
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_oca_cancel_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2.0, "low": 1.0, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 2.2, "low": 1.0, "close": 1.0, "volume": 120},
        {"time": 3, "open": 2, "high": 3.0, "low": 1.8, "close": 2.8, "volume": 140},
        {"time": 4, "open": 3, "high": 3.2, "low": 2.0, "close": 2.4, "volume": 160},
    ]
    batch_script = """
strategy("OCA", overlay=True, initial_capital=1000)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=2.5, oca_name="bracket", oca_type=strategy.oca.cancel)
strategy.order("Fade", strategy.short, qty=1, when=bar_index == 0, limit=2.7, oca_name="bracket", oca_type=strategy.oca.cancel)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental OCA", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=2.5, oca_name="bracket", oca_type=ctx.strategy.oca.cancel)
    ctx.strategy.order("Fade", ctx.strategy.short, qty=1, when=ctx.bar_index == 0, limit=2.7, oca_name="bracket", oca_type=ctx.strategy.oca.cancel)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_oca_reduce_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2.0, "low": 1.0, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 2.2, "low": 1.0, "close": 1.0, "volume": 120},
        {"time": 3, "open": 2, "high": 3.0, "low": 1.8, "close": 2.8, "volume": 140},
        {"time": 4, "open": 3, "high": 3.2, "low": 2.0, "close": 2.4, "volume": 160},
    ]
    batch_script = """
strategy("OCA Reduce", overlay=True, initial_capital=1000)
strategy.entry("First", strategy.long, qty=1, when=bar_index == 0, stop=2.5, oca_name="scale", oca_type=strategy.oca.reduce)
strategy.order("Second", strategy.long, qty=2, when=bar_index == 0, stop=3.1, oca_name="scale", oca_type=strategy.oca.reduce)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental OCA Reduce", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("First", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=2.5, oca_name="scale", oca_type=ctx.strategy.oca.reduce)
    ctx.strategy.order("Second", ctx.strategy.long, qty=2, when=ctx.bar_index == 0, stop=3.1, oca_name="scale", oca_type=ctx.strategy.oca.reduce)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_limit_verification_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 3, "high": 3.1, "low": 2.8, "close": 3.0, "volume": 100},
        {"time": 2, "open": 3, "high": 3.1, "low": 2.65, "close": 2.9, "volume": 100},
        {"time": 3, "open": 2.9, "high": 3.0, "low": 2.59, "close": 2.8, "volume": 100},
    ]
    batch_script = """
strategy("Limit Verify", overlay=True, initial_capital=1000, mintick=0.1, backtest_fill_limits_assumption=1)
strategy.entry("Pullback", strategy.long, qty=1, when=bar_index == 0, limit=2.7)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Limit Verify", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000, mintick=0.1, backtest_fill_limits_assumption=1)

def on_bar(ctx, bar):
    ctx.strategy.entry("Pullback", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, limit=2.7)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_same_bar_stop_first_matches_batch_report() -> None:
    bars = [{"time": 1, "open": 10, "high": 13, "low": 7, "close": 10.0, "volume": 100}]
    batch_script = """
strategy("Same Bar Pending", overlay=True, initial_capital=1000)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Same Bar", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=12, limit=8)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_same_bar_limit_first_matches_batch_report() -> None:
    bars = [{"time": 1, "open": 10, "high": 13, "low": 7, "close": 10.0, "volume": 100}]
    batch_script = """
strategy("Same Bar Pending", overlay=True, initial_capital=1000, same_bar_fill_priority=strategy.same_bar.limit_first)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Same Bar Limit", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000, same_bar_fill_priority=ctx.strategy.same_bar.limit_first)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=12, limit=8)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_intrabar_high_first_matches_batch_report() -> None:
    bars = [{"time": 1, "open": 10, "high": 13, "low": 7, "close": 10.0, "volume": 100}]
    batch_script = """
strategy("Path Pending", overlay=True, initial_capital=1000, intrabar_path=strategy.intrabar.open_high_low_close)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Path High", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000, intrabar_path=ctx.strategy.intrabar.open_high_low_close)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=12, limit=8)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_intrabar_low_first_matches_batch_report() -> None:
    bars = [{"time": 1, "open": 10, "high": 13, "low": 7, "close": 10.0, "volume": 100}]
    batch_script = """
strategy("Path Pending", overlay=True, initial_capital=1000, intrabar_path=strategy.intrabar.open_low_high_close)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Path Low", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000, intrabar_path=ctx.strategy.intrabar.open_low_high_close)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=12, limit=8)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_limit_exit_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 2.2, "low": 1, "close": 1.0, "volume": 120},
        {"time": 3, "open": 2, "high": 3, "low": 1.8, "close": 2.8, "volume": 140},
        {"time": 4, "open": 3, "high": 3.2, "low": 2, "close": 2.4, "volume": 160},
    ]
    batch_script = """
strategy("Limit Exit", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Take Profit", from_entry="Long", limit=2.7, stop=0.8)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Limit Exit", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Take Profit", from_entry="Long", limit=2.7, stop=0.8)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_short_stop_exit_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 2.2, "low": 1, "close": 1.0, "volume": 120},
        {"time": 3, "open": 2, "high": 3, "low": 1.8, "close": 2.8, "volume": 140},
        {"time": 4, "open": 3, "high": 3.2, "low": 2, "close": 2.4, "volume": 160},
    ]
    batch_script = """
strategy("Short Stop", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Short", strategy.short, qty=2, price=close)
strategy.exit("Stop", from_entry="Short", stop=2.1)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Short Stop Exit", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Short", ctx.strategy.short, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Stop", from_entry="Short", stop=2.1)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_partial_exit_qty_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 2.2, "low": 1, "close": 1.0, "volume": 120},
        {"time": 3, "open": 2, "high": 3, "low": 1.8, "close": 2.8, "volume": 140},
        {"time": 4, "open": 3, "high": 3.2, "low": 2, "close": 2.4, "volume": 160},
    ]
    batch_script = """
strategy("Partial Exit", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=2, price=close)
strategy.exit("Take Some", from_entry="Long", qty=0.5, limit=2.7, when=bar_index == 2)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Partial Exit", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Take Some", from_entry="Long", qty=0.5, limit=2.7, when=ctx.bar_index == 2)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_partial_exit_percent_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        {"time": 2, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 100},
        {"time": 3, "open": 11, "high": 13, "low": 10, "close": 12, "volume": 100},
    ]
    batch_script = """
strategy("Exit Percent", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=2, price=close)
strategy.exit("Exit A Half", from_entry="A", qty_percent=50, limit=12, when=bar_index == 1)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Exit Percent", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("A", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Exit A Half", from_entry="A", qty_percent=50, limit=12, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_exit_same_bar_limit_first_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 10, "high": 10.5, "low": 9.5, "close": 10, "volume": 100},
        {"time": 2, "open": 10, "high": 13, "low": 8, "close": 11, "volume": 100},
    ]
    batch_script = """
strategy("Same Bar Exit", overlay=True, initial_capital=1000)
strategy.configure(same_bar_fill_priority=strategy.same_bar.limit_first)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Bracket", from_entry="Long", stop=9, limit=12)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Same Bar Exit", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000, same_bar_fill_priority=ctx.strategy.same_bar.limit_first)

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Bracket", from_entry="Long", stop=9, limit=12)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_market_costs_match_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2, "low": 1, "close": 2.0, "volume": 100},
        {"time": 3, "open": 1, "high": 3, "low": 1, "close": 3.0, "volume": 100},
    ]
    batch_script = """
strategy("Market Costs", overlay=True, initial_capital=1000, slippage=1, mintick=0.1, commission_type=strategy.commission.cash_per_contract, commission_value=0.5)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=2, price=close)
strategy.close("Long", when=bar_index == 2, qty=1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Market Costs", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(
        initial_capital=1000,
        slippage=1,
        mintick=0.1,
        commission_type=ctx.strategy.commission.cash_per_contract,
        commission_value=0.5,
    )

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.close("Long", qty=1, price=bar.close, when=ctx.bar_index == 2)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_pending_costs_match_batch_report() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 1.5, "low": 0.9, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2.4, "low": 1.0, "close": 2.0, "volume": 100},
        {"time": 3, "open": 2, "high": 3.0, "low": 2.0, "close": 3.0, "volume": 100},
    ]
    batch_script = """
strategy("Pending Costs", overlay=True, initial_capital=1000, slippage=1, mintick=0.1, commission_type=strategy.commission.percent, commission_value=1)
strategy.entry("Breakout", strategy.long, qty=2, when=bar_index == 0, stop=2.5)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Pending Costs", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(
        initial_capital=1000,
        slippage=1,
        mintick=0.1,
        commission_type=ctx.strategy.commission.percent,
        commission_value=1,
    )

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=2, when=ctx.bar_index == 0, stop=2.5)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_exit_costs_match_batch_report() -> None:
    bars = [
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        {"time": 2, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 100},
        {"time": 3, "open": 11, "high": 13, "low": 10, "close": 12, "volume": 100},
    ]
    batch_script = """
strategy("Exit Costs", overlay=True, initial_capital=1000, slippage=1, mintick=0.1, commission_type=strategy.commission.cash_per_order, commission_value=1)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=2, price=close)
strategy.exit("Half", from_entry="Long", qty_percent=50, limit=12, when=bar_index == 1)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Exit Costs", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(
        initial_capital=1000,
        slippage=1,
        mintick=0.1,
        commission_type=ctx.strategy.commission.cash_per_order,
        commission_value=1,
    )

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Half", from_entry="Long", qty_percent=50, limit=12, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_one_shot_exit_persists_until_later_bar() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 2.2, "low": 1, "close": 1.0, "volume": 120},
        {"time": 3, "open": 2, "high": 3, "low": 1.8, "close": 2.8, "volume": 140},
        {"time": 4, "open": 3, "high": 3.2, "low": 2, "close": 2.4, "volume": 160},
    ]
    batch_script = """
strategy("Persistent Exit", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Take Profit", from_entry="Long", limit=2.7, stop=0.8)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Persistent Exit", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Take Profit", from_entry="Long", limit=2.7, stop=0.8, when=ctx.bar_index == 0)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_one_shot_exit_preserves_cost_parity() -> None:
    bars = [
        {"time": 1, "open": 10, "high": 10.2, "low": 9.8, "close": 10, "volume": 100},
        {"time": 2, "open": 10, "high": 11.1, "low": 10, "close": 10.5, "volume": 100},
        {"time": 3, "open": 10.5, "high": 11.25, "low": 10.2, "close": 11, "volume": 100},
    ]
    batch_script = """
strategy("Persistent Exit Costs", overlay=True, initial_capital=1000, mintick=0.1, slippage=1, backtest_fill_limits_assumption=2, commission_type=strategy.commission.cash_per_order, commission_value=0.5)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Take", from_entry="Long", limit=11)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Persistent Exit Costs", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(
        initial_capital=1000,
        mintick=0.1,
        slippage=1,
        backtest_fill_limits_assumption=2,
        commission_type=ctx.strategy.commission.cash_per_order,
        commission_value=0.5,
    )

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.exit("Take", from_entry="Long", limit=11, when=ctx.bar_index == 0)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_trade_accessors_expose_scalar_ledgers() -> None:
    script = """
indicator("Incremental Trade Accessors", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(
        initial_capital=1000,
        pyramiding=2,
        commission_type=ctx.strategy.commission.cash_per_contract,
        commission_value=0.25,
    )

def on_bar(ctx, bar):
    ctx.strategy.entry(
        "A",
        ctx.strategy.long,
        qty=1,
        price=bar.close,
        when=ctx.bar_index == 0,
        comment="alpha",
    )
    ctx.strategy.entry(
        "B",
        ctx.strategy.long,
        qty=2,
        price=bar.close,
        when=ctx.bar_index == 1,
        comment="beta",
    )
    ctx.strategy.close("A", price=bar.close, when=ctx.bar_index == 2, comment="done")
    ctx.plot("Closed Count", ctx.strategy.closedtrades)
    ctx.plot("Open Count", ctx.strategy.opentrades.count)
    ctx.plot("Closed Profit", ctx.strategy.closedtrades.profit(0))
    ctx.plot("Closed Profit Percent", ctx.strategy.closedtrades.profit_percent(0))
    ctx.plot("Closed Commission", ctx.strategy.closedtrades.commission(0))
    ctx.plot("Closed Net", ctx.strategy.closedtrades.net_profit(0))
    ctx.plot("Open Entry", ctx.strategy.opentrades.entry_price(0))
    ctx.plot("Open Profit", ctx.strategy.opentrades.profit(0))
    ctx.plot("Open Profit Percent", ctx.strategy.opentrades.profit_percent(0))
    ctx.plot("Closed Id Match", 1 if ctx.strategy.closedtrades.entry_id(0) == "A" else 0)
    ctx.plot("Open Id Match", 1 if ctx.strategy.opentrades.entry_id(0) == "B" else 0)
    ctx.plot("Latest Open Size", ctx.strategy.opentrades.size(-1))
    ctx.plot(
        "Closed Entry Comment",
        1 if ctx.strategy.closedtrades.entry_comment(0) == "alpha" else 0,
    )
    ctx.plot(
        "Closed Exit Comment",
        1 if ctx.strategy.closedtrades.exit_comment(0) == "done" else 0,
    )
    ctx.plot(
        "Open Entry Comment",
        1 if ctx.strategy.opentrades.entry_comment(0) == "beta" else 0,
    )
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert result.ok
    assert _line_values(result, "closed_count") == [0.0, 0.0, 1.0]
    assert _line_values(result, "open_count") == [1.0, 2.0, 1.0]
    assert _line_values(result, "closed_profit") == [0.0, 0.0, 2.0]
    assert _line_values(result, "closed_profit_percent") == [0.0, 0.0, 200.0]
    assert _line_values(result, "closed_commission") == [0.0, 0.0, 0.5]
    assert _line_values(result, "closed_net") == [0.0, 0.0, 1.5]
    assert _line_values(result, "open_entry") == [1.0, 1.0, 2.0]
    assert _line_values(result, "open_profit") == [0.0, 1.0, 2.0]
    assert _line_values(result, "open_profit_percent") == [0.0, 100.0, 50.0]
    assert _line_values(result, "closed_id_match") == [0.0, 0.0, 1.0]
    assert _line_values(result, "open_id_match") == [0.0, 0.0, 1.0]
    assert _line_values(result, "latest_open_size") == [1.0, 2.0, 2.0]
    assert _line_values(result, "closed_entry_comment") == [0.0, 0.0, 1.0]
    assert _line_values(result, "closed_exit_comment") == [0.0, 0.0, 1.0]
    assert _line_values(result, "open_entry_comment") == [0.0, 0.0, 1.0]
    assert result.output["strategy"]["closedtrades"][0]["entry_comment"] == "alpha"
    assert result.output["strategy"]["closedtrades"][0]["exit_comment"] == "done"
    assert result.output["strategy"]["opentrades"][0]["entry_comment"] == "beta"


def test_incremental_strategy_margin_reject_costs_match_batch_report() -> None:
    bars = [
        {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
        {"time": 2, "open": 105, "high": 106, "low": 104, "close": 105, "volume": 100},
    ]
    batch_script = """
strategy("Margin Cost", overlay=True, initial_capital=1000, margin_long=100, commission_type=strategy.commission.cash_per_order, commission_value=1)
strategy.entry_when(bar_index == 0, "Too Big", strategy.long, qty=20, price=close)
strategy.entry_when(bar_index == 0, "Small", strategy.long, qty=5, price=close)
strategy.close_all(when=bar_index == 1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Margin Cost", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(
        initial_capital=1000,
        margin_long=100,
        commission_type=ctx.strategy.commission.cash_per_order,
        commission_value=1,
    )

def on_bar(ctx, bar):
    ctx.strategy.entry("Too Big", ctx.strategy.long, qty=20, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.entry("Small", ctx.strategy.long, qty=5, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.close_all(price=bar.close, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_default_margin_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
        {"time": 2, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
    ]
    batch_script = """
strategy("Default Margin", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "High Notional", strategy.long, qty=20, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Default Margin", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("High Notional", ctx.strategy.long, qty=20, price=bar.close, when=ctx.bar_index == 0)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_pending_margin_stays_pending_like_batch() -> None:
    bars = [
        {"time": 1, "open": 100, "high": 120, "low": 99, "close": 100, "volume": 100},
        {"time": 2, "open": 100, "high": 121, "low": 99, "close": 100, "volume": 100},
    ]
    batch_script = """
strategy("Pending Margin", overlay=True, initial_capital=1000, margin_long=100)
strategy.entry("Breakout", strategy.long, qty=11, when=bar_index == 0, stop=110)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Pending Margin", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000, margin_long=100)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=11, when=ctx.bar_index == 0, stop=110)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_order_partial_reduction_matches_batch_report() -> None:
    batch_script = """
strategy("Order Reduce", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=5, price=close)
strategy.order_when(bar_index == 1, "Reduce", strategy.short, qty=2, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Order Reduce", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=5, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.order("Reduce", ctx.strategy.short, qty=2, price=bar.close, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, _bars(), executor_mode="inline")
    incremental = pn.run(incremental_script, _bars(), executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_risk_allow_entry_in_matches_batch_report() -> None:
    batch_script = """
strategy("Risk Direction", overlay=True)
strategy.risk.allow_entry_in(strategy.direction.long)
strategy.entry_when(bar_index == 0, "Short", strategy.short, qty=1, price=close)
strategy.entry_when(bar_index == 1, "Long", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Risk Direction", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.risk.allow_entry_in(ctx.strategy.direction.long)

def on_bar(ctx, bar):
    ctx.strategy.entry("Short", ctx.strategy.short, qty=1, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.entry("Long", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, _bars(), executor_mode="inline")
    incremental = pn.run(incremental_script, _bars(), executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_risk_max_position_size_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
    ]
    batch_script = """
strategy("Risk Position Size", overlay=True, initial_capital=1000, pyramiding=2)
strategy.risk.max_position_size(3)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=5, price=close)
strategy.entry_when(bar_index == 1, "More", strategy.long, qty=2, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Risk Position Size", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000, pyramiding=2)
    ctx.strategy.risk.max_position_size(3)

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=5, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.entry("More", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 1)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_risk_max_drawdown_matches_batch_report() -> None:
    bars = [
        {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
        {"time": 2, "open": 100, "high": 100, "low": 89, "close": 90, "volume": 100},
        {"time": 3, "open": 90, "high": 92, "low": 88, "close": 90, "volume": 100},
        {"time": 4, "open": 90, "high": 95, "low": 90, "close": 94, "volume": 100},
    ]
    batch_script = """
strategy("Risk Drawdown", overlay=True, initial_capital=1000)
strategy.risk.max_drawdown(5, strategy.percent_of_equity)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=10, price=close)
strategy.entry_when(bar_index == 2, "Blocked Entry", strategy.long, qty=1, price=close)
strategy.order_when(bar_index == 2, "Blocked Order", strategy.long, qty=1, price=close)
strategy.close_all(when=bar_index == 2, price=close)
strategy.order_when(bar_index == 3, "Still Blocked", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Risk Drawdown", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)
    ctx.strategy.risk.max_drawdown(5, ctx.strategy.percent_of_equity)

def on_bar(ctx, bar):
    ctx.strategy.entry("Long", ctx.strategy.long, qty=10, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.entry("Blocked Entry", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 2)
    ctx.strategy.order("Blocked Order", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 2)
    ctx.strategy.close_all(price=bar.close, when=ctx.bar_index == 2)
    ctx.strategy.order("Still Blocked", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 3)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_risk_intraday_filled_orders_reset_matches_batch_report() -> None:
    bars = [
        {
            "time": 1,
            "open": 10,
            "high": 11,
            "low": 9,
            "close": 10,
            "volume": 100,
            "session_isfirstbar": True,
        },
        {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        {
            "time": 3,
            "open": 10,
            "high": 11,
            "low": 9,
            "close": 10,
            "volume": 100,
            "session_isfirstbar": True,
        },
    ]
    batch_script = """
strategy("Risk Filled Reset", overlay=True, initial_capital=1000)
strategy.risk.max_intraday_filled_orders(1)
strategy.entry_when(bar_index == 0, "First", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 1, "Blocked", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 2, "Reset Entry", strategy.short, qty=1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
"""
    incremental_script = """
indicator("Incremental Risk Filled Reset", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)
    ctx.strategy.risk.max_intraday_filled_orders(1)

def on_bar(ctx, bar):
    ctx.strategy.entry("First", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.entry("Blocked", ctx.strategy.long, qty=1, price=bar.close, when=ctx.bar_index == 1)
    ctx.strategy.entry("Reset Entry", ctx.strategy.short, qty=1, price=bar.close, when=ctx.bar_index == 2)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    batch = pn.run(batch_script, bars, executor_mode="inline")
    incremental = pn.run(incremental_script, bars, executor_mode="inline")

    assert batch.ok
    assert incremental.ok
    _assert_full_strategy_matches_batch(incremental, batch)


def test_incremental_strategy_pending_seed_matches_closed_bar_session_snapshot() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 1.5, "low": 0.9, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2.4, "low": 1.0, "close": 2.0, "volume": 100},
        {"time": 3, "open": 2, "high": 3.0, "low": 2.0, "close": 3.0, "volume": 100},
    ]
    script = """
indicator("Incremental Pending Replay", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("Breakout", ctx.strategy.long, qty=1, when=ctx.bar_index == 0, stop=2.5)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    seeded = pn.run(script, bars, executor_mode="inline")
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )
    for bar in bars:
        session.on_bar_closed(bar)
    snapshot = session.snapshot_result()

    assert seeded.ok
    assert snapshot.output["strategy"] == seeded.output["strategy"]
    assert _line_values(snapshot, "position") == _line_values(seeded, "position")
    assert _line_values(snapshot, "equity") == _line_values(seeded, "equity")
    assert _line_values(snapshot, "net_profit") == _line_values(seeded, "net_profit")


def test_incremental_strategy_seed_matches_closed_bar_session_snapshot() -> None:
    script = """
indicator("Incremental Strategy Replay", mode="incremental", overlay=True)

def init(ctx):
    ctx.strategy.configure(initial_capital=1000)

def on_bar(ctx, bar):
    ctx.strategy.entry("A", ctx.strategy.long, qty=2, price=bar.close, when=ctx.bar_index == 0)
    ctx.strategy.close("A", qty=1, price=bar.close, when=ctx.bar_index == 2)
    ctx.plot("Position", ctx.strategy.position_size)
    ctx.plot("Equity", ctx.strategy.equity)
    ctx.plot("Net Profit", ctx.strategy.netprofit)
"""

    seeded = pn.run(script, _bars(), executor_mode="inline")
    session = pn.PyneIncrementalSession(
        script=script,
        settings=pn.PyneSettings(executor_mode="inline"),
    )
    for bar in _bars():
        session.on_bar_closed(bar)
    snapshot = session.snapshot_result()

    assert seeded.ok
    assert _line_values(snapshot, "position") == _line_values(seeded, "position")
    assert _line_values(snapshot, "equity") == _line_values(seeded, "equity")
    assert _line_values(snapshot, "net_profit") == _line_values(seeded, "net_profit")
    assert snapshot.output["strategy"] == seeded.output["strategy"]

