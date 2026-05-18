indicator("Supertrend", overlay=True)

trend, direction = ta.supertrend(10, 3.0)

plot(trend, "Supertrend", color=color.green)
marker(direction > 0, text="Up", color=color.green)
marker(direction < 0, text="Down", color=color.red)

