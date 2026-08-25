from __future__ import annotations

from pathlib import Path
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import local_data
from app.local_data import LocalDatasetService
from tests.asgi_peer import PeerASGIApp

_TRUSTED_HEADERS = {
    "origin": "http://127.0.0.1:15173",
    "host": "127.0.0.1:18080",
}


def _client(tmp_path: Path, monkeypatch) -> TestClient:
    app = FastAPI()
    app.include_router(local_data.router, prefix="/api/v1")
    service = LocalDatasetService(tmp_path / "local-data")
    service.start()
    app.state.local_data_service = service
    return TestClient(PeerASGIApp(app, "127.0.0.1"), headers=_TRUSTED_HEADERS)


def test_import_list_and_query_local_csv(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    csv_body = (
        "time,open,high,low,close,volume\n"
        "1704067200000,100,102,99,101,10\n"
        "1704067260000,101,103,100,102,11\n"
    )
    response = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "Imported BTC",
            "symbol": "BTC-USDT",
            "interval": "1m",
            "timestamp_unit": "ms",
        },
        content=csv_body,
        headers={"content-type": "text/csv"},
    )
    assert response.status_code == 201, response.text
    manifest = response.json()

    listed = client.get("/api/v1/local/datasets")
    assert listed.status_code == 200
    assert listed.json()["count"] == 1

    latest = client.get(
        f"/api/v1/local/datasets/{manifest['dataset_id']}/klines/latest",
        params={"interval": "1m", "limit": 100},
    )
    assert latest.status_code == 200
    assert [row["close"] for row in latest.json()["data"]] == [101.0, 102.0]
    assert latest.json()["source"] == "local_dataset"


def test_local_api_resamples_15m_for_chart_and_indicators(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    rows = ["time,open,high,low,close,volume"]
    for index in range(12):
        timestamp = 1_704_067_200 + index * 15 * 60
        rows.append(
            f"{timestamp},{100 + index},{102 + index},{99 + index},"
            f"{101 + index},{10 + index}"
        )
    imported = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "15m source",
            "symbol": "BTCUSDT",
            "interval": "15m",
            "timestamp_unit": "s",
        },
        content="\n".join(rows) + "\n",
        headers={"content-type": "text/csv"},
    ).json()

    ninety = client.get(
        f"/api/v1/local/datasets/{imported['dataset_id']}/klines/latest",
        params={"interval": "90m", "limit": 10},
    )
    assert ninety.status_code == 200, ninety.text
    assert ninety.json()["aggregation_factor"] == 6
    assert [row["close"] for row in ninety.json()["data"]] == [106.0, 112.0]

    indicators = client.post(
        f"/api/v1/local/datasets/{imported['dataset_id']}/indicators/compute/batch",
        json={
            "schemaVersion": 1,
            "data_epoch": imported["data_epoch"],
            "interval": "90m",
            "requests": [
                {
                    "jobKey": "ma-2-90m",
                    "clientId": "local-ma-90m",
                    "name": "MA",
                    "params": {"period": 2, "source": "close"},
                }
            ],
        },
    )
    assert indicators.status_code == 200, indicators.text
    assert indicators.json()["interval"] == "90m"
    assert indicators.json()["derived"] is True
    assert indicators.json()["results"][0]["payload"]["lines"][0]["data"][-1][
        "value"
    ] == 109.0

    unsupported = client.get(
        f"/api/v1/local/datasets/{imported['dataset_id']}/klines/latest",
        params={"interval": "89m", "limit": 10},
    )
    assert unsupported.status_code == 422
    assert unsupported.json()["detail"]["code"] == "interval_not_composable"
    assert "not an integer multiple" in unsupported.json()["detail"]["message"]


def test_event_time_resolution_endpoint_preserves_input_order(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    imported = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "Event bars",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "timestamp_unit": "ms",
        },
        content=(
            "time,open,high,low,close\n"
            "1704067200000,100,102,99,101\n"
            "1704067260000,101,103,100,102\n"
        ),
        headers={"content-type": "text/csv"},
    ).json()

    response = client.post(
        f"/api/v1/local/datasets/{imported['dataset_id']}/events/resolve-times",
        json={
            "data_epoch": imported["data_epoch"],
            "times_ms": [1704067230000, 1704067260000, 1704067400000],
            "mode": "containing",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [result["input_index"] for result in body["results"]] == [0, 1, 2]
    assert [result["matched"] for result in body["results"]] == [True, True, False]
    assert body["matched"] == 2
    assert body["rejected"] == 1


def test_import_accepts_default_volume_mapping_for_tradingview(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "TradingView BTC",
            "symbol": "BINANCE:BTCUSDT",
            "interval": "1m",
            "timestamp_unit": "s",
        },
        content=(
            "time,open,high,low,close,Volume\n"
            "1785608340,62632.54,62640,62600.01,62603.16,18.97148\n"
            "1785608400,62617.85,62630,62533.54,62569.41,26.64177\n"
        ),
        headers={"content-type": "text/csv"},
    )

    assert response.status_code == 201, response.text
    assert response.json()["rows"] == 2


def test_import_exposes_ohlc_only_without_fabricating_volume(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    csv_body = (
        "time,open,high,low,close\n"
        "1739577600,97500,98000,97000,97750\n"
        "1739664000,97750,99000,97500,98500\n"
    )
    imported = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "TradingView OHLC only",
            "symbol": "BINANCE:BTCUSDT",
            "interval": "1d",
            "timestamp_unit": "s",
        },
        content=csv_body,
        headers={"content-type": "text/csv"},
    )

    assert imported.status_code == 201, imported.text
    assert imported.json()["volume_available"] is False
    dataset_id = imported.json()["dataset_id"]
    latest = client.get(
        f"/api/v1/local/datasets/{dataset_id}/klines/latest",
        params={"interval": "1d", "limit": 10},
    )
    assert latest.status_code == 200
    assert latest.json()["volume_available"] is False
    assert [row["volume"] for row in latest.json()["data"]] == [None, None]

    required = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "Volume required",
            "symbol": "BINANCE:BTCUSDT",
            "interval": "1d",
            "timestamp_unit": "s",
            "volume_required": True,
        },
        content=csv_body,
        headers={"content-type": "text/csv"},
    )
    assert required.status_code == 422


def test_local_builtin_indicators_are_revision_bound_and_capability_gated(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    rows = ["time,open,high,low,close"]
    for index in range(40):
        timestamp = 1704067200 + index * 60
        close = 101 + index
        rows.append(f"{timestamp},{close - 1},{close + 1},{close - 2},{close}")
    imported = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "OHLC indicators",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "timestamp_unit": "s",
        },
        content="\n".join(rows) + "\n",
        headers={"content-type": "text/csv"},
    ).json()
    endpoint = (
        f"/api/v1/local/datasets/{imported['dataset_id']}/indicators/compute/batch"
    )
    response = client.post(
        endpoint,
        json={
            "schemaVersion": 1,
            "data_epoch": imported["data_epoch"],
            "requests": [
                {
                    "jobKey": "ma-3",
                    "clientId": "local-ma-one",
                    "name": "MA",
                    "params": {"period": 3, "source": "close"},
                },
                {
                    "jobKey": "ema-3",
                    "clientId": "local-ema-one",
                    "name": "EMA",
                    "params": {"period": 3, "source": "close"},
                },
                {
                    "jobKey": "rsi-2",
                    "clientId": "local-rsi-one",
                    "name": "RSI",
                    "params": {"period": 2, "source": "close"},
                },
                {
                    "jobKey": "macd-valid",
                    "clientId": "local-macd-valid",
                    "name": "MACD",
                    "params": {"fast": 2, "slow": 3, "signal": 2},
                },
                {
                    "jobKey": "boll-3",
                    "clientId": "local-boll-one",
                    "name": "BOLL",
                    "params": {"period": 3, "mult": 2},
                },
                {
                    "jobKey": "atr-3",
                    "clientId": "local-atr-one",
                    "name": "ATR",
                    "params": {"period": 3},
                },
                {
                    "jobKey": "vol-missing",
                    "clientId": "local-vol-missing",
                    "name": "VOL",
                    "params": {},
                },
                {
                    "jobKey": "macd-invalid",
                    "clientId": "local-macd-invalid",
                    "name": "MACD",
                    "params": {"fast": 30, "slow": 20, "signal": 9},
                },
            ],
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["source"] == "local_dataset"
    assert payload["data_epoch"] == imported["data_epoch"]
    assert payload["ok"] is False
    ma_payload = payload["results"][0]["payload"]
    assert ma_payload["ok"] is True
    assert ma_payload["dataRevision"]["token"] == imported["data_epoch"]
    assert ma_payload["lines"][0]["data"][0] == {
        "time": 1704067320,
        "value": 102.0,
    }
    by_client = {item["clientId"]: item["payload"] for item in payload["results"]}
    for client_id in (
        "local-ma-one",
        "local-ema-one",
        "local-rsi-one",
        "local-macd-valid",
        "local-boll-one",
        "local-atr-one",
    ):
        assert by_client[client_id]["ok"] is True
        assert by_client[client_id]["lines"]
    assert by_client["local-rsi-one"]["lines"][0]["pane"] == "separate"
    assert len(by_client["local-macd-valid"]["lines"]) == 3
    assert len(by_client["local-boll-one"]["lines"]) == 3
    assert by_client["local-vol-missing"]["code"] == ("LOCAL_INDICATOR_PARAMS_INVALID")
    assert by_client["local-macd-invalid"]["code"] == ("LOCAL_INDICATOR_PARAMS_INVALID")

    stale = client.post(
        endpoint,
        json={
            "schemaVersion": 1,
            "data_epoch": "sha256:" + "0" * 64,
            "requests": [
                {
                    "jobKey": "ma-stale",
                    "clientId": "local-ma-stale",
                    "name": "MA",
                    "params": {"period": 3},
                }
            ],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "dataset_revision_changed"


def test_local_indicator_catalog_and_volume_capability(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    catalog = client.get("/api/v1/local/indicators/presets")
    assert catalog.status_code == 200
    names = {item["engineName"] for item in catalog.json()}
    assert {"MA", "EMA", "RSI", "MACD", "BOLL", "ATR", "VOL"} <= names

    rows = ["time,open,high,low,close,volume"]
    for index in range(8):
        timestamp = 1704067200 + index * 60
        close = 101 + index
        rows.append(
            f"{timestamp},{close - 1},{close + 1},{close - 2},{close},{10 + index}"
        )
    imported = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "Volume indicator",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "timestamp_unit": "s",
        },
        content="\n".join(rows) + "\n",
        headers={"content-type": "text/csv"},
    ).json()
    response = client.post(
        f"/api/v1/local/datasets/{imported['dataset_id']}/indicators/compute/batch",
        json={
            "schemaVersion": 1,
            "data_epoch": imported["data_epoch"],
            "requests": [
                {
                    "jobKey": "vol-ready",
                    "clientId": "local-vol-ready",
                    "name": "VOL",
                    "params": {},
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]["payload"]
    assert result["ok"] is True
    assert result["lines"][0]["data"][-1]["value"] == 17.0
    assert response.json()["cache"] == "miss"
    repeated = client.post(
        f"/api/v1/local/datasets/{imported['dataset_id']}/indicators/compute/batch",
        json={
            "schemaVersion": 1,
            "data_epoch": imported["data_epoch"],
            "requests": [
                {
                    "jobKey": "vol-ready",
                    "clientId": "local-vol-ready",
                    "name": "VOL",
                    "params": {},
                }
            ],
        },
    )
    assert repeated.status_code == 200
    assert repeated.json()["cache"] == "hit"


def test_background_import_job_and_library_api(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post(
        "/api/v1/local/imports/csv/jobs",
        params={
            "name": "Background BTC",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "timestamp_unit": "ms",
        },
        content=(
            "time,open,high,low,close\n1704067200000,1,2,1,2\n1704067260000,2,3,2,3\n"
        ),
        headers={"content-type": "text/csv"},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    for _ in range(100):
        job = client.get(f"/api/v1/local/imports/jobs/{job_id}").json()
        if job["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.01)
    assert job["status"] == "completed", job
    dataset = job["dataset"]

    renamed = client.patch(
        f"/api/v1/local/datasets/{dataset['dataset_id']}",
        json={"name": "Renamed locally"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed locally"
    quality = client.get(
        f"/api/v1/local/datasets/{dataset['dataset_id']}/quality",
        params={"data_epoch": dataset["data_epoch"]},
    )
    assert quality.status_code == 200
    assert quality.json()["quality"]["rows"] == 2

    deleted = client.delete(f"/api/v1/local/datasets/{dataset['dataset_id']}")
    assert deleted.status_code == 200
    trash_id = deleted.json()["trash_id"]
    restored = client.post(f"/api/v1/local/trash/{trash_id}/restore")
    assert restored.status_code == 200
    assert restored.json()["name"] == "Renamed locally"


def test_project_package_api_round_trip_remaps_collision(
    tmp_path: Path, monkeypatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    imported = client.post(
        "/api/v1/local/imports/csv",
        params={
            "name": "Portable API project",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "timestamp_unit": "ms",
        },
        content=(
            "time,open,high,low,close\n1704067200000,1,2,1,2\n1704067260000,2,3,2,3\n"
        ),
        headers={"content-type": "text/csv"},
    ).json()
    exported = client.post(
        f"/api/v1/local/projects/{imported['dataset_id']}/export",
        json={
            "data_epoch": imported["data_epoch"],
            "client_state": {
                "schema_version": 1,
                "events": [],
                "indicators": [],
                "drawings": [],
                "settings": {},
            },
        },
    )
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"].startswith(
        "application/vnd.candlescope.local-project+zip"
    )
    restored = client.post(
        "/api/v1/local/projects/import",
        content=exported.content,
        headers={"content-type": "application/vnd.candlescope.local-project+zip"},
    )
    assert restored.status_code == 201, restored.text
    assert restored.json()["identity_changed"] is True
    assert restored.json()["dataset_id"] != imported["dataset_id"]
    assert restored.json()["client_state"]["schema_version"] == 1
