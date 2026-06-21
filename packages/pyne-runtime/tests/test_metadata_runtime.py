from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2, "close": 3.5, "volume": 140},
    ]


def test_default_runtime_metadata_is_available_to_scripts() -> None:
    result = pn.run(
        """
indicator("Metadata", overlay=False)
plot(syminfo.mintick, "Min Tick")
plot(timeframe.multiplier, "Timeframe Multiplier")
plot(1 if timeframe.isintraday else 0, "Intraday")
plot(session.ismarket, "Market")
plot(session.isfirstbar, "First Session Bar")
plot(session.islastbar, "Last Session Bar")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Min Tick") == [1.0, 1.0, 1.0]
    assert result.values("Timeframe Multiplier") == [1.0, 1.0, 1.0]
    assert result.values("Intraday") == [1.0, 1.0, 1.0]
    assert result.values("Market") == [1.0, 1.0, 1.0]
    assert result.values("First Session Bar") == [1.0, 0.0, 0.0]
    assert result.values("Last Session Bar") == [0.0, 0.0, 1.0]


def test_runtime_metadata_can_be_supplied_through_run() -> None:
    result = pn.run(
        """
indicator("Metadata", overlay=False)
plot(syminfo.mintick, "Min Tick")
plot(1 if syminfo.ticker == "AAPL" else 0, "Ticker Match")
plot(timeframe.multiplier, "Timeframe Multiplier")
plot(1 if timeframe.isintraday else 0, "Intraday")
plot(1 if timeframe.isdaily else 0, "Daily")
plot(session.ismarket, "Market")
""",
        _bars(),
        executor_mode="inline",
        syminfo={"tickerid": "NASDAQ:AAPL", "mintick": 0.01, "currency": "USD"},
        timeframe="1h",
        session={"ismarket": False},
    )

    assert result.ok
    assert result.values("Min Tick") == [0.01, 0.01, 0.01]
    assert result.values("Ticker Match") == [1.0, 1.0, 1.0]
    assert result.values("Timeframe Multiplier") == [60.0, 60.0, 60.0]
    assert result.values("Intraday") == [1.0, 1.0, 1.0]
    assert result.values("Daily") == [0.0, 0.0, 0.0]
    assert result.values("Market") == [0.0, 0.0, 0.0]


def test_runtime_rejects_missing_ohlcv_fields() -> None:
    result = pn.PyneRuntime().execute(
        'plot(close, "Close")',
        [{"time": 1, "open": 1, "high": 2, "low": 1, "volume": 100}],
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "missing required fields" in str(result.error)


def test_time_close_last_bar_uses_timeframe_duration() -> None:
    result = pn.run(
        """
plot(time_close, "Close Time")
""",
        _bars()[:2],
        timeframe="1h",
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Close Time") == [2.0, 3602.0]


def test_time_close_last_bar_supports_minute_suffix_timeframe() -> None:
    result = pn.run(
        """
plot(time_close, "Close Time")
""",
        _bars()[:2],
        timeframe="15m",
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Close Time") == [2.0, 902.0]


def test_derived_series_names_are_stable() -> None:
    result = pn.run(
        """
plot(hl2, hl2.name)
plot(hlc3, hlc3.name)
plot(ohlc4, ohlc4.name)
plot(hlcc4, hlcc4.name)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [line["name"] for line in result.lines] == ["hl2", "hlc3", "ohlc4", "hlcc4"]


def test_session_namespace_uses_bar_level_host_flags() -> None:
    bars = [
        {**_bars()[0], "session_ismarket": True, "session_isfirstbar": True},
        {**_bars()[1], "session_ismarket": False},
        {**_bars()[2], "session": {"ismarket": True, "islastbar": True}},
    ]

    result = pn.run(
        """
indicator("Session", overlay=False)
plot(session.ismarket, "Market")
plot(session.isfirstbar, "First")
plot(session.islastbar, "Last")
plot(when(session.ismarket, close, 0), "Market Close")
""",
        bars,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Market") == [1.0, 0.0, 1.0]
    assert result.values("First") == [1.0, 0.0, 0.0]
    assert result.values("Last") == [0.0, 0.0, 1.0]
    assert result.values("Market Close") == [1.5, 0.0, 3.5]


def test_session_namespace_preserves_explicit_false_first_last_flags() -> None:
    bars = [
        {
            **bar,
            "session_isfirstbar": False,
            "session_islastbar": False,
        }
        for bar in _bars()
    ]

    result = pn.run(
        """
indicator("Session Explicit False", overlay=False)
plot(session.isfirstbar, "First")
plot(session.islastbar, "Last")
""",
        bars,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("First") == [0.0, 0.0, 0.0]
    assert result.values("Last") == [0.0, 0.0, 0.0]


def test_timeframe_parses_daily_weekly_and_monthly_periods() -> None:
    assert pn.TimeframeInfo.from_value("1D").isdaily
    assert pn.TimeframeInfo.from_value("2W").isweekly
    assert pn.TimeframeInfo.from_value("3M").ismonthly
    assert pn.TimeframeInfo.from_value("5").multiplier == 5


def test_strategy_slippage_uses_syminfo_mintick_when_not_overridden() -> None:
    result = pn.run(
        """
strategy("Metadata Strategy", overlay=True, slippage=2)
strategy.order("Buy", strategy.long, qty=1, when=bar_index == 0, price=close)
""",
        _bars(),
        executor_mode="inline",
        syminfo={"mintick": 0.25},
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Buy",
            "type": "order",
            "side": "long",
            "qty": 1.0,
            "price": 2.0,
            "position_after": 1.0,
            "comment": "",
        },
    ]
