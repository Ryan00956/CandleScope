from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]


def test_extended_plot_outputs_are_collected() -> None:
    result = pn.run(
        """
indicator("Outputs", overlay=False)
p1 = plot(close, "Close", color=color.orange)
p2 = plot(open, "Open", color=color.blue)
fill(p1, p2, color="rgba(59,130,246,0.08)")
hline(2, "Mid")
bgcolor(close > open, color="rgba(34,197,94,0.1)")
barcolor(color.green)
emit_signal(close > open, name="up", message="Close above open")
alertcondition(close < open, title="down", message="Close below open")
label("U")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    output = result.output
    assert output["meta"]["title"] == "Outputs"
    assert len(output["fills"]) == 1
    assert len(output["hlines"]) == 1
    assert len(output["bgcolors"]) == 1
    assert len(output["barcolors"]) == 1
    assert len(output["signals"]) == 1
    assert len(output["labels"]) == 1
