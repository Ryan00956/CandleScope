indicator("Parameter Schema Demo", overlay=True)

length = input.int(
    20,
    "Length",
    minval=1,
    maxval=200,
    step=1,
    tooltip="Moving average period.",
    group="Moving Average",
    inline="ma",
    confirm=True,
)
source = input.source(close, "Source", group="Moving Average", inline="ma")
higher_tf = input.timeframe(
    "60",
    "Higher TF",
    options=["15", "60", "1D"],
    tooltip="Example host-facing timeframe parameter.",
    group="Context",
)
comparison_symbol = input.symbol("NASDAQ:AAPL", "Comparison Symbol", group="Context")
active_session = input.session("0930-1600", "Active Session", group="Context")
start_time = input.time(1710000000, "Start Time", group="Context", confirm=True)
kind = input.string(
    "EMA",
    "Type",
    options=["SMA", "EMA"],
    tooltip="Average calculation type.",
    group="Moving Average",
)
show_signal = input.bool(True, "Show Signal", group="Display", inline="display")
line_color = input.color("#f59e0b", "Line Color", group="Display", inline="display")

ma = ta.sma(source, length) if kind == "SMA" else ta.ema(source, length)
signal = crossover(source, ma) if show_signal else False
plot(ma, kind, color=line_color)
plot(when(signal, source, na), "Cross Up", color="#22c55e")
plot(1 if higher_tf == "1D" else 0, "Daily Context")
plot(1 if comparison_symbol else 0, "Symbol Configured")
plot(1 if active_session else 0, "Session Configured")
plot(start_time, "Start Time")
