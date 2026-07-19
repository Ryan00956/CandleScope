from __future__ import annotations

import asyncio
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.api.v1.klines as klines_api
from app.api.v1.klines import (
    _schedule_related_interval_warmup,
    _verify_range_continuity,
    router as klines_router,
)
from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.models import BarData, MissingRange, QueryResult, QuerySource
from app.data_engine.history import SessionCalendar


def test_range_verifier_rejects_explicitly_unclosed_bar_inside_closed_range() -> None:
    verification = _verify_range_continuity(
        data=[{
            "time": 60,
            "open": 1,
            "high": 1,
            "low": 1,
            "close": 1,
            "volume": 1,
            "is_closed": False,
        }],
        symbol="BTCUSDT",
        interval="1m",
        exchange="binance",
        market_type="spot",
        start_ms=60_000,
        end_ms=60_000,
    )

    assert verification["verified_contiguous"] is False
    assert verification["unclosed_bars"] == 1
    assert verification["missing_ranges"][0]["start_ms"] == 60_000


def test_custom_verification_does_not_duplicate_reported_base_component_repair() -> None:
    verification_missing = [{
        "symbol": "BTCUSDT",
        "interval": "45m",
        "exchange": "binance",
        "market_type": "spot",
        "start_ms": 0,
        "end_ms": 0,
        "missing_bars": 1,
        "reason": "range_verification",
    }]
    reported_base_missing = [{
        "symbol": "BTCUSDT",
        "interval": "15m",
        "exchange": "binance",
        "market_type": "spot",
        "start_ms": 1_800_000,
        "end_ms": 1_800_000,
        "missing_bars": 1,
        "reason": "query_interior_gap",
    }]

    assert klines_api._verification_only_missing_ranges(
        verification_missing,
        reported_base_missing,
        interval="45m",
        calendar=None,
    ) == []


def test_custom_verifier_projects_suppressed_base_component_to_target_bucket() -> None:
    verification = _verify_range_continuity(
        data=[],
        symbol="BTCUSDT",
        interval="45m",
        exchange="binance",
        market_type="spot",
        start_ms=0,
        end_ms=0,
        excluded_ranges=[{
            "start_ms": 1_800_000,
            "end_ms": 1_800_000,
            "reason": "gap_ledger_source_empty",
            "retry_at_ms": 86_400_000,
        }],
    )

    assert verification["verified_contiguous"] is True
    assert verification["missing_ranges"] == []


def test_range_verifier_splits_missing_runs_around_excluded_bucket() -> None:
    verification = _verify_range_continuity(
        data=[],
        symbol="BTCUSDT",
        interval="1m",
        exchange="binance",
        market_type="spot",
        start_ms=0,
        end_ms=120_000,
        excluded_ranges=[{
            "start_ms": 60_000,
            "end_ms": 60_000,
            "reason": "gap_ledger_source_empty",
        }],
    )

    assert verification["verified_contiguous"] is False
    assert verification["expected_bars"] == 2
    assert [
        (item["start_ms"], item["end_ms"], item["missing_bars"])
        for item in verification["missing_ranges"]
    ] == [(0, 0, 1), (120_000, 120_000, 1)]


def test_session_tail_bucket_does_not_absorb_closed_market_exclusions_or_reports() -> None:
    calendar = SessionCalendar(
        calendar_id="test.short-session",
        timezone_name="UTC",
        weekly_sessions={weekday: [("09:30", "10:00")] for weekday in range(5)},
    )
    session_open_ms = 1_719_826_200_000
    closed_market_ms = 1_719_856_800_000
    exclusion = {
        "start_ms": closed_market_ms,
        "end_ms": closed_market_ms,
        "reason": "unrelated_closed_market_gap",
    }

    verification = _verify_range_continuity(
        data=[],
        symbol="BTCUSDT",
        interval="30m",
        exchange="binance",
        market_type="spot",
        start_ms=session_open_ms,
        end_ms=session_open_ms,
        calendar=calendar,
        excluded_ranges=[exclusion],
    )

    assert verification["verified_contiguous"] is False
    assert verification["expected_bars"] == 1
    assert verification["missing_ranges"][0]["start_ms"] == session_open_ms
    assert klines_api._verification_only_missing_ranges(
        verification["missing_ranges"],
        [exclusion],
        interval="30m",
        calendar=calendar,
    ) == verification["missing_ranges"]


class _FakeDataManager:
    def __init__(self, *, is_closed: bool = True) -> None:
        self.is_closed = is_closed
        self.ensure_stream_calls: list[dict] = []
        self.release_stream_calls: list[dict] = []
        self.query_latest_calls: list[dict] = []

    async def ensure_stream(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        focus_scope: str = "foreground",
        consumer_id: str | None = None,
    ) -> None:
        self.ensure_stream_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "focus_scope": focus_scope,
            "consumer_id": consumer_id,
        })

    async def release_stream(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        focus_scope: str = "foreground",
        consumer_id: str | None = None,
    ) -> None:
        self.release_stream_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "focus_scope": focus_scope,
            "consumer_id": consumer_id,
        })

    def query_latest(
        self,
        symbol: str,
        interval: str,
        limit: int,
        exchange: str = "binance",
        *,
        market_type: str = "spot",
    ) -> QueryResult:
        self.query_latest_calls.append({
            "symbol": symbol,
            "interval": interval,
            "limit": limit,
            "exchange": exchange,
            "market_type": market_type,
        })
        bars = [
            BarData.from_storage_row({
                "exchange": exchange,
                "market_type": market_type,
                "open_time": 1_700_000_000_000,
                "open": 1,
                "high": 2,
                "low": 0.5,
                "close": 1.5,
                "volume": 10,
                "is_closed": self.is_closed,
                "quote_volume": 15,
                "trades": 7,
                "taker_buy_base": 6,
                "taker_buy_quote": 9,
            })
        ]
        return QueryResult(
            bars=bars,
            symbol=symbol,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            source=QuerySource.CACHE,
            total=len(bars),
            metadata={"cache_hit": True},
        )


def _client(data_manager=None) -> TestClient:
    app = FastAPI()
    app.include_router(klines_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _client_with_runtime(data_manager=None, backfill_coordinator=None) -> TestClient:
    class _Runtime:
        def get_backfill_coordinator(self):
            return backfill_coordinator

    app = FastAPI()
    app.include_router(klines_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    if backfill_coordinator is not None:
        app.state.data_engine_runtime = _Runtime()
    return TestClient(app)


def test_strict_range_withholds_unverified_partial_rows() -> None:
    class _RangeDataManager:
        def query(self, symbol, interval, *, exchange, market_type, **kwargs) -> QueryResult:
            bars = [
                BarData(time=0, open=1, high=2, low=1, close=2, volume=1),
                BarData(time=120, open=2, high=3, low=2, close=3, volume=1),
            ]
            return QueryResult(
                bars=bars,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=len(bars),
            )

    client = _client(_RangeDataManager())
    params = {
        "symbol": "BTCUSDT",
        "interval": "1m",
        "start_ms": 0,
        "end_ms": 120_000,
        "repair": "none",
    }

    strict_payload = client.get("/api/v1/klines/range", params=params).json()
    permissive_payload = client.get(
        "/api/v1/klines/range",
        params={**params, "strict": False},
    ).json()

    assert strict_payload["verified_contiguous"] is False
    assert strict_payload["renderable"] is False
    assert strict_payload["data"] == []
    assert strict_payload["count"] == 0
    assert strict_payload["actual_bars"] == 2
    assert len(permissive_payload["data"]) == 2
    assert permissive_payload["renderable"] is True


def test_get_klines_returns_503_without_data_manager() -> None:
    client = _client()

    response = client.get("/api/v1/klines/", params={"symbol": "BTCUSDT", "interval": "1m"})

    assert response.status_code == 503
    assert response.json()["detail"] == "DataManager 尚未初始化"


def test_get_klines_uses_data_manager_when_available() -> None:
    dm = _FakeDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/",
        params={
            "symbol": "btcusdt",
            "interval": "1m",
            "limit": 1,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["exchange"] == "binance"
    assert payload["market_type"] == "spot"
    assert payload["symbol"] == "BTCUSDT"
    assert payload["interval"] == "1m"
    assert payload["count"] == 1
    assert payload["source"] == "cache"
    assert payload["fetched"] == 1
    assert payload["cache"] == {"cache_hit": True}
    assert payload["data"] == [
        {
            "time": 1_700_000_000,
            "open": 1,
            "high": 2,
            "low": 0.5,
            "close": 1.5,
            "volume": 10,
            "is_closed": True,
            "quote_volume": 15,
            "trades": 7,
            "taker_buy_base": 6,
            "taker_buy_quote": 9,
            "order_flow": {
                "taker_sell_base": 4,
                "volume_delta_base": 2,
                "taker_buy_ratio_base": 0.6,
                "cvd_contribution_base": 2,
            },
        }
    ]
    assert dm.ensure_stream_calls == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "focus_scope": "rest",
            "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
        }
    ]
    assert dm.ensure_stream_calls[0]["consumer_id"].startswith(
        "rest:klines:binance:spot:BTCUSDT:1m:"
    )
    assert dm.release_stream_calls == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "focus_scope": "rest",
            "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
        }
    ]
    assert dm.query_latest_calls == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "limit": 1,
            "exchange": "binance",
            "market_type": "spot",
        }
    ]


def test_get_klines_okx_suppresses_placeholder_order_flow() -> None:
    client = _client(_FakeDataManager())

    response = client.get(
        "/api/v1/klines/",
        params={
            "symbol": "BTC-USDT",
            "interval": "1m",
            "limit": 1,
            "exchange": "okx",
            "market_type": "swap",
        },
    )

    assert response.status_code == 200
    bar = response.json()["data"][0]
    assert bar["quote_volume"] == 15
    assert bar["trades"] is None
    assert bar["taker_buy_base"] is None
    assert bar["taker_buy_quote"] is None
    assert bar["order_flow"] is None


def test_get_klines_preserves_forming_bar_state() -> None:
    client = _client(_FakeDataManager(is_closed=False))

    response = client.get(
        "/api/v1/klines/",
        params={"symbol": "BTCUSDT", "interval": "1m", "limit": 1},
    )

    assert response.status_code == 200
    assert response.json()["data"][0]["is_closed"] is False


def test_history_before_waits_for_backfill_future_before_returning_rows() -> None:
    class _BeforeDataManager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def query_before(
            self,
            symbol: str,
            interval: str,
            before_ms: int,
            limit: int,
            exchange: str,
            *,
            market_type: str,
            auto_backfill: bool | None = None,
            backfill_reason: str | None = None,
            backfill_requester: str | None = None,
        ) -> QueryResult:
            self.calls.append({
                "auto_backfill": auto_backfill,
                "backfill_reason": backfill_reason,
                "backfill_requester": backfill_requester,
            })
            if len(self.calls) == 1:
                return QueryResult(
                    bars=[],
                    symbol=symbol,
                    interval=interval,
                    exchange=exchange,
                    market_type=market_type,
                    source=QuerySource.EMPTY,
                    total=0,
                    has_more=True,
                    backfill_triggered=True,
                    metadata={"backfill_request_ids": ["req-before-1"]},
                )
            bars = [BarData(time=(before_ms // 1000) - 60, open=1, high=2, low=1, close=2, volume=10)]
            return QueryResult(
                bars=bars,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=len(bars),
                has_more=True,
            )

    class _BackfillCoordinator:
        def __init__(self) -> None:
            self.waited: list[str] = []

        async def wait_for_request(self, request_id: str):
            self.waited.append(request_id)
            return object()

    dm = _BeforeDataManager()
    coordinator = _BackfillCoordinator()
    client = _client_with_runtime(dm, coordinator)

    response = client.get(
        "/api/v1/klines/history/before",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "before": 1_700_000_000,
            "bars": 500,
            "exchange": "binance",
            "market_type": "spot",
            "max_wait_ms": 1000,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert payload["source"] == "storage"
    assert coordinator.waited == ["req-before-1"]
    assert dm.calls == [
        {
            "auto_backfill": None,
            "backfill_reason": "visible_load_more",
            "backfill_requester": "klines_history_before",
        },
        {
            "auto_backfill": False,
            "backfill_reason": "visible_load_more",
            "backfill_requester": "klines_history_before",
        },
    ]


def test_history_requeries_storage_after_backfill_future_times_out() -> None:
    class _HistoryDataManager:
        def __init__(self) -> None:
            self.calls: list[bool | None] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            self.calls.append(auto_backfill)
            return QueryResult(
                bars=[],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.EMPTY,
                total=0,
                backfill_triggered=len(self.calls) == 1,
                metadata={"backfill_request_ids": ["req-history-timeout"]},
            )

    class _NeverCompletesCoordinator:
        async def wait_for_request(self, request_id: str):
            assert request_id == "req-history-timeout"
            await asyncio.Event().wait()

    dm = _HistoryDataManager()
    client = _client_with_runtime(dm, _NeverCompletesCoordinator())

    response = client.get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "days": 0.001,
            "exchange": "binance",
            "market_type": "spot",
            "max_wait_ms": 10,
        },
    )

    assert response.status_code == 200
    assert response.json()["count"] == 0
    assert response.json()["backfill_triggered"] is True
    assert dm.calls[0] is None
    assert len(dm.calls) >= 2
    assert all(auto_backfill is False for auto_backfill in dm.calls[1:])


def test_history_waits_for_a_scheduled_partial_tail_repair() -> None:
    class _HistoryDataManager:
        def __init__(self) -> None:
            self.calls: list[bool | None] = []
            self.tail_repaired = False

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            self.calls.append(auto_backfill)
            bars = [BarData(time=1_700_000_000, open=1, high=2, low=1, close=2, volume=10)]
            if self.tail_repaired:
                bars.append(BarData(time=1_700_000_060, open=2, high=3, low=2, close=3, volume=11))
            return QueryResult(
                bars=bars,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=len(bars),
                has_more=True,
                backfill_triggered=len(self.calls) == 1,
                has_tail_gap=not self.tail_repaired,
                metadata={"backfill_request_ids": ["req-partial-tail"]},
            )

    class _CompletedCoordinator:
        def __init__(self, data_manager: _HistoryDataManager) -> None:
            self._data_manager = data_manager
            self.waited: list[str] = []

        async def wait_for_request(self, request_id: str):
            self.waited.append(request_id)
            self._data_manager.tail_repaired = True
            return object()

    dm = _HistoryDataManager()
    coordinator = _CompletedCoordinator(dm)
    client = _client_with_runtime(dm, coordinator)

    response = client.get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "days": 0.001,
            "exchange": "binance",
            "market_type": "spot",
            "max_wait_ms": 1000,
        },
    )

    assert response.status_code == 200
    assert response.json()["count"] == 2
    assert coordinator.waited == ["req-partial-tail"]
    assert dm.calls == [None, False]


def test_history_verification_only_gap_submits_and_waits_for_exact_request(
    monkeypatch,
) -> None:
    class _HistoryDataManager:
        def __init__(self) -> None:
            self.repaired = False
            self.query_calls: list[bool | None] = []
            self.repair_calls: list[tuple[tuple, dict]] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
            **kwargs,
        ) -> QueryResult:
            self.query_calls.append(auto_backfill)
            times = [start_ms, end_ms]
            if self.repaired:
                times.insert(1, start_ms + 60_000)
            bars = [
                BarData(
                    time=value // 1000,
                    open=1,
                    high=2,
                    low=1,
                    close=2,
                    volume=10,
                )
                for value in times
            ]
            return QueryResult(
                bars=bars,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=len(bars),
            )

        def request_backfill(self, *args, **kwargs):
            self.repair_calls.append((args, kwargs))
            return "verification-history-wait"

    class _Coordinator:
        def __init__(self, dm: _HistoryDataManager) -> None:
            self.dm = dm
            self.waited: list[str] = []

        async def wait_for_request(self, request_id: str):
            self.waited.append(request_id)
            self.dm.repaired = True
            return object()

    monkeypatch.setattr(
        klines_api,
        "_schedule_related_interval_warmup",
        lambda *args, **kwargs: None,
    )
    dm = _HistoryDataManager()
    coordinator = _Coordinator(dm)
    response = _client_with_runtime(dm, coordinator).get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "count_back": 3,
            "max_wait_ms": 1000,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert dm.query_calls == [None, False]
    assert len(dm.repair_calls) == 1
    repair_args, repair_kwargs = dm.repair_calls[0]
    assert repair_args[3] == repair_args[2]
    assert repair_kwargs["reason"] == "initial_history"
    assert repair_kwargs["requester"] == "klines_history"
    assert repair_kwargs["metadata"]["missing_bars"] == 1
    assert coordinator.waited == ["verification-history-wait"]
    assert payload["backfill_triggered"] is True
    assert payload["verified_contiguous"] is True
    assert payload["complete"] is True
    assert payload["missing_ranges"] == []


def test_history_returns_promptly_when_completed_backfill_has_no_rows() -> None:
    class _HistoryDataManager:
        def __init__(self) -> None:
            self.calls: list[bool | None] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            self.calls.append(auto_backfill)
            return QueryResult(
                bars=[],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.EMPTY,
                total=0,
                backfill_triggered=len(self.calls) == 1,
                metadata={"backfill_request_ids": ["req-history-completed"]},
            )

    class _CompletedCoordinator:
        async def wait_for_request(self, request_id: str):
            assert request_id == "req-history-completed"
            return object()

    dm = _HistoryDataManager()
    client = _client_with_runtime(dm, _CompletedCoordinator())

    started = time.perf_counter()
    response = client.get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "days": 0.001,
            "exchange": "binance",
            "market_type": "spot",
            "max_wait_ms": 2000,
        },
    )
    elapsed = time.perf_counter() - started

    assert response.status_code == 200
    assert response.json()["count"] == 0
    assert dm.calls == [None, False]
    assert elapsed < 1.0


def test_history_before_returns_partial_write_when_aggregate_wait_times_out() -> None:
    class _BeforeDataManager:
        def __init__(self) -> None:
            self.calls: list[bool | None] = []
            self.partial_write_committed = False

        def query_before(
            self,
            symbol: str,
            interval: str,
            before_ms: int,
            limit: int,
            exchange: str,
            *,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            self.calls.append(auto_backfill)
            if self.partial_write_committed:
                bars = [
                    BarData(
                        time=(before_ms // 1000) - 60,
                        open=1,
                        high=2,
                        low=1,
                        close=2,
                        volume=10,
                    )
                ]
                return QueryResult(
                    bars=bars,
                    symbol=symbol,
                    interval=interval,
                    exchange=exchange,
                    market_type=market_type,
                    source=QuerySource.STORAGE,
                    total=len(bars),
                    has_more=True,
                )
            return QueryResult(
                bars=[],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.EMPTY,
                total=0,
                has_more=True,
                backfill_triggered=True,
                metadata={
                    "backfill_request_ids": ["req-before-written", "req-before-pending"],
                },
            )

    class _PartialCoordinator:
        async def wait_for_request(self, request_id: str):
            if request_id == "req-before-written":
                dm.partial_write_committed = True
                return object()
            assert request_id == "req-before-pending"
            await asyncio.Event().wait()

    dm = _BeforeDataManager()
    client = _client_with_runtime(dm, _PartialCoordinator())

    started = time.perf_counter()
    response = client.get(
        "/api/v1/klines/history/before",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "before": 1_700_000_000,
            "bars": 500,
            "exchange": "binance",
            "market_type": "spot",
            "max_wait_ms": 2000,
        },
    )
    elapsed = time.perf_counter() - started

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert payload["source"] == "storage"
    assert payload["has_more"] is True
    assert dm.calls == [None, False]
    assert elapsed < 1.0


def test_history_query_triggers_data_manager_backfill_request_when_empty() -> None:
    calls: list[tuple[str, str, int, int, str, str]] = []
    dm = DataManager()
    dm.set_backfill_trigger(
        lambda symbol, interval, start_ms, end_ms, exchange, market_type: calls.append(
            (symbol, interval, start_ms, end_ms, exchange, market_type)
        )
    )
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1h",
            "days": 0.001,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["symbol"] == "BTCUSDT"
    assert payload["interval"] == "1h"
    assert payload["count"] == 0
    assert payload["source"] == "empty"
    assert payload["backfill_triggered"] is True
    assert len(calls) == 4
    symbol, interval, start_ms, end_ms, exchange, market_type = calls[0]
    assert (symbol, interval, exchange, market_type) == ("BTCUSDT", "1h", "binance", "spot")
    assert start_ms < end_ms
    assert [call[1] for call in calls[1:]] == ["15m", "4h", "5m"]


def test_history_count_back_overrides_days_window() -> None:
    calls: list[tuple[str, str, int, int, str, str]] = []
    dm = DataManager()
    dm.set_backfill_trigger(
        lambda symbol, interval, start_ms, end_ms, exchange, market_type: calls.append(
            (symbol, interval, start_ms, end_ms, exchange, market_type)
        )
    )
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1h",
            "days": 30,
            "count_back": 10,
            "max_wait_ms": 0,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count_back"] == 10
    _symbol, _interval, start_ms, end_ms, _exchange, _market_type = calls[0]
    assert end_ms - start_ms == 9 * 60 * 60 * 1000


def test_history_count_back_monthly_steps_calendar_buckets_without_calendar(
    monkeypatch,
) -> None:
    may_open_ms = 1_714_521_600_000
    july_open_ms = 1_719_792_000_000

    class _HistoryDataManager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def query(self, symbol: str, interval: str, **kwargs) -> QueryResult:
            self.calls.append({"symbol": symbol, "interval": interval, **kwargs})
            return QueryResult(
                bars=[],
                symbol=symbol,
                interval=interval,
                source=QuerySource.EMPTY,
                total=0,
            )

    monkeypatch.setattr(
        klines_api,
        "_last_closed_open_ms",
        lambda interval, *args, **kwargs: july_open_ms,
    )
    dm = _HistoryDataManager()

    response = _client(dm).get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1M",
            "count_back": 3,
            "max_wait_ms": 0,
        },
    )

    assert response.status_code == 200
    assert dm.calls == [{
        "symbol": "BTCUSDT",
        "interval": "1M",
        "start_ms": may_open_ms,
        "end_ms": july_open_ms,
        "limit": 3,
        "exchange": "binance",
        "market_type": "spot",
        "auto_backfill": None,
        "backfill_reason": "initial_history",
        "backfill_requester": "klines_history",
    }]


def test_cap_range_request_monthly_uses_exact_calendar_boundaries() -> None:
    january_open_ms = 1_704_067_200_000
    march_open_ms = 1_709_251_200_000
    april_open_ms = 1_711_929_600_000
    june_open_ms = 1_717_200_000_000

    capped = klines_api._cap_range_request(
        start_ms=january_open_ms,
        end_ms=june_open_ms,
        interval="1M",
        max_bars=3,
        calendar=None,
    )

    assert capped["query_start_ms"] == april_open_ms
    assert capped["query_end_ms"] == june_open_ms
    assert capped["needed_limit"] == 3
    assert capped["truncated"] is True
    assert capped["next_end_ms"] == march_open_ms


def test_cap_range_request_session_end_is_inclusive_without_looking_ahead() -> None:
    calendar = SessionCalendar(
        calendar_id="test.cap.0930.utc",
        timezone_name="UTC",
        weekly_sessions={weekday: (("09:30", "17:00"),) for weekday in range(5)},
    )
    day_start_ms = 1_773_964_800_000  # 2026-03-20T00:00:00Z, Friday

    capped = klines_api._cap_range_request(
        start_ms=day_start_ms + 9 * 3_600_000 + 30 * 60_000,
        end_ms=day_start_ms + 15 * 3_600_000,
        interval="1h",
        max_bars=2,
        calendar=calendar,
    )

    # 15:00 lies between the 14:30 and 15:30 session opens.  The latter must
    # not leak into this inclusive request or its pagination cursor.
    assert capped["query_start_ms"] == day_start_ms + 13 * 3_600_000 + 30 * 60_000
    assert capped["query_end_ms"] == day_start_ms + 15 * 3_600_000
    assert capped["needed_limit"] == 2
    assert capped["truncated"] is True
    assert capped["next_end_ms"] == day_start_ms + 12 * 3_600_000 + 30 * 60_000


def test_latest_endpoint_does_not_trigger_backfill_when_storage_is_empty() -> None:
    calls: list[tuple] = []
    dm = DataManager()
    dm.set_backfill_trigger(lambda *args, **kwargs: calls.append((args, kwargs)))
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/latest",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "limit": 5,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 0
    assert payload["backfill_triggered"] is False
    assert calls == []


def test_history_endpoint_submits_initial_history_demand_metadata() -> None:
    calls: list[tuple[tuple, dict]] = []
    dm = DataManager()
    dm.set_backfill_trigger(lambda *args, **kwargs: calls.append((args, kwargs)))
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1h",
            "days": 0.001,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    assert len(calls) == 4
    args, kwargs = calls[0]
    assert args[0:2] == ("BTCUSDT", "1h")
    assert kwargs["reason"] == "initial_history"
    assert kwargs["priority"] == 10
    assert kwargs["requester"] == "klines_history"
    assert kwargs["metadata"]["query_reason"] == "query_empty"

    related = calls[1:]
    assert [item[0][1] for item in related] == ["15m", "4h", "5m"]
    assert all(item[1]["reason"] == "related_interval_warmup" for item in related)
    assert all(item[1]["priority"] == 40 for item in related)
    assert all(item[1]["requester"] == "klines_history_related" for item in related)
    assert related[0][1]["metadata"]["focus_scope"] == "related"
    assert related[0][1]["metadata"]["current_interval"] == "1h"


def test_range_query_reports_exact_visible_gap() -> None:
    class _RangeDataManager:
        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            assert (start_ms, end_ms, limit) == (60_000, 180_000, 102)
            assert auto_backfill is False
            return QueryResult(
                bars=[
                    BarData(time=60, open=1, high=2, low=1, close=2, volume=10),
                    BarData(time=180, open=3, high=4, low=3, close=4, volume=30),
                ],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=2,
            )

    client = _client(_RangeDataManager())

    response = client.get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "exchange": "binance",
            "market_type": "spot",
            "repair": "none",
            "strict": "true",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["verified_contiguous"] is False
    assert payload["renderable"] is False
    assert payload["missing_ranges"] == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "start_ms": 120_000,
            "end_ms": 120_000,
            "missing_bars": 1,
            "reason": "range_verification",
            "status": "detected",
        }
    ]


def test_range_verification_only_gap_submits_for_async_but_not_none() -> None:
    class _RangeDataManager:
        def __init__(self) -> None:
            self.query_calls: list[bool | None] = []
            self.repair_calls: list[tuple[tuple, dict]] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
            **kwargs,
        ) -> QueryResult:
            self.query_calls.append(auto_backfill)
            return QueryResult(
                bars=[
                    BarData(time=60, open=1, high=2, low=1, close=2, volume=10),
                    BarData(time=180, open=3, high=4, low=3, close=4, volume=30),
                ],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=2,
            )

        def request_backfill(self, *args, **kwargs):
            self.repair_calls.append((args, kwargs))
            return "verification-range-1"

    async_dm = _RangeDataManager()
    async_response = _client(async_dm).get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "repair": "async",
        },
    )
    assert async_response.status_code == 200
    async_payload = async_response.json()
    assert async_dm.query_calls == [True]
    assert len(async_dm.repair_calls) == 1
    repair_args, repair_kwargs = async_dm.repair_calls[0]
    assert repair_args == (
        "BTCUSDT",
        "1m",
        120_000,
        120_000,
        "binance",
        "spot",
    )
    assert repair_kwargs["reason"] == "visible_range_gap"
    assert repair_kwargs["requester"] == "klines_range"
    assert repair_kwargs["metadata"]["verification_only"] is True
    assert async_payload["backfill_triggered"] is True
    assert async_payload["history_state"] == "pending"

    none_dm = _RangeDataManager()
    none_response = _client(none_dm).get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "repair": "none",
        },
    )
    assert none_response.status_code == 200
    assert none_dm.query_calls == [False]
    assert none_dm.repair_calls == []
    assert none_response.json()["backfill_triggered"] is False


def test_range_verification_only_gap_honours_covering_ledger_suppression() -> None:
    class _RangeDataManager:
        def __init__(self) -> None:
            self.repair_calls: list[tuple] = []

        def query(self, symbol, interval, **kwargs) -> QueryResult:
            return QueryResult(
                bars=[
                    BarData(time=60, open=1, high=2, low=1, close=2, volume=10),
                    BarData(time=180, open=3, high=4, low=3, close=4, volume=30),
                ],
                symbol=symbol,
                interval=interval,
                source=QuerySource.STORAGE,
                total=2,
                history_state="ready",
                complete=True,
            )

        def get_backfill_suppression(
            self,
            symbol,
            interval,
            start_ms,
            end_ms,
            exchange,
            market_type,
        ):
            assert (start_ms, end_ms) == (120_000, 120_000)
            return {
                "suppressed": True,
                "ledger_status": "source_empty",
                "start_ms": 60_000,
                "end_ms": 180_000,
                "retry_at_ms": 86_400_000,
            }

        def request_backfill(self, *args, **kwargs):
            self.repair_calls.append((args, kwargs))
            return True

    dm = _RangeDataManager()
    response = _client(dm).get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "repair": "async",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert dm.repair_calls == []
    assert payload["verified_contiguous"] is True
    assert payload["missing_ranges"] == []
    assert payload["history_state"] == "ready"
    assert payload["complete"] is True
    assert payload["retryable"] is False
    assert payload["retry_at_ms"] == 86_400_000
    assert payload["excluded_ranges"][0]["reason"] == "gap_ledger_source_empty"


def test_range_repairs_only_unsuppressed_sides_of_excluded_bucket() -> None:
    class _RangeDataManager:
        def __init__(self) -> None:
            self.lookup_calls: list[tuple[int, int]] = []
            self.repair_calls: list[tuple[tuple, dict]] = []

        def query(self, symbol, interval, **kwargs) -> QueryResult:
            return QueryResult(
                bars=[],
                symbol=symbol,
                interval=interval,
                source=QuerySource.EMPTY,
                total=0,
                history_state="ready",
                complete=True,
                excluded_ranges=[{
                    "start_ms": 60_000,
                    "end_ms": 60_000,
                    "disposition": "terminal",
                    "reason": "gap_ledger_source_empty",
                }],
            )

        def get_backfill_suppression(
            self,
            symbol,
            interval,
            start_ms,
            end_ms,
            exchange,
            market_type,
        ):
            self.lookup_calls.append((start_ms, end_ms))
            return None

        def request_backfill(self, *args, **kwargs):
            self.repair_calls.append((args, kwargs))
            return True

    dm = _RangeDataManager()
    response = _client(dm).get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 0,
            "end_ms": 120_000,
            "repair": "async",
        },
    )

    assert response.status_code == 200
    assert dm.lookup_calls == [(0, 0), (120_000, 120_000)]
    submitted_ranges = [(args[2], args[3]) for args, _kwargs in dm.repair_calls]
    assert submitted_ranges == [(0, 0), (120_000, 120_000)]
    assert all(not (start <= 60_000 <= end) for start, end in submitted_ranges)


def test_custom_range_does_not_bypass_suppressed_base_component() -> None:
    class _RangeDataManager:
        def __init__(self) -> None:
            self.repair_calls: list[tuple] = []

        def query(self, symbol, interval, **kwargs) -> QueryResult:
            return QueryResult(
                bars=[],
                symbol=symbol,
                interval=interval,
                source=QuerySource.EMPTY,
                total=0,
                history_state="ready",
                complete=True,
                retryable=False,
                excluded_ranges=[{
                    "start_ms": 1_800_000,
                    "end_ms": 1_800_000,
                    "disposition": "terminal",
                    "reason": "gap_ledger_source_empty",
                    "retry_at_ms": 86_400_000,
                }],
                metadata={"backfill_retry_at_ms": 86_400_000},
            )

        def request_backfill(self, *args, **kwargs):
            self.repair_calls.append((args, kwargs))
            return True

    dm = _RangeDataManager()
    response = _client(dm).get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "45m",
            "start_ms": 0,
            "end_ms": 0,
            "repair": "async",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert dm.repair_calls == []
    assert payload["verified_contiguous"] is True
    assert payload["missing_ranges"] == []
    assert payload["retry_at_ms"] == 86_400_000


def test_range_wait_binds_verification_only_request_and_requeries_without_resubmit() -> None:
    class _RangeDataManager:
        def __init__(self) -> None:
            self.repaired = False
            self.query_calls: list[bool | None] = []
            self.repair_calls: list[tuple[tuple, dict]] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
            **kwargs,
        ) -> QueryResult:
            self.query_calls.append(auto_backfill)
            times = (60, 120, 180) if self.repaired else (60, 180)
            bars = [
                BarData(time=value, open=1, high=2, low=1, close=2, volume=10)
                for value in times
            ]
            return QueryResult(
                bars=bars,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=len(bars),
            )

        def request_backfill(self, *args, **kwargs):
            self.repair_calls.append((args, kwargs))
            return "verification-range-wait"

    class _Coordinator:
        def __init__(self, dm: _RangeDataManager) -> None:
            self.dm = dm
            self.waited: list[str] = []

        async def wait_for_request(self, request_id: str):
            self.waited.append(request_id)
            self.dm.repaired = True
            return object()

    dm = _RangeDataManager()
    coordinator = _Coordinator(dm)
    response = _client_with_runtime(dm, coordinator).get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "repair": "wait",
            "wait_ms": 1000,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert dm.query_calls == [True, False]
    assert len(dm.repair_calls) == 1
    assert coordinator.waited == ["verification-range-wait"]
    assert payload["backfill_triggered"] is True
    assert payload["verified_contiguous"] is True
    assert payload["complete"] is True
    assert payload["missing_ranges"] == []


def test_range_verification_submits_only_part_not_covered_by_query_result() -> None:
    class _RangeDataManager:
        def __init__(self) -> None:
            self.repair_calls: list[tuple[tuple, dict]] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            exchange: str,
            market_type: str,
            **kwargs,
        ) -> QueryResult:
            return QueryResult(
                bars=[
                    BarData(time=60, open=1, high=2, low=1, close=2, volume=10),
                    BarData(time=240, open=3, high=4, low=3, close=4, volume=30),
                ],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=2,
                backfill_triggered=True,
                missing_ranges=[
                    MissingRange(
                        symbol=symbol,
                        interval=interval,
                        exchange=exchange,
                        market_type=market_type,
                        start_ms=120_000,
                        end_ms=120_000,
                        reason="query_interior_gap",
                        missing_bars=1,
                    )
                ],
            )

        def request_backfill(self, *args, **kwargs):
            self.repair_calls.append((args, kwargs))
            return "verification-uncovered-1"

    dm = _RangeDataManager()
    response = _client(dm).get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 240_000,
            "repair": "async",
        },
    )

    assert response.status_code == 200
    assert len(dm.repair_calls) == 1
    args, kwargs = dm.repair_calls[0]
    assert args[2:4] == (180_000, 180_000)
    assert kwargs["metadata"]["missing_bars"] == 1


def test_range_wait_requeries_without_resubmitting_visible_gap() -> None:
    class _RangeDataManager:
        def __init__(self) -> None:
            self.calls: list[bool | None] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
            **kwargs,
        ) -> QueryResult:
            self.calls.append(auto_backfill)
            return QueryResult(
                bars=[
                    BarData(time=60, open=1, high=2, low=1, close=2, volume=10),
                    BarData(time=180, open=3, high=4, low=3, close=4, volume=30),
                ],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=2,
                backfill_triggered=len(self.calls) == 1,
            )

    dm = _RangeDataManager()
    client = _client(dm)
    response = client.get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "exchange": "binance",
            "market_type": "spot",
            "repair": "wait",
            "wait_ms": 1,
            "strict": "true",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert dm.calls[0] is True
    assert len(dm.calls) >= 2
    assert all(auto_backfill is False for auto_backfill in dm.calls[1:])
    assert payload["backfill_triggered"] is True
    assert payload["history_state"] == "pending"
    assert payload["complete"] is False
    assert payload["retryable"] is True
    assert payload["verified_contiguous"] is False


def test_range_query_caps_huge_range_from_newest_end() -> None:
    class _CappedRangeDataManager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            self.calls.append({
                "start_ms": start_ms,
                "end_ms": end_ms,
                "limit": limit,
                "auto_backfill": auto_backfill,
            })
            bars = [
                BarData(
                    time=(start_ms // 1000) + (index * 60),
                    open=1,
                    high=2,
                    low=1,
                    close=2,
                    volume=10,
                )
                for index in range(5_000)
            ]
            return QueryResult(
                bars=bars,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=len(bars),
            )

    dm = _CappedRangeDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 360_060_000,
            "exchange": "binance",
            "market_type": "spot",
            "repair": "none",
            "strict": "true",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    expected_query_start = 360_060_000 - (4_999 * 60_000)
    assert dm.calls == [{
        "start_ms": expected_query_start,
        "end_ms": 360_060_000,
        "limit": 5_000,
        "auto_backfill": False,
    }]
    assert payload["truncated"] is True
    assert payload["query_start_ms"] == expected_query_start
    assert payload["query_end_ms"] == 360_060_000
    assert payload["next_end_ms"] == expected_query_start - 60_000
    assert payload["expected_bars"] == 5_000
    assert payload["actual_bars"] == 5_000
    assert payload["verified_contiguous"] is True


def test_related_interval_warmup_caps_each_interval_to_target_bars() -> None:
    class _WarmupDataManager:
        def __init__(self) -> None:
            self.calls: list[tuple[tuple, dict]] = []

        def request_backfill(self, *args, **kwargs) -> None:
            self.calls.append((args, kwargs))

    dm = _WarmupDataManager()

    _schedule_related_interval_warmup(
        dm,
        symbol="BTCUSDT",
        current_interval="1d",
        start_ms=0,
        end_ms=10_000_000_000,
        exchange="binance",
        market_type="spot",
    )

    by_interval = {args[1]: (args, kwargs) for args, kwargs in dm.calls}
    assert list(by_interval) == ["4h", "1h", "15m"]
    args, kwargs = by_interval["15m"]
    assert args[2] == 10_000_000_000 - (1_000 * 15 * 60 * 1_000)
    assert args[3] == 10_000_000_000
    assert kwargs["metadata"]["visible_range"] == {"start_ms": 0, "end_ms": 10_000_000_000}
    assert kwargs["metadata"]["warmup_range"] == {
        "start_ms": args[2],
        "end_ms": 10_000_000_000,
        "target_bars": 1_000,
    }


def test_related_interval_warmup_uses_each_target_last_closed_open(
    monkeypatch,
) -> None:
    class _WarmupDataManager:
        def __init__(self) -> None:
            self.calls: list[tuple[tuple, dict]] = []

        def request_backfill(self, *args, **kwargs) -> None:
            self.calls.append((args, kwargs))

    last_closed = {
        "1m": 9_600_000,
        "5m": 9_000_000,
        "1h": 7_200_000,
    }
    monkeypatch.setattr(
        klines_api,
        "_last_closed_open_ms",
        lambda interval, *args, **kwargs: last_closed[interval],
    )
    dm = _WarmupDataManager()

    _schedule_related_interval_warmup(
        dm,
        symbol="BTCUSDT",
        current_interval="15m",
        start_ms=9_750_000,
        end_ms=9_900_000,
        exchange="binance",
        market_type="futures",
    )

    by_interval = {args[1]: (args, kwargs) for args, kwargs in dm.calls}
    assert list(by_interval) == ["5m", "1h", "1m"]
    for interval, expected_end_ms in last_closed.items():
        args, kwargs = by_interval[interval]
        assert args[2] == expected_end_ms
        assert args[3] == expected_end_ms
        assert kwargs["metadata"]["visible_range"] == {
            "start_ms": 9_750_000,
            "end_ms": 9_900_000,
        }
        assert kwargs["metadata"]["warmup_range"]["end_ms"] == expected_end_ms


def test_continuity_endpoint_returns_storage_gap_report() -> None:
    class _ContinuityDataManager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def scan_storage_gaps(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int | None,
            end_ms: int | None,
            exchange: str,
            market_type: str,
            limit: int,
        ) -> dict:
            self.calls.append({
                "symbol": symbol,
                "interval": interval,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "exchange": exchange,
                "market_type": market_type,
                "limit": limit,
            })
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol,
                "interval": interval,
                "gaps": [{
                    "start_ms": 120_000,
                    "end_ms": 120_000,
                    "missing_bars": 1,
                    "reason": "interior_gap",
                    "status": "detected",
                }],
                "gap_count": 1,
                "missing_bars": 1,
                "scanned_bars": 2,
                "truncated": False,
            }

    dm = _ContinuityDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/continuity",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["verified_contiguous"] is False
    assert payload["gap_count"] == 1
    assert dm.calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "start_ms": 60_000,
        "end_ms": 180_000,
        "exchange": "binance",
        "market_type": "spot",
        "limit": 50_000,
    }]
