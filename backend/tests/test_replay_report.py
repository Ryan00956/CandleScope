from __future__ import annotations

from app.replay.broker.models import FillReason, OrderSide
from tests.fixtures.replay.broker_fakes import bar, make_broker, request


def test_report_is_recomputable_from_ledger_fills_and_closed_trades() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="long"), command_id="cmd-long")
    broker.apply_bar(bar(0, 100))
    broker.close_position(command_id="cmd-close")
    broker.apply_bar(bar(1, 105))
    report = broker.build_report()

    assert report.trade_count == 1
    assert report.winning_trades == 1
    assert report.win_rate == "1"
    assert report.realized_pnl == broker.account.realized_pnl
    assert report.fees_paid == broker.account.fees_paid
    assert report.final_equity == broker.account.equity
    assert report.report_hash.startswith("sha256:")
    assert report.verify()


def test_session_end_mark_close_is_synthetic_and_never_claims_historical_fill() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="long"), command_id="cmd-long")
    broker.apply_bar(bar(0, 100))
    result = broker.end_session(
        open_order_disposition="expire",
        position_disposition="mark_close",
        virtual_time_ms=bar(0, 100).close_time_ms,
    )

    assert broker.position.quantity == "0"
    assert len(result.fills) == 1
    fill = result.fills[0]
    assert fill.reason is FillReason.SESSION_END_MARK_CLOSE
    assert fill.synthetic is True
    assert fill.historical_execution is False
    assert broker.build_report().ended is True

    snapshot = broker.snapshot()
    restored = make_broker()
    restored.restore(snapshot)
    assert restored.snapshot() == snapshot
    assert restored.build_report().report_hash == broker.build_report().report_hash


def test_report_counts_explicit_ambiguous_bar_warnings() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="entry"), command_id="cmd-entry")
    broker.apply_bar(bar(0, 100))
    broker.place_order(
        request(
            client_order_id="exit-a",
            side=OrderSide.SELL,
            order_type="STOP_MARKET",
            reduce_only=True,
            stop_price="101",
        ),
        command_id="cmd-exit-a",
    )
    broker.place_order(
        request(
            client_order_id="exit-b",
            side=OrderSide.SELL,
            order_type="TAKE_PROFIT_MARKET",
            reduce_only=True,
            stop_price="104",
        ),
        command_id="cmd-exit-b",
    )
    broker.apply_bar(bar(1, 102))
    assert broker.build_report().ambiguous_bar_count == 1
