from __future__ import annotations

import os
from pathlib import Path

from app.core import config
from scripts.replay_smoke_fixture import (
    INTERVAL_MS,
    LEGACY_LIVE_TAIL_ROWS,
    _force_offline_upstreams,
    _legacy_live_tail_rows,
    _legacy_live_tail_required,
)


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
