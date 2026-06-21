from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1, "close": 2.5, "volume": 120},
    ]


def test_ticker_new_inherit_modify_and_standard_helpers() -> None:
    result = pn.run(
        """
base = ticker.new("NASDAQ", "AAPL")
extended = ticker.new("NASDAQ", "AAPL", ticker.session_extended, ticker.adjustment_dividends)
inherited = ticker.inherit("MSFT", ticker.session_regular)
modified = ticker.modify(base, session=ticker.session_extended)
standard = ticker.standard(extended)

label(base)
label(extended)
label(inherited)
label(modified)
label(standard)
plot(1 if standard == "NASDAQ:AAPL" else 0, "Standard Match")
""",
        _bars(),
        executor_mode="inline",
        syminfo={"tickerid": "NASDAQ:NVDA"},
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "NASDAQ:AAPL",
        "NASDAQ:AAPL?session=extended&adjustment=dividends",
        "NASDAQ:MSFT?session=regular",
        "NASDAQ:AAPL?session=extended",
        "NASDAQ:AAPL",
    ]
    assert result.values("Standard Match") == [1.0, 1.0]


def test_ticker_chart_type_helpers_add_stable_query_modifiers() -> None:
    result = pn.run(
        """
base = ticker.new("NYSE", "IBM")
ha = ticker.heikinashi(base)
renko = ticker.renko(base, "ATR", 14)
lb = ticker.linebreak(base, 3)
kagi = ticker.kagi(base, 1.5)
pf = ticker.pointfigure(base, "hl", 2, 3)

label(ha)
label(renko)
label(lb)
label(kagi)
label(pf)
plot(1 if ticker.standard(renko) == base else 0, "Base Preserved")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "NYSE:IBM?chart=heikinashi",
        "NYSE:IBM?chart=renko&style=ATR&param=14",
        "NYSE:IBM?chart=linebreak&lines=3",
        "NYSE:IBM?chart=kagi&reversal=1.5",
        "NYSE:IBM?chart=pointfigure&style=hl&param=2&reversal=3",
    ]
    assert result.values("Base Preserved") == [1.0, 1.0]


def test_ticker_defaults_to_current_syminfo_tickerid() -> None:
    result = pn.run(
        """
label(ticker.standard())
label(ticker.heikinashi())
label(ticker.inherit())
""",
        _bars(),
        executor_mode="inline",
        syminfo={"tickerid": "BINANCE:BTCUSDT"},
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "BINANCE:BTCUSDT",
        "BINANCE:BTCUSDT?chart=heikinashi",
        "BINANCE:BTCUSDT",
    ]
