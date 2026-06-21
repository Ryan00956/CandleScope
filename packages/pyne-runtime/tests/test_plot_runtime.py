from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]


def test_extended_plot_outputs_are_collected() -> None:
    result = pn.run(
        """
indicator("Outputs", overlay=False)
p1 = plot(close, "Close", color=color.orange)
p2 = plot(open, "Open", color=color.blue)
fill(p1, p2, color="rgba(59,130,246,0.08)")
hline(2, "Mid")
bgcolor(close > open, color="rgba(34,197,94,0.1)")
barcolor(color.green)
emit_signal(close > open, name="up", message="Close above open")
alertcondition(close < open, title="down", message="Close below open")
label("U")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    output = result.output
    assert output["meta"]["title"] == "Outputs"
    assert len(output["fills"]) == 1
    assert len(output["hlines"]) == 1
    assert len(output["bgcolors"]) == 1
    assert len(output["barcolors"]) == 1
    assert len(output["signals"]) == 1
    assert len(output["labels"]) == 1


def test_line_and_label_objects_are_collected_and_updated() -> None:
    result = pn.run(
        """
indicator("Objects", overlay=True)
trend = line.new(
    bar_index[2],
    close[2],
    bar_index,
    close,
    color=color.orange,
    width=1,
)
line.set_color(trend, color.blue)
line.set_width(trend, 3)
line.set_xy2(trend, bar_index, high)
note = label.new(bar_index, high, text="Hi", color=color.green)
label.set_text(note, "Updated")
label.set_color(note, color.red)
label.set_xy(note, bar_index[1], low[1])
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    objects = result.output["objects"]
    assert set(objects) == {"lines", "labels"}

    line_object = objects["lines"][0]
    assert line_object["id"] == "line_1"
    assert line_object["x1"] == 0
    assert line_object["y1"] == 1.5
    assert line_object["x2"] == 2
    assert line_object["y2"] == 4
    assert line_object["color"] == "#2196f3"
    assert line_object["width"] == 3

    label_object = objects["labels"][0]
    assert label_object["id"] == "label_2"
    assert label_object["x"] == 1
    assert label_object["y"] == 1.5
    assert label_object["text"] == "Updated"
    assert label_object["color"] == "#ef5350"


def test_drawing_objects_can_be_deleted() -> None:
    result = pn.run(
        """
indicator("Deleted", overlay=True)
trend = line.new(bar_index[1], close[1], bar_index, close)
note = label.new(bar_index, high, text="gone")
line.delete(trend)
label.delete(note)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert "objects" not in result.output


def test_box_and_table_objects_are_collected_and_updated() -> None:
    result = pn.run(
        """
indicator("Box Table", overlay=True)
zone = box.new(
    bar_index[2],
    high[2],
    bar_index,
    low,
    bgcolor=color.new(color.green, 80),
    border_color=color.green,
)
box.set_rightbottom(zone, bar_index, low[1])
box.set_bgcolor(zone, color.new(color.blue, 85))
summary = table.new(position.top_right, 2, 2, bgcolor=color.white)
table.cell(summary, 0, 0, "Metric", text_color=color.black)
table.cell(summary, 1, 0, "Value", text_color=color.black)
table.cell(summary, 0, 1, "Close", text_color=color.blue)
table.cell(summary, 1, 1, close, text_color=color.green)
table.set_border_color(summary, color.blue)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    objects = result.output["objects"]
    assert set(objects) == {"boxes", "tables"}

    box_object = objects["boxes"][0]
    assert box_object["id"] == "box_1"
    assert box_object["left"] == 0
    assert box_object["top"] == 2
    assert box_object["right"] == 2
    assert box_object["bottom"] == 1.5
    assert box_object["bgcolor"] == "rgba(33,150,243,0.15)"
    assert box_object["border_color"] == "#26a69a"

    table_object = objects["tables"][0]
    assert table_object["id"] == "table_2"
    assert table_object["position"] == "top_right"
    assert table_object["columns"] == 2
    assert table_object["rows"] == 2
    assert table_object["border_color"] == "#2196f3"
    assert table_object["cells"] == [
        {
            "column": 0,
            "row": 0,
            "text": "Metric",
            "text_color": "#000000",
            "bgcolor": None,
            "width": None,
            "height": None,
            "text_halign": "center",
            "text_valign": "middle",
        },
        {
            "column": 1,
            "row": 0,
            "text": "Value",
            "text_color": "#000000",
            "bgcolor": None,
            "width": None,
            "height": None,
            "text_halign": "center",
            "text_valign": "middle",
        },
        {
            "column": 0,
            "row": 1,
            "text": "Close",
            "text_color": "#2196f3",
            "bgcolor": None,
            "width": None,
            "height": None,
            "text_halign": "center",
            "text_valign": "middle",
        },
        {
            "column": 1,
            "row": 1,
            "text": "3.5",
            "text_color": "#26a69a",
            "bgcolor": None,
            "width": None,
            "height": None,
            "text_halign": "center",
            "text_valign": "middle",
        },
    ]


def test_pine_like_plot_enum_namespaces_are_injected() -> None:
    result = pn.run(
        """
indicator("Enums", overlay=True)
marker(close > open, shape=shape.square, location=location.absolute, size=size.large)
note = label.new(bar_index, high, text="Enum", style=label.style_label_down, size=size.small)
zone = box.new(bar_index[1], high[1], bar_index, low, border_style=box.border_style_dotted)
trend = line.new(bar_index[1], close[1], bar_index, close, style=line.style_dashed)
summary = table.new(position.bottom_center, 1, 1)
table.cell(summary, 0, 0, "Aligned", text_halign=text.align_left, text_valign=text.align_top)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    marker = result.output["markers"][0]
    assert marker["shape"] == "square"
    assert marker["position"] == "absolute"
    assert marker["size"] == "large"

    objects = result.output["objects"]
    assert objects["labels"][0]["style"] == "label_down"
    assert objects["labels"][0]["size"] == "small"
    assert objects["boxes"][0]["border_style"] == "dotted"
    assert objects["lines"][0]["style"] == "dashed"
    assert objects["tables"][0]["position"] == "bottom_center"
    assert objects["tables"][0]["cells"][0]["text_halign"] == "left"
    assert objects["tables"][0]["cells"][0]["text_valign"] == "top"


def test_indicator_and_plot_display_format_scale_namespaces() -> None:
    result = pn.run(
        """
indicator("Display Enums", overlay=False, format=format.price, precision=2, scale=scale.right)
plot(close, "Hidden Close", display=display.none, format=format.volume, precision=0)
plot(volume, "Volume Columns", style=plot.style_columns, display=display.data_window)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.output["meta"] == {
        "title": "Display Enums",
        "overlay": False,
        "format": "price",
        "precision": 2,
        "scale": "right",
    }
    assert result.output["lines"][0]["display"] == "none"
    assert result.output["lines"][0]["format"] == "volume"
    assert result.output["lines"][0]["precision"] == 0
    assert result.output["histograms"][0]["display"] == "data_window"


def test_plot_color_series_is_serialized_per_point() -> None:
    result = pn.run(
        """
colors = when(close > open, color.green, color.red)
plot(close, "Close", color=colors)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    line = result.output["lines"][0]
    assert line["per_bar_color"] is True
    assert [point["color"] for point in line["data"]] == ["#26a69a", "#26a69a", "#26a69a"]


def test_xloc_and_yloc_namespaces_are_injected_for_drawing_objects() -> None:
    result = pn.run(
        """
indicator("Location Enums", overlay=True)
trend = line.new(time[1], close[1], time, close, xloc=xloc.bar_time)
zone = box.new(time[1], high[1], time, low, xloc=xloc.bar_time)
note = label.new(time, high, text="Here", xloc=xloc.bar_time, yloc=yloc.abovebar)
label.set_yloc(note, yloc.belowbar)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    objects = result.output["objects"]
    assert objects["lines"][0]["xloc"] == "bar_time"
    assert objects["boxes"][0]["xloc"] == "bar_time"
    assert objects["labels"][0]["xloc"] == "bar_time"
    assert objects["labels"][0]["yloc"] == "belowbar"


def test_plotshape_wraps_marker_output_with_pine_like_arguments() -> None:
    result = pn.run(
        """
indicator("Plotshape", overlay=True)
plotshape(
    close > open,
    title="Up",
    style=shape.triangleup,
    location=location.belowbar,
    color=color.green,
    text="B",
    textcolor=color.white,
    size=size.small,
)
plotshape(
    close,
    title="Absolute",
    style=shape.circle,
    location=location.absolute,
    offset=-1,
    show_last=2,
    display=display.all,
)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    shape_marker, absolute_marker = result.output["markers"]

    assert shape_marker["title"] == "Up"
    assert shape_marker["shape"] == "triangle_up"
    assert shape_marker["position"] == "below"
    assert shape_marker["textcolor"] == "#ffffff"
    assert len(shape_marker["data"]) == 3
    assert shape_marker["data"][0]["text"] == "B"
    assert shape_marker["data"][0]["size"] == "small"

    assert absolute_marker["title"] == "Absolute"
    assert absolute_marker["position"] == "absolute"
    assert absolute_marker["offset"] == -1
    assert absolute_marker["display"] == "all"
    assert [point["time"] for point in absolute_marker["data"]] == [1, 2]
    assert [point["value"] for point in absolute_marker["data"]] == [2.5, 3.5]


def test_plotchar_wraps_marker_output_with_character_payload() -> None:
    result = pn.run(
        """
indicator("Plotchar", overlay=True)
plotchar(
    close > open,
    title="Up Char",
    char="*",
    location=location.abovebar,
    color=color.blue,
    textcolor=color.white,
    size=size.tiny,
)
plotchar(
    close > open,
    title="Last",
    char="L",
    location=location.belowbar,
    offset=-1,
    show_last=1,
    display=display.data_window,
)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    char_marker, last_marker = result.output["markers"]

    assert char_marker["title"] == "Up Char"
    assert char_marker["shape"] == "char"
    assert char_marker["char"] == "*"
    assert char_marker["text"] == "*"
    assert char_marker["position"] == "above"
    assert char_marker["textcolor"] == "#ffffff"
    assert char_marker["data"][0]["char"] == "*"
    assert char_marker["data"][0]["size"] == "tiny"

    assert last_marker["title"] == "Last"
    assert last_marker["char"] == "L"
    assert last_marker["offset"] == -1
    assert last_marker["display"] == "data_window"
    assert [point["time"] for point in last_marker["data"]] == [2]


def test_plotarrow_maps_signed_series_to_directional_markers() -> None:
    result = pn.run(
        """
indicator("Plotarrow", overlay=True)
plotarrow(
    close - 2.5,
    title="Momentum",
    colorup=color.green,
    colordown=color.red,
    minheight=10,
    maxheight=20,
)
plotarrow(
    close - 1.5,
    title="Last Arrow",
    offset=-1,
    show_last=1,
    display=display.status_line,
)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    momentum, last_arrow = result.output["markers"]

    assert momentum["title"] == "Momentum"
    assert momentum["shape"] == "arrow"
    assert momentum["color_up"] == "#26a69a"
    assert momentum["color_down"] == "#ef5350"
    assert momentum["minheight"] == 10
    assert momentum["maxheight"] == 20
    assert [(point["time"], point["direction"]) for point in momentum["data"]] == [
        (1, "down"),
        (3, "up"),
    ]
    assert [point["shape"] for point in momentum["data"]] == ["arrow_down", "arrow_up"]
    assert [point["position"] for point in momentum["data"]] == ["above", "below"]
    assert [point["height"] for point in momentum["data"]] == [20, 20]
    assert [point["value"] for point in momentum["data"]] == [-1.0, 1.0]

    assert last_arrow["title"] == "Last Arrow"
    assert last_arrow["offset"] == -1
    assert last_arrow["display"] == "status_line"
    assert [(point["time"], point["direction"], point["value"]) for point in last_arrow["data"]] == [
        (2, "up", 2.0),
    ]


def test_box_and_table_objects_can_be_deleted() -> None:
    result = pn.run(
        """
indicator("Deleted Box Table", overlay=True)
zone = box.new(bar_index[1], high[1], bar_index, low)
summary = table.new(position.bottom_right, 1, 1)
table.cell(summary, 0, 0, "gone")
box.delete(zone)
table.delete(summary)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert "objects" not in result.output


def test_drawing_object_limit_is_enforced() -> None:
    result = pn.run(
        """
indicator("Object Limit", overlay=True)
line.new(bar_index[1], close[1], bar_index, close)
box.new(bar_index[1], high[1], bar_index, low)
""",
        _bars(),
        settings=pn.PyneSettings(max_drawing_objects=1),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_OUTPUT_LIMIT_EXCEEDED"
    assert "Drawing object limit exceeded" in str(result.error)
