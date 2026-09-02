from __future__ import annotations

import asyncio
import copy
import time
from contextlib import suppress
from types import SimpleNamespace

import pytest

from app.api.v1 import symbols as symbols_api
from app.exchanges import (
    HistoricalRequest,
    RateLimitDeferred,
    RateLimitManager,
    bootstrap_default_adapters,
    get_exchange_registry,
    get_shared_rate_limit_manager,
)
from app.exchanges import catalog_http
from app.exchanges.models import SymbolInfo


class _Registry:
    def __init__(self, adapter) -> None:
        self.adapter = adapter

    def list(self):
        return [self.adapter]

    def get(self, exchange: str):
        assert exchange == self.adapter.id
        return self.adapter


class _Adapter:
    id = "test"

    def __init__(self) -> None:
        self.calls = 0
        self.release: asyncio.Event | None = None
        self.started: asyncio.Event | None = None
        self.empty = False
        self.symbol_names = ["AAAUSDT"]

    def capabilities(self):
        return SimpleNamespace(markets=[SimpleNamespace(market_type="spot")])

    async def list_symbols(self, market_type: str) -> list[SymbolInfo]:
        assert market_type == "spot"
        self.calls += 1
        if self.started is not None:
            self.started.set()
        if self.release is not None:
            await self.release.wait()
        if self.empty:
            return []
        return [
            SymbolInfo(
                symbol,
                symbol.removesuffix("USDT"),
                "USDT",
                "TRADING",
                self.id,
                market_type,
                "spot",
            )
            for symbol in self.symbol_names
        ]


class _PartialAdapter:
    id = "test"

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.release: asyncio.Event | None = None
        self.started: dict[str, asyncio.Event] = {}

    def capabilities(self):
        return SimpleNamespace(markets=[
            SimpleNamespace(market_type="spot"),
            SimpleNamespace(market_type="futures"),
        ])

    async def list_symbols(self, market_type: str) -> list[SymbolInfo]:
        self.calls.append(market_type)
        self.started[market_type].set()
        if self.release is not None:
            await self.release.wait()
        symbol = "AAAUSDT" if market_type == "spot" else "BBBUSDT"
        return [
            SymbolInfo(
                symbol,
                symbol.removesuffix("USDT"),
                "USDT",
                "TRADING",
                self.id,
                market_type,
                "spot" if market_type == "spot" else "perpetual",
            )
        ]


@pytest.fixture(autouse=True)
def _reset_symbol_catalog_state(monkeypatch, tmp_path):
    monkeypatch.setattr(
        symbols_api,
        "SYMBOL_CATALOG_SNAPSHOT_PATH",
        tmp_path / "symbol_catalog.v1.json",
    )
    monkeypatch.setattr(symbols_api, "SYMBOL_CATALOG_RETRY_JITTER_SECONDS", 0.0)
    symbols_api._symbol_cache.clear()
    symbols_api._market_refresh_state.clear()
    symbols_api._market_refresh_tasks.clear()
    symbols_api._market_refresh_timers.clear()
    symbols_api._market_auto_refresh_tasks.clear()
    symbols_api._cache_loaded_at = 0.0
    symbols_api._catalog_stopping = False
    symbols_api.configure_exchange_metadata_foreground_probe(None)
    symbols_api._snapshot_revision = 0
    symbols_api._last_persisted_revision = 0
    yield
    for handle in symbols_api._market_refresh_timers.values():
        handle.cancel()
    for task in (
        *symbols_api._market_refresh_tasks.values(),
        *symbols_api._market_auto_refresh_tasks.values(),
    ):
        if not task.done():
            task.cancel()
    symbols_api._symbol_cache.clear()
    symbols_api._market_refresh_state.clear()
    symbols_api._market_refresh_tasks.clear()
    symbols_api._market_refresh_timers.clear()
    symbols_api._market_auto_refresh_tasks.clear()
    symbols_api._cache_loaded_at = 0.0
    symbols_api._catalog_stopping = False
    symbols_api.configure_exchange_metadata_foreground_probe(None)
    symbols_api._snapshot_revision = 0
    symbols_api._last_persisted_revision = 0


def _install_registry(monkeypatch, adapter: _Adapter) -> None:
    registry = _Registry(adapter)
    monkeypatch.setattr(symbols_api, "bootstrap_default_adapters", lambda: None)
    monkeypatch.setattr(symbols_api, "get_exchange_registry", lambda: registry)


def test_concurrent_forced_refreshes_join_one_physical_request(monkeypatch) -> None:
    adapter = _Adapter()
    _install_registry(monkeypatch, adapter)

    async def run() -> tuple[dict[str, int], dict[str, int]]:
        adapter.started = asyncio.Event()
        adapter.release = asyncio.Event()
        first = asyncio.create_task(
            symbols_api.refresh_exchange_metadata(force=True)
        )
        await adapter.started.wait()
        second = asyncio.create_task(
            symbols_api.refresh_exchange_metadata(force=True)
        )
        await asyncio.sleep(0)
        assert adapter.calls == 1
        adapter.release.set()
        return await asyncio.gather(first, second)

    first, second = asyncio.run(run())
    assert first == second == {"test:spot": 1}
    assert adapter.calls == 1


def test_refresh_honors_ttl_but_force_bypasses_it(monkeypatch) -> None:
    adapter = _Adapter()
    _install_registry(monkeypatch, adapter)

    async def run() -> None:
        await symbols_api.refresh_exchange_metadata()
        await symbols_api.refresh_exchange_metadata()
        assert adapter.calls == 1
        await symbols_api.refresh_exchange_metadata(force=True)

    asyncio.run(run())
    assert adapter.calls == 2


def test_successful_refresh_restores_validated_snapshot_after_process_reset(
    monkeypatch,
) -> None:
    adapter = _Adapter()
    _install_registry(monkeypatch, adapter)

    asyncio.run(symbols_api.refresh_exchange_metadata(force=True))
    snapshot_path = symbols_api.SYMBOL_CATALOG_SNAPSHOT_PATH
    assert snapshot_path.exists()

    symbols_api._symbol_cache.clear()
    symbols_api._market_refresh_state.clear()
    symbols_api._cache_loaded_at = 0.0
    assert symbols_api.load_exchange_metadata_snapshot() is True

    restored = symbols_api.get_cached_symbol_metadata("test", "spot", "AAAUSDT")
    assert restored is not None
    assert restored["active"] is True
    status = symbols_api._catalog_status_payload("test", "spot")
    assert status["stale"] is True
    assert status["last_success_at"] > 0


def test_corrupt_snapshot_is_rejected_without_overwriting_memory(monkeypatch) -> None:
    adapter = _Adapter()
    _install_registry(monkeypatch, adapter)
    asyncio.run(symbols_api.refresh_exchange_metadata(force=True))
    before = copy.deepcopy(symbols_api._symbol_cache)
    symbols_api.SYMBOL_CATALOG_SNAPSHOT_PATH.write_text(
        '{"version":1,"markets":[{"symbols":[]}]}',
        encoding="utf-8",
    )

    assert symbols_api.load_exchange_metadata_snapshot() is False
    assert symbols_api._symbol_cache == before


def test_empty_get_bounded_joins_initial_singleflight(monkeypatch) -> None:
    adapter = _Adapter()
    _install_registry(monkeypatch, adapter)
    monkeypatch.setattr(symbols_api, "SYMBOL_CATALOG_EMPTY_WAIT_SECONDS", 0.2)

    async def run() -> dict:
        adapter.started = asyncio.Event()
        adapter.release = asyncio.Event()
        response = asyncio.create_task(symbols_api.get_exchange_info(
            search="",
            quote_asset="",
            exchange="test",
            market_type="spot",
        ))
        await adapter.started.wait()
        adapter.release.set()
        return await response

    payload = asyncio.run(run())
    assert payload["count"] == 1
    assert adapter.calls == 1


def test_partial_get_returns_lkg_and_completes_missing_stale_markets_in_background(
    monkeypatch,
) -> None:
    adapter = _PartialAdapter()
    _install_registry(monkeypatch, adapter)  # type: ignore[arg-type]

    async def run() -> tuple[dict, dict]:
        adapter.release = asyncio.Event()
        adapter.started = {
            "spot": asyncio.Event(),
            "futures": asyncio.Event(),
        }
        observed_at = time.time() - 10
        spot_key = ("test", "spot")
        symbols_api._symbol_cache[spot_key] = [
            SymbolInfo(
                "AAAUSDT",
                "AAA",
                "USDT",
                "TRADING",
                "test",
                "spot",
                "spot",
            ).to_dict()
        ]
        symbols_api._market_refresh_state[spot_key] = symbols_api._MarketRefreshState(
            last_success_at=observed_at,
            stale=True,
        )
        symbols_api._cache_loaded_at = observed_at

        # Neither physical refresh is released yet: the first response must
        # still return the usable partial LKG rather than joining upstream I/O.
        partial = await asyncio.wait_for(
            symbols_api.get_exchange_info(
                search="",
                quote_asset="",
                exchange="test",
                market_type="",
            ),
            timeout=0.05,
        )
        assert partial["count"] == 1
        assert partial["symbols"][0]["symbol"] == "AAAUSDT"
        assert partial["stale"] is True

        await asyncio.wait_for(adapter.started["spot"].wait(), timeout=0.2)
        await asyncio.wait_for(adapter.started["futures"].wait(), timeout=0.2)
        assert set(symbols_api._market_auto_refresh_tasks) == {
            ("test", "spot"),
            ("test", "futures"),
        }

        adapter.release.set()
        deadline = asyncio.get_running_loop().time() + 0.5
        while (
            (
                symbols_api._active_symbol_count(("test", "futures")) == 0
                or symbols_api._market_auto_refresh_tasks
                or symbols_api._market_refresh_tasks
            )
            and asyncio.get_running_loop().time() < deadline
        ):
            await asyncio.sleep(0.01)

        complete = await symbols_api.get_exchange_info(
            search="",
            quote_asset="",
            exchange="test",
            market_type="",
        )
        await symbols_api.cancel_exchange_metadata_refreshes()
        return partial, complete

    partial, complete = asyncio.run(run())
    assert partial["count"] == 1
    assert complete["count"] == 2
    assert complete["stale"] is False
    assert adapter.calls.count("spot") == 1
    assert adapter.calls.count("futures") == 1


def test_empty_get_returns_retryable_503_instead_of_false_empty(monkeypatch) -> None:
    adapter = _Adapter()
    adapter.empty = True
    _install_registry(monkeypatch, adapter)
    monkeypatch.setattr(symbols_api, "SYMBOL_CATALOG_EMPTY_WAIT_SECONDS", 0.05)

    with pytest.raises(symbols_api.HTTPException) as caught:
        asyncio.run(symbols_api.get_exchange_info(
            search="",
            quote_asset="",
            exchange="test",
            market_type="spot",
        ))
    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "symbol_catalog_unavailable"
    assert caught.value.detail["retryable"] is True


def test_failed_refresh_retries_automatically_and_shutdown_clears_timers(
    monkeypatch,
) -> None:
    adapter = _Adapter()
    adapter.empty = True
    _install_registry(monkeypatch, adapter)
    monkeypatch.setattr(symbols_api, "SYMBOL_CATALOG_FAILURE_RETRY_SECONDS", 0.01)

    async def run() -> None:
        await symbols_api.refresh_exchange_metadata(force=True)
        assert symbols_api._market_refresh_timers
        adapter.empty = False
        deadline = asyncio.get_running_loop().time() + 0.5
        while (
            (
                adapter.calls < 2
                or not symbols_api._market_refresh_timers
                or symbols_api._market_auto_refresh_tasks
            )
            and asyncio.get_running_loop().time() < deadline
        ):
            await asyncio.sleep(0.01)
        assert adapter.calls >= 2
        assert symbols_api._active_symbol_count(("test", "spot")) == 1
        assert symbols_api._market_refresh_timers
        await symbols_api.cancel_exchange_metadata_refreshes()
        assert symbols_api._market_refresh_timers == {}
        assert symbols_api._market_auto_refresh_tasks == {}
        assert symbols_api._market_refresh_tasks == {}

    asyncio.run(run())


def test_automatic_catalog_retry_yields_to_foreground(monkeypatch) -> None:
    adapter = _Adapter()
    adapter.empty = True
    _install_registry(monkeypatch, adapter)
    monkeypatch.setattr(symbols_api, "SYMBOL_CATALOG_FAILURE_RETRY_SECONDS", 0.01)
    monkeypatch.setattr(symbols_api, "SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS", 0.01)

    class _Coordinator:
        busy = True

        def has_foreground_work(self) -> bool:
            return self.busy

        def foreground_idle_seconds(self) -> float:
            return 0.0 if self.busy else 2.0

    async def run() -> None:
        coordinator = _Coordinator()
        symbols_api.configure_exchange_metadata_foreground_probe(coordinator)
        await symbols_api.refresh_exchange_metadata(force=True)
        adapter.empty = False
        await asyncio.sleep(0.12)
        assert adapter.calls == 1

        coordinator.busy = False
        deadline = asyncio.get_running_loop().time() + 0.5
        while adapter.calls < 2 and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        assert adapter.calls >= 2
        await symbols_api.cancel_exchange_metadata_refreshes()

    asyncio.run(run())


def test_failed_empty_refresh_keeps_last_known_good_and_exposes_stale(monkeypatch) -> None:
    adapter = _Adapter()
    _install_registry(monkeypatch, adapter)

    async def run() -> tuple[dict, dict[str, int]]:
        await symbols_api.refresh_exchange_metadata(force=True)
        before = copy.deepcopy(symbols_api._symbol_cache)
        adapter.empty = True
        counts = await symbols_api.refresh_exchange_metadata(force=True)
        payload = await symbols_api.get_exchange_info(
            search="",
            quote_asset="",
            exchange="test",
            market_type="spot",
        )
        assert symbols_api._symbol_cache == before
        return payload, counts

    payload, counts = asyncio.run(run())
    assert counts == {"test:spot": 1}
    assert payload["count"] == 1
    assert payload["symbols"][0]["symbol"] == "AAAUSDT"
    assert payload["stale"] is True
    assert payload["last_success_at"] > 0
    assert payload["retry_at_ms"] is not None
    assert payload["markets"]["test:spot"]["last_error"].startswith("RuntimeError:")


def test_suspicious_catalog_shrink_cannot_replace_memory_or_disk_lkg(
    monkeypatch,
) -> None:
    adapter = _Adapter()
    adapter.symbol_names = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"]
    _install_registry(monkeypatch, adapter)

    asyncio.run(symbols_api.refresh_exchange_metadata(force=True))
    before_cache = copy.deepcopy(symbols_api._symbol_cache)
    before_disk = symbols_api.SYMBOL_CATALOG_SNAPSHOT_PATH.read_bytes()
    adapter.symbol_names = ["AAAUSDT"]
    counts = asyncio.run(symbols_api.refresh_exchange_metadata(force=True))

    assert counts == {"test:spot": 4}
    assert symbols_api._symbol_cache == before_cache
    assert symbols_api.SYMBOL_CATALOG_SNAPSHOT_PATH.read_bytes() == before_disk
    state = symbols_api._market_refresh_state[("test", "spot")]
    assert state.stale is True
    assert "suspicious symbol catalog shrink" in str(state.last_error)


class _RateLimitedResponse:
    status = 429
    headers = {"Retry-After": "0.05"}

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def text(self) -> str:
        return '{"code": -1003, "msg": "too many requests"}'

    async def json(self):
        return {"code": -1003, "msg": "too many requests"}


class _RateLimitedSession:
    calls: list[str] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def get(self, url: str, **kwargs):
        self.calls.append(url)
        return _RateLimitedResponse()


class _RateLimitedBodyFailureResponse(_RateLimitedResponse):
    async def text(self) -> str:
        raise catalog_http.aiohttp.ClientPayloadError("body reset")


class _RateLimitedBodyFailureSession(_RateLimitedSession):
    calls: list[str] = []

    def get(self, url: str, **kwargs):
        self.calls.append(url)
        return _RateLimitedBodyFailureResponse()


class _ConnectionFailure:
    async def __aenter__(self):
        raise catalog_http.aiohttp.ClientConnectionError("unreachable")

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _SuccessfulResponse:
    status = 200
    headers = {"X-MBX-USED-WEIGHT-1M": "2"}

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def json(self):
        return {"symbols": []}


class _FailoverSession:
    calls: list[str] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def get(self, url: str, **kwargs):
        self.calls.append(url)
        if len(self.calls) == 1:
            return _ConnectionFailure()
        return _SuccessfulResponse()


def test_catalog_429_uses_one_host_and_opens_shared_bucket_cooldown(monkeypatch) -> None:
    _RateLimitedSession.calls.clear()
    monkeypatch.setattr(catalog_http.aiohttp, "ClientSession", _RateLimitedSession)

    async def run():
        bootstrap_default_adapters()
        registry = get_exchange_registry()
        plugin = registry.get_plugin("binance")
        request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/exchangeInfo",
            symbol="*",
        )
        policy = plugin.rate_limit_policy()
        rule = policy.rule_for(request)
        kline_request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/klines",
            symbol="BTCUSDT",
        )
        kline_rule = policy.rule_for(kline_request)
        manager = get_shared_rate_limit_manager()

        with pytest.raises(RateLimitDeferred) as first:
            await catalog_http.fetch_catalog_json(
                exchange="binance",
                market_type="spot",
                base_urls=("https://first.invalid", "https://second.invalid"),
                path=request.endpoint,
                timeout_seconds=1,
                proxy=None,
            )
        admission = await manager.inspect(kline_rule, kline_request)
        with pytest.raises(RateLimitDeferred):
            await catalog_http.fetch_catalog_json(
                exchange="binance",
                market_type="spot",
                base_urls=("https://first.invalid", "https://second.invalid"),
                path=request.endpoint,
                timeout_seconds=1,
                proxy=None,
            )
        return first.value, admission, rule, kline_rule

    deferred, admission, rule, kline_rule = asyncio.run(run())
    assert _RateLimitedSession.calls == [
        "https://first.invalid/api/v3/exchangeInfo"
    ]
    assert deferred.bucket_key == "binance:spot:request_weight:ip"
    assert kline_rule.bucket_key == deferred.bucket_key
    assert admission.allowed is False
    assert admission.reason == "cooldown"
    assert admission.retry_at_ms is not None
    assert rule.request_cost(
        HistoricalRequest("binance", "spot", rule.endpoint or "", "*")
    ) == 20


def test_catalog_429_body_read_failure_still_opens_cooldown_without_failover(
    monkeypatch,
) -> None:
    _RateLimitedBodyFailureSession.calls.clear()
    monkeypatch.setattr(
        catalog_http.aiohttp,
        "ClientSession",
        _RateLimitedBodyFailureSession,
    )

    async def run():
        bootstrap_default_adapters()
        registry = get_exchange_registry()
        request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/exchangeInfo",
            symbol="*",
        )
        rule = registry.get_plugin("binance").rate_limit_policy().rule_for(request)
        manager = get_shared_rate_limit_manager()
        with pytest.raises(RateLimitDeferred):
            await catalog_http.fetch_catalog_json(
                exchange="binance",
                market_type="spot",
                base_urls=("https://first.invalid", "https://second.invalid"),
                path=request.endpoint,
                timeout_seconds=1,
                proxy=None,
            )
        return manager.snapshot()[rule.bucket_key]

    snapshot = asyncio.run(run())
    assert _RateLimitedBodyFailureSession.calls == [
        "https://first.invalid/api/v3/exchangeInfo"
    ]
    assert snapshot["last_status_code"] == 429
    assert snapshot["cooldown_remaining_seconds"] > 0


def test_catalog_network_error_can_fail_over_to_next_host(monkeypatch) -> None:
    _FailoverSession.calls.clear()
    monkeypatch.setattr(catalog_http.aiohttp, "ClientSession", _FailoverSession)
    monkeypatch.setattr(
        catalog_http,
        "get_shared_rate_limit_manager",
        lambda: RateLimitManager(),
    )

    async def run():
        return await catalog_http.fetch_catalog_json(
            exchange="binance",
            market_type="futures",
            base_urls=("https://first.invalid", "https://second.invalid"),
            path="/fapi/v1/exchangeInfo",
            timeout_seconds=1,
            proxy=None,
        )

    assert asyncio.run(run()) == {"symbols": []}
    assert _FailoverSession.calls == [
        "https://first.invalid/fapi/v1/exchangeInfo",
        "https://second.invalid/fapi/v1/exchangeInfo",
    ]


def test_startup_catalog_refresh_is_a_background_task(monkeypatch) -> None:
    from app import main as main_module

    async def run() -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_refresh():
            started.set()
            await release.wait()
            return {}

        monkeypatch.setattr(symbols_api, "refresh_exchange_metadata", slow_refresh)
        monkeypatch.setattr(main_module, "SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS", 0)
        task = main_module._schedule_symbol_catalog_refresh()
        await started.wait()
        assert task.done() is False
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    asyncio.run(run())


def test_startup_catalog_refresh_waits_for_foreground_quiet_dwell(monkeypatch) -> None:
    from app import main as main_module

    class _Coordinator:
        busy = True

        def has_foreground_work(self) -> bool:
            return self.busy

        def foreground_idle_seconds(self) -> float:
            return 0.0 if self.busy else 1.0

    async def run() -> None:
        coordinator = _Coordinator()
        refreshed = asyncio.Event()

        async def refresh():
            refreshed.set()
            return {}

        monkeypatch.setattr(symbols_api, "refresh_exchange_metadata", refresh)
        monkeypatch.setattr(main_module, "SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS", 0.01)
        monkeypatch.setattr(main_module, "SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS", 0.005)
        monkeypatch.setattr(
            main_module.app.state,
            "data_engine_runtime",
            SimpleNamespace(backfill_coordinator=coordinator),
            raising=False,
        )
        task = main_module._schedule_symbol_catalog_refresh()
        await asyncio.sleep(0.03)
        assert refreshed.is_set() is False
        coordinator.busy = False
        await asyncio.wait_for(refreshed.wait(), timeout=0.2)
        await task

    asyncio.run(run())


def test_catalog_shutdown_cancels_shielded_physical_refresh(monkeypatch) -> None:
    adapter = _Adapter()
    _install_registry(monkeypatch, adapter)

    async def run() -> None:
        adapter.started = asyncio.Event()
        adapter.release = asyncio.Event()
        outer = asyncio.create_task(
            symbols_api.refresh_exchange_metadata(force=True)
        )
        await adapter.started.wait()
        outer.cancel()
        with suppress(asyncio.CancelledError):
            await outer

        assert any(
            not task.done()
            for task in symbols_api._market_refresh_tasks.values()
        )
        await symbols_api.cancel_exchange_metadata_refreshes()
        assert symbols_api._market_refresh_tasks == {}

    asyncio.run(run())


def test_startup_initializes_data_manager_before_catalog_schedule(monkeypatch) -> None:
    from starlette.datastructures import State

    from app import main as main_module
    from app.plugin_core_v2 import DisabledCorePluginPlatform

    # Startup writes app.state directly. Keep its test owners out of later
    # tests and avoid starting the user's installed sidecars for an order check.
    monkeypatch.setattr(main_module.app, "state", State())
    monkeypatch.setattr(main_module, "BACKTEST_SETTINGS", SimpleNamespace(enabled=False))
    monkeypatch.setattr(main_module, "RESEARCH_DATA_LIBRARY_ENABLED", False)
    monkeypatch.setattr(symbols_api, "initialize_exchange_metadata_cache", lambda: {})
    monkeypatch.setattr(
        symbols_api, "configure_exchange_metadata_foreground_probe", lambda _probe: None
    )

    events: list[str] = []

    class _LagMonitor:
        def start(self) -> None:
            pass

    async def init_data_manager() -> None:
        events.append("data-manager")

    async def init_replay_runtime() -> None:
        main_module.app.state.replay_runtime = None
        main_module.app.state.replay_service = None

    async def init_plugin_plane() -> None:
        main_module.app.state.plugin_runtime_host = None
        main_module.app.state.indicator_runtime_service = None
        main_module.app.state.plugin_platform_v2 = DisabledCorePluginPlatform()

    async def init_alert_delivery() -> None:
        pass

    def schedule_catalog():
        events.append("catalog")
        return None

    monkeypatch.setattr(main_module, "EventLoopLagMonitor", lambda **kwargs: _LagMonitor())
    monkeypatch.setattr(
        main_module,
        "initialize_market_storage",
        lambda **_kwargs: SimpleNamespace(to_dict=lambda: {}),
    )
    monkeypatch.setattr(main_module, "_init_replay_runtime", init_replay_runtime)
    monkeypatch.setattr(main_module, "_start_plugin_plane", init_plugin_plane)
    monkeypatch.setattr(main_module, "_init_alert_delivery", init_alert_delivery)
    monkeypatch.setattr(main_module, "_init_data_manager", init_data_manager)
    monkeypatch.setattr(main_module, "_schedule_symbol_catalog_refresh", schedule_catalog)

    asyncio.run(main_module.startup_event())
    assert events == ["data-manager", "catalog"]
