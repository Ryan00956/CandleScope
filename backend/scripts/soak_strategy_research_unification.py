from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

CSV = "time,open,high,low,close,volume\n1704067200000,1,2,1,2,1\n1704067260000,2,3,2,3,1\n1704067320000,3,4,3,4,1\n"


def _prepare_path() -> Path:
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    sdk = root.parent / "packages" / "candlescope-plugin-sdk" / "src"
    backtest_sdk = root.parent / "packages" / "candlescope-backtest-sdk" / "src"
    for path in (root, sdk, backtest_sdk):
        text = str(path)
        if text not in sys.path:
            sys.path.insert(0, text)
    return root


def _make_client(tmp: Path):
    from fastapi.testclient import TestClient

    from app.main import app
    from tests.asgi_peer import PeerASGIApp

    os.environ["CANDLESCOPE_LOCAL_DATA_DIR"] = str(tmp / "local")
    return TestClient(PeerASGIApp(app, "127.0.0.1")), app


def _cycle_offline(client, app, cycle: int) -> dict[str, object]:
    from fastapi.testclient import TestClient

    from tests.asgi_peer import PeerASGIApp

    health = client.get("/health")
    payload = health.json()
    assert health.status_code == 200
    assert payload["runtime_mode"] == "LOCAL_OFFLINE"
    imported = client.post(
        "/api/v1/local/imports/csv",
        params={"name": f"soak-{cycle}", "symbol": "BTC-USDT", "interval": "1m", "timestamp_unit": "ms"},
        content=CSV,
        headers={"content-type": "text/csv", "origin": "http://127.0.0.1:15173", "host": "127.0.0.1:18080"},
    )
    assert imported.status_code == 201, imported.text
    dataset = imported.json()
    listed = client.get("/api/v1/local/datasets", headers={"host": "127.0.0.1:18080"})
    assert listed.status_code == 200, listed.text
    for path in ("/api/v1/klines/history", "/api/v1/stream", "/api/v1/replay/sessions"):
        blocked = client.get(path)
        assert blocked.status_code == 403, path
    remote = TestClient(PeerASGIApp(app, "203.0.113.9"))
    denied = remote.get(
        "/api/v1/local/datasets",
        headers={"origin": "https://evil.example", "host": "203.0.113.9"},
    )
    assert denied.status_code == 403
    return {
        "cycle": cycle,
        "dataset_id": dataset.get("dataset_id"),
        "data_epoch": dataset.get("data_epoch"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-ms", type=int, default=1000)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    _prepare_path()
    tmp = args.output.parent / "soak-tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    os.environ["CANDLESCOPE_RUNTIME_MODE"] = "LOCAL_OFFLINE"
    os.environ["CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED"] = "1"
    os.environ["CANDLESCOPE_LOCAL_DATA_DIR"] = str(tmp / "local")
    os.environ["CANDLE_DATA_DIR"] = str(tmp / "candles")
    os.environ.setdefault("BACKTEST_ENABLED", "1")
    os.environ.setdefault("BACKTEST_BAR_ENABLED", "1")
    started = time.time()
    deadline = started + (args.duration_ms / 1000)
    cycles: list[dict[str, object]] = []
    index = 0
    error: str | None = None
    try:
        client, app = _make_client(tmp)
        with client:
            while True:
                if index == 0 or index % 30 == 0:
                    cycles.append(_cycle_offline(client, app, index))
                else:
                    health = client.get("/health")
                    assert health.status_code == 200
                    assert health.json()["runtime_mode"] == "LOCAL_OFFLINE"
                    listed = client.get("/api/v1/local/datasets", headers={"host": "127.0.0.1:18080"})
                    assert listed.status_code == 200
                    cycles.append({"cycle": index, "heartbeat": True})
                index += 1
                if time.time() >= deadline:
                    break
                remaining = deadline - time.time()
                time.sleep(min(5.0, max(0.0, remaining)))
    except Exception as exc:  # noqa: BLE001 - soak must record the failure
        error = str(exc)
    elapsed_ms = int((time.time() - started) * 1000)
    result = {
        "schemaVersion": "candlescope.strategy-research-unification-soak/1",
        "status": "FAIL" if error else "PASS",
        "requestedDurationMs": args.duration_ms,
        "elapsedMs": elapsed_ms,
        "cycles": len(cycles),
        "error": error,
        "last": cycles[-1] if cycles else None,
        "covers": {
            "localOfflineImport": True,
            "localOfflineNetworkDeny": True,
            "remoteOriginDeny": True,
            "liveChartBrowser": False,
            "liveImportedChartBrowser": False,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if error is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
