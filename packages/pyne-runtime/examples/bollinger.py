indicator("Bollinger Bands", overlay=True)

upper, mid, lower = ta.bb(close, 20, 2)

p1 = plot(upper, "Upper", color=color.blue)
plot(mid, "Middle", color=color.orange)
p2 = plot(lower, "Lower", color=color.blue)
fill(p1, p2, color="rgba(59,130,246,0.08)")

