from __future__ import annotations

import asyncio
import os
from pathlib import Path

from app.core import config
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.training.historical_book import verify_historical_book_archive
from scripts.replay_smoke_fixture import (
    FIXTURE_SYMBOLS,
    HISTORICAL_BOOK_FIXTURE_MINUTES,
    INTERVAL_MS,
    LEGACY_LIVE_TAIL_ROWS,
    SOAK_LIVE_FUTURE_MS,
    SOAK_LIVE_HISTORY_ROWS,
    _force_offline_upstreams,
    _legacy_live_tail_rows,
    _legacy_live_tail_required,
    _release_replay_adapter_when_idle,
    _seed_historical_book_source,
    _smoke_live_tail_required,
    _soak_live_window_rows,
)


def test_phase5_smoke_fixture_has_multiple_same_settlement_symbols() -> None:
    assert [symbol for symbol, _price in FIXTURE_SYMBOLS] == [
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "XRPUSDT",
        "ADAUSDT",
        "BNBUSDT",
        "DOGEUSDT",
        "AVAXUSDT",
    ]


def test_phase10_fixture_retries_only_transient_adapter_busy_conflicts() -> None:
    class TransientBusyService:
        def __init__(self) -> None:
            self.calls = 0

        async def release_session_to_hub(self, _session_id: str) -> None:
            self.calls += 1
            if self.calls < 3:
                raise ReplayDomainError(
                    ReplayErrorCode.REVISION_CONFLICT,
                    "replay session is busy",
                )

    service = TransientBusyService()

    attempts = asyncio.run(
        _release_replay_adapter_when_idle(
            service,
            "session-0001",
            max_attempts=3,
            retry_delay_seconds=0,
        )
    )

    assert attempts == 3
    assert service.calls == 3


def test_phase10_fixture_fails_closed_when_adapter_stays_busy() -> None:
    class PersistentlyBusyService:
        def __init__(self) -> None:
            self.calls = 0

        async def release_session_to_hub(self, _session_id: str) -> None:
            self.calls += 1
            raise ReplayDomainError(
                ReplayErrorCode.REVISION_CONFLICT,
                "replay session is busy",
            )

    service = PersistentlyBusyService()

    try:
        asyncio.run(
            _release_replay_adapter_when_idle(
                service,
                "session-0001",
                max_attempts=2,
                retry_delay_seconds=0,
            )
        )
    except ReplayDomainError as exc:
        assert exc.code is ReplayErrorCode.REVISION_CONFLICT
        assert exc.message == "replay session is busy"
    else:
        raise AssertionError("persistent adapter contention must fail closed")
    assert service.calls == 2


def test_phase10_fixture_never_retries_other_adapter_failures() -> None:
    class MissingSessionService:
        def __init__(self) -> None:
            self.calls = 0

        async def release_session_to_hub(self, _session_id: str) -> None:
            self.calls += 1
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_NOT_FOUND,
                "replay session does not exist",
            )

    service = MissingSessionService()

    try:
        asyncio.run(
            _release_replay_adapter_when_idle(
                service,
                "session-0001",
                max_attempts=3,
                retry_delay_seconds=0,
            )
        )
    except ReplayDomainError as exc:
        assert exc.code is ReplayErrorCode.SESSION_NOT_FOUND
    else:
        raise AssertionError("non-busy adapter failures must propagate immediately")
    assert service.calls == 1


def test_replay_smoke_fixture_removes_public_fallback_upstreams(monkeypatch) -> None:
    monkeypatch.setattr(config, "BINANCE_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(config, "BINANCE_WS_URL", "ws://127.0.0.1:9")
    monkeypatch.setattr(config, "BINANCE_FUTURES_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(config, "BINANCE_FUTURES_WS_URL", "ws://127.0.0.1:9")
    monkeypatch.setattr(config, "BINANCE_BASE_URLS", ["https://api.binance.com"])
    monkeypatch.setattr(config, "BINANCE_WS_URLS", ["wss://stream.binance.com/ws"])
    monkeypatch.setattr(
        config,
        "BINANCE_FUTURES_BASE_URLS",
        ["https://fapi.binance.com"],
    )
    monkeypatch.setattr(
        config,
        "BINANCE_FUTURES_WS_URLS",
        ["wss://fstream.binance.com/ws"],
    )
    for key in (
        "INGESTION_HTTP_BASE_URLS",
        "INGESTION_WS_BASE_URLS",
        "INGESTION_HTTP_BASE_URLS_FUTURES",
        "INGESTION_WS_BASE_URLS_FUTURES",
        "INGESTION_PROXY_MODE",
    ):
        # Register every key with monkeypatch even when it was originally
        # absent. The helper intentionally writes os.environ directly, so a
        # no-op delenv would otherwise leave those values behind for later
        # tests in the same process.
        monkeypatch.setenv(key, "pytest-restore-sentinel")

    _force_offline_upstreams()

    assert config.BINANCE_BASE_URLS == ["http://127.0.0.1:9"]
    assert config.BINANCE_WS_URLS == ["ws://127.0.0.1:9"]
    assert config.BINANCE_FUTURES_BASE_URLS == ["http://127.0.0.1:9"]
    assert config.BINANCE_FUTURES_WS_URLS == ["ws://127.0.0.1:9"]
    assert os.environ["INGESTION_HTTP_BASE_URLS"] == "http://127.0.0.1:9"
    assert os.environ["INGESTION_WS_BASE_URLS"] == "ws://127.0.0.1:9"
    assert (
        os.environ["INGESTION_HTTP_BASE_URLS_FUTURES"]
        == "http://127.0.0.1:9"
    )
    assert (
        os.environ["INGESTION_WS_BASE_URLS_FUTURES"]
        == "ws://127.0.0.1:9"
    )
    assert os.environ["INGESTION_PROXY_MODE"] == "none"


def test_legacy_rollback_live_tail_is_recent_closed_and_bounded() -> None:
    now_ms = 1_800_000_345_678

    rows = _legacy_live_tail_rows(now_ms=now_ms)

    assert len(rows) == LEGACY_LIVE_TAIL_ROWS
    assert all(
        int(right["open_time"]) - int(left["open_time"]) == INTERVAL_MS
        for left, right in zip(rows, rows[1:])
    )
    assert rows[-1]["open_time"] == (now_ms // INTERVAL_MS - 1) * INTERVAL_MS
    assert int(rows[-1]["close_time"]) < now_ms


def test_legacy_live_tail_is_limited_to_cross_root_rollback_invocation(
    tmp_path: Path,
) -> None:
    current_root = tmp_path / "current-backend"
    legacy_root = tmp_path / "legacy-backend"
    current_root.mkdir()
    legacy_root.mkdir()

    assert not _legacy_live_tail_required(
        runtime_backend_root=current_root,
        fixture_backend_root=current_root,
    )
    assert _legacy_live_tail_required(
        runtime_backend_root=legacy_root,
        fixture_backend_root=current_root,
    )


def test_phase10_soak_can_explicitly_request_the_bounded_live_tail(
    tmp_path: Path,
) -> None:
    current_root = tmp_path / "current-backend"
    current_root.mkdir()

    assert not _smoke_live_tail_required(
        explicit=False,
        runtime_backend_root=current_root,
        fixture_backend_root=current_root,
    )
    assert _smoke_live_tail_required(
        explicit=True,
        runtime_backend_root=current_root,
        fixture_backend_root=current_root,
    )


def test_phase10_soak_live_window_covers_history_and_the_formal_horizon() -> None:
    now_ms = 1_800_000_345_678
    interval_ms = 5 * INTERVAL_MS

    rows = _soak_live_window_rows(interval_ms=interval_ms, now_ms=now_ms)

    last_closed_open_ms = (now_ms // interval_ms - 1) * interval_ms
    assert rows[SOAK_LIVE_HISTORY_ROWS - 1]["open_time"] == last_closed_open_ms
    assert rows[-1]["open_time"] == (
        (now_ms + SOAK_LIVE_FUTURE_MS) // interval_ms
    ) * interval_ms
    assert all(
        int(right["open_time"]) - int(left["open_time"]) == interval_ms
        for left, right in zip(rows, rows[1:])
    )


def test_phase9_smoke_fixture_builds_verified_opt_in_historical_book(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("REPLAY_HISTORICAL_BOOK_ENABLED", "1")
    monkeypatch.setenv("REPLAY_SMOKE_BOOK_SOURCE_DIR", str(tmp_path / "trusted"))

    source = _seed_historical_book_source()
    descriptor = verify_historical_book_archive(
        source,
        trusted_origin="REPLAY_SMOKE_FIXTURE",
    )

    assert descriptor.symbol == "BTCUSDT"
    assert descriptor.snapshot_count == 1
    assert descriptor.delta_count == HISTORICAL_BOOK_FIXTURE_MINUTES
