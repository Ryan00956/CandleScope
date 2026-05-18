indicator("MA Cross", overlay=True)

fast = ta.ema(close, 3)
slow = ta.ema(close, 5)

plot(fast, "Fast EMA", color=color.orange)
plot(slow, "Slow EMA", color=color.blue)
marker(crossover(fast, slow), text="Buy", color=color.green)
marker(crossunder(fast, slow), text="Sell", color=color.red)

