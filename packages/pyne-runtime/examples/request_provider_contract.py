indicator("Request Provider Contract", overlay=True)

higher_open, higher_close = request.security(
    "BTCUSDT",
    "5",
    lambda ctx: (ctx.open, ctx.close),
)
higher_mintick = request.security("BTCUSDT", "5", lambda ctx: ctx.syminfo.mintick)
lower_close = request.security_lower_tf("BTCUSDT", "1", lambda ctx: ctx.close)

plot(higher_open, "Higher Open", color=color.orange)
plot(higher_close, "Higher Close", color=color.blue)
plot(higher_mintick, "Higher Mintick", color=color.gray, pane="lower")
plot(lower_close.last(), "Lower Close", color=color.green, pane="lower")
plot(lower_close.size(), "Lower Count", color=color.gray, pane="lower")
