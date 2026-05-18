from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.0, "volume": 100},
        {"time": 2, "open": 1, "high": 2, "low": 1, "close": 2.0, "volume": 100},
        {"time": 3, "open": 1, "high": 2, "low": 1, "close": 3.0, "volume": 100},
    ]


def test_incremental_runtime_seeds_history() -> None:
    script = """
indicator("Incremental MA", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.sma("ma", period=2)

def on_bar(ctx, bar):
    value = ctx.ta.sma("ma").update(bar.close)
    ctx.plot("MA", value, color=color.orange)
"""

    result = pn.run(script, _bars(), executor_mode="inline")

    assert result.ok
    assert len(result.lines) == 1
    assert len(result.lines[0]["data"]) == 2

