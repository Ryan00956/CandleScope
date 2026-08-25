from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import local_data
from app.local_data import LocalDatasetService
from app.research_data.access import (
    LOCAL_RESEARCH_ORIGIN_REQUIRED,
    evaluate_local_research_access,
)
from tests.asgi_peer import PeerASGIApp


def test_access_matrix_loopback_and_forwards() -> None:
    trusted = evaluate_local_research_access(
        client_host="127.0.0.1",
        host_header="127.0.0.1:18080",
        origin="http://127.0.0.1:15173",
        forwarded_for="8.8.8.8",
    )
    assert trusted.allowed is True
    localhost = evaluate_local_research_access(
        client_host="127.0.0.1",
        host_header="localhost:18080",
        origin="http://localhost:15173",
    )
    assert localhost.allowed is True
    cli = evaluate_local_research_access(
        client_host="127.0.0.1",
        host_header="127.0.0.1:18080",
        origin=None,
    )
    assert cli.allowed is True
    lan_direct = evaluate_local_research_access(
        client_host="192.168.1.20",
        host_header="192.168.1.20:18080",
        origin="http://192.168.1.20:15173",
    )
    assert lan_direct.allowed is False
    lan_via_vite = evaluate_local_research_access(
        client_host="127.0.0.1",
        host_header="127.0.0.1:18080",
        origin="http://192.168.1.20:15173",
    )
    assert lan_via_vite.allowed is False
    spoofed = evaluate_local_research_access(
        client_host="192.168.1.20",
        host_header="127.0.0.1:18080",
        origin="http://192.168.1.20:15173",
        forwarded_for="127.0.0.1",
    )
    assert spoofed.allowed is False
    dns_label = evaluate_local_research_access(
        client_host="127.0.0.1",
        host_header="127.0.0.1:18080",
        origin="http://127.attacker.example:15173",
    )
    assert dns_label.allowed is False
    loopback_octet = evaluate_local_research_access(
        client_host="127.0.0.2",
        host_header="127.0.0.2:18080",
        origin="http://127.0.0.2:15173",
    )
    assert loopback_octet.allowed is True


def _app(tmp_path: Path) -> FastAPI:
    app = FastAPI()
    app.include_router(local_data.router, prefix="/api/v1")
    service = LocalDatasetService(tmp_path / "local-data")
    service.start()
    app.state.local_data_service = service
    return app


def test_f1_trusted_local_origin_can_import(tmp_path: Path) -> None:
    client = TestClient(PeerASGIApp(_app(tmp_path), "127.0.0.1"))
    response = client.post(
        "/api/v1/local/imports/csv",
        params={"name": "ok", "symbol": "BTC-USDT", "interval": "1m", "timestamp_unit": "ms"},
        content="time,open,high,low,close,volume\n1704067200000,1,1,1,1,1\n",
        headers={"content-type": "text/csv", "origin": "http://127.0.0.1:15173", "host": "127.0.0.1"},
    )
    assert response.status_code == 201, response.text


def test_f2_lan_origin_direct_is_403(tmp_path: Path) -> None:
    client = TestClient(PeerASGIApp(_app(tmp_path), "192.168.1.20"))
    response = client.get(
        "/api/v1/local/datasets",
        headers={"origin": "http://192.168.1.20:15173", "host": "192.168.1.20:18080"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == LOCAL_RESEARCH_ORIGIN_REQUIRED


def test_f3_lan_origin_via_vite_loopback_peer_is_403(tmp_path: Path) -> None:
    client = TestClient(PeerASGIApp(_app(tmp_path), "127.0.0.1"))
    response = client.get(
        "/api/v1/local/datasets",
        headers={"origin": "http://192.168.1.20:15173", "host": "127.0.0.1:18080"},
    )
    assert response.status_code == 403


def test_f4_x_forwarded_for_does_not_grant_access(tmp_path: Path) -> None:
    client = TestClient(PeerASGIApp(_app(tmp_path), "192.168.1.20"))
    response = client.get(
        "/api/v1/local/datasets",
        headers={
            "origin": "http://192.168.1.20:15173",
            "host": "127.0.0.1:18080",
            "x-forwarded-for": "127.0.0.1",
        },
    )
    assert response.status_code == 403


def test_f5_remote_origin_cannot_read_datasets_or_klines(tmp_path: Path) -> None:
    app = _app(tmp_path)
    trusted = TestClient(PeerASGIApp(app, "127.0.0.1"))
    imported = trusted.post(
        "/api/v1/local/imports/csv",
        params={"name": "ok", "symbol": "BTC-USDT", "interval": "1m", "timestamp_unit": "ms"},
        content="time,open,high,low,close,volume\n1704067200000,1,1,1,1,1\n",
        headers={"content-type": "text/csv", "origin": "http://127.0.0.1:15173"},
    )
    assert imported.status_code == 201, imported.text
    dataset_id = imported.json()["dataset_id"]
    remote = TestClient(PeerASGIApp(app, "203.0.113.9"))
    listed = remote.get(
        "/api/v1/local/datasets",
        headers={"origin": "https://evil.example", "host": "203.0.113.9"},
    )
    klines = remote.get(
        f"/api/v1/local/datasets/{dataset_id}/klines/latest",
        params={"interval": "1m", "limit": 10},
        headers={"origin": "https://evil.example", "host": "203.0.113.9"},
    )
    assert listed.status_code == 403
    assert klines.status_code == 403


def test_f6_deny_logs_do_not_include_absolute_paths(tmp_path: Path, caplog) -> None:
    caplog.set_level(logging.INFO, logger="candlescope.research_data.access")
    client = TestClient(PeerASGIApp(_app(tmp_path), "10.0.0.8"))
    client.get(
        "/api/v1/local/datasets",
        headers={"origin": "http://10.0.0.8:15173", "host": "10.0.0.8"},
    )
    text = caplog.text
    assert "untrusted_origin" in text or "origin_not_trusted" in text
    assert str(tmp_path) not in text
    assert "C:\\" not in text
    assert "/home/" not in text


def test_live_flag_off_does_not_mount_local_library(tmp_path: Path) -> None:
    script = """
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import RESEARCH_DATA_LIBRARY_ENABLED, RUNTIME_MODE
assert RUNTIME_MODE == "LIVE"
assert RESEARCH_DATA_LIBRARY_ENABLED is False
client = TestClient(app)
assert client.get("/health").status_code == 200
response = client.get("/api/v1/local/datasets")
assert response.status_code == 404, response.text
"""
    environment = os.environ.copy()
    environment.update(
        {
            "CANDLESCOPE_RUNTIME_MODE": "LIVE",
            "CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED": "0",
            "BACKTEST_ENABLED": "0",
            "CANDLE_DATA_DIR": str(tmp_path / "data"),
            "CANDLESCOPE_LOCAL_DATA_DIR": str(tmp_path / "local-data"),
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


def test_loopback_cli_without_origin_succeeds(tmp_path: Path) -> None:
    client = TestClient(PeerASGIApp(_app(tmp_path), "127.0.0.1"))
    response = client.get("/api/v1/local/datasets", headers={"host": "127.0.0.1:18080"})
    assert response.status_code == 200, response.text


def test_capabilities_report_process_runtime_not_a_hardcoded_offline_profile(
    tmp_path: Path,
) -> None:
    app = _app(tmp_path)
    app.state.runtime_mode = "LIVE"
    client = TestClient(PeerASGIApp(app, "127.0.0.1"))
    live = client.get("/api/v1/local/capabilities", headers={"host": "127.0.0.1:18080"})
    assert live.status_code == 200, live.text
    assert live.json()["runtime_mode"] == "LIVE"
    assert live.json()["network_policy"] == "trusted_local_origin"
    app.state.runtime_mode = "LOCAL_OFFLINE"
    app.state.local_offline_runtime = object()
    offline = client.get("/api/v1/local/capabilities", headers={"host": "127.0.0.1:18080"})
    assert offline.status_code == 200, offline.text
    assert offline.json()["runtime_mode"] == "LOCAL_OFFLINE"
    assert offline.json()["network_policy"] == "loopback_only"
