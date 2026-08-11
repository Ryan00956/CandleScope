from __future__ import annotations

import asyncio
import json

import pytest

import app.data_engine.ingestion.shared_ws as shared_ws_module
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    SessionHealth,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.ingestion.shared_ws import SharedMultiplexHub, SharedWsHubRegistry
from app.data_engine.ingestion.transport import TransportError, TransportLayer
from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.exchanges.plugins.binance.normalizer import BinanceNormalizer
from app.exchanges.plugins.binance.plugin import BinancePlugin
from app.exchanges.plugins.binance.protocol import BinanceExchangeProtocol
from app.exchanges.rate_limits import HistoricalRequest
from app.exchanges.ws_protocol import WsSubscriptionMode


def _descriptor(stream_type: StreamType, symbol: str = "BTCUSDT", interval: str | None = None):
    return StreamDescriptor(
        symbol=symbol,
        stream_type=stream_type,
        interval=interval,
        exchange="binance",
        market_type="futures",
    )


def test_binance_derivatives_rest_snapshot_and_history_paths_are_distinct() -> None:
    protocol = BinanceExchangeProtocol()
    funding = _descriptor(StreamType.FUNDING_RATE)
    oi = _descriptor(StreamType.OPEN_INTEREST, interval="5m")

    current_funding = protocol.rest_request(TransportRequest(funding, limit=10))
    history_funding = protocol.rest_request(
        TransportRequest(funding, limit=5000, start_ms=100, end_ms=200, history=True),
    )
    current_oi = protocol.rest_request(TransportRequest(oi, limit=10))
    history_oi = protocol.rest_request(
        TransportRequest(oi, limit=5000, start_ms=100, end_ms=200, history=True),
    )

    assert current_funding is not None and current_funding.path == "/fapi/v1/premiumIndex"
    assert history_funding is not None and history_funding.path == "/fapi/v1/fundingRate"
    assert history_funding.params["limit"] == 1000
    assert current_oi is not None and current_oi.path == "/fapi/v1/openInterest"
    assert "period" not in current_oi.params
    assert history_oi is not None and history_oi.path == "/futures/data/openInterestHist"
    assert history_oi.params == {
        "symbol": "BTCUSDT",
        "period": "5m",
        "limit": 500,
        "startTime": "100",
        "endTime": "200",
    }


def test_derivatives_history_override_preserves_existing_futures_rest_paths() -> None:
    protocol = BinanceExchangeProtocol()
    kline = _descriptor(StreamType.KLINE, interval="1m")
    agg_trade = _descriptor(StreamType.AGG_TRADE)

    kline_request = protocol.rest_request(TransportRequest(kline, history=True, limit=10))
    agg_trade_request = protocol.rest_request(
        TransportRequest(agg_trade, history=True, limit=10),
    )

    assert kline_request is not None and kline_request.path == "/fapi/v1/klines"
    assert agg_trade_request is not None and agg_trade_request.path == "/fapi/v1/aggTrades"
    assert protocol.rest_request(
        TransportRequest(_descriptor(StreamType.MARK_PRICE), history=True),
    ) is None


def test_premium_index_history_has_explicit_fixed_1m_contract() -> None:
    protocol = BinanceExchangeProtocol()
    descriptor = _descriptor(StreamType.PREMIUM_INDEX, interval="1m")

    request = protocol.rest_request(TransportRequest(
        descriptor,
        history=True,
        limit=5000,
        start_ms=100,
        end_ms=200,
    ))

    assert request is not None
    assert request.path == "/fapi/v1/premiumIndexKlines"
    assert request.params == {
        "symbol": "BTCUSDT",
        "interval": "1m",
        "limit": 1000,
        "startTime": "100",
        "endTime": "200",
    }
    assert protocol.supports_ws(descriptor) is False
    with pytest.raises(ValueError, match="fixed 1m"):
        _descriptor(StreamType.PREMIUM_INDEX, interval="5m").validate()


def test_premium_index_normalizer_uses_official_close_time_position() -> None:
    descriptor = _descriptor(StreamType.PREMIUM_INDEX, interval="1m")
    event = BinanceNormalizer(IngestionConfig(), descriptor).parse(RawMessage(
        payload=[
            1_700_000_000_000,
            "0.0001",
            "0.0003",
            "-0.0001",
            "0.0002",
            "0",
            1_700_000_059_999,
            "0",
            0,
            "0",
            "0",
            "0",
        ],
        source=DataSource.HTTP_BACKFILL,
        stream_type=StreamType.PREMIUM_INDEX,
        received_at_ms=1_700_000_060_100,
    ))

    assert event is not None
    assert event.event_type == StreamType.PREMIUM_INDEX
    assert event.event_time_ms == 1_700_000_000_000
    assert event.data["close_time_ms"] == 1_700_000_059_999
    assert event.data["premium_index_close"] == 0.0002


def test_aggregate_trade_gap_repair_uses_from_id_without_time_range() -> None:
    protocol = BinanceExchangeProtocol()
    descriptor = _descriptor(StreamType.AGG_TRADE)

    request = protocol.rest_request(
        TransportRequest(descriptor, history=True, limit=5000, from_id=123),
    )

    assert request is not None
    assert request.path == "/fapi/v1/aggTrades"
    assert request.params == {
        "symbol": "BTCUSDT",
        "limit": 1000,
        "fromId": "123",
    }

    with pytest.raises(ValueError, match="cannot combine from_id"):
        protocol.rest_request(
            TransportRequest(
                descriptor,
                history=True,
                from_id=123,
                start_ms=1_700_000_000_000,
            ),
        )


def test_open_interest_history_rejects_unsupported_period_before_http() -> None:
    protocol = BinanceExchangeProtocol()
    with pytest.raises(ValueError, match="unsupported open-interest period"):
        protocol.rest_request(TransportRequest(
            _descriptor(StreamType.OPEN_INTEREST, interval="1m"),
            history=True,
        ))


def test_binance_derivatives_rest_endpoints_have_shared_quota_buckets() -> None:
    rules = {
        rule.endpoint: rule
        for rule in BinancePlugin().rate_limit_policy().endpoint_rules
    }

    assert rules["/fapi/v1/premiumIndex"].bucket_key == (
        "binance:futures:request_weight:ip"
    )
    assert rules["/fapi/v1/premiumIndexKlines"].bucket_key == (
        "binance:futures:request_weight:ip"
    )
    assert rules["/fapi/v1/premiumIndexKlines"].max_concurrency == 4
    assert rules["/fapi/v1/openInterest"].bucket_key == (
        "binance:futures:request_weight:ip"
    )
    agg_trade_rule = rules["/fapi/v1/aggTrades"]
    assert agg_trade_rule.bucket_key == "binance:futures:request_weight:ip"
    assert agg_trade_rule.cost(HistoricalRequest(
        exchange="binance",
        market_type="futures",
        endpoint="/fapi/v1/aggTrades",
        symbol="BTCUSDT",
    )) == 20
    assert rules["/fapi/v1/fundingRate"].refill_interval_seconds == 300
    assert rules["/futures/data/openInterestHist"].refill_interval_seconds == 300

    configured_rules = {
        rule.endpoint: rule
        for rule in BinancePlugin().rate_limit_policy(IngestionConfig(
            fetch_binance_futures_premium_index_concurrency=2,
        )).endpoint_rules
    }
    assert configured_rules["/fapi/v1/premiumIndexKlines"].max_concurrency == 2
    assert configured_rules["/fapi/v1/premiumIndexKlines"].algorithm == "header_weight"
    assert configured_rules["/fapi/v1/premiumIndexKlines"].cooldown_seconds > 0


def test_binance_mark_projections_share_one_message_subscription_name() -> None:
    protocol = BinanceExchangeProtocol()
    descriptors = [
        _descriptor(StreamType.MARK_PRICE),
        _descriptor(StreamType.INDEX_PRICE),
        _descriptor(StreamType.FUNDING_RATE),
    ]

    assert {protocol.build_ws_stream_name(item) for item in descriptors} == {
        "btcusdt@markPrice@1s",
    }
    spec = protocol.ws_connection(descriptors[0])
    assert spec.connection_model == "shared_multiplex"
    assert spec.subscription.mode is WsSubscriptionMode.MESSAGE
    assert protocol.build_combined_subscribe(descriptors) == {
        "method": "SUBSCRIBE",
        "params": ["btcusdt@markPrice@1s"],
        "id": 1,
    }


def test_binance_mark_payload_filter_and_oi_ws_capability_are_truthful() -> None:
    protocol = BinanceExchangeProtocol()
    payload = {"e": "markPriceUpdate", "s": "BTCUSDT"}

    assert protocol.payload_matches_descriptor(payload, _descriptor(StreamType.MARK_PRICE))
    assert not protocol.payload_matches_descriptor(
        {**payload, "st": 0},
        _descriptor(StreamType.MARK_PRICE),
    )
    assert not protocol.payload_matches_descriptor(
        payload,
        _descriptor(StreamType.MARK_PRICE, symbol="ETHUSDT"),
    )
    assert protocol.supports_ws(_descriptor(StreamType.MARK_PRICE))
    assert not protocol.supports_ws(_descriptor(StreamType.OPEN_INTEREST))

    transport = TransportLayer(IngestionConfig())
    assert transport.supports_ws(_descriptor(StreamType.MARK_PRICE))
    assert not transport.supports_ws(_descriptor(StreamType.OPEN_INTEREST))


def test_binance_liquidation_capability_is_futures_ws_only_and_lossy() -> None:
    capabilities = BinancePlugin().capabilities()
    liquidation = capabilities.channel_capability(MarketChannel.LIQUIDATION, "futures")

    assert capabilities.channel_capability(MarketChannel.LIQUIDATION, "spot") is None
    assert liquidation is not None
    assert liquidation.realtime is True
    assert liquidation.history is False
    assert liquidation.realtime_transports == (TransportMode.WEBSOCKET,)
    assert liquidation.history_transports == ()
    assert liquidation.delivery is DeliveryClass.APPEND
    assert liquidation.snapshot is False
    assert liquidation.sequence == "none"
    assert liquidation.resync == "none"
    assert liquidation.update_intervals_ms == (1000,)
    assert liquidation.connection_model == "path_per_stream"
    limitations = " ".join(liquidation.known_limitations).lower()
    assert "latest liquidation order" in limitations
    assert "no sequence" in limitations
    assert "no public market-level liquidation history" in limitations


def test_binance_liquidation_protocol_routes_only_futures_market_ws() -> None:
    protocol = BinanceExchangeProtocol()
    descriptor = _descriptor(StreamType.LIQUIDATION)
    spot = StreamDescriptor(
        symbol="BTCUSDT",
        stream_type=StreamType.LIQUIDATION,
        exchange="binance",
        market_type="spot",
    )

    assert protocol.build_ws_stream_name(descriptor) == "btcusdt@forceOrder"
    connection = protocol.ws_connection(descriptor)
    assert connection.base_urls[0] == "wss://fstream.binance.com/market/ws"
    assert connection.connection_model == "path_per_stream"
    assert connection.subscription.mode is WsSubscriptionMode.PATH
    assert protocol.supports_ws(descriptor)
    assert not protocol.supports_ws(spot)
    assert protocol.rest_request(TransportRequest(descriptor)) is None
    assert protocol.rest_request(TransportRequest(descriptor, history=True)) is None

    transport = TransportLayer(IngestionConfig())
    assert transport.supports_ws(descriptor)
    assert not transport.supports_ws(spot)


def test_binance_liquidation_payload_filter_requires_um_matching_symbol() -> None:
    protocol = BinanceExchangeProtocol()
    descriptor = _descriptor(StreamType.LIQUIDATION)
    payload = {
        "e": "forceOrder",
        "E": 1_700_000_000_010,
        "o": {"s": "BTCUSDT"},
    }

    assert protocol.payload_matches_descriptor(payload, descriptor)
    assert protocol.payload_matches_descriptor({**payload, "st": 1}, descriptor)
    assert not protocol.payload_matches_descriptor({**payload, "st": 2}, descriptor)
    assert not protocol.payload_matches_descriptor({**payload, "st": True}, descriptor)
    assert not protocol.payload_matches_descriptor(
        {**payload, "o": {"s": "ETHUSDT"}},
        descriptor,
    )
    assert not protocol.payload_matches_descriptor(
        {**payload, "e": "aggTrade"},
        descriptor,
    )


@pytest.mark.parametrize(
    ("order_side", "position_side"),
    [("SELL", "long"), ("BUY", "short")],
)
def test_binance_liquidation_normalizer_preserves_order_semantics(
    order_side: str,
    position_side: str,
) -> None:
    descriptor = _descriptor(StreamType.LIQUIDATION)
    payload = {
        "e": "forceOrder",
        "E": 1_700_000_000_010,
        "o": {
            "s": "BTCUSDT",
            "S": order_side,
            "o": "LIMIT",
            "f": "IOC",
            "q": "0.014",
            "p": "9910",
            "ap": "9909.5",
            "X": "FILLED",
            "l": "0.010",
            "z": "0.014",
            "T": 1_700_000_000_000,
        },
        "ps": "BTCUSDT",
        "st": 1,
    }

    event = BinanceNormalizer(IngestionConfig(), descriptor).parse(RawMessage(
        payload=payload,
        source=DataSource.WEBSOCKET,
        stream_type=StreamType.LIQUIDATION,
        received_at_ms=1_700_000_000_020,
    ))

    assert event is not None
    assert event.event_type is StreamType.LIQUIDATION
    assert event.event_time_ms == 1_700_000_000_010
    assert event.sequence is None
    assert event.data == {
        "order_side": order_side,
        "position_side": position_side,
        "order_type": "LIMIT",
        "time_in_force": "IOC",
        "original_quantity": 0.014,
        "order_price": 9910.0,
        "average_price": 9909.5,
        "order_status": "FILLED",
        "last_filled_quantity": 0.010,
        "filled_quantity": 0.014,
        "trade_time_ms": 1_700_000_000_000,
        "pair_symbol": "BTCUSDT",
        "symbol_type": "UM",
    }
    assert "notional" not in event.data
    assert "estimated_notional" not in event.data


def test_binance_liquidation_normalizer_allows_legacy_um_payload_without_tags() -> None:
    descriptor = _descriptor(StreamType.LIQUIDATION)
    payload = {
        "e": "forceOrder",
        "E": 1_700_000_000_010,
        "o": {
            "s": "BTCUSDT",
            "S": "SELL",
            "o": "LIMIT",
            "f": "IOC",
            "q": "0.014",
            "p": "9910",
            "ap": "9910",
            "X": "FILLED",
            "l": "0.014",
            "z": "0.014",
            "T": 1_700_000_000_000,
        },
    }

    event = BinanceNormalizer(IngestionConfig(), descriptor).parse(RawMessage(
        payload=payload,
        source=DataSource.WEBSOCKET,
        stream_type=StreamType.LIQUIDATION,
        received_at_ms=1_700_000_000_020,
    ))

    assert event is not None
    assert "pair_symbol" not in event.data
    assert "symbol_type" not in event.data


def test_binance_liquidation_normalizer_rejects_wrong_market_contract_or_symbol() -> None:
    descriptor = _descriptor(StreamType.LIQUIDATION)
    payload = {
        "e": "forceOrder",
        "E": 1_700_000_000_010,
        "o": {
            "s": "BTCUSDT",
            "S": "SELL",
            "o": "LIMIT",
            "f": "IOC",
            "q": "0.014",
            "p": "9910",
            "ap": "9910",
            "X": "FILLED",
            "l": "0.014",
            "z": "0.014",
            "T": 1_700_000_000_000,
        },
    }

    def parse(candidate: dict, target: StreamDescriptor = descriptor):
        return BinanceNormalizer(IngestionConfig(), target).parse(RawMessage(
            payload=candidate,
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.LIQUIDATION,
            received_at_ms=1_700_000_000_020,
        ))

    assert parse({**payload, "st": 2}) is None
    assert parse({**payload, "st": True}) is None
    assert parse({**payload, "o": {**payload["o"], "s": "ETHUSDT"}}) is None
    assert parse({**payload, "e": "aggTrade"}) is None
    assert parse({**payload, "o": {**payload["o"], "S": "UNKNOWN"}}) is None
    assert parse({**payload, "o": {**payload["o"], "ap": ""}}) is None
    spot = StreamDescriptor(
        symbol="BTCUSDT",
        stream_type=StreamType.LIQUIDATION,
        exchange="binance",
        market_type="spot",
    )
    assert parse(payload, spot) is None


class _ControlConnection:
    def __init__(self, incoming: str | None = None) -> None:
        self.sent: list[dict] = []
        self.incoming = incoming
        self.closed = False

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def recv(self) -> str:
        assert self.incoming is not None
        return self.incoming

    async def close(self) -> None:
        self.closed = True


class _BlockingControlConnection(_ControlConnection):
    def __init__(self) -> None:
        super().__init__()
        self.send_entered = asyncio.Event()
        self.send_gate = asyncio.Event()
        self.close_entered = asyncio.Event()
        self.close_gate = asyncio.Event()
        self.block_send = True
        self.block_close = False

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))
        self.send_entered.set()
        if self.block_send:
            await self.send_gate.wait()

    async def close(self) -> None:
        self.close_entered.set()
        if self.block_close:
            await self.close_gate.wait()
        await super().close()


def test_shared_ws_adds_and_removes_stream_without_reconnecting() -> None:
    async def _scenario() -> None:
        hub = SharedMultiplexHub(
            IngestionConfig(),
            TransportLayer(IngestionConfig()),
            "binance",
            "futures",
            "derivatives_summary",
            protocol=BinanceExchangeProtocol(),
        )
        hub._ensure_runner = lambda: None

        async def _noop(*_args) -> None:
            return None

        first = await hub.subscribe(_descriptor(StreamType.MARK_PRICE), _noop, _noop)
        hub._subscription_changed.clear()
        connection = _ControlConnection()
        hub._conn = connection
        hub._health = SessionHealth.CONNECTED

        second = await hub.subscribe(
            _descriptor(StreamType.MARK_PRICE, "ETHUSDT"),
            _noop,
            _noop,
        )
        assert connection.sent[0]["method"] == "SUBSCRIBE"
        assert connection.closed is False
        assert not hub._subscription_changed.is_set()

        await second.unsubscribe()
        assert connection.sent[-1]["method"] == "UNSUBSCRIBE"
        assert connection.closed is False
        assert not hub._subscription_changed.is_set()
        await first.unsubscribe()

    asyncio.run(_scenario())


def test_cancelled_dynamic_subscribe_rolls_back_local_and_remote_state() -> None:
    async def _scenario() -> None:
        hub = SharedMultiplexHub(
            IngestionConfig(),
            TransportLayer(IngestionConfig()),
            "binance",
            "futures",
            "derivatives_summary",
            protocol=BinanceExchangeProtocol(),
        )
        hub._ensure_runner = lambda: None

        async def _noop(*_args) -> None:
            return None

        first = await hub.subscribe(_descriptor(StreamType.MARK_PRICE), _noop, _noop)
        connection = _BlockingControlConnection()
        hub._conn = connection
        hub._health = SessionHealth.CONNECTED

        subscribe = asyncio.create_task(hub.subscribe(
            _descriptor(StreamType.MARK_PRICE, "ETHUSDT"),
            _noop,
            _noop,
        ))
        await connection.send_entered.wait()
        subscribe.cancel()
        connection.block_send = False
        connection.send_gate.set()
        with pytest.raises(asyncio.CancelledError):
            await subscribe

        assert len(hub._subscribers) == 1
        assert connection.sent[0]["method"] == "SUBSCRIBE"
        assert connection.sent[-1]["method"] == "UNSUBSCRIBE"
        await first.unsubscribe()

    asyncio.run(_scenario())


def test_last_unsubscribe_serializes_new_subscribe_before_runner_cleanup() -> None:
    async def _scenario() -> None:
        hub = SharedMultiplexHub(
            IngestionConfig(),
            TransportLayer(IngestionConfig()),
            "binance",
            "futures",
            "derivatives_summary",
            protocol=BinanceExchangeProtocol(),
        )
        runner_starts = 0

        def _record_runner_start() -> None:
            nonlocal runner_starts
            runner_starts += 1

        hub._ensure_runner = _record_runner_start

        async def _noop(*_args) -> None:
            return None

        first = await hub.subscribe(_descriptor(StreamType.MARK_PRICE), _noop, _noop)
        connection = _BlockingControlConnection()
        connection.block_send = False
        connection.block_close = True
        hub._conn = connection
        hub._health = SessionHealth.CONNECTED

        unsubscribe = asyncio.create_task(first.unsubscribe())
        await connection.close_entered.wait()
        subscribe = asyncio.create_task(hub.subscribe(
            _descriptor(StreamType.MARK_PRICE, "ETHUSDT"),
            _noop,
            _noop,
        ))
        await asyncio.sleep(0)
        assert not subscribe.done()

        connection.close_gate.set()
        await unsubscribe
        second = await subscribe
        assert len(hub._subscribers) == 1
        assert runner_starts == 2
        await second.unsubscribe()

    asyncio.run(_scenario())


def test_cancelled_handle_unsubscribe_keeps_cleanup_alive_and_retryable() -> None:
    async def _scenario() -> None:
        hub = SharedMultiplexHub(
            IngestionConfig(),
            TransportLayer(IngestionConfig()),
            "binance",
            "futures",
            "derivatives_summary",
            protocol=BinanceExchangeProtocol(),
        )
        hub._ensure_runner = lambda: None

        async def _noop(*_args) -> None:
            return None

        first = await hub.subscribe(_descriptor(StreamType.MARK_PRICE), _noop, _noop)
        await hub.subscribe(
            _descriptor(StreamType.MARK_PRICE, "ETHUSDT"),
            _noop,
            _noop,
        )
        connection = _BlockingControlConnection()
        hub._conn = connection
        hub._health = SessionHealth.CONNECTED

        unsubscribe = asyncio.create_task(first.unsubscribe())
        await connection.send_entered.wait()
        unsubscribe.cancel()
        with pytest.raises(asyncio.CancelledError):
            await unsubscribe
        assert first._closed is False

        connection.block_send = False
        connection.send_gate.set()
        assert first._unsubscribe_task is not None
        await first._unsubscribe_task
        await first.unsubscribe()
        assert first._closed is True
        assert len(hub._subscribers) == 1
        assert connection.sent[-1]["method"] == "UNSUBSCRIBE"

    asyncio.run(_scenario())


def test_shared_ws_control_send_timeout_closes_degraded_connection() -> None:
    async def _scenario() -> None:
        hub = SharedMultiplexHub(
            IngestionConfig(ws_control_timeout=0.01),
            TransportLayer(IngestionConfig()),
            "binance",
            "futures",
            "derivatives_summary",
            protocol=BinanceExchangeProtocol(),
        )
        hub._ensure_runner = lambda: None

        async def _noop(*_args) -> None:
            return None

        await hub.subscribe(_descriptor(StreamType.MARK_PRICE), _noop, _noop)
        connection = _BlockingControlConnection()
        hub._conn = connection
        hub._health = SessionHealth.CONNECTED

        handle = await asyncio.wait_for(
            hub.subscribe(
                _descriptor(StreamType.MARK_PRICE, "ETHUSDT"),
                _noop,
                _noop,
            ),
            timeout=0.5,
        )
        assert connection.closed is True
        assert hub._subscription_changed.is_set()
        await handle.unsubscribe()

    asyncio.run(_scenario())


def test_shared_ws_rejects_binance_code_msg_control_error() -> None:
    async def _scenario() -> None:
        hub = SharedMultiplexHub(
            IngestionConfig(),
            TransportLayer(IngestionConfig()),
            "binance",
            "futures",
            "derivatives_summary",
            protocol=BinanceExchangeProtocol(),
        )
        hub._ensure_runner = lambda: None

        async def _noop(*_args) -> None:
            return None

        await hub.subscribe(_descriptor(StreamType.MARK_PRICE), _noop, _noop)
        hub._subscription_changed.clear()
        hub._conn = _ControlConnection('{"code":2,"msg":"Invalid request"}')
        with pytest.raises(TransportError, match="subscription rejected"):
            await hub._read_loop()

    asyncio.run(_scenario())


def test_shared_ws_registry_defers_derivatives_summary_to_ccxt_provider() -> None:
    config = IngestionConfig()
    transport = TransportLayer(config)
    registry = SharedWsHubRegistry(config, transport)

    mark_hub = registry.get_hub(_descriptor(StreamType.MARK_PRICE, "BTCUSDT"))
    index_hub = registry.get_hub(_descriptor(StreamType.INDEX_PRICE, "ETHUSDT"))
    funding_hub = registry.get_hub(_descriptor(StreamType.FUNDING_RATE, "SOLUSDT"))

    assert mark_hub is None
    assert index_hub is None
    assert funding_hub is None
    assert registry.get_hub(_descriptor(StreamType.OPEN_INTEREST)) is None


def test_shared_ws_registry_preserves_schema_v1_kline_fallback(monkeypatch) -> None:
    class _Capabilities:
        capability_schema_version = 1
        ws_connection_model = "shared_multiplex"

    class _Plugin:
        def capabilities(self):
            return _Capabilities()

        def protocol(self):
            return BinanceExchangeProtocol()

    class _Registry:
        def get_plugin(self, _exchange):
            return _Plugin()

    monkeypatch.setattr(shared_ws_module, "bootstrap_default_adapters", lambda: None)
    monkeypatch.setattr(shared_ws_module, "get_exchange_registry", lambda: _Registry())
    config = IngestionConfig()
    registry = SharedWsHubRegistry(config, TransportLayer(config))
    descriptor = StreamDescriptor(
        symbol="BTCUSDT",
        stream_type=StreamType.KLINE,
        interval="1m",
        exchange="legacy",
        market_type="spot",
    )

    assert registry.get_hub(descriptor) is not None


def test_binance_derivatives_normalizer_requires_channel_core_field() -> None:
    config = IngestionConfig()
    received_at = 1_700_000_000_010
    payload = {
        "e": "markPriceUpdate",
        "E": 1_700_000_000_000,
        "s": "BTCUSDT",
        "p": "101",
        "i": "100",
        "P": "100.5",
        "r": "0.0001",
        "T": 1_700_028_800_000,
    }

    for stream_type, required in (
        (StreamType.MARK_PRICE, "mark_price"),
        (StreamType.INDEX_PRICE, "index_price"),
        (StreamType.FUNDING_RATE, "funding_rate"),
    ):
        descriptor = _descriptor(stream_type)
        event = BinanceNormalizer(config, descriptor).parse(RawMessage(
            payload=payload,
            source=DataSource.WEBSOCKET,
            stream_type=stream_type,
            received_at_ms=received_at,
        ))
        assert event is not None
        assert required in event.data

    missing_mark = dict(payload)
    missing_mark.pop("p")
    assert BinanceNormalizer(config, _descriptor(StreamType.MARK_PRICE)).parse(RawMessage(
        payload=missing_mark,
        source=DataSource.WEBSOCKET,
        stream_type=StreamType.MARK_PRICE,
        received_at_ms=received_at,
    )) is None
