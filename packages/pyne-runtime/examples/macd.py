indicator("MACD", overlay=False)

dif, dea, hist = ta.macd(close, 12, 26, 9)

plot(dif, "DIF", color=color.blue)
plot(dea, "DEA", color=color.orange)
bar(hist, "Histogram", color_up=color.green, color_down=color.red)

