from __future__ import annotations

import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.klines import router as klines_router
from app.data_engine.data_manager import SeriesKey
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.data_manager.models import BarData, QueryResult, QuerySource
from app.data_engine.series_identity import KlineSeriesIdentity
from app.data_engine.storage import klines_repo
from app.exchanges.models import SymbolInfo


def _bar(open_time: int, close: float) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + 59_999,
        "open": close - 1,
        "high": close + 1,
        "low": close - 2,
        "close": close,
        "volume": 10,
        "quote_volume": None,
        "trades": None,
        "taker_buy_base": None,
        "taker_buy_quote": None,
    }


def _equity_identity(*, adjustment: str) -> KlineSeriesIdentity:
    return KlineSeriesIdentity(
        provider_id="polygon",
        venue="xnys",
        asset_class="equity",
        series_variant="official",
        price_adjustment=adjustment,
        session_variant="regular",
        volume_semantics="shares",
    )


def test_series_key_preserves_legacy_topic_and_separates_semantics() -> None:
    legacy = SeriesKey("btcusdt", "1m")
    explicit_legacy = SeriesKey(
        "BTCUSDT",
        "1m",
        provider_id="binance",
        venue="binance",
    )
    raw = SeriesKey(
        "AAPL",
        "1m",
        exchange="alpaca",
        market_type="stock",
        **_equity_identity(adjustment="raw").to_dict(),
    )
    adjusted = SeriesKey(
        "AAPL",
        "1m",
        exchange="alpaca",
        market_type="stock",
        **_equity_identity(adjustment="split_adjusted").to_dict(),
    )

    assert legacy == explicit_legacy
    assert legacy.topic == "BTCUSDT@1m"
    assert raw != adjusted
    assert raw.topic != adjusted.topic


def test_legacy_schema_migrates_to_semantic_primary_key(monkeypatch, tmp_path) -> None:
    database = tmp_path / "legacy.sqlite"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE klines (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time INTEGER NOT NULL,
                close_time INTEGER,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                quote_volume REAL,
                trades INTEGER,
                taker_buy_base REAL,
                taker_buy_quote REAL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (exchange, market_type, symbol, interval, open_time)
            );
            INSERT INTO klines VALUES (
                'binance', 'spot', 'BTCUSDT', '1m', 60000, 119999,
                99, 101, 98, 100, 10, NULL, NULL, NULL, NULL,
                'backfill_rest_verified', 1, 1
            );
            """
        )

    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", database)
    klines_repo.init_klines_storage()
    klines_repo.init_klines_storage()

    with sqlite3.connect(database) as connection:
        info = connection.execute("PRAGMA table_info(klines)").fetchall()
        primary_key = tuple(
            row[1]
            for row in sorted(info, key=lambda item: item[5])
            if row[5] > 0
        )
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"

    assert primary_key == klines_repo._KLINES_PRIMARY_KEY
    row = klines_repo.query_klines("BTCUSDT", "1m")[0]
    assert row["provider_id"] == "binance"
    assert row["venue"] == "binance"
    assert row["asset_class"] == "crypto"
    assert row["price_adjustment"] == "raw"
    assert row["session_variant"] == "continuous"
    assert row["volume_semantics"] == "base_asset"


def test_storage_query_and_delete_are_isolated_by_series_semantics(
    monkeypatch,
    tmp_path,
) -> None:
    database = tmp_path / "semantic.sqlite"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", database)
    klines_repo.init_klines_storage()
    raw = _equity_identity(adjustment="raw")
    adjusted = _equity_identity(adjustment="split_adjusted")

    for identity, close in ((raw, 200.0), (adjusted, 100.0)):
        assert klines_repo.upsert_klines(
            "AAPL",
            "1m",
            [_bar(60_000, close)],
            source="vendor_history_verified",
            exchange="alpaca",
            market_type="stock",
            series_identity=identity,
        ) == 1

    raw_rows = klines_repo.query_klines(
        "AAPL",
        "1m",
        exchange="alpaca",
        market_type="stock",
        series_identity=raw,
    )
    adjusted_rows = klines_repo.query_klines(
        "AAPL",
        "1m",
        exchange="alpaca",
        market_type="stock",
        series_identity=adjusted,
    )
    assert [row["close"] for row in raw_rows] == [200.0]
    assert [row["close"] for row in adjusted_rows] == [100.0]
    assert len(klines_repo.list_series_summaries()) == 2

    assert klines_repo.delete_klines(
        "AAPL",
        "1m",
        exchange="alpaca",
        market_type="stock",
        series_identity=adjusted,
    ) == 1
    assert klines_repo.query_klines(
        "AAPL",
        "1m",
        exchange="alpaca",
        market_type="stock",
        series_identity=raw,
    ) == raw_rows


def test_query_engine_reads_nonlegacy_identity_without_crypto_backfill(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", tmp_path / "engine.sqlite")
    klines_repo.init_klines_storage()
    identity = _equity_identity(adjustment="split_adjusted")
    klines_repo.upsert_klines(
        "AAPL",
        "1m",
        [_bar(60_000, 100.0)],
        source="vendor_history_verified",
        exchange="binance",
        market_type="spot",
        series_identity=identity,
    )
    triggered: list[tuple] = []
    engine = QueryEngine(
        BarCache(),
        klines_repo.KlinesRepoAdapter(),
        QueryConfig(auto_backfill=True),
        lambda *args: triggered.append(args),
    )

    result = engine.query(
        "AAPL",
        "1m",
        start_ms=60_000,
        end_ms=60_000,
        limit=1,
        exchange="binance",
        market_type="spot",
        series_identity=identity,
    )

    assert [bar.close for bar in result.bars] == [100.0]
    assert result.provider_id == "polygon"
    assert result.price_adjustment == "split_adjusted"
    assert triggered == []


def test_symbol_info_serializes_traditional_finance_contract() -> None:
    payload = SymbolInfo(
        symbol="AAPL",
        base_asset="AAPL",
        quote_asset="USD",
        status="active",
        exchange="alpaca",
        market_type="stock",
        product_type="equity",
        display_name="Apple Inc.",
        currency="usd",
        provider_id="polygon",
        provider_instrument_id="AAPL",
        venue="xnys",
        venue_mic="XNYS",
        asset_class="equity",
        session_variant="regular",
        volume_semantics="shares",
        entitlement="realtime",
        delay_seconds=0,
        redistribution="display_only",
    ).to_dict()

    assert payload["providerId"] == "polygon"
    assert payload["venue"] == "xnys"
    assert payload["venueMic"] == "XNYS"
    assert payload["assetClass"] == "equity"
    assert payload["sessionVariant"] == "regular"
    assert payload["volumeSemantics"] == "shares"
    assert payload["delaySeconds"] == 0


def test_kline_api_threads_nonlegacy_identity_without_starting_crypto_stream() -> None:
    seen: list[KlineSeriesIdentity] = []

    class DataManager:
        async def ensure_stream(self, *args, **kwargs):
            raise AssertionError("non-default identity must not start the legacy stream")

        def query_latest(
            self,
            symbol,
            interval,
            limit,
            exchange,
            *,
            market_type,
            series_identity,
        ) -> QueryResult:
            seen.append(series_identity)
            return QueryResult(
                bars=[BarData(time=60, open=99, high=101, low=98, close=100, volume=10)],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                **series_identity.to_dict(),
                source=QuerySource.STORAGE,
                total=1,
            )

    app = FastAPI()
    app.include_router(klines_router, prefix="/api/v1")
    app.state.data_manager = DataManager()
    response = TestClient(app).get(
        "/api/v1/klines/",
        params={
            "symbol": "AAPL",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "provider_id": "polygon",
            "venue": "XNYS",
            "asset_class": "equity",
            "price_adjustment": "split_adjusted",
            "session_variant": "regular",
            "volume_semantics": "shares",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_id"] == "polygon"
    assert payload["venue"] == "xnys"
    assert payload["price_adjustment"] == "split_adjusted"
    assert [identity.provider_id for identity in seen] == ["polygon"]
