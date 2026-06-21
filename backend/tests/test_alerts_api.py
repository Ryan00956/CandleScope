from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.alerts.facade import AlertFacade
from app.api.v1.alerts import router as alerts_router


def _client(path: Path) -> TestClient:
    app = FastAPI()
    app.include_router(alerts_router, prefix="/api/v1")
    app.state.alert_facade = AlertFacade(store_path=path)
    return TestClient(app)


class FakeAlertRuntime:
    def __init__(self) -> None:
        self.synced: list[str] = []
        self.removed: list[str] = []

    async def sync_rule(self, rule: dict) -> None:
        self.synced.append(rule["id"])

    async def remove_rule(self, rule_id: str) -> None:
        self.removed.append(rule_id)


def _rule_payload() -> dict:
    return {
        "name": "BTC price break",
        "target": {
            "exchange": "binance",
            "marketType": "spot",
            "symbol": "btcusdt",
            "interval": "1m",
        },
        "triggerOn": "bar_close",
        "expression": {
            "left": "close",
            "comparator": "crossesAbove",
            "right": {"type": "number", "value": 68000},
        },
        "actions": [
            {"type": "in_app", "enabled": True, "config": {}},
            {"type": "telegram", "enabled": False, "config": {"chatId": "demo"}},
        ],
        "cooldownMs": 1000,
        "maxTriggers": 3,
    }


def test_alert_rule_crud_and_enabled_patch(tmp_path: Path) -> None:
    client = _client(tmp_path / "alerts.json")

    created = client.post("/api/v1/alerts/rules", json=_rule_payload())
    assert created.status_code == 200
    rule = created.json()
    assert rule["id"].startswith("alert-")
    assert rule["target"]["symbol"] == "BTCUSDT"
    assert rule["enabled"] is True
    assert rule["actions"][1]["type"] == "telegram"

    listed = client.get("/api/v1/alerts/rules")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [rule["id"]]

    patched = client.patch(f"/api/v1/alerts/rules/{rule['id']}/enabled", json={"enabled": False})
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False

    updated_payload = _rule_payload()
    updated_payload["name"] = "BTC price break edited"
    updated = client.put(f"/api/v1/alerts/rules/{rule['id']}", json=updated_payload)
    assert updated.status_code == 200
    assert updated.json()["name"] == "BTC price break edited"
    assert updated.json()["id"] == rule["id"]

    deleted = client.delete(f"/api/v1/alerts/rules/{rule['id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True, "id": rule["id"]}

    missing = client.get(f"/api/v1/alerts/rules/{rule['id']}")
    assert missing.status_code == 404


def test_alert_rule_validation_rejects_empty_expression(tmp_path: Path) -> None:
    client = _client(tmp_path / "alerts.json")
    payload = _rule_payload()
    payload["expression"] = {}

    response = client.post("/api/v1/alerts/rules", json=payload)

    assert response.status_code == 400
    assert "expression" in response.json()["detail"]


def test_alert_rule_changes_sync_runtime(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(alerts_router, prefix="/api/v1")
    app.state.alert_facade = AlertFacade(store_path=tmp_path / "alerts.json")
    app.state.alert_runtime = FakeAlertRuntime()
    client = TestClient(app)

    created = client.post("/api/v1/alerts/rules", json=_rule_payload())
    assert created.status_code == 200
    rule_id = created.json()["id"]

    patched = client.patch(f"/api/v1/alerts/rules/{rule_id}/enabled", json={"enabled": False})
    assert patched.status_code == 200

    deleted = client.delete(f"/api/v1/alerts/rules/{rule_id}")
    assert deleted.status_code == 200

    assert app.state.alert_runtime.synced == [rule_id, rule_id]
    assert app.state.alert_runtime.removed == [rule_id]


def test_alert_trigger_records_history_and_dispatch_outcomes(tmp_path: Path) -> None:
    client = _client(tmp_path / "alerts.json")
    rule = client.post("/api/v1/alerts/rules", json=_rule_payload()).json()

    triggered = client.post("/api/v1/alerts/events/triggered", json={
        "ruleId": rule["id"],
        "message": "BTCUSDT crossed above 68000",
        "values": {"close": 68123.4},
    })

    assert triggered.status_code == 200
    event = triggered.json()
    assert event["id"].startswith("alert-event-")
    assert event["ruleId"] == rule["id"]
    assert event["dispatch"][0]["type"] == "in_app"
    assert event["dispatch"][0]["status"] == "queued"
    assert event["dispatch"][1]["status"] == "skipped"

    history = client.get(f"/api/v1/alerts/history?rule_id={rule['id']}")
    assert history.status_code == 200
    assert history.json()[0]["message"] == "BTCUSDT crossed above 68000"

    refreshed = client.get(f"/api/v1/alerts/rules/{rule['id']}")
    assert refreshed.status_code == 200
    assert refreshed.json()["triggerCount"] == 1
    assert refreshed.json()["lastTriggeredAt"] == event["createdAt"]


def test_alert_evaluate_endpoint_returns_trace(tmp_path: Path) -> None:
    client = _client(tmp_path / "alerts.json")

    response = client.post("/api/v1/alerts/evaluate", json={
        "expression": {
            "op": "AND",
            "children": [
                {"left": "close", "comparator": "crossesAbove", "right": {"type": "number", "value": 100}},
                {"left": "rsi", "comparator": ">", "right": {"type": "number", "value": 70}},
            ],
        },
        "context": {
            "previous": {"close": 99, "rsi": 69},
            "values": {"close": 101, "rsi": 72},
        },
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["result"] is True
    assert payload["trace"]["children"][0]["status"] == "matched"
