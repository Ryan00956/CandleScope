indicator("RSI Signals", overlay=False)

r = ta.rsi(close, 14)

plot(r, "RSI", color=color.purple)
hline(70, "Overbought", color=color.red)
hline(30, "Oversold", color=color.green)
marker(crossunder(r, 70), text="Exit OB", color=color.orange)
marker(crossover(r, 30), text="Exit OS", color=color.green)

