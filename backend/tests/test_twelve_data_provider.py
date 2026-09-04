from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.symbols import router as symbols_router
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import BackfillTask, FetchedBar
from app.data_engine.data_manager.manager import DataManager
from app.data_engine.data_manager.models import MissingRange, QueryResult, QuerySource
from app.data_engine.history import get_history_calendar_registry
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    SessionHealth,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.exchanges.plugins.twelvedata.adapter import (
    EXCHANGE_DATE_CALENDAR_ID,
    WEEKDAY_CALENDAR_ID,
    TwelveDataConfigurationError,
    TwelveDataExchangeAdapter,
)
from app.exchanges.plugins.twelvedata.identity import identity_for_instrument
from app.exchanges.plugins.twelvedata.normalizer import TwelveDataNormalizer
from app.exchanges.plugins.twelvedata.plugin import TwelveDataPlugin
from app.exchanges.plugins.twelvedata.protocol import TwelveDataExchangeProtocol
from app.exchanges.plugins.twelvedata.runtime import (
    TwelveDataLifecycleEvent,
    TwelveDataRuntime,
    TwelveDataWsEvent,
)
from app.exchanges.plugins.twelvedata.session import TwelveDataProviderSession
from app.exchanges.plugins.twelvedata.symbols import parse_symbol_search_payload


def _ms(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1000)


def _descriptor(
    symbol: str = "AAPL:NASDAQ",
    *,
    interval: str = "1d",
    market_type: str = "stock",
) -> StreamDescriptor:
    return StreamDescriptor(
        symbol=symbol,
        stream_type=StreamType.KLINE,
        interval=interval,
        exchange="twelvedata",
        market_type=market_type,
    )


def _request(**descriptor_kwargs: str) -> TransportRequest:
    return TransportRequest(
        descriptor=_descriptor(**descriptor_kwargs),
        limit=8_000,
        start_ms=_ms("2026-08-01T00:00:00"),
        end_ms=_ms("2026-08-28T23:59:59"),
        history=True,
    )


def _search_payload() -> dict:
    return {
        "status": "ok",
        "data": [
            {
                "symbol": "AAPL",
                "instrument_name": "Apple Inc",
                "exchange": "NASDAQ",
                "mic_code": "XNGS",
                "exchange_timezone": "America/New_York",
                "instrument_type": "Common Stock",
                "currency": "USD",
                "country": "United States",
                "access": {"plan": "Basic"},
            },
            {
                "symbol": "EUR/USD",
                "instrument_name": "Euro / US Dollar",
                "exchange": "Physical Currency",
                "instrument_type": "Physical Currency",
                "currency": "USD",
                "access": {"plan": "Basic"},
            },
            {
                "symbol": "XAU/USD",
                "instrument_name": "Gold / US Dollar",
                "exchange": "Commodity",
                "instrument_type": "Precious Metal",
                "currency": "USD",
                "access": {"plan": "Grow"},
            },
        ],
    }


def test_configuration_fails_closed_and_redacts_api_key() -> None:
    protocol = TwelveDataExchangeProtocol()
    with pytest.raises(TwelveDataConfigurationError, match="INGESTION_TWELVE_DATA_API_KEY"):
        protocol.rest_request(_request(), IngestionConfig(twelve_data_api_key=""))

    config = IngestionConfig(twelve_data_api_key="server-secret")
    assert config.snapshot()["twelve_data_api_key"] == "***"


def test_protocol_uses_header_auth_raw_series_and_reverse_range() -> None:
    spec = TwelveDataExchangeProtocol().rest_request(
        _request(),
        IngestionConfig(
            twelve_data_api_key="server-secret",
            twelve_data_http_base_urls=["https://provider.example/"],
        ),
    )

    assert spec is not None
    assert spec.base_urls == ["https://provider.example/"]
    assert spec.path == "/time_series"
    assert spec.headers == {
        "Authorization": "apikey server-secret",
        "Accept-Encoding": "gzip, deflate",
    }
    assert "apikey" not in spec.params
    assert spec.params == {
        "symbol": "AAPL:NASDAQ",
        "interval": "1day",
        "order": "ASC",
        "timezone": "UTC",
        "format": "JSON",
        "dp": 11,
        "adjust": "none",
        "outputsize": 5000,
        "start_date": "2026-08-01T00:00:00",
        "end_date": "2026-08-28T23:59:59",
    }


def test_protocol_opens_regular_session_us_equity_intraday_but_keeps_index_coarse() -> None:
    protocol = TwelveDataExchangeProtocol()
    config = IngestionConfig(twelve_data_api_key="key")

    stock = protocol.rest_request(_request(interval="1m", market_type="stock"), config)
    assert stock is not None
    assert stock.params["interval"] == "1min"
    assert stock.params["prepost"] == "false"

    stock_45m = protocol.rest_request(
        _request(interval="45m", market_type="stock"),
        config,
    )
    assert stock_45m is not None
    assert stock_45m.params["interval"] == "45min"

    with pytest.raises(ValueError, match="daily or coarser"):
        protocol.rest_request(
            _request(symbol="SPX", interval="1m", market_type="index"),
            config,
        )

    forex = protocol.rest_request(
        _request(symbol="EUR/USD", interval="1m", market_type="forex"),
        config,
    )
    assert forex is not None
    assert forex.params["interval"] == "1min"


def test_protocol_quote_snapshot_is_header_authenticated_and_regular_session() -> None:
    descriptor = StreamDescriptor(
        "AAPL:NASDAQ",
        StreamType.TICKER,
        exchange="twelvedata",
        market_type="stock",
    )
    spec = TwelveDataExchangeProtocol().rest_request(
        TransportRequest(descriptor, limit=1),
        IngestionConfig(twelve_data_api_key="server-secret"),
    )

    assert spec is not None
    assert spec.path == "/quote"
    assert spec.params == {
        "symbol": "AAPL:NASDAQ",
        "dp": 11,
        "prepost": "false",
    }
    assert spec.headers["Authorization"] == "apikey server-secret"
    assert "apikey" not in spec.params


def test_capabilities_expose_m2_intraday_and_ticker_without_claiming_ws_ohlc() -> None:
    capabilities = TwelveDataPlugin().capabilities()
    stock = capabilities.channel_capability("kline", "stock")
    forex = capabilities.channel_capability("kline", "forex")
    index = capabilities.channel_capability("kline", "index")

    assert stock is not None and stock.history is True and stock.realtime is False
    assert stock.params["interval"] == [
        "1m", "5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h",
        "1d", "1w", "1M",
    ]
    assert forex is not None and "1m" in forex.params["interval"]
    assert forex.unavailable_fields == ("volume",)
    assert index is not None and index.unavailable_fields == ("volume",)
    ticker = capabilities.channel_capability("ticker", "stock")
    assert ticker is not None and ticker.realtime is True and ticker.history is False
    assert [item.value for item in ticker.realtime_transports] == [
        "plugin_stream",
        "rest_poll",
    ]
    assert capabilities.ws_connection_model == "plugin_sidecar"
    assert capabilities.supports_symbol_search is True


def test_symbol_search_preserves_provider_symbol_venue_and_entitlement() -> None:
    symbols = parse_symbol_search_payload(_search_payload())
    by_symbol = {symbol.symbol: symbol for symbol in symbols}

    stock = by_symbol["AAPL:NASDAQ"]
    assert stock.market_type == "stock"
    assert stock.provider_instrument_id == "AAPL:NASDAQ"
    assert stock.venue == "xngs"
    assert stock.venue_mic == "XNGS"
    assert stock.entitlement == "basic"
    assert stock.price_adjustment == "raw"
    assert stock.volume_semantics == "shares"

    forex = by_symbol["EUR/USD"]
    assert forex.market_type == "forex"
    assert forex.session_variant == "continuous_24x5"
    assert forex.volume_semantics == "unavailable"

    commodity = by_symbol["XAU/USD"]
    assert commodity.market_type == "commodity"
    assert commodity.entitlement == "grow"


def test_adapter_symbol_search_is_query_only_and_keeps_key_out_of_params(monkeypatch) -> None:
    calls: list[dict] = []

    async def fake_fetch_catalog_json(**kwargs):
        calls.append(kwargs)
        return _search_payload()

    monkeypatch.setattr(
        "app.exchanges.plugins.twelvedata.adapter.fetch_catalog_json",
        fake_fetch_catalog_json,
    )
    adapter = TwelveDataExchangeAdapter()
    config = IngestionConfig(twelve_data_api_key="server-secret")

    assert asyncio.run(adapter.search_symbols("", config=config)) == []
    results = asyncio.run(
        adapter.search_symbols("aapl", market_type="stock", limit=999, config=config)
    )

    assert [item.symbol for item in results] == ["AAPL:NASDAQ"]
    assert len(calls) == 1
    assert calls[0]["path"] == "/symbol_search"
    assert calls[0]["headers"] == {
        "Authorization": "apikey server-secret",
        "Accept-Encoding": "gzip, deflate",
    }
    assert calls[0]["params"] == {
        "symbol": "aapl",
        "outputsize": 120,
        "show_plan": "true",
    }


def test_symbol_api_routes_query_only_search_and_returns_series_identity(monkeypatch) -> None:
    async def fake_search_symbols(self, query, market_type="", **kwargs):
        del self, kwargs
        assert (query, market_type) == ("AAPL", "stock")
        return parse_symbol_search_payload(_search_payload(), market_type=market_type)

    monkeypatch.setattr(TwelveDataExchangeAdapter, "search_symbols", fake_search_symbols)
    app = FastAPI()
    app.include_router(symbols_router, prefix="/api/v1")
    response = TestClient(app).get(
        "/api/v1/symbols/exchange-info",
        params={
            "exchange": "twelvedata",
            "market_type": "stock",
            "search": "AAPL",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_search"] is True
    assert payload["count"] == 1
    assert payload["symbols"][0]["symbol"] == "AAPL:NASDAQ"
    assert payload["symbols"][0]["providerId"] == "twelvedata"
    assert payload["symbols"][0]["venue"] == "xngs"
    assert payload["symbols"][0]["volumeSemantics"] == "shares"


def test_normalizer_requires_share_volume_but_marks_non_equity_volume_unavailable() -> None:
    config = IngestionConfig(twelve_data_api_key="key")
    row = {
        "datetime": "2026-08-28",
        "open": "100.0",
        "high": "102.0",
        "low": "99.0",
        "close": "101.5",
    }
    message = RawMessage(
        payload=row,
        source=DataSource.HTTP_BACKFILL,
        stream_type=StreamType.KLINE,
        received_at_ms=_ms("2026-08-29T00:00:00"),
    )

    assert TwelveDataNormalizer(config, _descriptor()).parse(message) is None

    forex_descriptor = _descriptor("EUR/USD", market_type="forex")
    event = TwelveDataNormalizer(config, forex_descriptor).parse(message)
    assert event is not None
    assert event.data["open_time"] == _ms("2026-08-28T00:00:00")
    assert event.data["volume"] == 0.0
    assert event.data["volume_available"] is False

    stock_event = TwelveDataNormalizer(config, _descriptor()).parse(
        RawMessage(
            payload={**row, "volume": "12345"},
            source=DataSource.HTTP_BACKFILL,
            stream_type=StreamType.KLINE,
            received_at_ms=message.received_at_ms,
        )
    )
    assert stock_event is not None
    assert stock_event.data["volume"] == 12345.0
    assert stock_event.data["volume_available"] is True


def test_pagination_moves_backward_without_refetching_oldest_bar() -> None:
    plugin = TwelveDataPlugin()
    policy = plugin.pagination_policy(IngestionConfig(twelve_data_api_key="key"))
    task = BackfillTask(
        symbol="AAPL:NASDAQ",
        interval="1d",
        start_ms=_ms("2026-08-01T00:00:00"),
        end_ms=_ms("2026-08-28T00:00:00"),
        exchange="twelvedata",
        market_type="stock",
    )
    first = policy.first_request(task, batch_size=5000, now_ms=task.end_ms)
    bars = [
        FetchedBar(
            symbol=task.symbol,
            interval=task.interval,
            open_time=_ms("2026-08-20T00:00:00"),
            close_time=_ms("2026-08-21T00:00:00") - 1,
            open=100,
            high=101,
            low=99,
            close=100,
            volume=1,
            exchange=task.exchange,
            market_type=task.market_type,
        )
    ]
    second = policy.next_request(task, first, bars, batch_size=5000)

    assert first.start_ms == task.start_ms
    assert first.end_ms == task.end_ms
    assert second is not None
    assert second.start_ms == task.start_ms
    assert second.end_ms == bars[0].open_time - 1


def test_history_identity_gate_accepts_only_owned_raw_series() -> None:
    plugin = TwelveDataPlugin()
    stock = identity_for_instrument(market_type="stock", venue="XNGS")

    assert plugin.supports_history_identity(
        market_type="stock",
        interval="1d",
        identity=stock,
    )
    assert plugin.supports_history_identity(
        market_type="stock",
        interval="1m",
        identity=stock,
    )
    assert not plugin.supports_history_identity(
        market_type="stock",
        interval="1m",
        identity=identity_for_instrument(market_type="stock", venue="XLON"),
    )
    assert not plugin.supports_history_identity(
        market_type="stock",
        interval="1d",
        identity=identity_for_instrument(market_type="etf", venue="XNGS"),
    )


def test_registered_calendars_emit_weekdays_and_skip_weekends() -> None:
    TwelveDataPlugin()
    registry = get_history_calendar_registry()
    friday = _ms("2026-08-28T00:00:00")
    monday = _ms("2026-08-31T00:00:00")

    for calendar_id in (EXCHANGE_DATE_CALENDAR_ID, WEEKDAY_CALENDAR_ID):
        calendar = registry.get(calendar_id)
        assert calendar is not None
        assert list(calendar.expected_opens(friday, monday, "1d")) == [friday, monday]
        assert list(calendar.expected_opens(
            _ms("2024-09-01T00:00:00"),
            _ms("2024-10-01T00:00:00"),
            "1M",
        )) == [
            _ms("2024-09-01T00:00:00"),
            _ms("2024-10-01T00:00:00"),
        ]


def test_us_equity_intraday_calendar_handles_holiday_dst_and_early_close() -> None:
    TwelveDataPlugin()
    calendar = get_history_calendar_registry().require(EXCHANGE_DATE_CALENDAR_ID)

    thanksgiving = list(calendar.expected_opens(
        _ms("2024-11-28T00:00:00"),
        _ms("2024-11-28T23:59:59"),
        "1m",
    ))
    black_friday = list(calendar.expected_opens(
        _ms("2024-11-29T00:00:00"),
        _ms("2024-11-29T23:59:59"),
        "1h",
    ))
    after_dst = list(calendar.expected_opens(
        _ms("2024-03-11T00:00:00"),
        _ms("2024-03-11T23:59:59"),
        "1h",
    ))

    assert thanksgiving == []
    assert black_friday == [
        _ms("2024-11-29T14:30:00"),
        _ms("2024-11-29T15:30:00"),
        _ms("2024-11-29T16:30:00"),
        _ms("2024-11-29T17:30:00"),
    ]
    assert after_dst[0] == _ms("2024-03-11T13:30:00")
    assert after_dst[-1] == _ms("2024-03-11T19:30:00")
    with pytest.raises(ValueError, match="intraday calendar is available only"):
        calendar.expected_opens(
            _ms("1999-12-31T14:30:00"),
            _ms("1999-12-31T15:30:00"),
            "1h",
        )
    assert calendar.bucket_end_ms(_ms("1999-12-31T14:30:00"), "8h") > _ms("1999-12-31T14:30:00")


@pytest.mark.parametrize(
    ("interval", "open_time"),
    [("1h", "2024-11-29T17:30:00Z"), ("8h", "2024-11-29T14:30:00Z")],
)
def test_us_equity_normalizer_closes_short_final_bar_at_early_close(
    interval: str,
    open_time: str,
) -> None:
    descriptor = StreamDescriptor(
        "AAPL:NASDAQ",
        StreamType.KLINE,
        interval=interval,
        exchange="twelvedata",
        market_type="stock",
    )
    event = TwelveDataNormalizer(
        IngestionConfig(twelve_data_api_key="key"),
        descriptor,
    ).parse(RawMessage(
        payload={
            "datetime": open_time,
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100.5",
            "volume": "123",
        },
        source=DataSource.HTTP_BACKFILL,
        stream_type=StreamType.KLINE,
        received_at_ms=_ms("2024-11-29T18:00:01"),
    ))

    assert event is not None
    assert event.data["close_time"] == _ms("2024-11-29T18:00:00") - 1
    assert event.data["is_closed"] is True


@pytest.mark.parametrize(
    ("interval", "open_time", "expected_close"),
    [
        ("1w", "2024-11-25", "2024-12-02T00:00:00"),
        ("1M", "2024-11-01", "2024-12-01T00:00:00"),
    ],
)
def test_us_equity_coarse_bars_keep_their_full_provider_period(
    interval: str,
    open_time: str,
    expected_close: str,
) -> None:
    descriptor = StreamDescriptor(
        "AAPL:NASDAQ",
        StreamType.KLINE,
        interval=interval,
        exchange="twelvedata",
        market_type="stock",
    )
    event = TwelveDataNormalizer(
        IngestionConfig(twelve_data_api_key="key"),
        descriptor,
    ).parse(RawMessage(
        payload={
            "datetime": open_time,
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100.5",
            "volume": "123",
        },
        source=DataSource.HTTP_BACKFILL,
        stream_type=StreamType.KLINE,
        received_at_ms=_ms("2025-01-01T00:00:00"),
    ))

    assert event is not None
    assert event.data["close_time"] == _ms(expected_close) - 1


def test_us_equity_normalizer_preserves_rows_outside_calendar_horizon() -> None:
    descriptor = StreamDescriptor(
        "AAPL:NASDAQ",
        StreamType.KLINE,
        interval="8h",
        exchange="twelvedata",
        market_type="stock",
    )
    event = TwelveDataNormalizer(
        IngestionConfig(twelve_data_api_key="key"),
        descriptor,
    ).parse(RawMessage(
        payload={
            "datetime": "1999-12-31T14:30:00Z",
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100.5",
            "volume": "123",
        },
        source=DataSource.HTTP_BACKFILL,
        stream_type=StreamType.KLINE,
        received_at_ms=_ms("2000-01-01T00:00:00"),
    ))

    assert event is not None
    assert event.data["close_time"] == _ms("1999-12-31T22:30:00") - 1


def test_ticker_normalizer_seeds_quote_then_applies_ws_price() -> None:
    descriptor = StreamDescriptor(
        "AAPL:NASDAQ",
        StreamType.TICKER,
        exchange="twelvedata",
        market_type="stock",
    )
    normalizer = TwelveDataNormalizer(
        IngestionConfig(twelve_data_api_key="key"),
        descriptor,
    )
    snapshot = normalizer.parse(RawMessage(
        payload={
            "symbol": "AAPL",
            "timestamp": 1_777_000_000,
            "open": "100",
            "high": "102",
            "low": "99",
            "close": "101",
            "percent_change": "1",
            "volume": "12345",
        },
        source=DataSource.HTTP,
        stream_type=StreamType.TICKER,
        received_at_ms=1_777_000_000_100,
    ))
    update = normalizer.parse(RawMessage(
        payload={
            "event": "price",
            "symbol": "AAPL",
            "timestamp": 1_777_000_001,
            "price": "103",
            "day_volume": "12350",
            "_twelve_data_ws_generation": 2,
        },
        source=DataSource.WEBSOCKET,
        stream_type=StreamType.TICKER,
        received_at_ms=1_777_000_001_100,
    ))

    assert snapshot is not None and snapshot.data["open_price"] == 100.0
    assert update is not None
    assert update.event_type == StreamType.TICKER
    assert update.data["last_price"] == 103.0
    assert update.data["open_price"] == 100.0
    assert update.data["high_price"] == 103.0
    assert update.data["volume"] == 12350.0
    assert update.data["volume_available"] is True
    assert update.data["provider_meta"]["ws_generation"] == 2


def test_twelve_data_runtime_enforces_unique_symbol_ceiling() -> None:
    async def run() -> None:
        runtime = TwelveDataRuntime(IngestionConfig(
            twelve_data_api_key="key",
            twelve_data_ws_max_symbols=2,
        ))
        def noop_raw(_event) -> None:
            return None

        def noop_lifecycle(_event) -> None:
            return None
        first = await runtime.subscribe(
            symbol="AAPL:NASDAQ",
            market_type="stock",
            raw_callback=noop_raw,
            lifecycle_callback=noop_lifecycle,
        )
        await runtime.subscribe(
            symbol="EUR/USD",
            market_type="forex",
            raw_callback=noop_raw,
            lifecycle_callback=noop_lifecycle,
        )
        with pytest.raises(RuntimeError, match="symbol limit reached"):
            await runtime.subscribe(
                symbol="SPY:NYSE",
                market_type="etf",
                raw_callback=noop_raw,
                lifecycle_callback=noop_lifecycle,
            )
        await runtime.unsubscribe(first)
        await runtime.subscribe(
            symbol="SPY:NYSE",
            market_type="etf",
            raw_callback=noop_raw,
            lifecycle_callback=noop_lifecycle,
        )
        snapshot = runtime.snapshot()
        assert snapshot["subscribed_symbols"] == 2
        assert "key" not in str(snapshot)

    asyncio.run(run())


def test_twelve_data_basic_runtime_never_declares_more_than_eight_symbols() -> None:
    runtime = TwelveDataRuntime(IngestionConfig(
        twelve_data_api_key="key",
        twelve_data_ws_max_symbols=99,
    ))

    assert runtime.snapshot()["max_symbols"] == 8


def test_twelve_data_runtime_treats_partial_ok_as_subscription_failure() -> None:
    async def run() -> None:
        runtime = TwelveDataRuntime(IngestionConfig(twelve_data_api_key="key"))
        lifecycle: list[TwelveDataLifecycleEvent] = []
        await runtime.subscribe(
            symbol="AAPL:NASDAQ",
            market_type="stock",
            raw_callback=lambda _event: None,
            lifecycle_callback=lifecycle.append,
        )

        runtime._handle_subscribe_status({
            "event": "subscribe-status",
            "status": "ok",
            "fails": [{"symbol": "AAPL"}],
        })

        assert lifecycle[-1].state == "unhealthy"

    asyncio.run(run())


def test_provider_session_releases_runtime_when_subscribe_fails() -> None:
    class FailingRuntime:
        async def subscribe(self, **_kwargs):
            raise RuntimeError("subscribe failed")

    class FakePool:
        def __init__(self) -> None:
            self.runtime = FailingRuntime()
            self.released = False

        async def acquire(self, _config):
            return self.runtime

        async def release(self, runtime):
            assert runtime is self.runtime
            self.released = True

    async def run() -> None:
        pool = FakePool()
        session = TwelveDataProviderSession(
            config=IngestionConfig(twelve_data_api_key="key"),
            descriptor=StreamDescriptor(
                "AAPL:NASDAQ",
                StreamType.TICKER,
                exchange="twelvedata",
                market_type="stock",
            ),
            pool=pool,  # type: ignore[arg-type]
        )

        with pytest.raises(RuntimeError, match="subscribe failed"):
            await session.start()
        assert pool.released is True
        assert session.health == SessionHealth.DISCONNECTED

    asyncio.run(run())


def test_provider_session_emits_ws_tick_and_generation_quote_snapshot(monkeypatch) -> None:
    class FakeRuntime:
        def __init__(self) -> None:
            self.raw_callback = None
            self.lifecycle_callback = None

        async def start(self) -> None:
            return None

        async def subscribe(self, **kwargs):
            self.raw_callback = kwargs["raw_callback"]
            self.lifecycle_callback = kwargs["lifecycle_callback"]
            self.lifecycle_callback(TwelveDataLifecycleEvent(
                state="connected",
                reason="connected",
                generation=1,
            ))
            return "token"

        async def unsubscribe(self, _token):
            return None

        def snapshot(self):
            return {"physical_websockets": 1}

    class FakePool:
        def __init__(self) -> None:
            self.runtime = FakeRuntime()
            self.released = False

        async def acquire(self, _config):
            return self.runtime

        async def release(self, _runtime):
            self.released = True

    async def fake_quote(*_args, **_kwargs):
        return {
            "symbol": "AAPL",
            "timestamp": 1_777_000_000,
            "open": "100",
            "high": "102",
            "low": "99",
            "close": "101",
            "volume": "12345",
        }

    monkeypatch.setattr(
        "app.exchanges.plugins.twelvedata.session.fetch_twelve_data_quote",
        fake_quote,
    )

    async def run() -> None:
        pool = FakePool()
        session = TwelveDataProviderSession(
            config=IngestionConfig(twelve_data_api_key="key"),
            descriptor=StreamDescriptor(
                "AAPL:NASDAQ",
                StreamType.TICKER,
                exchange="twelvedata",
                market_type="stock",
            ),
            pool=pool,  # type: ignore[arg-type]
        )
        messages: list[RawMessage] = []

        async def on_message(message: RawMessage) -> None:
            messages.append(message)

        session.on_message(on_message)
        await session.start()
        await asyncio.sleep(0)
        assert pool.runtime.raw_callback is not None
        pool.runtime.raw_callback(TwelveDataWsEvent(
            payload={
                "event": "price",
                "symbol": "AAPL",
                "timestamp": 1_777_000_001,
                "price": "101.5",
            },
            received_at_ms=1_777_000_001_100,
            generation=1,
        ))
        await asyncio.sleep(0.01)
        assert {message.source for message in messages} == {
            DataSource.HTTP,
            DataSource.WEBSOCKET,
        }
        assert session.health == SessionHealth.CONNECTED
        assert session.snapshot()["last_snapshot_generation"] == 1
        await session.stop()
        assert pool.released is True

    asyncio.run(run())


def test_fetched_bar_retains_task_series_identity() -> None:
    identity = identity_for_instrument(market_type="stock", venue="XNGS")
    task = BackfillTask(
        symbol="AAPL:NASDAQ",
        interval="1d",
        start_ms=_ms("2026-08-28T00:00:00"),
        end_ms=_ms("2026-08-28T00:00:00"),
        exchange="twelvedata",
        market_type="stock",
        metadata={"series_identity": identity.to_dict()},
    )
    event = TwelveDataNormalizer(
        IngestionConfig(twelve_data_api_key="key"),
        _descriptor(),
    ).parse(
        RawMessage(
            payload={
                "datetime": "2026-08-28",
                "open": "100",
                "high": "101",
                "low": "99",
                "close": "100.5",
                "volume": "123",
            },
            source=DataSource.HTTP_BACKFILL,
            stream_type=StreamType.KLINE,
            received_at_ms=_ms("2026-08-29T00:00:00"),
        )
    )

    assert event is not None
    bar = HistoricalFetcher._event_to_bar(event, task)
    assert bar is not None
    assert bar.series_identity == identity


def test_data_manager_opens_only_the_registered_twelve_data_history_route() -> None:
    identity = identity_for_instrument(market_type="stock", venue="XNGS")
    calls: list[tuple[tuple, dict]] = []
    manager = DataManager()
    manager.set_backfill_trigger(
        lambda *args, **kwargs: calls.append((args, kwargs)) or "td-request",
    )
    result = QueryResult(
        bars=[],
        symbol="AAPL:NASDAQ",
        interval="1d",
        exchange="twelvedata",
        market_type="stock",
        source=QuerySource.EMPTY,
        missing_ranges=[MissingRange(
            symbol="AAPL:NASDAQ",
            interval="1d",
            start_ms=_ms("2026-08-20T00:00:00"),
            end_ms=_ms("2026-08-28T00:00:00"),
            exchange="twelvedata",
            market_type="stock",
        )],
        **identity.to_dict(),
    )

    manager._submit_missing_ranges(
        result,
        backfill_metadata={
            "series_identity": identity_for_instrument(
                market_type="etf",
                venue="ARCX",
            ).to_dict(),
            "history_verification": "caller_override",
            "requires_trusted_finality": False,
        },
    )

    assert result.backfill_triggered is True
    assert len(calls) == 1
    metadata = calls[0][1]["metadata"]
    assert metadata["series_identity"] == identity.to_dict()
    assert metadata["history_verification"] == "provider_authoritative_sparse"
    assert metadata["requires_trusted_finality"] is True
