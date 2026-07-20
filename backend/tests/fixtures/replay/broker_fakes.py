from __future__ import annotations

from app.replay.bars.builder import ReplayBarBuilder
from app.replay.broker.execution import ConservativeBarBroker
from app.replay.broker.models import (
    BrokerConfig,
    BrokerLimits,
    InstrumentFilters,
    OrderRequest,
    OrderSide,
    OrderType,
)
from tests.fixtures.replay.bar_builder_fakes import (
    INTERVAL_MS,
    REPLAY_START_MS,
    make_replay_bar,
)


FILTERS = InstrumentFilters(
    price_tick="0.1",
    quantity_step="0.001",
    min_quantity="0.001",
    max_quantity="100",
    min_notional="5",
    max_notional="1000000",
    quote_step="0.00000001",
)

LIMITS = BrokerLimits(
    max_leverage="5",
    max_position_notional="50000",
    max_order_quantity="10",
    max_open_orders=64,
    max_orders=256,
    max_fills=512,
    max_ledger_entries=4096,
    max_warnings=256,
)

CONFIG = BrokerConfig(
    initial_equity="10000",
    quote_asset="USDT",
    maker_bps="2",
    taker_bps="4",
    market_slippage_bps="1",
    initial_mark_price="100",
    instrument=FILTERS,
    limits=LIMITS,
)


def make_broker(
    *,
    config: BrokerConfig = CONFIG,
    display_interval: str = "1m",
    max_closed_bars: int = 32,
) -> ConservativeBarBroker:
    builder = ReplayBarBuilder(
        base_interval="1m",
        display_interval=display_interval,
        replay_start_ms=REPLAY_START_MS,
        warmup_bars=(),
        max_closed_bars=max_closed_bars,
    )
    return ConservativeBarBroker(config=config, bar_builder=builder)


def request(
    *,
    client_order_id: str,
    side: OrderSide | str = OrderSide.BUY,
    order_type: OrderType | str = OrderType.MARKET,
    quantity: str = "1",
    reduce_only: bool = False,
    limit_price: str | None = None,
    stop_price: str | None = None,
) -> OrderRequest:
    return OrderRequest(
        client_order_id=client_order_id,
        side=side,
        order_type=order_type,
        quantity=quantity,
        reduce_only=reduce_only,
        limit_price=limit_price,
        stop_price=stop_price,
    )


def bar(index: int, value: int | str):
    return make_replay_bar(
        REPLAY_START_MS + index * INTERVAL_MS,
        value,
        volume="10",
    )
