from __future__ import annotations

import asyncio

from app.data_engine.backfill.models import FetchedBar
from app.data_engine.bar_aggregator import BarAggregator, BarAggregatorConfig
from app.data_engine.bar_aggregator.bar_state import StandardOHLCVMerge
from app.data_engine.bar_aggregator.models import (
    BarInput,
    BarInputSource,
    BarState,
)
from app.data_engine.data_manager.custom_query import _aggregate_rows_to_interval
from app.data_engine.data_manager.models import BarData
from app.data_engine.interval_policy import aggregate_rows_by_month
from app.data_engine.market_data.kline_metrics import KLINE_ENHANCED_FIELDS


def _storage_row(exchange: str = "binance") -> dict:
    return {
        "exchange": exchange,
        "market_type": "spot",
        "open_time": 1_700_000_000_000,
        "open": 100,
        "high": 110,
        "low": 90,
        "close": 105,
        "volume": 10,
        "quote_volume": 1_000,
        "trades": 25,
        "taker_buy_base": 6,
        "taker_buy_quote": 650,
    }


def test_binance_storage_row_exposes_raw_and_derived_kline_metrics() -> None:
    bar = BarData.from_storage_row(_storage_row())

    assert bar.to_dict() == {
        "time": 1_700_000_000,
        "open": 100,
        "high": 110,
        "low": 90,
        "close": 105,
        "volume": 10,
        "is_closed": True,
    }
    payload = bar.to_kline_dict()
    assert payload["quote_volume"] == 1_000
    assert payload["trades"] == 25
    assert payload["taker_buy_base"] == 6
    assert payload["taker_buy_quote"] == 650
    assert payload["order_flow"] == {
        "taker_sell_base": 4,
        "volume_delta_base": 2,
        "taker_buy_ratio_base": 0.6,
        "cvd_contribution_base": 2,
    }


def test_okx_placeholder_zeros_are_suppressed_by_capability() -> None:
    bar = BarData.from_storage_row(_storage_row("okx"))

    payload = bar.to_kline_dict()
    assert payload["quote_volume"] == 1_000
    assert payload["trades"] is None
    assert payload["taker_buy_base"] is None
    assert payload["taker_buy_quote"] is None
    assert payload["order_flow"] is None


def test_okx_swap_uses_futures_capability_alias() -> None:
    row = _storage_row("okx")
    row["market_type"] = "swap"

    payload = BarData.from_storage_row(row).to_kline_dict()

    assert payload["quote_volume"] == 1_000
    assert payload["trades"] is None
    assert payload["order_flow"] is None


def test_storage_without_market_context_fails_closed() -> None:
    row = _storage_row()
    row.pop("exchange")
    row.pop("market_type")

    unknown = BarData.from_storage_row(row).to_kline_dict()
    okx = BarData.from_storage_row(
        row,
        exchange="okx",
        market_type="spot",
    ).to_kline_dict()

    assert unknown["quote_volume"] is None
    assert unknown["order_flow"] is None
    assert okx["quote_volume"] == 1_000
    assert okx["trades"] is None


def test_invalid_enhanced_values_fail_closed_and_never_emit_nan() -> None:
    bar = BarData(
        time=1,
        open=1,
        high=1,
        low=1,
        close=1,
        volume=10,
        quote_volume=float("inf"),
        trades=True,
        taker_buy_base=11,
        taker_buy_quote=float("nan"),
    )

    payload = bar.to_kline_dict()
    assert payload["quote_volume"] is None
    assert payload["trades"] is None
    assert payload["taker_buy_base"] is None
    assert payload["taker_buy_quote"] is None
    assert payload["order_flow"] is None

    from_dict = BarData.from_dict({
        "time": 1,
        "open": 1,
        "high": 1,
        "low": 1,
        "close": 1,
        "volume": 10,
        "quote_volume": "not-a-number",
        "trades": 1.5,
        "taker_buy_base": -1,
        "taker_buy_quote": True,
    }).to_kline_dict()
    assert from_dict["quote_volume"] is None
    assert from_dict["trades"] is None
    assert from_dict["taker_buy_base"] is None
    assert from_dict["taker_buy_quote"] is None


def test_zero_volume_is_valid_but_ratio_is_undefined() -> None:
    payload = BarData(
        time=1,
        open=1,
        high=1,
        low=1,
        close=1,
        volume=0,
        taker_buy_base=0,
    ).to_kline_dict()

    assert payload["order_flow"] is not None
    assert payload["order_flow"]["volume_delta_base"] == 0
    assert payload["order_flow"]["taker_buy_ratio_base"] is None


def test_legacy_positive_volume_with_zero_quote_placeholders_fails_closed() -> None:
    payload = BarData(
        time=1,
        open=100,
        high=100,
        low=100,
        close=100,
        volume=2,
        quote_volume=0,
        trades=0,
        taker_buy_base=0,
        taker_buy_quote=0,
    ).to_kline_dict()

    assert payload["quote_volume"] is None
    assert payload["trades"] is None
    assert payload["taker_buy_base"] is None
    assert payload["order_flow"] is None


def test_with_closed_state_preserves_enhanced_fields() -> None:
    original = BarData.from_storage_row(_storage_row())

    forming = original.with_closed_state(False)

    assert forming.is_closed is False
    assert forming.quote_volume == original.quote_volume
    assert forming.trades == original.trades
    assert forming.taker_buy_base == original.taker_buy_base
    assert forming.taker_buy_quote == original.taker_buy_quote
    assert forming.to_kline_dict()["order_flow"] == original.to_kline_dict()["order_flow"]


def test_forming_snapshot_replaces_current_cvd_contribution() -> None:
    merge = StandardOHLCVMerge()
    state = BarState(
        symbol="BTCUSDT",
        interval="1m",
        bucket_start_ms=1_700_000_000_000,
        bucket_end_ms=1_700_000_060_000,
        open=0,
        high=0,
        low=0,
        close=0,
        volume=0,
    )
    first = _snapshot_input(volume=10, taker_buy_base=6)
    latest = _snapshot_input(volume=12, taker_buy_base=7)

    merge.apply(state, first, is_new=True)
    merge.apply(state, latest, is_new=False)
    payload = BarData.from_bar_state(state).to_kline_dict()

    assert state.volume == 12
    assert state.taker_buy_base == 7
    assert payload["order_flow"]["cvd_contribution_base"] == 2


def test_custom_and_monthly_intervals_sum_complete_enhanced_fields() -> None:
    rows = [
        _lightweight_row(1_704_067_200, volume=10, quote=1_000, trades=2, buy=6, buy_quote=650),
        _lightweight_row(1_704_067_260, volume=20, quote=2_000, trades=3, buy=9, buy_quote=900),
    ]

    custom = _aggregate_rows_to_interval(
        rows,
        120,
        source_interval_seconds=60,
    )[0]
    monthly_rows = [dict(row) for row in rows]
    monthly_rows[-1]["is_closed"] = False
    monthly = aggregate_rows_by_month(
        monthly_rows,
        source_interval_seconds=60,
    )[0]
    for aggregate in (custom, monthly):
        assert aggregate["volume"] == 30
        assert aggregate["quote_volume"] == 3_000
        assert aggregate["trades"] == 5
        assert aggregate["taker_buy_base"] == 15
        assert aggregate["taker_buy_quote"] == 1_550
        metrics = BarData.from_dict(aggregate).to_kline_dict()["order_flow"]
        assert metrics["volume_delta_base"] == 0
        assert metrics["cvd_contribution_base"] == 0


def test_custom_interval_does_not_sum_partial_enhanced_data() -> None:
    rows = [
        _lightweight_row(0, volume=10, quote=100, trades=1, buy=6, buy_quote=60),
        _lightweight_row(60, volume=10, quote=None, trades=None, buy=None, buy_quote=None),
    ]

    aggregate = _aggregate_rows_to_interval(
        rows,
        120,
        source_interval_seconds=60,
    )[0]

    assert aggregate["quote_volume"] is None
    assert aggregate["trades"] is None
    assert aggregate["taker_buy_base"] is None
    assert aggregate["taker_buy_quote"] is None
    assert BarData.from_dict(aggregate).to_kline_dict()["order_flow"] is None


def test_invalid_component_cannot_become_valid_after_custom_sum() -> None:
    rows = [
        _lightweight_row(0, volume=10, quote=100, trades=1, buy=12, buy_quote=60),
        _lightweight_row(60, volume=10, quote=100, trades=1, buy=0, buy_quote=40),
    ]

    custom = _aggregate_rows_to_interval(
        rows,
        120,
        source_interval_seconds=60,
    )[0]
    rows[-1]["is_closed"] = False
    monthly = aggregate_rows_by_month(
        rows,
        source_interval_seconds=60,
    )[0]

    for aggregate in (custom, monthly):
        assert aggregate["taker_buy_base"] is None
        assert BarData.from_dict(aggregate).to_kline_dict()["order_flow"] is None


def test_aggregate_batch_preserves_masks_gaps_and_storage_roundtrip() -> None:
    async def _run() -> None:
        aggregator = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        complete_rows = [
            _storage_component(0, volume=10, buy=6),
            _storage_component(60_000, volume=20, buy=9),
        ]
        complete_states = await aggregator.aggregate_batch(
            "BTCUSDT",
            "2m",
            "1m",
            complete_rows,
            exchange="binance",
            market_type="spot",
        )
        assert len(complete_states) == 1
        complete = BarData.from_bar_state(complete_states[0]).to_kline_dict()
        assert complete["quote_volume"] == 3_000
        assert complete["trades"] == 4
        assert complete["order_flow"]["volume_delta_base"] == 0

        invalid_rows = [
            _storage_component(0, volume=10, buy=12),
            _storage_component(60_000, volume=10, buy=0),
        ]
        invalid_state = (await aggregator.aggregate_batch(
            "BTCUSDT",
            "2m",
            "1m",
            invalid_rows,
            exchange="binance",
            market_type="spot",
        ))[0]
        invalid = BarData.from_bar_state(invalid_state).to_kline_dict()
        assert invalid["taker_buy_base"] is None
        assert invalid["order_flow"] is None

        persisted = invalid_state.to_storage_dict()
        persisted.update({"exchange": "binance", "market_type": "spot"})
        restored = BarData.from_storage_row(persisted).to_kline_dict()
        assert persisted["taker_buy_base"] is None
        assert restored["taker_buy_base"] is None
        assert restored["order_flow"] is None

        gapped_rows = [
            _storage_component(0, volume=10, buy=6),
            _storage_component(120_000, volume=10, buy=6),
            _storage_component(360_000, volume=10, buy=6),
        ]
        gapped_state = (await aggregator.aggregate_batch(
            "BTCUSDT",
            "7m",
            "1m",
            gapped_rows,
            exchange="binance",
            market_type="spot",
        ))[0]
        gapped = BarData.from_bar_state(gapped_state).to_kline_dict()
        assert gapped["quote_volume"] is None
        assert gapped["order_flow"] is None

        okx_state = (await aggregator.aggregate_batch(
            "BTC-USDT",
            "2m",
            "1m",
            complete_rows,
            exchange="okx",
            market_type="swap",
        ))[0]
        okx = BarData.from_bar_state(okx_state).to_kline_dict()
        assert okx["quote_volume"] == 3_000
        assert okx["trades"] is None
        assert okx["order_flow"] is None

    asyncio.run(_run())


def test_fetched_bar_cache_and_storage_shapes_keep_availability_mask() -> None:
    okx = FetchedBar(
        symbol="BTC-USDT",
        interval="1m",
        open_time=0,
        close_time=59_999,
        open=100,
        high=100,
        low=100,
        close=100,
        volume=10,
        exchange="okx",
        market_type="swap",
        quote_volume=1_000,
        trades=0,
        taker_buy_base=0,
        taker_buy_quote=0,
        enhanced_fields=frozenset({"quote_volume"}),
    )

    for payload in (okx.to_storage_dict(), okx.to_lightweight()):
        assert payload["quote_volume"] == 1_000
        assert payload["trades"] is None
        assert payload["taker_buy_base"] is None
        assert payload["taker_buy_quote"] is None


def _snapshot_input(*, volume: float, taker_buy_base: float) -> BarInput:
    return BarInput(
        symbol="BTCUSDT",
        source_interval="1m",
        open_time_ms=1_700_000_000_000,
        close_time_ms=1_700_000_059_999,
        open=100,
        high=110,
        low=90,
        close=105,
        volume=volume,
        source=BarInputSource.REALTIME,
        is_closed=False,
        quote_volume=volume * 100,
        trades=10,
        taker_buy_base=taker_buy_base,
        taker_buy_quote=taker_buy_base * 100,
        enhanced_fields=frozenset(KLINE_ENHANCED_FIELDS),
    )


def _lightweight_row(
    time: int,
    *,
    volume: float,
    quote: float | None,
    trades: int | None,
    buy: float | None,
    buy_quote: float | None,
) -> dict:
    return {
        "time": time,
        "open": 100,
        "high": 110,
        "low": 90,
        "close": 105,
        "volume": volume,
        "quote_volume": quote,
        "trades": trades,
        "taker_buy_base": buy,
        "taker_buy_quote": buy_quote,
        "is_closed": True,
    }


def _storage_component(open_time: int, *, volume: float, buy: float) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + 59_999,
        "open": 100,
        "high": 101,
        "low": 99,
        "close": 100,
        "volume": volume,
        "quote_volume": volume * 100,
        "trades": 2,
        "taker_buy_base": buy,
        "taker_buy_quote": buy * 100,
        "is_closed": True,
    }
