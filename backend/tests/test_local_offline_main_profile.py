from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_main_local_profile_starts_only_local_runtime(tmp_path: Path) -> None:
    script = """
import socket
from fastapi.testclient import TestClient
from app.core.config import HOST
from app.main import app

class Peer:
    def __init__(self, app, host):
        self.app = app
        self.host = host
    async def __call__(self, scope, receive, send):
        if scope.get("type") in {"http", "websocket"}:
            scope = dict(scope)
            scope["client"] = (self.host, 50000)
        await self.app(scope, receive, send)

assert HOST == "127.0.0.1"
with TestClient(Peer(app, "127.0.0.1")) as client:
    health = client.get("/health")
    assert health.status_code == 200, health.text
    payload = health.json()
    assert payload["runtime_mode"] == "LOCAL_OFFLINE"
    assert payload["local_offline"]["network"]["installed"] is True
    caps = client.get("/api/v1/local/capabilities", headers={"host": "127.0.0.1:18080"})
    assert caps.status_code == 200, caps.text
    blocked = client.get("/api/v1/klines/history")
    assert blocked.status_code == 403, blocked.text
    stream = client.get("/api/v1/stream")
    assert stream.status_code == 403, stream.text
    replay = client.get("/api/v1/replay/sessions")
    assert replay.status_code == 403, replay.text
    plugins = client.get("/api/v1/plugins")
    assert plugins.status_code == 403, plugins.text
    backtests = client.get("/api/v1/backtests/capabilities")
    assert backtests.status_code == 200, backtests.text
    assert not hasattr(app.state, "plugin_runtime_host")
    assert not hasattr(app.state, "data_engine_runtime")
    assert not hasattr(app.state, "replay_runtime")
    try:
        socket.getaddrinfo("example.com", 443)
    except OSError:
        pass
    else:
        raise AssertionError("external DNS was not blocked")
"""
    environment = os.environ.copy()
    environment["CANDLESCOPE_RUNTIME_MODE"] = "LOCAL_OFFLINE"
    environment["CANDLESCOPE_LOCAL_DATA_DIR"] = str(tmp_path / "local-data")
    environment["CANDLE_HOST"] = "0.0.0.0"
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_main_local_profile_can_start_opt_in_backtest_runtime(
    tmp_path: Path,
) -> None:
    script = """
from fastapi.testclient import TestClient
from app.main import app

with TestClient(app) as client:
    capabilities = client.get("/api/v1/backtests/capabilities")
    assert capabilities.status_code == 200, capabilities.text
    assert capabilities.json()["flags"]["BACKTEST_ENABLED"] is True
    assert hasattr(app.state, "local_offline_runtime")
    assert hasattr(app.state, "backtest_runtime")
    assert not hasattr(app.state, "plugin_runtime_host")
"""
    environment = os.environ.copy()
    environment.update(
        {
            "CANDLESCOPE_RUNTIME_MODE": "LOCAL_OFFLINE",
            "CANDLE_DATA_DIR": str(tmp_path / "runtime-data"),
            "CANDLESCOPE_LOCAL_DATA_DIR": str(tmp_path / "local-data"),
            "BACKTEST_DB_PATH": str(tmp_path / "backtest.db"),
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
        }
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
