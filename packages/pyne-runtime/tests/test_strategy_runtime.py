from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 2.2, "low": 1, "close": 1.0, "volume": 120},
        {"time": 3, "open": 2, "high": 3, "low": 1.8, "close": 2.8, "volume": 140},
        {"time": 4, "open": 3, "high": 3.2, "low": 2, "close": 2.4, "volume": 160},
    ]


def test_strategy_entry_and_close_events_are_collected() -> None:
    result = pn.run(
        """
indicator("Strategy", overlay=True)
strategy.entry_when(close > open, "Long", strategy.long, qty=2, price=close)
strategy.close_when(close < open, "Long", price=close)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    strategy_output = result.output["strategy"]
    assert strategy_output["position"] == {
        "size": 0.0,
        "side": "flat",
        "avg_price": None,
    }
    assert strategy_output["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 2.0,
            "price": 1.5,
            "position_after": 2.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Long",
            "type": "close",
            "side": "flat",
            "qty": 2.0,
            "price": 1.0,
            "position_after": 0.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 2.0,
            "price": 2.8,
            "position_after": 2.0,
            "comment": "",
        },
        {
            "time": 4,
            "id": "Long",
            "type": "close",
            "side": "flat",
            "qty": 2.0,
            "price": 2.4,
            "position_after": 0.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [2.0, 0.0, 2.0, 0.0]


def test_strategy_entry_accepts_when_keyword_and_short_direction() -> None:
    result = pn.run(
        """
indicator("Short", overlay=True)
strategy.entry("Short", strategy.short, qty=1.5, when=close < open)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["position"] == {
        "size": -1.5,
        "side": "short",
        "avg_price": 1.0,
    }
    assert result.values("Position") == [0.0, -1.5, -1.5, -1.5]


def test_strategy_order_reduces_and_reverses_net_position() -> None:
    result = pn.run(
        """
indicator("Order", overlay=True)
strategy.order_when(bar_index == 0, "Buy", strategy.long, qty=2, price=close)
strategy.order_when(bar_index == 1, "Sell Some", strategy.short, qty=1, price=close)
strategy.order_when(bar_index == 2, "Reverse", strategy.short, qty=3, price=close)
plot(strategy.position_size, "Position")
plot(strategy.position_avg_price, "Average")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Buy",
            "type": "order",
            "side": "long",
            "qty": 2.0,
            "price": 1.5,
            "position_after": 2.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Sell Some",
            "type": "order",
            "side": "short",
            "qty": 1.0,
            "price": 1.0,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "Reverse",
            "type": "order",
            "side": "short",
            "qty": 3.0,
            "price": 2.8,
            "position_after": -2.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [2.0, 1.0, -2.0, -2.0]
    assert result.values("Average") == [1.5, 1.5, 2.8, 2.8]


def test_strategy_risk_allow_entry_in_blocks_disallowed_entry_direction() -> None:
    result = pn.run(
        """
indicator("Risk Direction", overlay=True)
strategy.risk.allow_entry_in(strategy.direction.long)
strategy.entry_when(bar_index == 0, "Short", strategy.short, qty=1, price=close)
strategy.entry_when(bar_index == 1, "Long", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 2,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 1.0,
            "position_after": 1.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [0.0, 1.0, 1.0, 1.0]


def test_strategy_rejects_invalid_risk_direction_and_mode_values() -> None:
    invalid_direction = pn.run(
        """
strategy("Invalid Risk Direction", overlay=True)
strategy.risk.allow_entry_in("sideways")
""",
        _bars(),
        executor_mode="inline",
    )
    invalid_mode = pn.run(
        """
strategy("Invalid Risk Mode", overlay=True)
strategy.risk.max_drawdown(5, "points")
""",
        _bars(),
        executor_mode="inline",
    )

    assert not invalid_direction.ok
    assert "direction is invalid" in str(invalid_direction.error)
    assert not invalid_mode.ok
    assert "risk mode" in str(invalid_mode.error)


def test_strategy_risk_allow_entry_in_does_not_block_order_namespace() -> None:
    result = pn.run(
        """
indicator("Risk Order", overlay=True)
strategy.risk.allow_entry_in(strategy.risk.none)
strategy.entry_when(bar_index == 0, "Long Entry", strategy.long, qty=1, price=close)
strategy.order_when(bar_index == 1, "Long Order", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 2,
            "id": "Long Order",
            "type": "order",
            "side": "long",
            "qty": 1.0,
            "price": 1.0,
            "position_after": 1.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [0.0, 1.0, 1.0, 1.0]


def test_strategy_risk_max_drawdown_locks_future_entries_and_orders() -> None:
    result = pn.run(
        """
strategy("Risk Drawdown", overlay=True, initial_capital=1000)
strategy.risk.max_drawdown(5, strategy.percent_of_equity)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=10, price=close)
strategy.entry_when(bar_index == 2, "Blocked Entry", strategy.long, qty=1, price=close)
strategy.order_when(bar_index == 2, "Blocked Order", strategy.long, qty=1, price=close)
strategy.close_all(when=bar_index == 2, price=close)
strategy.order_when(bar_index == 3, "Still Blocked", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
""",
        [
            {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 2, "open": 100, "high": 100, "low": 89, "close": 90, "volume": 100},
            {"time": 3, "open": 90, "high": 92, "low": 88, "close": 90, "volume": 100},
            {"time": 4, "open": 90, "high": 95, "low": 90, "close": 94, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 10.0,
            "price": 100.0,
            "position_after": 10.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "close_all",
            "type": "close_all",
            "side": "flat",
            "qty": 10.0,
            "price": 90.0,
            "position_after": 0.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [10.0, 10.0, 0.0, 0.0]
    assert result.values("Equity") == [1000.0, 900.0, 900.0, 900.0]
    assert result.output["strategy"]["risk"] == {
        "locked": True,
        "max_drawdown": 5.0,
        "max_drawdown_type": "percent_of_equity",
        "max_intraday_loss": None,
        "max_intraday_loss_type": "percent_of_equity",
        "max_position_size": None,
        "max_intraday_filled_orders": None,
    }


def test_strategy_risk_max_drawdown_accepts_cash_threshold() -> None:
    result = pn.run(
        """
strategy("Risk Cash", overlay=True, initial_capital=1000)
strategy.risk.max_drawdown(50, strategy.cash)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 2, "Blocked", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 2, "open": 100, "high": 100, "low": 39, "close": 40, "volume": 100},
            {"time": 3, "open": 40, "high": 41, "low": 39, "close": 40, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == ["Long"]
    assert result.values("Position") == [1.0, 1.0, 1.0]
    assert result.output["strategy"]["risk"]["max_drawdown_type"] == "cash"


def test_strategy_risk_max_intraday_loss_resets_on_session_first_bar() -> None:
    result = pn.run(
        """
strategy("Risk Intraday", overlay=True, initial_capital=1000)
strategy.risk.max_intraday_loss(5, strategy.percent_of_equity)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=10, price=close)
strategy.entry_when(bar_index == 2, "Blocked", strategy.long, qty=1, price=close)
strategy.close_all(when=bar_index == 2, price=close)
strategy.entry_when(bar_index == 3, "Reset Long", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {
                "time": 1,
                "open": 100,
                "high": 101,
                "low": 99,
                "close": 100,
                "volume": 100,
                "session_isfirstbar": True,
            },
            {"time": 2, "open": 100, "high": 100, "low": 89, "close": 90, "volume": 100},
            {"time": 3, "open": 90, "high": 91, "low": 89, "close": 90, "volume": 100},
            {
                "time": 4,
                "open": 90,
                "high": 91,
                "low": 89,
                "close": 90,
                "volume": 100,
                "session_isfirstbar": True,
            },
            {"time": 5, "open": 90, "high": 92, "low": 89, "close": 90, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == [
        "Long",
        "risk.max_intraday_loss",
        "Reset Long",
    ]
    assert result.values("Position") == [10.0, 0.0, 0.0, 1.0, 1.0]
    assert result.output["strategy"]["risk"] == {
        "locked": False,
        "max_drawdown": None,
        "max_drawdown_type": "percent_of_equity",
        "max_intraday_loss": 5.0,
        "max_intraday_loss_type": "percent_of_equity",
        "max_position_size": None,
        "max_intraday_filled_orders": None,
    }


def test_strategy_risk_max_intraday_loss_accepts_cash_threshold() -> None:
    result = pn.run(
        """
strategy("Risk Intraday Cash", overlay=True, initial_capital=1000)
strategy.risk.max_intraday_loss(50, strategy.cash)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 2, "Blocked", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 2, "open": 100, "high": 100, "low": 39, "close": 40, "volume": 100},
            {"time": 3, "open": 40, "high": 41, "low": 39, "close": 40, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == [
        "Long",
        "risk.max_intraday_loss",
    ]
    assert result.values("Position") == [1.0, 0.0, 0.0]
    assert result.output["strategy"]["risk"]["max_intraday_loss_type"] == "cash"


def test_strategy_risk_max_position_size_caps_entry_quantity() -> None:
    result = pn.run(
        """
strategy("Risk Position Size", overlay=True, initial_capital=1000, pyramiding=2)
strategy.risk.max_position_size(3)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=5, price=close)
strategy.entry_when(bar_index == 1, "More", strategy.long, qty=2, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 3.0,
            "price": 10.0,
            "position_after": 3.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [3.0, 3.0]
    assert result.output["strategy"]["risk"]["max_position_size"] == 3.0
    lifecycle = {event["id"]: event for event in result.output["strategy"]["lifecycle"]}
    assert lifecycle["Long"]["requested_qty"] == 5.0
    assert lifecycle["Long"]["filled_qty"] == 3.0
    assert lifecycle["More"]["status"] == "rejected"
    assert lifecycle["More"]["rejected_reason"] == "max_position_size"
    assert lifecycle["More"]["requested_qty"] == 2.0
    assert lifecycle["More"]["filled_qty"] == 0.0


def test_strategy_risk_max_position_size_caps_reversal_entry_quantity() -> None:
    result = pn.run(
        """
strategy("Risk Position Reversal", overlay=True, initial_capital=1000)
strategy.risk.max_position_size(3)
strategy.entry_when(bar_index == 0, "Short", strategy.short, qty=4, price=close)
strategy.entry_when(bar_index == 1, "Reverse Long", strategy.long, qty=10, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Short",
            "type": "entry",
            "side": "short",
            "qty": 3.0,
            "price": 10.0,
            "position_after": -3.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Reverse Long",
            "type": "entry",
            "side": "long",
            "qty": 3.0,
            "price": 10.0,
            "position_after": 3.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [-3.0, 3.0]


def test_strategy_risk_max_position_size_does_not_cap_order_namespace() -> None:
    result = pn.run(
        """
strategy("Risk Position Order", overlay=True, initial_capital=1000)
strategy.risk.max_position_size(1)
strategy.order_when(bar_index == 0, "Long Order", strategy.long, qty=5, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"][0]["qty"] == 5.0
    assert result.values("Position") == [5.0, 5.0]


def test_strategy_risk_max_intraday_filled_orders_blocks_future_entries_and_orders() -> None:
    result = pn.run(
        """
strategy("Risk Filled Orders", overlay=True, initial_capital=1000, pyramiding=2)
strategy.risk.max_intraday_filled_orders(2)
strategy.entry_when(bar_index == 0, "First", strategy.long, qty=1, price=close)
strategy.order_when(bar_index == 1, "Second", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 2, "Blocked", strategy.long, qty=1, price=close)
strategy.close_all(when=bar_index == 2, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 3, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == [
        "First",
        "Second",
        "close_all",
    ]
    assert result.values("Position") == [1.0, 2.0, 0.0]
    assert result.output["strategy"]["risk"]["max_intraday_filled_orders"] == 2


def test_strategy_risk_max_intraday_filled_orders_resets_on_session_first_bar() -> None:
    result = pn.run(
        """
strategy("Risk Filled Reset", overlay=True, initial_capital=1000)
strategy.risk.max_intraday_filled_orders(1)
strategy.entry_when(bar_index == 0, "First", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 1, "Blocked", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 2, "Reset Entry", strategy.short, qty=1, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {
                "time": 1,
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10,
                "volume": 100,
                "session_isfirstbar": True,
            },
            {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {
                "time": 3,
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10,
                "volume": 100,
                "session_isfirstbar": True,
            },
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == [
        "First",
        "Reset Entry",
    ]
    assert result.values("Position") == [1.0, 1.0, -1.0]


def test_strategy_order_alias_accepts_when_keyword_and_costs() -> None:
    result = pn.run(
        """
indicator("Order Alias", overlay=True)
strategy.configure(
    slippage=1,
    mintick=0.1,
    commission_type=strategy.commission.cash_per_contract,
    commission_value=0.5,
)
strategy.order("Buy", strategy.long, qty=2, when=bar_index == 0, price=close)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Buy",
            "type": "order",
            "side": "long",
            "qty": 2.0,
            "price": 1.6,
            "position_after": 2.0,
            "comment": "",
            "commission": 1.0,
        },
    ]
    assert result.values("Position") == [2.0, 2.0, 2.0, 2.0]


def test_strategy_entry_stop_order_fills_on_later_bar() -> None:
    result = pn.run(
        """
indicator("Pending Stop", overlay=True)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=2.5)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 3,
            "id": "Breakout",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 2.5,
            "position_after": 1.0,
            "comment": "",
            "reason": "stop",
        },
    ]
    assert result.values("Position") == [0.0, 0.0, 1.0, 1.0]


def test_strategy_limit_fill_assumption_requires_price_to_exceed_limit() -> None:
    result = pn.run(
        """
strategy("Limit Verify", overlay=True, mintick=0.1, backtest_fill_limits_assumption=1)
strategy.entry("Pullback", strategy.long, qty=1, when=bar_index == 0, limit=2.7)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 3, "high": 3.1, "low": 2.8, "close": 3, "volume": 100},
            {"time": 2, "open": 3, "high": 3.1, "low": 2.65, "close": 2.9, "volume": 100},
            {"time": 3, "open": 2.9, "high": 3, "low": 2.59, "close": 2.8, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 3,
            "id": "Pullback",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 2.7,
            "position_after": 1.0,
            "comment": "",
            "reason": "limit",
        },
    ]
    assert result.values("Position") == [0.0, 0.0, 1.0]
    assert result.output["strategy"]["summary"]["backtest_fill_limits_assumption"] == 1


def test_strategy_pending_same_bar_stop_limit_priority_defaults_to_stop_first() -> None:
    result = pn.run(
        """
strategy("Same Bar Pending", overlay=True)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 13, "low": 7, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Breakout",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 12.0,
            "position_after": 1.0,
            "comment": "",
            "reason": "stop",
        },
    ]
    assert result.output["strategy"]["summary"]["same_bar_fill_priority"] == "stop_first"
    assert result.values("Position") == [1.0]


def test_strategy_pending_same_bar_stop_limit_can_prefer_limit_first() -> None:
    result = pn.run(
        """
strategy("Same Bar Pending", overlay=True, same_bar_fill_priority=strategy.same_bar.limit_first)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 13, "low": 7, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Breakout",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 8.0,
            "position_after": 1.0,
            "comment": "",
            "reason": "limit",
        },
    ]
    assert result.output["strategy"]["summary"]["same_bar_fill_priority"] == "limit_first"
    assert result.values("Position") == [1.0]


def test_strategy_pending_intrabar_path_can_choose_high_before_low() -> None:
    result = pn.run(
        """
strategy("Path Pending", overlay=True, intrabar_path=strategy.intrabar.open_high_low_close)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 13, "low": 7, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"][0]["reason"] == "stop"
    assert result.output["strategy"]["orders"][0]["price"] == 12.0
    assert result.output["strategy"]["summary"]["intrabar_path"] == "open_high_low_close"
    assert result.values("Position") == [1.0]


def test_strategy_pending_intrabar_path_can_choose_low_before_high() -> None:
    result = pn.run(
        """
strategy("Path Pending", overlay=True, intrabar_path=strategy.intrabar.open_low_high_close)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=12, limit=8)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 13, "low": 7, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"][0]["reason"] == "limit"
    assert result.output["strategy"]["orders"][0]["price"] == 8.0
    assert result.output["strategy"]["summary"]["intrabar_path"] == "open_low_high_close"
    assert result.values("Position") == [1.0]


def test_strategy_margin_blocks_entry_when_required_margin_exceeds_equity() -> None:
    result = pn.run(
        """
strategy("Margin Long", overlay=True, initial_capital=1000, margin_long=100)
strategy.entry_when(bar_index == 0, "Too Big", strategy.long, qty=11, price=close)
strategy.entry_when(bar_index == 1, "Allowed", strategy.long, qty=5, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 2, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == ["Allowed"]
    assert result.values("Position") == [0.0, 5.0]
    assert result.output["strategy"]["summary"]["margin_long"] == 100.0


def test_strategy_default_margin_does_not_reject_high_notional_entry() -> None:
    result = pn.run(
        """
strategy("Default Margin", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "High Notional", strategy.long, qty=20, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 2, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == ["High Notional"]
    assert result.values("Position") == [20.0, 20.0]
    assert result.output["strategy"]["summary"]["margin_long"] == 0.0
    assert result.output["strategy"]["summary"]["margin_short"] == 0.0


def test_strategy_process_orders_on_close_delays_market_fill_visibility() -> None:
    result = pn.run(
        """
strategy("Process On Close", overlay=True, initial_capital=1000, process_orders_on_close=True)
strategy.entry("Long", strategy.long, qty=2, when=bar_index == 0, price=close)
strategy.close("Long", when=bar_index == 2, price=close)
plot(strategy.position_size, "Position")
plot(strategy.netprofit, "Net Profit")
plot(strategy.openprofit, "Open Profit")
plot(strategy.closedtrades, "Closed Trades")
plot(strategy.closedtrades.profit(1), "Next Closed Profit")
""",
        [
            {"time": 1, "open": 10, "high": 10.5, "low": 9.5, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 11.5, "low": 10.5, "close": 11, "volume": 100},
            {"time": 3, "open": 13, "high": 13.5, "low": 12.5, "close": 13, "volume": 100},
            {"time": 4, "open": 12, "high": 12.5, "low": 11.5, "close": 12, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [0.0, 2.0, 2.0, 0.0]
    assert result.values("Net Profit") == [0.0, 0.0, 0.0, 6.0]
    assert result.values("Open Profit") == [0.0, 2.0, 6.0, 0.0]
    assert result.values("Closed Trades") == [0.0, 0.0, 0.0, 1.0]
    assert result.values("Next Closed Profit") == [0.0, 0.0, 0.0, 0.0]


def test_strategy_process_orders_on_close_new_exit_uses_close_and_fifo_visibility() -> None:
    result = pn.run(
        """
strategy("Process Exit", overlay=True, initial_capital=1000, pyramiding=2, process_orders_on_close=True)
strategy.entry("A", strategy.long, qty=1, when=bar_index == 0, price=close)
strategy.entry("B", strategy.long, qty=2, when=bar_index == 1, price=close)
strategy.exit("Exit B Half", from_entry="B", qty_percent=50, limit=1, when=bar_index == 2)
plot(strategy.position_size, "Position")
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
plot(strategy.openprofit, "Open Profit")
plot(strategy.closedtrades, "Closed Trades")
plot(strategy.opentrades, "Open Trades")
plot(strategy.closedtrades.profit(0), "First Closed Profit")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 100},
            {"time": 3, "open": 11, "high": 13, "low": 10, "close": 12, "volume": 100},
            {"time": 4, "open": 12, "high": 14, "low": 11, "close": 13, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [0.0, 1.0, 3.0, 2.0]
    assert result.values("Equity") == [1000.0, 1001.0, 1004.0, 1006.0]
    assert result.values("Net Profit") == [0.0, 0.0, 0.0, 2.0]
    assert result.values("Open Profit") == [0.0, 1.0, 4.0, 4.0]
    assert result.values("Closed Trades") == [0.0, 0.0, 0.0, 1.0]
    assert result.values("Open Trades") == [0.0, 1.0, 2.0, 1.0]
    assert result.values("First Closed Profit") == [0.0, 0.0, 0.0, 2.0]
    assert result.output["strategy"]["orders"][-1] == {
        "time": 3,
        "id": "Exit B Half",
        "from_entry": "B",
        "type": "exit",
        "side": "flat",
        "qty": 1.0,
        "price": 12.0,
        "position_after": 2.0,
        "reason": "limit",
        "comment": "",
    }
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 3,
            "entry_id": "A",
            "exit_id": "Exit B Half",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "exit_price": 12.0,
            "profit": 2.0,
            "commission": 0.0,
            "net_profit": 2.0,
        }
    ]
    assert result.output["strategy"]["opentrades"] == [
        {
            "entry_time": 2,
            "entry_id": "B",
            "side": "long",
            "qty": 2.0,
            "entry_price": 11.0,
            "profit": 4.0,
        }
    ]


def test_strategy_process_orders_on_close_carry_exit_uses_previous_close() -> None:
    result = pn.run(
        """
strategy("Process Carry Exit", overlay=True, initial_capital=1000, process_orders_on_close=True)
strategy.entry("Long", strategy.long, qty=1, when=bar_index == 0, price=close)
strategy.exit("Bracket", from_entry="Long", limit=1)
plot(strategy.position_size, "Position")
plot(strategy.netprofit, "Net Profit")
plot(strategy.closedtrades, "Closed Trades")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 9.9, "high": 12, "low": 9, "close": 11, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [0.0, 0.0]
    assert result.values("Net Profit") == [0.0, 0.0]
    assert result.values("Closed Trades") == [0.0, 1.0]
    assert result.output["strategy"]["orders"][-1] == {
        "time": 2,
        "id": "Bracket",
        "from_entry": "Long",
        "type": "exit",
        "side": "flat",
        "qty": 1.0,
        "price": 10.0,
        "position_after": 0.0,
        "reason": "limit",
        "comment": "",
    }


def test_strategy_margin_allows_leveraged_short_when_margin_percent_is_lower() -> None:
    result = pn.run(
        """
strategy("Margin Short", overlay=True, initial_capital=1000, margin_short=25)
strategy.order_when(bar_index == 0, "Short", strategy.short, qty=20, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 2, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert [order["id"] for order in result.output["strategy"]["orders"]] == ["Short"]
    assert result.values("Position") == [-20.0, -20.0]
    assert result.output["strategy"]["summary"]["margin_short"] == 25.0


def test_strategy_cancel_prevents_pending_entry_fill() -> None:
    result = pn.run(
        """
indicator("Cancel", overlay=True)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=2.5)
strategy.cancel("Breakout", when=bar_index == 1, comment="No trade")
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 2,
            "id": "Breakout",
            "type": "cancel",
            "side": "flat",
            "qty": 0.0,
            "price": None,
            "position_after": 0.0,
            "comment": "No trade",
            "canceled": 1,
        },
    ]
    assert result.values("Position") == [0.0, 0.0, 0.0, 0.0]


def test_strategy_lifecycle_reports_pending_fill_and_cancel() -> None:
    result = pn.run(
        """
indicator("Lifecycle", overlay=True)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=2.5)
strategy.entry("Fade", strategy.short, qty=1, when=bar_index == 0, limit=3.5)
strategy.cancel("Fade", when=bar_index == 1, comment="No fade")
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    lifecycle = result.output["strategy"]["lifecycle"]
    assert lifecycle == [
        {
            "id": "Breakout",
            "type": "entry",
            "status": "filled",
            "phase": "pending_fill",
            "submitted_time": 1,
            "filled_time": 3,
            "canceled_time": None,
            "rejected_time": None,
            "side": "long",
            "qty": 1.0,
            "price": 2.5,
            "position_after": 1.0,
            "reason": "stop",
            "comment": "",
            "stop": 2.5,
            "requested_qty": 1.0,
            "filled_qty": 1.0,
        },
        {
            "id": "Fade",
            "type": "entry",
            "status": "canceled",
            "phase": "pending_canceled",
            "submitted_time": 1,
            "filled_time": None,
            "canceled_time": 2,
            "rejected_time": None,
            "side": "short",
            "qty": 1.0,
            "price": 1.5,
            "position_after": 0.0,
            "comment": "",
            "limit": 3.5,
            "canceled_by": "Fade",
        },
        {
            "id": "Fade",
            "type": "cancel",
            "status": "canceled",
            "phase": "cancel",
            "submitted_time": 2,
            "filled_time": None,
            "canceled_time": 2,
            "rejected_time": None,
            "side": "flat",
            "qty": 0.0,
            "price": None,
            "position_after": 0.0,
            "comment": "No fade",
            "canceled": 1,
        },
    ]


def test_strategy_lifecycle_reports_rejected_entry_and_order_reasons() -> None:
    result = pn.run(
        """
strategy("Lifecycle Reject", overlay=True, initial_capital=1000, margin_long=100)
strategy.risk.allow_entry_in(strategy.direction.long)
strategy.entry_when(bar_index == 0, "Short", strategy.short, qty=1, price=close)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 1, "Pyramid", strategy.long, qty=1, price=close)
strategy.order_when(bar_index == 2, "Too Big", strategy.long, qty=11, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 2, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
            {"time": 3, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    lifecycle = {event["id"]: event for event in result.output["strategy"]["lifecycle"]}
    assert lifecycle["Long"]["status"] == "filled"
    assert lifecycle["Long"]["requested_qty"] == 1.0
    assert lifecycle["Long"]["filled_qty"] == 1.0
    assert lifecycle["Short"]["status"] == "rejected"
    assert lifecycle["Short"]["phase"] == "rejected"
    assert lifecycle["Short"]["rejected_reason"] == "direction_not_allowed"
    assert lifecycle["Short"]["rejected_time"] == 1
    assert lifecycle["Short"]["requested_qty"] == 1.0
    assert lifecycle["Short"]["filled_qty"] == 0.0
    assert lifecycle["Pyramid"]["status"] == "rejected"
    assert lifecycle["Pyramid"]["rejected_reason"] == "pyramiding_exceeded"
    assert lifecycle["Pyramid"]["rejected_time"] == 2
    assert lifecycle["Too Big"]["status"] == "rejected"
    assert lifecycle["Too Big"]["rejected_reason"] == "margin"
    assert lifecycle["Too Big"]["rejected_time"] == 3
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 100.0,
            "position_after": 1.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [1.0, 1.0, 1.0]


def test_strategy_cancel_all_clears_multiple_pending_orders() -> None:
    result = pn.run(
        """
indicator("Cancel All", overlay=True)
strategy.entry("Breakout", strategy.long, qty=1, when=bar_index == 0, stop=2.5)
strategy.order("Fade", strategy.short, qty=1, when=bar_index == 0, limit=2.7)
strategy.cancel_all(when=bar_index == 1, comment="Flat")
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 2,
            "id": "cancel_all",
            "type": "cancel_all",
            "side": "flat",
            "qty": 0.0,
            "price": None,
            "position_after": 0.0,
            "comment": "Flat",
            "canceled": 2,
        },
    ]
    assert result.values("Position") == [0.0, 0.0, 0.0, 0.0]


def test_strategy_oca_cancel_fills_first_pending_order_and_cancels_siblings() -> None:
    result = pn.run(
        """
indicator("OCA", overlay=True)
strategy.entry(
    "Breakout",
    strategy.long,
    qty=1,
    when=bar_index == 0,
    stop=2.5,
    oca_name="bracket",
    oca_type=strategy.oca.cancel,
)
strategy.order(
    "Fade",
    strategy.short,
    qty=1,
    when=bar_index == 0,
    limit=2.7,
    oca_name="bracket",
    oca_type=strategy.oca.cancel,
)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 3,
            "id": "Breakout",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 2.5,
            "position_after": 1.0,
            "comment": "",
            "reason": "stop",
            "oca_name": "bracket",
            "oca_type": "cancel",
        },
    ]
    assert result.values("Position") == [0.0, 0.0, 1.0, 1.0]


def test_strategy_rejects_invalid_direction_and_oca_type_values() -> None:
    invalid_direction = pn.run(
        """
strategy("Invalid Direction", overlay=True)
strategy.entry("Bad", "sideways", qty=1, when=bar_index == 0, price=close)
""",
        _bars(),
        executor_mode="inline",
    )
    invalid_oca = pn.run(
        """
strategy("Invalid OCA", overlay=True)
strategy.entry("Bad", strategy.long, qty=1, when=bar_index == 0, oca_type="mystery")
""",
        _bars(),
        executor_mode="inline",
    )

    assert not invalid_direction.ok
    assert "strategy direction" in str(invalid_direction.error)
    assert not invalid_oca.ok
    assert "oca_type" in str(invalid_oca.error)


def test_strategy_oca_reduce_decreases_sibling_pending_quantity() -> None:
    result = pn.run(
        """
indicator("OCA Reduce", overlay=True)
strategy.entry(
    "First",
    strategy.long,
    qty=1,
    when=bar_index == 0,
    stop=2.5,
    oca_name="scale",
    oca_type=strategy.oca.reduce,
)
strategy.order(
    "Second",
    strategy.long,
    qty=2,
    when=bar_index == 0,
    stop=3.1,
    oca_name="scale",
    oca_type=strategy.oca.reduce,
)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 3,
            "id": "First",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 2.5,
            "position_after": 1.0,
            "comment": "",
            "reason": "stop",
            "oca_name": "scale",
            "oca_type": "reduce",
        },
        {
            "time": 4,
            "id": "Second",
            "type": "order",
            "side": "long",
            "qty": 1.0,
            "price": 3.1,
            "position_after": 2.0,
            "comment": "",
            "reason": "stop",
            "oca_name": "scale",
            "oca_type": "reduce",
        },
    ]
    assert result.values("Position") == [0.0, 0.0, 1.0, 2.0]


def test_strategy_unused_does_not_emit_strategy_output() -> None:
    result = pn.run(
        """
indicator("No Strategy", overlay=True)
plot(close, "Close")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert "strategy" not in result.output


def test_strategy_close_all_closes_any_open_position() -> None:
    result = pn.run(
        """
indicator("Close All", overlay=True)
strategy.entry_when(bar_index == 0, "Short", strategy.short, qty=2, price=close)
strategy.close_all(when=bar_index == 2, price=close, comment="Risk off")
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Short",
            "type": "entry",
            "side": "short",
            "qty": 2.0,
            "price": 1.5,
            "position_after": -2.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "close_all",
            "type": "close_all",
            "side": "flat",
            "qty": 2.0,
            "price": 2.8,
            "position_after": 0.0,
            "comment": "Risk off",
        },
    ]
    assert result.values("Position") == [-2.0, -2.0, 0.0, 0.0]


def test_strategy_configure_pyramiding_two_allows_same_direction_add() -> None:
    result = pn.run(
        """
indicator("Pyramiding", overlay=True)
strategy.configure(pyramiding=2)
strategy.entry_when(close > open, "Long", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
plot(strategy.position_avg_price, "Average")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 1.5,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 2.8,
            "position_after": 2.0,
            "comment": "",
        },
    ]
    assert result.values("Position") == [1.0, 1.0, 2.0, 2.0]
    assert result.values("Average") == [1.5, 1.5, 2.15, 2.15]


def test_strategy_configure_applies_pine_like_tick_slippage() -> None:
    result = pn.run(
        """
indicator("Slippage", overlay=True)
strategy.configure(slippage=2, mintick=0.1)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.close_when(bar_index == 1, "Long", price=close)
plot(strategy.position_avg_price, "Average")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 1.7,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Long",
            "type": "close",
            "side": "flat",
            "qty": 1.0,
            "price": 0.8,
            "position_after": 0.0,
            "comment": "",
        },
    ]
    assert result.values("Average") == [1.7]


def test_strategy_configure_applies_percent_commission() -> None:
    result = pn.run(
        """
indicator("Commission", overlay=True)
strategy.configure(
    commission_type=strategy.commission.percent,
    commission_value=1,
)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=2, price=close)
strategy.close_when(bar_index == 1, "Long", price=close)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 2.0,
            "price": 1.5,
            "position_after": 2.0,
            "comment": "",
            "commission": 0.03,
        },
        {
            "time": 2,
            "id": "Long",
            "type": "close",
            "side": "flat",
            "qty": 2.0,
            "price": 1.0,
            "position_after": 0.0,
            "comment": "",
            "commission": 0.02,
        },
    ]


def test_strategy_callable_declares_metadata_and_configures_replay() -> None:
    result = pn.run(
        """
strategy(
    "Declared Strategy",
    overlay=False,
    pyramiding=2,
    slippage=1,
    mintick=0.1,
    commission_type=strategy.commission.percent,
    commission_value=1,
)
strategy.entry_when(close > open, "Long", strategy.long, qty=1, price=close)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.meta == {
        "title": "Declared Strategy",
        "overlay": False,
        "script_type": "strategy",
        "pyramiding": 2,
        "slippage": 1,
        "mintick": 0.1,
        "commission_type": "percent",
        "commission_value": 1,
        "securityMode": "safe",
    }
    assert result.lines[0]["pane"] == "separate"
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 1.6,
            "position_after": 1.0,
            "comment": "",
            "commission": 0.016,
        },
        {
            "time": 3,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 2.9,
            "position_after": 2.0,
            "comment": "",
            "commission": 0.029,
        },
    ]


def test_strategy_exit_emits_limit_exit_for_long_position() -> None:
    result = pn.run(
        """
indicator("Limit Exit", overlay=True)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Take Profit", from_entry="Long", limit=2.7, stop=0.8)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 1.5,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "Take Profit",
            "from_entry": "Long",
            "type": "exit",
            "side": "flat",
            "qty": 1.0,
            "price": 2.7,
            "position_after": 0.0,
            "reason": "limit",
            "comment": "",
        },
    ]
    assert result.values("Position") == [1.0, 1.0, 0.0, 0.0]


def test_strategy_limit_fill_assumption_applies_to_exits() -> None:
    result = pn.run(
        """
strategy("Exit Verify", overlay=True, mintick=0.1, backtest_fill_limits_assumption=2)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Take Profit", from_entry="Long", limit=11)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 10.2, "low": 9.8, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 11.1, "low": 10, "close": 10.5, "volume": 100},
            {"time": 3, "open": 10.5, "high": 11.25, "low": 10.2, "close": 11, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 10.0,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "Take Profit",
            "from_entry": "Long",
            "type": "exit",
            "side": "flat",
            "qty": 1.0,
            "price": 11.0,
            "position_after": 0.0,
            "reason": "limit",
            "comment": "",
        },
    ]
    assert result.values("Position") == [1.0, 1.0, 0.0]


def test_strategy_exit_same_bar_stop_limit_defaults_to_stop_first() -> None:
    result = pn.run(
        """
strategy("Same Bar Exit", overlay=True)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Bracket", from_entry="Long", stop=9, limit=12)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 10.5, "low": 9.5, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 13, "low": 8, "close": 11, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 10.0,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Bracket",
            "from_entry": "Long",
            "type": "exit",
            "side": "flat",
            "qty": 1.0,
            "price": 9.0,
            "position_after": 0.0,
            "reason": "stop",
            "comment": "",
        },
    ]
    assert result.values("Position") == [1.0, 0.0]


def test_strategy_exit_same_bar_stop_limit_can_prefer_limit_first() -> None:
    result = pn.run(
        """
strategy("Same Bar Exit", overlay=True)
strategy.configure(same_bar_fill_priority=strategy.same_bar.limit_first)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Bracket", from_entry="Long", stop=9, limit=12)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 10.5, "low": 9.5, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 13, "low": 8, "close": 11, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 10.0,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Bracket",
            "from_entry": "Long",
            "type": "exit",
            "side": "flat",
            "qty": 1.0,
            "price": 12.0,
            "position_after": 0.0,
            "reason": "limit",
            "comment": "",
        },
    ]
    assert result.output["strategy"]["summary"]["same_bar_fill_priority"] == "limit_first"
    assert result.values("Position") == [1.0, 0.0]


def test_strategy_exit_intrabar_path_can_choose_high_before_low() -> None:
    result = pn.run(
        """
strategy("Path Exit", overlay=True, intrabar_path=strategy.intrabar.open_high_low_close)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Bracket", from_entry="Long", stop=9, limit=12)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 10.5, "low": 9.5, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 13, "low": 8, "close": 11, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"][1]["reason"] == "limit"
    assert result.output["strategy"]["orders"][1]["price"] == 12.0
    assert result.output["strategy"]["summary"]["intrabar_path"] == "open_high_low_close"
    assert result.values("Position") == [1.0, 0.0]


def test_strategy_exit_intrabar_path_can_choose_low_before_high() -> None:
    result = pn.run(
        """
strategy("Path Exit", overlay=True, intrabar_path=strategy.intrabar.open_low_high_close)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Bracket", from_entry="Long", stop=9, limit=12)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 10.5, "low": 9.5, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 13, "low": 8, "close": 11, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"][1]["reason"] == "stop"
    assert result.output["strategy"]["orders"][1]["price"] == 9.0
    assert result.output["strategy"]["summary"]["intrabar_path"] == "open_low_high_close"
    assert result.values("Position") == [1.0, 0.0]


def test_strategy_exit_qty_partially_reduces_long_position() -> None:
    result = pn.run(
        """
indicator("Partial Exit", overlay=True)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=2, price=close)
strategy.exit("Take Some", from_entry="Long", qty=0.5, limit=2.7, when=bar_index == 2)
plot(strategy.position_size, "Position")
plot(strategy.position_avg_price, "Average")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 2.0,
            "price": 1.5,
            "position_after": 2.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "Take Some",
            "from_entry": "Long",
            "type": "exit",
            "side": "flat",
            "qty": 0.5,
            "price": 2.7,
            "position_after": 1.5,
            "reason": "limit",
            "comment": "",
        },
    ]
    assert result.values("Position") == [2.0, 2.0, 1.5, 1.5]
    assert result.values("Average") == [1.5, 1.5, 1.5, 1.5]
    exit_lifecycle = result.output["strategy"]["lifecycle"][-1]
    assert exit_lifecycle["id"] == "Take Some"
    assert exit_lifecycle["target_qty"] == 2.0
    assert exit_lifecycle["requested_qty"] == 0.5
    assert exit_lifecycle["filled_qty"] == 0.5


def test_strategy_exit_emits_stop_exit_for_short_position() -> None:
    result = pn.run(
        """
indicator("Short Stop", overlay=True)
strategy.entry_when(bar_index == 0, "Short", strategy.short, qty=2, price=close)
strategy.exit("Stop", from_entry="Short", stop=2.1)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Short",
            "type": "entry",
            "side": "short",
            "qty": 2.0,
            "price": 1.5,
            "position_after": -2.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Stop",
            "from_entry": "Short",
            "type": "exit",
            "side": "flat",
            "qty": 2.0,
            "price": 2.1,
            "position_after": 0.0,
            "reason": "stop",
            "comment": "",
        },
    ]
    assert result.values("Position") == [-2.0, 0.0, 0.0, 0.0]


def test_strategy_exit_when_filters_exit_events() -> None:
    result = pn.run(
        """
indicator("Exit When", overlay=True)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=1, price=close)
strategy.exit("Later Stop", from_entry="Long", stop=1.2, when=bar_index >= 2)
plot(strategy.position_size, "Position")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert len(result.output["strategy"]["orders"]) == 1
    assert result.values("Position") == [1.0, 1.0, 1.0, 1.0]


def test_strategy_reporting_exposes_equity_profit_and_closed_trades() -> None:
    result = pn.run(
        """
strategy(
    "Report",
    overlay=True,
    initial_capital=1000,
    currency="USD",
    commission_type=strategy.commission.cash_per_order,
    commission_value=1,
)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=2, price=close)
strategy.close_when(bar_index == 2, "Long", price=close)
plot(strategy.equity, "Equity")
plot(strategy.netprofit, "Net Profit")
plot(strategy.openprofit, "Open Profit")
plot(strategy.grossprofit, "Gross Profit")
plot(strategy.grossloss, "Gross Loss")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 13, "low": 10, "close": 12, "volume": 100},
            {"time": 3, "open": 12, "high": 12, "low": 10, "close": 11, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Equity") == [999.0, 1003.0, 1000.0]
    assert result.values("Net Profit") == [-1.0, -1.0, 0.0]
    assert result.values("Open Profit") == [0.0, 4.0, 0.0]
    assert result.values("Gross Profit") == [0.0, 0.0, 2.0]
    assert result.values("Gross Loss") == [0.0, 0.0, 0.0]
    assert result.output["strategy"]["summary"] == {
        "initial_capital": 1000.0,
        "currency": "USD",
        "equity": 1000.0,
        "netprofit": 0.0,
        "openprofit": 0.0,
        "grossprofit": 2.0,
        "grossloss": 0.0,
        "commission": 2.0,
        "backtest_fill_limits_assumption": 0,
        "same_bar_fill_priority": "stop_first",
        "intrabar_path": "same_bar_priority",
        "margin_long": 0.0,
        "margin_short": 0.0,
    }
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 3,
            "entry_id": "Long",
            "exit_id": "Long",
            "side": "long",
            "qty": 2.0,
            "entry_price": 10.0,
            "exit_price": 11.0,
            "profit": 2.0,
            "commission": 2.0,
            "net_profit": 0.0,
        }
    ]
    assert result.output["strategy"]["opentrades"] == []


def test_strategy_reporting_exposes_open_trades() -> None:
    result = pn.run(
        """
strategy("Open Report", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=2, price=close)
plot(strategy.equity, "Equity")
plot(strategy.openprofit, "Open Profit")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 12, "low": 10, "close": 10.5, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Equity") == [1000.0, 1001.0]
    assert result.values("Open Profit") == [0.0, 1.0]
    assert result.output["strategy"]["opentrades"] == [
        {
            "entry_time": 1,
            "entry_id": "Long",
            "side": "long",
            "qty": 2.0,
            "entry_price": 10.0,
            "profit": 1.0,
        }
    ]


def test_strategy_trade_ledger_tracks_entry_id_partial_exit() -> None:
    result = pn.run(
        """
strategy("Lots", overlay=True, initial_capital=1000, pyramiding=2)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 1, "B", strategy.long, qty=2, price=close)
strategy.exit("B Exit", from_entry="B", qty=1, limit=12, when=bar_index == 2)
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
            {"time": 4, "open": 13, "high": 14, "low": 12, "close": 13, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 2,
            "exit_time": 3,
            "entry_id": "B",
            "exit_id": "B Exit",
            "side": "long",
            "qty": 1.0,
            "entry_price": 11.0,
            "exit_price": 12.0,
            "profit": 1.0,
            "commission": 0.0,
            "net_profit": 1.0,
        }
    ]
    assert result.output["strategy"]["opentrades"] == [
        {
            "entry_time": 1,
            "entry_id": "A",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "profit": 3.0,
        },
        {
            "entry_time": 2,
            "entry_id": "B",
            "side": "long",
            "qty": 1.0,
            "entry_price": 11.0,
            "profit": 2.0,
        },
    ]


def test_strategy_trade_ledger_splits_close_all_by_entry_lot() -> None:
    result = pn.run(
        """
strategy("Close Lots", overlay=True, initial_capital=1000, pyramiding=2)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 1, "B", strategy.long, qty=2, price=close)
strategy.close_all(when=bar_index == 2, price=close)
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 3,
            "entry_id": "A",
            "exit_id": "close_all",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "exit_price": 12.0,
            "profit": 2.0,
            "commission": 0.0,
            "net_profit": 2.0,
        },
        {
            "entry_time": 2,
            "exit_time": 3,
            "entry_id": "B",
            "exit_id": "close_all",
            "side": "long",
            "qty": 2.0,
            "entry_price": 11.0,
            "exit_price": 12.0,
            "profit": 2.0,
            "commission": 0.0,
            "net_profit": 2.0,
        },
    ]
    assert result.output["strategy"]["opentrades"] == []


def test_strategy_close_id_closes_matching_entry_lot_only() -> None:
    result = pn.run(
        """
strategy("Close By Id", overlay=True, initial_capital=1000, pyramiding=2)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 1, "B", strategy.long, qty=2, price=close)
strategy.close("A", when=bar_index == 2, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
            {"time": 4, "open": 13, "high": 14, "low": 12, "close": 13, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [1.0, 3.0, 2.0, 2.0]
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "A",
            "type": "entry",
            "side": "long",
            "qty": 1.0,
            "price": 10.0,
            "position_after": 1.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "B",
            "type": "entry",
            "side": "long",
            "qty": 2.0,
            "price": 11.0,
            "position_after": 3.0,
            "comment": "",
        },
        {
            "time": 3,
            "id": "A",
            "type": "close",
            "side": "flat",
            "qty": 1.0,
            "price": 12.0,
            "position_after": 2.0,
            "comment": "",
        },
    ]
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 3,
            "entry_id": "A",
            "exit_id": "A",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "exit_price": 12.0,
            "profit": 2.0,
            "commission": 0.0,
            "net_profit": 2.0,
        }
    ]
    assert result.output["strategy"]["opentrades"] == [
        {
            "entry_time": 2,
            "entry_id": "B",
            "side": "long",
            "qty": 2.0,
            "entry_price": 11.0,
            "profit": 4.0,
        }
    ]


def test_strategy_close_supports_partial_qty() -> None:
    result = pn.run(
        """
strategy("Close Qty", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=4, price=close)
strategy.close("Long", when=bar_index == 1, qty=1.5, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [4.0, 2.5, 2.5]
    assert result.output["strategy"]["orders"] == [
        {
            "time": 1,
            "id": "Long",
            "type": "entry",
            "side": "long",
            "qty": 4.0,
            "price": 10.0,
            "position_after": 4.0,
            "comment": "",
        },
        {
            "time": 2,
            "id": "Long",
            "type": "close",
            "side": "flat",
            "qty": 1.5,
            "price": 11.0,
            "position_after": 2.5,
            "comment": "",
        },
    ]
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 2,
            "entry_id": "Long",
            "exit_id": "Long",
            "side": "long",
            "qty": 1.5,
            "entry_price": 10.0,
            "exit_price": 11.0,
            "profit": 1.5,
            "commission": 0.0,
            "net_profit": 1.5,
        }
    ]
    assert result.output["strategy"]["opentrades"] == [
        {
            "entry_time": 1,
            "entry_id": "Long",
            "side": "long",
            "qty": 2.5,
            "entry_price": 10.0,
            "profit": 5.0,
        }
    ]


def test_strategy_close_supports_qty_percent_for_matching_entry_lot() -> None:
    result = pn.run(
        """
strategy("Close Percent", overlay=True, initial_capital=1000, pyramiding=2)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=2, price=close)
strategy.entry_when(bar_index == 1, "B", strategy.long, qty=2, price=close)
strategy.close("A", when=bar_index == 2, qty_percent=50, price=close)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
            {"time": 4, "open": 13, "high": 14, "low": 12, "close": 13, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [2.0, 4.0, 3.0, 3.0]
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 3,
            "entry_id": "A",
            "exit_id": "A",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "exit_price": 12.0,
            "profit": 2.0,
            "commission": 0.0,
            "net_profit": 2.0,
        }
    ]
    assert result.output["strategy"]["opentrades"] == [
        {
            "entry_time": 1,
            "entry_id": "A",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "profit": 3.0,
        },
        {
            "entry_time": 2,
            "entry_id": "B",
            "side": "long",
            "qty": 2.0,
            "entry_price": 11.0,
            "profit": 4.0,
        },
    ]


def test_strategy_exit_from_entry_without_qty_closes_matching_lot_only() -> None:
    result = pn.run(
        """
strategy("Exit By Entry", overlay=True, initial_capital=1000, pyramiding=2)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=1, price=close)
strategy.entry_when(bar_index == 1, "B", strategy.long, qty=2, price=close)
strategy.exit("Exit B", from_entry="B", limit=12, when=bar_index == 2)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [1.0, 3.0, 1.0]
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 2,
            "exit_time": 3,
            "entry_id": "B",
            "exit_id": "Exit B",
            "side": "long",
            "qty": 2.0,
            "entry_price": 11.0,
            "exit_price": 12.0,
            "profit": 2.0,
            "commission": 0.0,
            "net_profit": 2.0,
        }
    ]


def test_strategy_exit_supports_qty_percent_for_matching_entry_lot() -> None:
    result = pn.run(
        """
strategy("Exit Percent", overlay=True, initial_capital=1000, pyramiding=2)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=2, price=close)
strategy.entry_when(bar_index == 1, "B", strategy.long, qty=2, price=close)
strategy.exit("Exit A Half", from_entry="A", qty_percent=50, limit=12, when=bar_index == 2)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
            {"time": 4, "open": 13, "high": 14, "low": 12, "close": 13, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [2.0, 4.0, 3.0, 3.0]
    assert result.output["strategy"]["orders"][-1] == {
        "time": 3,
        "id": "Exit A Half",
        "from_entry": "A",
        "type": "exit",
        "side": "flat",
        "qty": 1.0,
        "price": 12.0,
        "position_after": 3.0,
        "reason": "limit",
        "comment": "",
    }
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 3,
            "entry_id": "A",
            "exit_id": "Exit A Half",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "exit_price": 12.0,
            "profit": 2.0,
            "commission": 0.0,
            "net_profit": 2.0,
        }
    ]
    assert result.output["strategy"]["opentrades"] == [
        {
            "entry_time": 1,
            "entry_id": "A",
            "side": "long",
            "qty": 1.0,
            "entry_price": 10.0,
            "profit": 3.0,
        },
        {
            "entry_time": 2,
            "entry_id": "B",
            "side": "long",
            "qty": 2.0,
            "entry_price": 11.0,
            "profit": 4.0,
        },
    ]
    exit_lifecycle = result.output["strategy"]["lifecycle"][-1]
    assert exit_lifecycle["id"] == "Exit A Half"
    assert exit_lifecycle["target_qty"] == 2.0
    assert exit_lifecycle["requested_qty"] == 1.0
    assert exit_lifecycle["filled_qty"] == 1.0
    assert exit_lifecycle["qty_percent"] == 50.0


def test_strategy_exit_qty_takes_precedence_over_qty_percent() -> None:
    result = pn.run(
        """
strategy("Exit Qty Precedence", overlay=True, initial_capital=1000)
strategy.entry_when(bar_index == 0, "Long", strategy.long, qty=4, price=close)
strategy.exit("Exit Some", from_entry="Long", qty=1.5, qty_percent=75, limit=12, when=bar_index == 2)
plot(strategy.position_size, "Position")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Position") == [4.0, 4.0, 2.5]
    assert result.output["strategy"]["orders"][-1]["qty"] == 1.5
    assert result.output["strategy"]["closedtrades"] == [
        {
            "entry_time": 1,
            "exit_time": 3,
            "entry_id": "Long",
            "exit_id": "Exit Some",
            "side": "long",
            "qty": 1.5,
            "entry_price": 10.0,
            "exit_price": 12.0,
            "profit": 3.0,
            "commission": 0.0,
            "net_profit": 3.0,
        }
    ]


def test_strategy_trade_namespaces_expose_count_series_and_fields() -> None:
    result = pn.run(
        """
strategy("Trade Namespace", overlay=True, initial_capital=1000, pyramiding=2)
strategy.entry_when(bar_index == 0, "A", strategy.long, qty=1, price=close, comment="alpha")
strategy.entry_when(bar_index == 1, "B", strategy.long, qty=2, price=close, comment="beta")
strategy.close("A", when=bar_index == 2, price=close, comment="done")
plot(strategy.closedtrades, "Closed Count")
plot(strategy.opentrades, "Open Count")
plot(strategy.closedtrades.profit(0), "First Closed Profit")
plot(strategy.closedtrades.profit_percent(0), "First Closed Profit Percent")
plot(strategy.opentrades.entry_price(0), "First Open Entry")
plot(strategy.opentrades.profit_percent(0), "First Open Profit Percent")
plot(strategy.closedtrades.entry_bar_index(0), "Closed Entry Bar")
plot(strategy.closedtrades.exit_bar_index(0), "Closed Exit Bar")
plot(strategy.opentrades.entry_bar_index(0), "Open Entry Bar")
plot(1 if strategy.closedtrades.entry_id(0) == "A" else 0, "Closed Id Match")
plot(1 if strategy.opentrades.entry_id(0) == "B" else 0, "Open Id Match")
plot(1 if strategy.closedtrades.entry_comment(0) == "alpha" else 0, "Closed Entry Comment")
plot(1 if strategy.closedtrades.exit_comment(0) == "done" else 0, "Closed Exit Comment")
plot(1 if strategy.opentrades.entry_comment(0) == "beta" else 0, "Open Entry Comment")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 11, "high": 12, "low": 10, "close": 11, "volume": 100},
            {"time": 3, "open": 12, "high": 13, "low": 11, "close": 12, "volume": 100},
            {"time": 4, "open": 13, "high": 14, "low": 12, "close": 13, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Closed Count") == [0.0, 0.0, 1.0, 1.0]
    assert result.values("Open Count") == [1.0, 2.0, 1.0, 1.0]
    assert result.values("First Closed Profit") == [2.0, 2.0, 2.0, 2.0]
    assert result.values("First Closed Profit Percent") == [20.0, 20.0, 20.0, 20.0]
    assert result.values("First Open Entry") == [11.0, 11.0, 11.0, 11.0]
    assert result.values("First Open Profit Percent") == [
        18.18181818,
        18.18181818,
        18.18181818,
        18.18181818,
    ]
    assert result.values("Closed Entry Bar") == [0.0, 0.0, 0.0, 0.0]
    assert result.values("Closed Exit Bar") == [2.0, 2.0, 2.0, 2.0]
    assert result.values("Open Entry Bar") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Closed Id Match") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Open Id Match") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Closed Entry Comment") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Closed Exit Comment") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Open Entry Comment") == [1.0, 1.0, 1.0, 1.0]
    assert result.output["strategy"]["closedtrades"][0]["entry_comment"] == "alpha"
    assert result.output["strategy"]["closedtrades"][0]["exit_comment"] == "done"
    assert result.output["strategy"]["opentrades"][0]["entry_comment"] == "beta"
    assert "_entry_bar_index" not in result.output["strategy"]["closedtrades"][0]
    assert "_entry_bar_index" not in result.output["strategy"]["opentrades"][0]


def test_strategy_trade_accessors_return_zero_for_empty_default_trade() -> None:
    result = pn.run(
        """
strategy("Empty Trade Accessors", overlay=True, initial_capital=1000)
plot(strategy.closedtrades.profit(0), "Closed Profit")
plot(strategy.closedtrades.profit_percent(0), "Closed Profit Percent")
plot(strategy.closedtrades.commission(-1), "Closed Commission")
plot(strategy.opentrades.profit(0), "Open Profit")
plot(1 if na(strategy.closedtrades.profit(99)) else 0, "Closed Far Missing Is Na")
""",
        [
            {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
            {"time": 2, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Closed Profit") == [0.0, 0.0]
    assert result.values("Closed Profit Percent") == [0.0, 0.0]
    assert result.values("Closed Commission") == [0.0, 0.0]
    assert result.values("Open Profit") == [0.0, 0.0]
    assert result.values("Closed Far Missing Is Na") == [1.0, 1.0]
