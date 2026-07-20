from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.market import router as market_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.events import HubRecord, MarketStateEvent
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.service import MarketHistoryPage


class _MarketDataManager:
    market_data_ready = True

    def __init__(self) -> None:
        self.snapshot_calls: list[tuple[list[MarketStreamKey], bool]] = []
        self.history_calls: list[dict] = []

    async def market_snapshot(
        self,
        keys: list[MarketStreamKey],
        *,
        refresh_missing: bool,
    ) -> list[HubRecord]:
        self.snapshot_calls.append((keys, refresh_missing))
        records: list[HubRecord] = []
        for revision, key in enumerate(keys, start=1):
            if key.channel == MarketChannel.BASIS:
                continue
            records.append(HubRecord(
                event=MarketStateEvent(
                    key=key,
                    event_time_ms=1_700_000_000_000 + revision,
                    received_at_ms=1_700_000_000_100 + revision,
                    source=DataSource.HTTP,
                    data={key.channel.value: float(revision)},
                ),
                revision=revision,
            ))
        return records

    async def market_history(self, key: MarketStreamKey, **kwargs) -> list[MarketStateEvent]:
        self.history_calls.append({"key": key, **kwargs})
        return [
            MarketStateEvent(
                key=key,
                event_time_ms=1_700_000_000_000,
                received_at_ms=1_700_000_000_100,
                source=DataSource.HTTP_BACKFILL,
                data={
                    "funding_rate": 0.0001,
                    "is_final": True,
                    "sample_kind": "settlement",
                },
            ),
            MarketStateEvent(
                key=key,
                event_time_ms=1_700_028_800_000,
                received_at_ms=1_700_028_800_100,
                source=DataSource.HTTP_BACKFILL,
                data={
                    "funding_rate": 0.0002,
                    "is_final": False,
                    "sample_kind": "preview",
                },
            ),
        ]


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(market_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def test_market_snapshot_returns_records_and_explicit_missing_keys() -> None:
    dm = _MarketDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/market/snapshot",
        params={
            "symbol": "btcusdt",
            "channel": "mark_price,basis",
            "refresh_missing": "false",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "market.snapshot"
    assert [item["channel"] for item in payload["data"]] == ["mark_price"]
    assert payload["missing"] == [{
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "channel": "basis",
        "params": {},
    }]
    assert dm.snapshot_calls[0][1] is False


def test_market_history_returns_coverage_and_forwards_query() -> None:
    dm = _MarketDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/market/history",
        params={
            "symbol": "ETHUSDT",
            "channel": "funding_rate",
            "start_ms": 1_699_999_999_000,
            "limit": 3,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "market.history"
    assert payload["count"] == 2
    assert payload["fallback"] is False
    assert payload["has_more"] is False
    assert payload["data"][0]["data"]["sample_kind"] == "settlement"
    assert payload["data"][1]["data"] == {
        "funding_rate": 0.0002,
        "is_final": False,
        "sample_kind": "preview",
    }
    assert payload["coverage"] == {
        "earliest_ms": 1_700_000_000_000,
        "latest_ms": 1_700_028_800_000,
        "complete": True,
        "terminal_reason": None,
        "retryable": False,
        "earliest_available_ms": None,
        "availability_revision": None,
    }
    assert dm.history_calls == [{
        "key": MarketStreamKey.build(
            "binance",
            "futures",
            "ETHUSDT",
            MarketChannel.FUNDING_RATE,
        ),
        "period": None,
        "start_ms": 1_699_999_999_000,
        "end_ms": None,
        "limit": 3,
    }]


def test_market_http_rejects_invalid_channel_and_unready_runtime() -> None:
    client = _client(_MarketDataManager())
    invalid = client.get("/api/v1/market/snapshot?channel=not_a_channel")
    assert invalid.status_code == 422

    missing = _client().get("/api/v1/market/snapshot")
    assert missing.status_code == 503
    assert missing.json()["detail"] == "DataManager not initialized"


def test_market_history_validates_range_and_period_is_part_of_response_identity() -> None:
    dm = _MarketDataManager()
    client = _client(dm)

    invalid = client.get(
        "/api/v1/market/history",
        params={
            "channel": "open_interest",
            "period": "5m",
            "start_ms": 200,
            "end_ms": 100,
        },
    )
    assert invalid.status_code == 422

    response = client.get(
        "/api/v1/market/history",
        params={"channel": "open_interest", "period": "5m"},
    )
    assert response.status_code == 200
    assert response.json()["key"]["params"] == {"period": "5m"}


def test_market_history_explicit_hybrid_view_is_forwarded_and_identified() -> None:
    dm = _MarketDataManager()
    response = _client(dm).get(
        "/api/v1/market/history",
        params={
            "channel": "funding_rate",
            "period": "1s",
            "view": "hybrid",
            "start_ms": 1000,
            "end_ms": 2000,
        },
    )

    assert response.status_code == 200
    assert response.json()["key"]["params"] == {
        "period": "1s",
        "view": "hybrid",
    }
    assert dm.history_calls[0]["view"] == "hybrid"
    assert dm.history_calls[0]["period"] == "1s"

    missing_period = _client(dm).get(
        "/api/v1/market/history?channel=funding_rate&view=hybrid",
    )
    assert missing_period.status_code == 422
    wrong_channel = _client(dm).get(
        "/api/v1/market/history?channel=open_interest&period=5m&view=hybrid",
    )
    assert wrong_channel.status_code == 422


def test_hybrid_funding_canonicalizes_irregular_chart_period_alias() -> None:
    dm = _MarketDataManager()
    response = _client(dm).get(
        "/api/v1/market/history",
        params={
            "channel": "funding_rate",
            "period": "2820s",
            "view": "hybrid",
        },
    )

    assert response.status_code == 200
    assert response.json()["key"]["params"] == {
        "period": "47m",
        "view": "hybrid",
    }
    assert dm.history_calls[0]["period"] == "47m"


def test_market_history_expired_empty_page_is_complete_and_not_retryable() -> None:
    class _ExpiredHistoryManager(_MarketDataManager):
        async def market_history_page(self, key: MarketStreamKey, **kwargs):
            self.history_calls.append({"key": key, **kwargs})
            return MarketHistoryPage(events=[], fallback=False)

    response = _client(_ExpiredHistoryManager()).get(
        "/api/v1/market/history",
        params={
            "channel": "open_interest",
            "period": "1h",
            "start_ms": 1,
            "end_ms": 2,
            "limit": 500,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "type": "market.history",
        "key": {
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
            "channel": "open_interest",
            "params": {"period": "1h"},
        },
        "count": 0,
        "data": [],
        "fallback": False,
        "has_more": False,
        "history_state": "ready",
        "complete": True,
        "retryable": False,
        "terminal_reason": None,
        "earliest_available_ms": None,
        "next_before_ms": None,
        "availability_revision": None,
        "excluded_ranges": [],
        "coverage": {
            "earliest_ms": None,
            "latest_ms": None,
            "complete": True,
            "terminal_reason": None,
            "retryable": False,
            "earliest_available_ms": None,
            "availability_revision": None,
        },
    }


def test_market_history_exposes_not_expected_future_exclusion() -> None:
    class _FutureHistoryManager(_MarketDataManager):
        async def market_history_page(self, key: MarketStreamKey, **kwargs):
            self.history_calls.append({"key": key, **kwargs})
            return MarketHistoryPage(
                events=[],
                complete=True,
                excluded_ranges=({
                    "start_ms": 200,
                    "end_ms": 300,
                    "disposition": "not_expected",
                    "reason": "future",
                },),
            )

    response = _client(_FutureHistoryManager()).get(
        "/api/v1/market/history",
        params={
            "channel": "funding_rate",
            "start_ms": 200,
            "end_ms": 300,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 0
    assert payload["history_state"] == "ready"
    assert payload["complete"] is True
    assert payload["retryable"] is False
    assert payload["terminal_reason"] is None
    assert payload["has_more"] is False
    assert payload["excluded_ranges"] == [{
        "start_ms": 200,
        "end_ms": 300,
        "disposition": "not_expected",
        "reason": "future",
    }]


def test_market_http_does_not_expose_raw_upstream_error_text() -> None:
    class _FailingManager(_MarketDataManager):
        async def market_snapshot(self, keys, *, refresh_missing):
            raise RuntimeError("secret upstream response body")

    response = _client(_FailingManager()).get("/api/v1/market/snapshot")

    assert response.status_code == 502
    assert response.json()["detail"] == "market snapshot is temporarily unavailable"
