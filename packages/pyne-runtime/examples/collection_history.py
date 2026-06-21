indicator("Collection History Demo", mode="incremental", overlay=True)


def on_bar(ctx, bar):
    closes = ctx.state("closes", array.new_float())
    counts = ctx.state("counts", map.new())
    latest = ctx.state("latest", matrix.new_float(1, 1, 0.0))

    previous_closes = closes[1]
    previous_counts = counts[1]
    previous_latest = latest[1]

    array.push(closes.value, bar.close)
    map.put(counts.value, "bars", bar.bar_index + 1)
    matrix.set(latest.value, 0, 0, bar.close)

    previous_size = array.size(previous_closes) if previous_closes is not None else 0
    previous_bars = map.get(previous_counts, "bars", 0) if previous_counts is not None else 0
    previous_close = matrix.get(previous_latest, 0, 0) if previous_latest is not None else 0

    ctx.plot("Close", bar.close, color=color.orange)
    ctx.plot("Stored Count", array.size(closes.value), pane="separate", color=color.blue)
    ctx.plot("Previous Count", previous_size, pane="separate", color=color.purple)
    ctx.plot("Previous Bars", previous_bars, pane="separate", color=color.green)
    ctx.plot("Previous Close", previous_close, color=color.gray)
