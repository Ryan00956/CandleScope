indicator("Host Output Contract Demo", overlay=True)

fast = ta.sma(close, 3)
slow = ta.sma(close, 5)

fast_plot = plot(fast, "Fast SMA", color=color.orange)
slow_plot = plot(slow, "Slow SMA", color=color.blue)
fill(fast_plot, slow_plot, color=color.new(color.blue, 85), title="MA Spread")

bar(close - open, "Body", color_up=color.green, color_down=color.red, pane="separate")
hline(0, "Zero", color=color.gray, pane="separate")

plotshape(
    close > open,
    title="Close Up",
    style=shape.triangleup,
    location=location.belowbar,
    color=color.green,
    text="UP",
    size=size.small,
)

bgcolor(close > fast, color=color.new(color.green, 92), title="Above Fast")
barcolor(color.new(color.green, 75))
emit_signal(
    close > open,
    name="Close Up",
    side="buy",
    message="close above open",
    price=close,
    payload={"example": "host_output_contract"},
)
label("Host-ready output", position="topright", color=color.white, textcolor=color.black)

trend = line.new(bar_index[3], close[3], bar_index, close, color=color.orange)
line.set_width(trend, 2)

note = label.new(
    bar_index,
    high,
    text="Latest",
    color=color.new(color.blue, 70),
    textcolor=color.white,
    yloc=yloc.abovebar,
)
label.set_size(note, size.small)

zone = box.new(
    bar_index[2],
    high[2],
    bar_index,
    low,
    bgcolor=color.new(color.blue, 88),
    border_color=color.blue,
    border_style=box.border_style_dashed,
)
box.set_border_width(zone, 2)

summary = table.new(position.top_right, 2, 1, bgcolor=color.white)
table.cell(summary, 0, 0, "schema", text_color=color.black)
table.cell(summary, 1, 0, "v1", text_color=color.blue)
