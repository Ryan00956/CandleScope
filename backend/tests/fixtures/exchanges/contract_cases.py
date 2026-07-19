from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from app.core.market import VALID_INTERVALS
from app.data_engine.ingestion.models import (
    DataSource,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.data_engine.market_data.kline_metrics import KLINE_DERIVED_FIELDS
from app.exchanges.contracts import ExchangeContractCase, NormalizerContractSample


@dataclass(frozen=True, slots=True)
class ChannelCapabilityExpectation:
    """Exact built-in capability contract for one market/channel pair."""

    delivery: DeliveryClass
    snapshot: bool
    delta: bool
    history: bool
    sequence: str
    resync: str
    connection_model: str
    available_fields: frozenset[str]
    unavailable_fields: frozenset[str] = frozenset()
    derived_fields: frozenset[str] = frozenset()
    params: tuple[tuple[str, tuple[Any, ...]], ...] = ()
    update_intervals_ms: tuple[int, ...] = ()
    limits: tuple[tuple[str, Any], ...] = ()
    known_limitations: tuple[str, ...] = ()
    realtime_transports: tuple[TransportMode, ...] = (
        TransportMode.WEBSOCKET,
        TransportMode.REST_POLL,
    )


_BINANCE_FIELDS = {
    MarketChannel.KLINE: frozenset({
        "interval",
        "open_time",
        "close_time",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "quote_volume",
        "trades",
        "taker_buy_base",
        "taker_buy_quote",
        "is_closed",
    }),
    MarketChannel.AGG_TRADE: frozenset({
        "agg_trade_id",
        "price",
        "quantity",
        "first_trade_id",
        "last_trade_id",
        "trade_time_ms",
        "is_buyer_maker",
    }),
    MarketChannel.TRADE: frozenset({
        "trade_id",
        "price",
        "quantity",
        "trade_time_ms",
        "is_buyer_maker",
        "buyer_order_id",
        "seller_order_id",
    }),
    MarketChannel.TICKER: frozenset({
        "price_change",
        "price_change_pct",
        "weighted_avg_price",
        "prev_close_price",
        "last_price",
        "last_qty",
        "bid_price",
        "bid_qty",
        "ask_price",
        "ask_qty",
        "open_price",
        "high_price",
        "low_price",
        "volume",
        "quote_volume",
        "open_time",
        "close_time",
        "trades",
    }),
    MarketChannel.MINI_TICKER: frozenset({
        "close_price",
        "open_price",
        "high_price",
        "low_price",
        "volume",
        "quote_volume",
    }),
    MarketChannel.DEPTH: frozenset({"last_update_id", "bids", "asks"}),
    MarketChannel.FULL_DEPTH: frozenset({
        "kind",
        "last_update_id",
        "first_update_id",
        "final_update_id",
        "previous_final_update_id",
        "event_time_ms",
        "transaction_time_ms",
        "update_interval_ms",
        "snapshot_limit",
        "bids",
        "asks",
    }),
    MarketChannel.MARK_PRICE: frozenset({"mark_price"}),
    MarketChannel.INDEX_PRICE: frozenset({"index_price"}),
    MarketChannel.FUNDING_RATE: frozenset({"funding_rate"}),
    MarketChannel.OPEN_INTEREST: frozenset({"open_interest"}),
    MarketChannel.LIQUIDATION: frozenset({
        "order_side",
        "position_side",
        "order_type",
        "time_in_force",
        "original_quantity",
        "order_price",
        "average_price",
        "order_status",
        "last_filled_quantity",
        "filled_quantity",
        "trade_time_ms",
        "pair_symbol",
        "symbol_type",
    }),
}

_OKX_KLINE_FIELDS = frozenset({
    "interval",
    "open_time",
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "is_closed",
})
_OKX_KLINE_UNAVAILABLE_FIELDS = frozenset({
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
})
_OKX_TICKER_FIELDS = frozenset({
    "last_price",
    "open_price",
    "high_price",
    "low_price",
    "price_change_pct",
    "volume",
    "quote_volume",
})
_BINANCE_FUTURES_TICKER_UNAVAILABLE_FIELDS = frozenset({
    "prev_close_price",
    "bid_price",
    "bid_qty",
    "ask_price",
    "ask_qty",
})
_BINANCE_FUTURES_DEPTH_FIELDS = frozenset({
    "last_update_id",
    "first_update_id",
    "final_update_id",
    "previous_final_update_id",
    "event_time_ms",
    "transaction_time_ms",
    "depth_levels",
    "update_interval_ms",
    "bids",
    "asks",
})
_BINANCE_SPOT_FULL_DEPTH_FIELDS = frozenset({
    "kind",
    "last_update_id",
    "first_update_id",
    "final_update_id",
    "event_time_ms",
    "update_interval_ms",
    "snapshot_limit",
    "bids",
    "asks",
})

_BINANCE_SPOT_EXPECTATIONS = {
    MarketChannel.KLINE: ChannelCapabilityExpectation(
        delivery=DeliveryClass.APPEND,
        snapshot=True,
        delta=False,
        history=True,
        sequence="timestamp",
        resync="replace_snapshot",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.KLINE],
        derived_fields=frozenset(KLINE_DERIVED_FIELDS),
        params=(("interval", tuple(VALID_INTERVALS)),),
        update_intervals_ms=(1000, 2000),
        limits=(("rest.max_limit", 1000),),
    ),
    MarketChannel.AGG_TRADE: ChannelCapabilityExpectation(
        delivery=DeliveryClass.APPEND,
        snapshot=False,
        delta=False,
        history=True,
        sequence="monotonic_id",
        resync="snapshot_replay",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.AGG_TRADE],
        limits=(("rest.max_limit", 1000),),
    ),
    MarketChannel.TRADE: ChannelCapabilityExpectation(
        delivery=DeliveryClass.APPEND,
        snapshot=False,
        delta=False,
        history=False,
        sequence="monotonic_id",
        resync="none",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.TRADE],
        known_limitations=(
            "REST exposes only recent trades and is not a historical range source",
            "Buyer and seller order IDs are WebSocket-only; REST normalizer zero placeholders are not data",
        ),
    ),
    MarketChannel.TICKER: ChannelCapabilityExpectation(
        delivery=DeliveryClass.LATEST,
        snapshot=True,
        delta=False,
        history=False,
        sequence="none",
        resync="none",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.TICKER],
        update_intervals_ms=(1000,),
    ),
    MarketChannel.MINI_TICKER: ChannelCapabilityExpectation(
        delivery=DeliveryClass.LATEST,
        snapshot=True,
        delta=False,
        history=False,
        sequence="none",
        resync="none",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.MINI_TICKER],
        update_intervals_ms=(1000,),
    ),
    MarketChannel.DEPTH: ChannelCapabilityExpectation(
        delivery=DeliveryClass.SNAPSHOT,
        snapshot=True,
        delta=False,
        history=False,
        sequence="monotonic_id",
        resync="replace_snapshot",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.DEPTH],
        params=(("depth_levels", (5, 10, 20)),),
        update_intervals_ms=(100, 1000),
        limits=(("rest.max_limit", 5000),),
        known_limitations=(
            "Current depth events are replaceable snapshots, not ordered full-book deltas",
        ),
    ),
    MarketChannel.FULL_DEPTH: ChannelCapabilityExpectation(
        delivery=DeliveryClass.ORDERED_DELTA,
        snapshot=True,
        delta=True,
        history=False,
        sequence="range",
        resync="replace_snapshot",
        connection_model="path_per_stream",
        available_fields=_BINANCE_SPOT_FULL_DEPTH_FIELDS,
        params=(("snapshot_limit", (5, 10, 20, 50, 100, 500, 1000, 5000)),),
        update_intervals_ms=(100, 1000),
        limits=(
            ("rest.default_limit", 100),
            ("rest.max_limit", 5000),
        ),
        known_limitations=(
            "A local full book is valid only after REST snapshot alignment with buffered WebSocket deltas",
            "A first-update range beyond the previous local update ID requires a fresh snapshot and buffered-delta replay",
            "The REST snapshot is bounded, so untouched levels outside the initial snapshot are unknown",
            "Binance Spot exposes no historical full-order-book replay endpoint",
        ),
        realtime_transports=(
            TransportMode.WEBSOCKET,
            TransportMode.REST_SNAPSHOT,
        ),
    ),
}

_BINANCE_CHANNEL_EXPECTATIONS = {
    **{
        ("spot", channel): expectation
        for channel, expectation in _BINANCE_SPOT_EXPECTATIONS.items()
    },
    ("futures", MarketChannel.KLINE): replace(
        _BINANCE_SPOT_EXPECTATIONS[MarketChannel.KLINE],
        params=(("interval", tuple(item for item in VALID_INTERVALS if item != "1s")),),
        update_intervals_ms=(250,),
        known_limitations=("The USD-M kline endpoint does not support 1s bars",),
    ),
    ("futures", MarketChannel.AGG_TRADE): replace(
        _BINANCE_SPOT_EXPECTATIONS[MarketChannel.AGG_TRADE],
        update_intervals_ms=(100,),
        limits=(
            ("history.max_age_ms", 86_400_000),
            ("history.max_window_ms", 3_600_000),
            ("rest.max_limit", 1000),
        ),
        known_limitations=(
            "USD-M aggregate-trade history is limited to the last 24 hours",
            "Each USD-M aggregate-trade time range must be shorter than one hour",
        ),
    ),
    ("futures", MarketChannel.TRADE): _BINANCE_SPOT_EXPECTATIONS[MarketChannel.TRADE],
    ("futures", MarketChannel.TICKER): replace(
        _BINANCE_SPOT_EXPECTATIONS[MarketChannel.TICKER],
        available_fields=(
            _BINANCE_FIELDS[MarketChannel.TICKER]
            - _BINANCE_FUTURES_TICKER_UNAVAILABLE_FIELDS
        ),
        unavailable_fields=_BINANCE_FUTURES_TICKER_UNAVAILABLE_FIELDS,
        known_limitations=(
            "USD-M 24h ticker omits prev-close and best bid/ask fields; normalizer zero placeholders are not data",
        ),
    ),
    ("futures", MarketChannel.MINI_TICKER): _BINANCE_SPOT_EXPECTATIONS[
        MarketChannel.MINI_TICKER
    ],
    ("futures", MarketChannel.DEPTH): replace(
        _BINANCE_SPOT_EXPECTATIONS[MarketChannel.DEPTH],
        available_fields=_BINANCE_FUTURES_DEPTH_FIELDS,
        update_intervals_ms=(100, 250, 500),
        limits=(("rest.max_limit", 1000),),
    ),
    ("futures", MarketChannel.FULL_DEPTH): ChannelCapabilityExpectation(
        delivery=DeliveryClass.ORDERED_DELTA,
        snapshot=True,
        delta=True,
        history=False,
        sequence="previous_link",
        resync="replace_snapshot",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.FULL_DEPTH],
        params=(("snapshot_limit", (5, 10, 20, 50, 100, 500, 1000)),),
        update_intervals_ms=(100, 250, 500),
        limits=(
            ("rest.default_limit", 500),
            ("rest.max_limit", 1000),
        ),
        known_limitations=(
            "A local full book is valid only after REST snapshot alignment with buffered WebSocket deltas",
            "Any broken previous-update link requires a fresh snapshot and buffered-delta replay",
            "Retail Price Improvement orders are excluded from both snapshot and delta feeds",
            "USD-M exposes no historical full-order-book replay endpoint",
        ),
        realtime_transports=(
            TransportMode.WEBSOCKET,
            TransportMode.REST_SNAPSHOT,
        ),
    ),
    ("futures", MarketChannel.MARK_PRICE): ChannelCapabilityExpectation(
        delivery=DeliveryClass.LATEST,
        snapshot=True,
        delta=False,
        history=False,
        sequence="none",
        resync="none",
        connection_model="shared_multiplex",
        available_fields=_BINANCE_FIELDS[MarketChannel.MARK_PRICE],
        derived_fields=frozenset({"basis", "basis_rate", "basis_bps"}),
        update_intervals_ms=(1000, 3000),
        limits=(("websocket.multiplex_scope", "symbols"),),
        known_limitations=("Mark-price OHLC history uses a different kline contract",),
    ),
    ("futures", MarketChannel.INDEX_PRICE): ChannelCapabilityExpectation(
        delivery=DeliveryClass.LATEST,
        snapshot=True,
        delta=False,
        history=False,
        sequence="none",
        resync="none",
        connection_model="shared_multiplex",
        available_fields=_BINANCE_FIELDS[MarketChannel.INDEX_PRICE],
        update_intervals_ms=(1000, 3000),
        limits=(("websocket.multiplex_scope", "symbols"),),
        known_limitations=(
            "Realtime index price shares the mark-price upstream stream",
            "Index-price OHLC history uses a different kline contract",
        ),
    ),
    ("futures", MarketChannel.FUNDING_RATE): ChannelCapabilityExpectation(
        delivery=DeliveryClass.LATEST,
        snapshot=True,
        delta=False,
        history=True,
        sequence="none",
        resync="none",
        connection_model="shared_multiplex",
        available_fields=_BINANCE_FIELDS[MarketChannel.FUNDING_RATE],
        update_intervals_ms=(1000, 3000),
        limits=(
            ("history.max_limit", 1000),
            ("history.shared_requests_per_5m", 500),
        ),
        known_limitations=("Realtime funding data shares the mark-price upstream stream",),
    ),
    ("futures", MarketChannel.OPEN_INTEREST): ChannelCapabilityExpectation(
        delivery=DeliveryClass.LATEST,
        snapshot=True,
        delta=False,
        history=True,
        sequence="none",
        resync="none",
        connection_model="polling_only",
        available_fields=_BINANCE_FIELDS[MarketChannel.OPEN_INTEREST],
        params=(("period", ("5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d")),),
        update_intervals_ms=(5000,),
        limits=(
            ("history.max_age_ms", 2_592_000_000),
            ("history.max_limit", 500),
            ("history.requests_per_5m", 1000),
            ("realtime.request_weight", 1),
            ("service.max_active_streams", 64),
        ),
        known_limitations=(
            "Binance USD-M exposes open interest through REST, not a public WS stream",
        ),
        realtime_transports=(TransportMode.REST_POLL,),
    ),
    ("futures", MarketChannel.LIQUIDATION): ChannelCapabilityExpectation(
        delivery=DeliveryClass.APPEND,
        snapshot=False,
        delta=False,
        history=False,
        sequence="none",
        resync="none",
        connection_model="path_per_stream",
        available_fields=_BINANCE_FIELDS[MarketChannel.LIQUIDATION],
        update_intervals_ms=(1000,),
        known_limitations=(
            "Binance publishes only the latest liquidation order per symbol within each 1000ms window",
            "The public liquidation stream has no sequence or public order ID, so exact continuity and deduplication are unavailable",
            "Binance exposes no public market-level liquidation history, so disconnect gaps cannot be backfilled",
        ),
        realtime_transports=(TransportMode.WEBSOCKET,),
    ),
}

_OKX_KLINE_EXPECTATION = ChannelCapabilityExpectation(
        delivery=DeliveryClass.APPEND,
        snapshot=True,
        delta=False,
        history=True,
        sequence="timestamp",
        resync="replace_snapshot",
        connection_model="shared_multiplex",
        available_fields=_OKX_KLINE_FIELDS,
        unavailable_fields=_OKX_KLINE_UNAVAILABLE_FIELDS,
        params=((
            "interval",
            ("1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w", "1M"),
        ),),
        update_intervals_ms=(1000,),
        limits=(
            ("rest.max_limit", 300),
            ("websocket.multiplex_scope", "symbol_intervals"),
        ),
        known_limitations=(
            "Trade count and taker-buy fields are unavailable; normalized zero placeholders are not data",
            "Current shared WebSocket hubs multiplex intervals only; each symbol has its own connection",
        ),
    )
_OKX_SPOT_TICKER_EXPECTATION = ChannelCapabilityExpectation(
        delivery=DeliveryClass.LATEST,
        snapshot=True,
        delta=False,
        history=False,
        sequence="none",
        resync="none",
        connection_model="message_per_stream",
        available_fields=_OKX_TICKER_FIELDS,
        update_intervals_ms=(100,),
        known_limitations=(
            "Ticker streams use individual message-subscription sessions in the current runtime",
        ),
    )
_OKX_CHANNEL_EXPECTATIONS = {
    ("spot", MarketChannel.KLINE): _OKX_KLINE_EXPECTATION,
    ("futures", MarketChannel.KLINE): _OKX_KLINE_EXPECTATION,
    ("spot", MarketChannel.TICKER): _OKX_SPOT_TICKER_EXPECTATION,
    ("futures", MarketChannel.TICKER): replace(
        _OKX_SPOT_TICKER_EXPECTATION,
        available_fields=_OKX_TICKER_FIELDS - {"quote_volume"},
        unavailable_fields=frozenset({"quote_volume"}),
        known_limitations=(
            "Ticker streams use individual message-subscription sessions in the current runtime",
            "For derivatives, volCcy24h is base-currency volume; normalized quote_volume is not data",
            "For derivatives, normalized volume is contract count rather than base-asset volume",
        ),
    ),
}

_STREAM_TYPE_TO_CHANNEL = {
    StreamType.KLINE: MarketChannel.KLINE,
    StreamType.AGG_TRADE: MarketChannel.AGG_TRADE,
    StreamType.TRADE: MarketChannel.TRADE,
    StreamType.TICKER: MarketChannel.TICKER,
    StreamType.MINI_TICKER: MarketChannel.MINI_TICKER,
    StreamType.DEPTH: MarketChannel.DEPTH,
    StreamType.FULL_DEPTH: MarketChannel.FULL_DEPTH,
    StreamType.MARK_PRICE: MarketChannel.MARK_PRICE,
    StreamType.INDEX_PRICE: MarketChannel.INDEX_PRICE,
    StreamType.FUNDING_RATE: MarketChannel.FUNDING_RATE,
    StreamType.OPEN_INTEREST: MarketChannel.OPEN_INTEREST,
    StreamType.LIQUIDATION: MarketChannel.LIQUIDATION,
}


def builtin_exchange_channel_expectations(
) -> dict[str, dict[tuple[str, MarketChannel], ChannelCapabilityExpectation]]:
    """Return the authoritative v2 market/channel matrix for built-ins."""

    return {
        "binance": dict(_BINANCE_CHANNEL_EXPECTATIONS),
        "okx": dict(_OKX_CHANNEL_EXPECTATIONS),
    }


def builtin_exchange_contract_cases() -> dict[str, list[ExchangeContractCase]]:
    """Contract fixtures covering every declared built-in market/channel pair."""

    return {
        "binance": [
            _binance_case(market_type, stream_type)
            for market_type in ("spot", "futures")
            for stream_type in (
                StreamType.KLINE,
                StreamType.AGG_TRADE,
                StreamType.TRADE,
                StreamType.TICKER,
                StreamType.MINI_TICKER,
                StreamType.DEPTH,
            )
        ] + [
            _binance_case("spot", StreamType.FULL_DEPTH),
        ] + [
            _binance_case("futures", stream_type)
            for stream_type in (
                StreamType.MARK_PRICE,
                StreamType.INDEX_PRICE,
                StreamType.FUNDING_RATE,
                StreamType.OPEN_INTEREST,
                StreamType.LIQUIDATION,
                StreamType.FULL_DEPTH,
            )
        ],
        "okx": [
            _okx_case(market_type, stream_type)
            for market_type in ("spot", "futures")
            for stream_type in (StreamType.KLINE, StreamType.TICKER)
        ],
    }


def contract_case_channel_key(case: ExchangeContractCase) -> tuple[str, MarketChannel]:
    """Return the canonical capability identity covered by one fixture case."""

    return (
        case.descriptor.market_type,
        _STREAM_TYPE_TO_CHANNEL[case.descriptor.stream_type],
    )


def _binance_case(market_type: str, stream_type: StreamType) -> ExchangeContractCase:
    descriptor = _descriptor("binance", _symbol("binance", market_type), stream_type, market_type)
    http_payload, normalizer_samples = _binance_payloads(stream_type, market_type)
    channel = _STREAM_TYPE_TO_CHANNEL[stream_type]
    expectation = _BINANCE_CHANNEL_EXPECTATIONS[(market_type, channel)]
    required_fields = set(expectation.available_fields)
    for sample in normalizer_samples:
        sample.required_data_fields.update(required_fields)
    return ExchangeContractCase(
        descriptor=descriptor,
        request=_request(descriptor),
        sample_http_payload=http_payload,
        expected_http_rows=None if http_payload is None else 1,
        normalizer_samples=normalizer_samples,
    )


def _okx_case(market_type: str, stream_type: StreamType) -> ExchangeContractCase:
    descriptor = _descriptor("okx", _symbol("okx", market_type), stream_type, market_type)
    expectation = _OKX_CHANNEL_EXPECTATIONS[
        (market_type, _STREAM_TYPE_TO_CHANNEL[stream_type])
    ]
    required_fields = set(expectation.available_fields)
    if stream_type == StreamType.KLINE:
        row = _okx_kline_row()
        http_payload: Any = {"code": "0", "data": [row]}
        samples = [
            NormalizerContractSample(
                payload=row,
                source=DataSource.HTTP_BACKFILL,
                required_data_fields=required_fields,
            ),
            NormalizerContractSample(
                payload=row,
                source=DataSource.HTTP,
                required_data_fields=required_fields,
            ),
            NormalizerContractSample(
                payload={
                    "arg": {"channel": "candle1m", "instId": descriptor.symbol},
                    "data": [row],
                },
                source=DataSource.WEBSOCKET,
                required_data_fields=required_fields,
            ),
        ]
    else:
        row = _okx_ticker_row()
        http_payload = {"code": "0", "data": [row]}
        samples = [
            NormalizerContractSample(
                payload=row,
                source=DataSource.HTTP,
                required_data_fields=required_fields,
            ),
            NormalizerContractSample(
                payload={
                    "arg": {"channel": "tickers", "instId": descriptor.symbol},
                    "data": [row],
                },
                source=DataSource.WEBSOCKET,
                required_data_fields=required_fields,
            ),
        ]
    return ExchangeContractCase(
        descriptor=descriptor,
        request=_request(descriptor),
        sample_http_payload=http_payload,
        expected_http_rows=1,
        normalizer_samples=samples,
    )


def _binance_payloads(
    stream_type: StreamType,
    market_type: str,
) -> tuple[Any, list[NormalizerContractSample]]:
    if stream_type == StreamType.KLINE:
        row = _binance_kline_row()
        return [row], [
            NormalizerContractSample(payload=row, source=DataSource.HTTP_BACKFILL),
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(
                payload={
                    "e": "kline",
                    "E": 1_700_000_000_100,
                    "s": "BTCUSDT",
                    "k": {
                        "t": row[0], "T": row[6], "i": "1m",
                        "o": row[1], "h": row[2], "l": row[3], "c": row[4],
                        "v": row[5], "q": row[7], "n": row[8],
                        "V": row[9], "Q": row[10], "x": True,
                    },
                },
                source=DataSource.WEBSOCKET,
            ),
        ]
    if stream_type == StreamType.AGG_TRADE:
        row = {
            "a": 42, "p": "100.5", "q": "2.5", "f": 100, "l": 102,
            "T": 1_700_000_000_000, "m": False,
        }
        return [row], [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(payload=row, source=DataSource.HTTP_BACKFILL),
            NormalizerContractSample(
                payload={"e": "aggTrade", "E": 1_700_000_000_010, **row},
                source=DataSource.WEBSOCKET,
            ),
        ]
    if stream_type == StreamType.TRADE:
        row = {
            "id": 43,
            "price": "100.5",
            "qty": "2.5",
            "time": 1_700_000_000_000,
            "isBuyerMaker": False,
        }
        ws_row = {
            "e": "trade", "E": 1_700_000_000_010, "t": 43,
            "p": "100.5", "q": "2.5", "T": 1_700_000_000_000,
            "m": False, "b": 501, "a": 502,
        }
        return [row], [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(payload=ws_row, source=DataSource.WEBSOCKET),
        ]
    if stream_type == StreamType.TICKER:
        row = _binance_ticker_http_row(market_type)
        ws_row = {
            "e": "24hrTicker", "E": 1_700_000_000_010,
            "p": "1", "P": "1", "w": "100", "x": "99", "c": "100.5",
            "Q": "0.5", "b": "100", "B": "2", "a": "101", "A": "3",
            "o": "99.5", "h": "110", "l": "90", "v": "12", "q": "1200",
            "O": 1_699_913_600_000, "C": 1_700_000_000_000, "n": 50,
        }
        if market_type == "futures":
            for field in ("x", "b", "B", "a", "A"):
                ws_row.pop(field)
        return row, [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(payload=ws_row, source=DataSource.WEBSOCKET),
        ]
    if stream_type == StreamType.MINI_TICKER:
        row = _binance_ticker_http_row(market_type)
        ws_row = {
            "e": "24hrMiniTicker", "E": 1_700_000_000_010,
            "c": "100.5", "o": "99.5", "h": "110", "l": "90",
            "v": "12", "q": "1200",
        }
        return row, [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(payload=ws_row, source=DataSource.WEBSOCKET),
        ]
    if stream_type == StreamType.DEPTH:
        row = {
            "lastUpdateId": 123,
            "bids": [["100", "2"]],
            "asks": [["101", "3"]],
        }
        if market_type == "futures":
            ws_row = {
                "e": "depthUpdate",
                "E": 1_700_000_000_010,
                "T": 1_700_000_000_009,
                "s": "BTCUSDT",
                "U": 120,
                "u": 124,
                "pu": 119,
                "b": [["100", "2"]],
                "a": [["101", "3"]],
                "ps": "BTCUSDT",
                "st": 1,
            }
        else:
            ws_row = {
                "lastUpdateId": 124,
                "bids": [["100", "2"]],
                "asks": [["101", "3"]],
            }
        return row, [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(
                payload=ws_row,
                source=DataSource.WEBSOCKET,
                required_data_fields=(
                    set(_BINANCE_FUTURES_DEPTH_FIELDS)
                    if market_type == "futures"
                    else set()
                ),
            ),
        ]
    if stream_type == StreamType.FULL_DEPTH:
        row: dict[str, Any] = {
            "lastUpdateId": 123,
            "bids": [["100", "2"]],
            "asks": [["101", "3"]],
        }
        ws_row: dict[str, Any] = {
            "e": "depthUpdate",
            "E": 1_700_000_000_010,
            "s": "BTCUSDT",
            "U": 120,
            "u": 124,
            "b": [["100", "0"]],
            "a": [["101", "3"]],
        }
        if market_type == "futures":
            row.update({
                "E": 1_700_000_000_008,
                "T": 1_700_000_000_007,
            })
            ws_row.update({
                "T": 1_700_000_000_009,
                "pu": 119,
                "ps": "BTCUSDT",
                "st": 1,
            })
        return row, [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(payload=ws_row, source=DataSource.WEBSOCKET),
        ]
    if stream_type in (StreamType.MARK_PRICE, StreamType.INDEX_PRICE):
        row = _binance_derivatives_summary_http_row()
        return row, [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(
                payload=_binance_derivatives_summary_ws_row(),
                source=DataSource.WEBSOCKET,
            ),
        ]
    if stream_type == StreamType.FUNDING_RATE:
        row = _binance_derivatives_summary_http_row()
        history_row = {
            "symbol": "BTCUSDT",
            "fundingTime": 1_700_000_000_000,
            "fundingRate": "0.0001",
            "markPrice": "100.5",
        }
        return row, [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(payload=history_row, source=DataSource.HTTP_BACKFILL),
            NormalizerContractSample(
                payload=_binance_derivatives_summary_ws_row(),
                source=DataSource.WEBSOCKET,
            ),
        ]
    if stream_type == StreamType.OPEN_INTEREST:
        row = {
            "symbol": "BTCUSDT",
            "openInterest": "12345.5",
            "time": 1_700_000_000_000,
        }
        history_row = {
            "symbol": "BTCUSDT",
            "sumOpenInterest": "12345.5",
            "sumOpenInterestValue": "1240722.75",
            "timestamp": 1_700_000_000_000,
        }
        return row, [
            NormalizerContractSample(payload=row, source=DataSource.HTTP),
            NormalizerContractSample(payload=history_row, source=DataSource.HTTP_BACKFILL),
        ]
    if stream_type == StreamType.LIQUIDATION:
        return None, [
            NormalizerContractSample(
                payload={
                    "e": "forceOrder",
                    "E": 1_700_000_000_010,
                    "o": {
                        "s": "BTCUSDT",
                        "S": "SELL",
                        "o": "LIMIT",
                        "f": "IOC",
                        "q": "0.014",
                        "p": "9910",
                        "ap": "9909.5",
                        "X": "FILLED",
                        "l": "0.014",
                        "z": "0.014",
                        "T": 1_700_000_000_000,
                    },
                    "ps": "BTCUSDT",
                    "st": 1,
                },
                source=DataSource.WEBSOCKET,
            ),
        ]
    raise AssertionError(f"Unhandled Binance fixture stream type: {stream_type}")


def _descriptor(
    exchange: str,
    symbol: str,
    stream_type: StreamType,
    market_type: str,
) -> StreamDescriptor:
    return StreamDescriptor(
        symbol,
        stream_type,
        interval="1m" if stream_type == StreamType.KLINE else None,
        depth_levels=20 if stream_type == StreamType.DEPTH else None,
        exchange=exchange,
        market_type=market_type,
        update_interval_ms=(
            250
            if stream_type == StreamType.DEPTH and market_type == "futures"
            else 100 if stream_type == StreamType.FULL_DEPTH else None
        ),
    )


def _request(descriptor: StreamDescriptor) -> TransportRequest:
    return TransportRequest(
        descriptor,
        limit=100,
        start_ms=1_700_000_000_000,
        end_ms=1_700_000_060_000,
    )


def _symbol(exchange: str, market_type: str) -> str:
    if exchange == "okx":
        return "BTC-USDT-SWAP" if market_type == "futures" else "BTC-USDT"
    return "BTCUSDT"


def _binance_kline_row() -> list[Any]:
    return [
        1_700_000_000_000, "1", "2", "0.5", "1.5", "10",
        1_700_000_059_999, "15", 42, "6", "9", "0",
    ]


def _binance_ticker_http_row(market_type: str) -> dict[str, Any]:
    row = {
        "priceChange": "1",
        "priceChangePercent": "1",
        "weightedAvgPrice": "100",
        "prevClosePrice": "99",
        "lastPrice": "100.5",
        "lastQty": "0.5",
        "bidPrice": "100",
        "bidQty": "2",
        "askPrice": "101",
        "askQty": "3",
        "openPrice": "99.5",
        "highPrice": "110",
        "lowPrice": "90",
        "volume": "12",
        "quoteVolume": "1200",
        "openTime": 1_699_913_600_000,
        "closeTime": 1_700_000_000_000,
        "count": 50,
    }
    if market_type == "futures":
        for field in ("prevClosePrice", "bidPrice", "bidQty", "askPrice", "askQty"):
            row.pop(field)
    return row


def _binance_derivatives_summary_http_row() -> dict[str, Any]:
    return {
        "symbol": "BTCUSDT",
        "markPrice": "100.5",
        "indexPrice": "100.0",
        "estimatedSettlePrice": "100.25",
        "lastFundingRate": "0.0001",
        "nextFundingTime": 1_700_028_800_000,
        "time": 1_700_000_000_000,
    }


def _binance_derivatives_summary_ws_row() -> dict[str, Any]:
    return {
        "e": "markPriceUpdate",
        "E": 1_700_000_000_000,
        "s": "BTCUSDT",
        "p": "100.5",
        "i": "100.0",
        "P": "100.25",
        "r": "0.0001",
        "T": 1_700_028_800_000,
    }


def _okx_kline_row() -> list[str]:
    return [
        "1700000000000", "1", "2", "0.5", "1.5", "10", "10", "15", "1",
    ]


def _okx_ticker_row() -> dict[str, str]:
    return {
        "last": "105",
        "open24h": "100",
        "high24h": "110",
        "low24h": "90",
        "vol24h": "12",
        "volCcy24h": "1260",
        "ts": "1700000000000",
    }
