from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.backtests import router as backtests_router
from app.backtest.errors import BacktestError
from app.backtest.runtime import BacktestRuntime
from app.core.config import load_backtest_settings
from app.data_engine.data_manager.models import BarData


BASE_MS = (1_700_000_000_000 // 900_000) * 900_000


def _bar(index: int, *, interval_ms: int = 60_000, close: float | None = None) -> BarData:
    price = 100.0 + index
    return BarData(
        time=(BASE_MS + index * interval_ms) // 1000,
        open=price,
        high=price + 2,
        low=price - 2,
        close=price + 1 if close is None else close,
        volume=10 + index,
        is_closed=True,
        source="backfill_rest_verified",
    )


class _HostData:
    def __init__(self, bars: list[BarData] | None = None) -> None:
        self.bars = list(bars or [])
        self.query_calls = 0
        self.bounds_calls = 0

    def query(self, *_args: Any, **_kwargs: Any) -> SimpleNamespace:
        self.query_calls += 1
        return SimpleNamespace(bars=list(self.bars), missing_ranges=[])

    def get_bounds(self, *_args: Any, **_kwargs: Any) -> dict[str, int]:
        self.bounds_calls += 1
        if not self.bars:
            return {}
        return {
            "earliest": self.bars[0].time * 1000,
            "latest": self.bars[-1].time * 1000,
        }


class _NoHostReads(_HostData):
    def query(self, *_args: Any, **_kwargs: Any) -> SimpleNamespace:
        raise AssertionError("READY resolve must not query mutable Host data")

    def get_bounds(self, *_args: Any, **_kwargs: Any) -> dict[str, int]:
        raise AssertionError("READY resolve must not inspect mutable Host bounds")


def _runtime(tmp_path: Path) -> BacktestRuntime:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_CHART_CONTEXT_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    return BacktestRuntime.start(settings, local_data_dir=tmp_path / "local")


def _request(
    *,
    symbol: str = "BTCUSDT",
    interval: str = "1m",
    start_ms: int = BASE_MS,
    end_ms: int = BASE_MS + 3 * 60_000 - 1,
    fidelity: str = "FAST",
    market_type: str = "futures",
) -> dict[str, object]:
    return {
        "exchange": "binance",
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        "range_mode": "CUSTOM",
        "start_time_ms": start_ms,
        "end_time_ms": end_ms,
        "fidelity_preference": fidelity,
    }


def _freeze(
    runtime: BacktestRuntime,
    bars: list[BarData],
    *,
    interval: str = "1m",
    dataset_id: str = "local-11111111111111111111111111111111",
    context_hash: str = "sha256:fixture",
) -> dict[str, Any]:
    return runtime.local_data.freeze_host_bars(
        bars,
        dataset_id=dataset_id,
        name="fixture",
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        interval=interval,
        chart_context_hash=context_hash,
    )


def test_resolve_statuses_are_typed_and_fail_closed(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        resolver = runtime.chart_context
        assert resolver.resolve(_request(interval="not-an-interval"))["status"] == (
            "UNSUPPORTED_INTERVAL"
        )
        assert resolver.resolve(_request(market_type="auto"))["status"] == (
            "AMBIGUOUS_MARKET"
        )
        assert resolver.resolve(_request(fidelity="PRECISE"))["status"] == (
            "UNSUPPORTED_FIDELITY"
        )
        assert resolver.resolve(_request())["status"] == "UNAVAILABLE"
        needs = resolver.resolve(_request(), host_data_manager=_HostData())
        assert needs["status"] == "NEEDS_DATA"
        assert needs["materialize"]["required"] is True
        assert needs["resolution_token"]
        assert needs["chart_context_hash"].startswith("sha256:")
    finally:
        runtime.shutdown()


def test_precise_without_matching_archive_is_not_offered_for_materialization(
    tmp_path: Path,
) -> None:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_CHART_CONTEXT_ENABLED": "1",
            "BACKTEST_TRADE_TAPE_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(
        settings,
        local_data_dir=tmp_path / "local",
        trade_archive_dir=tmp_path / "trades",
    )
    host = _HostData([_bar(0), _bar(1), _bar(2)])
    try:
        resolution = runtime.chart_context.resolve(
            _request(fidelity="PRECISE"), host_data_manager=host
        )
        assert resolution["status"] == "UNSUPPORTED_FIDELITY"
        assert host.query_calls == 0
    finally:
        runtime.shutdown()


def test_resolve_reuses_only_matching_immutable_host_snapshot(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        manifest = _freeze(runtime, [_bar(0), _bar(1), _bar(2)])
        ready = runtime.chart_context.resolve(
            _request(), host_data_manager=_NoHostReads()
        )
        assert ready["status"] == "READY"
        assert ready["dataset_id"] == manifest["dataset_id"]
        assert ready["data_epoch"] == manifest["data_epoch"]
        assert ready["coverage"]["complete"] is True
        preview = runtime.preview_snapshot(
            dataset_id=ready["dataset_id"],
            data_epoch=ready["data_epoch"],
            start_time_ms=BASE_MS,
            end_time_ms=BASE_MS + 3 * 60_000 - 1,
            interval="1m",
            exchange="binance",
            market_type="futures",
        )
        assert preview["snapshot_hash"] == ready["snapshot_hash"]
    finally:
        runtime.shutdown()


def test_materialize_requires_confirmation_and_deduplicates_concurrency(
    tmp_path: Path,
) -> None:
    runtime = _runtime(tmp_path)
    try:
        host = _HostData([_bar(0), _bar(1), _bar(2)])
        resolution = runtime.chart_context.resolve(
            _request(), host_data_manager=host
        )
        with pytest.raises(BacktestError, match="USER_CONFIRMATION_REQUIRED"):
            asyncio.run(
                runtime.chart_context.materialize(
                    resolution_token=resolution["resolution_token"],
                    user_confirmed=False,
                    idempotency_key="materialize-no-confirm",
                    host_data_manager=host,
                    backfill_coordinator=None,
                )
            )

        async def run_both() -> tuple[dict[str, Any], dict[str, Any]]:
            first, second = await asyncio.gather(
                runtime.chart_context.materialize(
                    resolution_token=resolution["resolution_token"],
                    user_confirmed=True,
                    idempotency_key="materialize-concurrent-a",
                    host_data_manager=host,
                    backfill_coordinator=None,
                ),
                runtime.chart_context.materialize(
                    resolution_token=resolution["resolution_token"],
                    user_confirmed=True,
                    idempotency_key="materialize-concurrent-b",
                    host_data_manager=host,
                    backfill_coordinator=None,
                ),
            )
            return first, second

        first, second = asyncio.run(run_both())
        assert first["status"] == second["status"] == "READY"
        assert first["snapshot_hash"] == second["snapshot_hash"]
        assert first["dataset_id"] == second["dataset_id"]
        assert len(runtime.local_data.list_revisions(first["dataset_id"])) == 1
        refreshed = runtime.chart_context.resolve(_request())
        assert refreshed["status"] == "READY"
        assert refreshed["snapshot_hash"] == first["snapshot_hash"]
    finally:
        runtime.shutdown()


def test_materialize_uses_existing_host_backfill_then_freezes(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        host = _HostData()
        resolution = runtime.chart_context.resolve(
            _request(), host_data_manager=host
        )

        class Backfill:
            calls = 0

            async def request_and_wait(self, request: Any) -> SimpleNamespace:
                self.calls += 1
                assert request.reason == "backtest_chart_context"
                assert request.metadata["requires_trusted_finality"] is True
                host.bars = [_bar(0), _bar(1), _bar(2)]
                return SimpleNamespace(status="completed")

        backfill = Backfill()
        ready = asyncio.run(
            runtime.chart_context.materialize(
                resolution_token=resolution["resolution_token"],
                user_confirmed=True,
                idempotency_key="existing-host-backfill",
                host_data_manager=host,
                backfill_coordinator=backfill,
            )
        )
        assert backfill.calls == 1
        assert ready["status"] == "READY"
        manifest = runtime.local_data.get_manifest(ready["dataset_id"])
        assert manifest["source"] == "host_chart_snapshot"
        assert manifest["exchange"] == "binance"
        assert manifest["market_type"] == "futures"
    finally:
        runtime.shutdown()


def test_same_idempotency_key_cannot_materialize_two_contexts(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        host = _HostData()
        first_resolution = runtime.chart_context.resolve(
            _request(symbol="BTCUSDT"), host_data_manager=host
        )
        second_resolution = runtime.chart_context.resolve(
            _request(symbol="ETHUSDT"), host_data_manager=host
        )

        class YieldingBackfill:
            calls = 0

            async def request_and_wait(self, _request: Any) -> SimpleNamespace:
                self.calls += 1
                await asyncio.sleep(0)
                host.bars = [_bar(0), _bar(1), _bar(2)]
                return SimpleNamespace(status="completed")

        backfill = YieldingBackfill()

        async def run_both() -> list[object]:
            return await asyncio.gather(
                runtime.chart_context.materialize(
                    resolution_token=first_resolution["resolution_token"],
                    user_confirmed=True,
                    idempotency_key="shared-idempotency-key",
                    host_data_manager=host,
                    backfill_coordinator=backfill,
                ),
                runtime.chart_context.materialize(
                    resolution_token=second_resolution["resolution_token"],
                    user_confirmed=True,
                    idempotency_key="shared-idempotency-key",
                    host_data_manager=host,
                    backfill_coordinator=backfill,
                ),
                return_exceptions=True,
            )

        outcomes = asyncio.run(run_both())
        successes = [item for item in outcomes if isinstance(item, dict)]
        failures = [item for item in outcomes if isinstance(item, BacktestError)]
        assert len(successes) == 1
        assert len(failures) == 1
        assert failures[0].code == "IDEMPOTENCY_CONFLICT"
        assert backfill.calls == 1
    finally:
        runtime.shutdown()


def test_resolve_exact_integer_multiple_from_same_revision(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        _freeze(runtime, [_bar(0), _bar(1), _bar(2)])
        response = runtime.chart_context.resolve(
            _request(interval="3m", end_ms=BASE_MS + 3 * 60_000 - 1)
        )
        assert response["status"] == "READY"
        assert response["coverage"]["row_count"] == 1
        assert response["snapshot_hash"].startswith("sha256:")
    finally:
        runtime.shutdown()


def test_materialize_rejects_candidate_revision_drift(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        original = _freeze(runtime, [_bar(0), _bar(1)])
        host = _HostData([_bar(0), _bar(1), _bar(2)])
        resolution = runtime.chart_context.resolve(
            _request(), host_data_manager=host
        )
        assert resolution["status"] == "NEEDS_DATA"
        assert resolution["data_epoch"] == original["data_epoch"]
        changed = _freeze(
            runtime,
            [_bar(0), _bar(1, close=101.5)],
            context_hash="sha256:changed",
        )
        assert changed["data_epoch"] != original["data_epoch"]
        with pytest.raises(BacktestError, match="DATA_SNAPSHOT_MISMATCH"):
            asyncio.run(
                runtime.chart_context.materialize(
                    resolution_token=resolution["resolution_token"],
                    user_confirmed=True,
                    idempotency_key="revision-drift-check",
                    host_data_manager=host,
                    backfill_coordinator=None,
                )
            )
    finally:
        runtime.shutdown()


def test_non_integer_local_interval_is_not_approximated(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        _freeze(
            runtime,
            [_bar(0, interval_ms=300_000), _bar(1, interval_ms=300_000)],
            interval="5m",
        )
        response = runtime.chart_context.resolve(
            _request(
                interval="89m",
                end_ms=BASE_MS + 300_000 - 1,
            )
        )
        assert response["status"] == "UNSUPPORTED_INTERVAL"
        assert response["quality_warnings"][0]["code"] == (
            "INTERVAL_NOT_COMPOSABLE"
        )
    finally:
        runtime.shutdown()


def test_materialize_failure_does_not_leak_host_error_details(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        host = _HostData()
        resolution = runtime.chart_context.resolve(
            _request(), host_data_manager=host
        )

        class BrokenBackfill:
            async def request_and_wait(self, _request: Any) -> None:
                raise RuntimeError(r"C:\Users\private\secret-token.txt")

        with pytest.raises(BacktestError) as captured:
            asyncio.run(
                runtime.chart_context.materialize(
                    resolution_token=resolution["resolution_token"],
                    user_confirmed=True,
                    idempotency_key="redacted-backfill-failure",
                    host_data_manager=host,
                    backfill_coordinator=BrokenBackfill(),
                )
            )
        wire = f"{captured.value.code} {captured.value.message} {captured.value.details}"
        assert "private" not in wire
        assert "secret-token" not in wire
        assert captured.value.code == "DATA_PREPARATION_FAILED"
    finally:
        runtime.shutdown()


def test_resolution_token_expires_at_the_advertised_boundary(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        clock = [BASE_MS]
        runtime.chart_context._now_ms = lambda: clock[0]
        resolution = runtime.chart_context.resolve(
            _request(), host_data_manager=_HostData()
        )
        clock[0] = resolution["expires_at_ms"]
        with pytest.raises(BacktestError, match="RESOLUTION_TOKEN_INVALID"):
            asyncio.run(
                runtime.chart_context.materialize(
                    resolution_token=resolution["resolution_token"],
                    user_confirmed=True,
                    idempotency_key="expired-at-boundary",
                    host_data_manager=_HostData([_bar(0), _bar(1), _bar(2)]),
                    backfill_coordinator=None,
                )
            )
    finally:
        runtime.shutdown()


def test_chart_context_http_contract_and_confirmation_gate(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    app = FastAPI()
    app.include_router(backtests_router, prefix="/api/v1")
    app.state.backtest_runtime = runtime
    app.state.backtest_service = runtime.service
    app.state.data_manager = _HostData([_bar(0), _bar(1), _bar(2)])
    app.state.data_engine_runtime = None
    try:
        client = TestClient(app)
        resolved = client.post(
            "/api/v1/backtests/chart-context/resolve", json=_request()
        )
        assert resolved.status_code == 200
        body = resolved.json()
        assert body["status"] == "NEEDS_DATA"
        assert body["schema_version"] == "candlescope.backtest-chart-context/1"
        denied = client.post(
            "/api/v1/backtests/chart-context/materialize",
            json={
                "resolution_token": body["resolution_token"],
                "user_confirmed": False,
                "idempotency_key": "http-confirmation-gate",
            },
        )
        assert denied.status_code == 400
        assert denied.json()["error"]["code"] == "USER_CONFIRMATION_REQUIRED"
        prepared = client.post(
            "/api/v1/backtests/chart-context/materialize",
            json={
                "resolution_token": body["resolution_token"],
                "user_confirmed": True,
                "idempotency_key": "http-materialize-ready",
            },
        )
        assert prepared.status_code == 200, prepared.text
        ready = prepared.json()
        assert ready["status"] == "READY"
        validated = client.post(
            "/api/v1/backtests/runs/validate",
            json={
                "strategy_revision_id": "builtin-sma-cross-v1",
                "dataset_id": ready["dataset_id"],
                "data_epoch": ready["data_epoch"],
                "snapshot_hash": ready["snapshot_hash"],
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": BASE_MS,
                "end_time_ms": BASE_MS + 3 * 60_000 - 1,
                "interval": "1m",
                "exchange": "binance",
                "market_type": "futures",
                "parameters": {"fast": 2, "slow": 3},
            },
        )
        assert validated.status_code == 200, validated.text
        assert validated.json()["ok"] is True
        assert validated.json()["snapshot"]["snapshot_hash"] == ready["snapshot_hash"]
        malformed = client.post(
            "/api/v1/backtests/chart-context/resolve",
            json={**_request(), "visible_candles": [{"time": 1}]},
        )
        assert malformed.status_code == 422
    finally:
        runtime.shutdown()


def test_chart_context_http_routes_accept_explicit_rollback(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_CHART_CONTEXT_ENABLED": "0",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(settings, local_data_dir=tmp_path / "local")
    app = FastAPI()
    app.include_router(backtests_router, prefix="/api/v1")
    app.state.backtest_runtime = runtime
    app.state.backtest_service = runtime.service
    app.state.data_manager = _HostData([_bar(0), _bar(1), _bar(2)])
    app.state.data_engine_runtime = None
    try:
        client = TestClient(app)
        resolved = client.post(
            "/api/v1/backtests/chart-context/resolve", json=_request()
        )
        assert resolved.status_code == 400
        assert resolved.json()["error"]["code"] == "FLAG_DISABLED"
    finally:
        runtime.shutdown()
