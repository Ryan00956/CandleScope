from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import sqlite3
import time
from pathlib import Path

import httpx
import pytest

import app.alerts.webhook as webhook_module
from app.alerts.facade import AlertFacade
from app.alerts.outbox import AlertOutboxStore, AlertOutboxWorker
from app.alerts.webhook import WebhookDeliveryResult, WebhookSender, WebhookSettings


def _settings(tmp_path: Path, **overrides) -> WebhookSettings:
    values = {
        "enabled": True,
        "secret": "test-signing-secret",
        "require_signature": True,
        "allow_http": False,
        "allow_private_network": False,
        "allowed_hosts": ("hooks.example.com", "internal.example.test"),
        "request_timeout_ms": 1_000,
        "max_attempts": 3,
        "base_retry_delay_ms": 100,
        "max_retry_delay_ms": 1_000,
        "poll_interval_ms": 100,
        "max_payload_bytes": 262_144,
        "retain_delivered": 100,
        "retain_dead_letter": 10,
        "outbox_path": tmp_path / "alerts-outbox.sqlite3",
    }
    values.update(overrides)
    return WebhookSettings(**values)


def _rule_payload(*, webhook_enabled: bool = True) -> dict:
    return {
        "name": "durable webhook",
        "target": {
            "exchange": "binance",
            "marketType": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
        },
        "triggerOn": "bar_update",
        "expression": {
            "left": "close",
            "comparator": ">",
            "right": {"type": "number", "value": 1},
        },
        "actions": [
            {
                "type": "webhook",
                "enabled": webhook_enabled,
                "config": {"url": "https://hooks.example.com/candlescope"},
            }
        ],
        "cooldownMs": 0,
        "maxTriggers": None,
        "afterTrigger": "keep",
    }


class SequenceSender:
    def __init__(self, results: list[WebhookDeliveryResult]) -> None:
        self.results = list(results)
        self.entries: list[dict] = []

    async def send(self, entry: dict) -> WebhookDeliveryResult:
        self.entries.append(entry)
        if not self.results:
            raise AssertionError("unexpected delivery attempt")
        return self.results.pop(0)


class BlockingSender:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def send(self, _entry: dict) -> WebhookDeliveryResult:
        self.started.set()
        await self.release.wait()
        return WebhookDeliveryResult(True, False, "http_204", 204)


def test_webhook_requires_explicit_ready_configuration(tmp_path: Path) -> None:
    disabled = AlertFacade(store_path=tmp_path / "disabled-alerts.json")
    assert "webhook" not in disabled.status()["registeredChannels"]
    with pytest.raises(ValueError, match="not available"):
        disabled.save_rule(_rule_payload())

    missing_secret = _settings(tmp_path, secret="")
    assert missing_secret.enabled is True
    assert missing_secret.ready is False
    assert missing_secret.configuration_error is not None


def test_webhook_settings_parse_explicit_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALERT_WEBHOOK_ENABLED", "1")
    monkeypatch.setenv("ALERT_WEBHOOK_SECRET", "0123456789abcdef")
    monkeypatch.setenv("ALERT_WEBHOOK_ALLOWED_HOSTS", "hooks.example.com, api.example.com ")
    monkeypatch.setenv("ALERT_WEBHOOK_MAX_ATTEMPTS", "999")

    settings = WebhookSettings.from_env()

    assert settings.ready is True
    assert settings.allowed_hosts == ("api.example.com", "hooks.example.com")
    assert settings.max_attempts == 20


def test_webhook_rule_validation_is_fail_closed(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    facade = AlertFacade(store_path=tmp_path / "alerts.json", webhook_settings=settings)
    assert "webhook" in facade.status()["registeredChannels"]

    invalid = _rule_payload()
    invalid["actions"][0]["config"]["url"] = "http://hooks.example.com/plaintext"
    with pytest.raises(ValueError, match="must use https"):
        facade.save_rule(invalid)

    credentialed = _rule_payload()
    credentialed["actions"][0]["config"]["url"] = "https://user:pass@hooks.example.com"
    with pytest.raises(ValueError, match="credentials"):
        facade.save_rule(credentialed)


def test_facade_persists_and_activates_webhook_before_delivery(tmp_path: Path) -> None:
    async def _run() -> None:
        settings = _settings(tmp_path)
        sender = SequenceSender([WebhookDeliveryResult(True, False, "http_204", 204)])
        facade = AlertFacade(
            store_path=tmp_path / "alerts.json",
            webhook_settings=settings,
            webhook_sender=sender,  # type: ignore[arg-type]
        )
        rule = facade.save_rule(_rule_payload())
        event = await facade.emit_triggered({
            "ruleId": rule["id"],
            "message": "price hit",
            "values": {"close": 2},
            "actions": rule["actions"],
        })

        assert event is not None
        assert event["dispatch"][0]["status"] == "queued"
        assert event["dispatch"][0]["durable"] is True
        assert facade.outbox_worker is not None
        queued = facade.outbox_worker.store.list_entries()
        assert queued[0]["status"] == "pending"
        assert queued[0]["payload"]["eventId"] == event["id"]

        processed = await facade.outbox_worker.run_once(now_ms=queued[0]["nextAttemptAt"])
        assert processed == 1
        delivered = facade.outbox_worker.store.list_entries()[0]
        assert delivered["status"] == "delivered"
        persisted = facade.list_history(rule_id=rule["id"])[0]
        assert persisted["dispatch"][0]["status"] == "delivered"
        assert persisted["dispatch"][0]["detail"] == "http_204"

    asyncio.run(_run())


def test_facade_worker_delivers_after_start_and_stops_cleanly(tmp_path: Path) -> None:
    async def _run() -> None:
        settings = _settings(tmp_path)
        facade = AlertFacade(
            store_path=tmp_path / "live-alerts.json",
            webhook_settings=settings,
            webhook_sender=SequenceSender([
                WebhookDeliveryResult(True, False, "http_202", 202),
            ]),  # type: ignore[arg-type]
        )
        await facade.start()
        try:
            rule = facade.save_rule(_rule_payload())
            await facade.emit_triggered({
                "ruleId": rule["id"],
                "message": "worker hit",
                "actions": rule["actions"],
            })
            for _ in range(100):
                if facade.status()["outbox"]["delivered"] == 1:
                    break
                await asyncio.sleep(0.01)
            assert facade.status()["outbox"]["delivered"] == 1
            assert facade.list_history(rule_id=rule["id"])[0]["dispatch"][0]["status"] == "delivered"
        finally:
            await facade.stop()
        assert facade.status()["outbox"]["running"] is False

    asyncio.run(_run())


def test_worker_stop_waits_for_inflight_delivery_and_receipt(tmp_path: Path) -> None:
    async def _run() -> None:
        settings = _settings(tmp_path)
        sender = BlockingSender()
        facade = AlertFacade(
            store_path=tmp_path / "graceful-alerts.json",
            webhook_settings=settings,
            webhook_sender=sender,  # type: ignore[arg-type]
        )
        await facade.start()
        rule = facade.save_rule(_rule_payload())
        await facade.emit_triggered({
            "ruleId": rule["id"],
            "message": "in flight",
            "actions": rule["actions"],
        })
        await asyncio.wait_for(sender.started.wait(), timeout=1)

        stop_task = asyncio.create_task(facade.stop())
        await asyncio.sleep(0)
        assert stop_task.done() is False
        sender.release.set()
        await asyncio.wait_for(stop_task, timeout=1)

        assert facade.get_rule(rule["id"]) is not None
        assert facade.list_history(rule_id=rule["id"])[0]["dispatch"][0]["status"] == "delivered"
        assert facade.status()["outbox"]["running"] is False

    asyncio.run(_run())


def test_outbox_recovers_claim_interrupted_by_restart(tmp_path: Path) -> None:
    store_path = tmp_path / "outbox.sqlite3"
    store = AlertOutboxStore(store_path)
    staged = store.stage(
        {"id": "event-1", "ruleId": "rule-1", "message": "hit"},
        {"type": "webhook", "config": {"url": "https://hooks.example.com/a"}},
    )
    store.activate_event("event-1")
    activated = store.list_entries()[0]
    claimed = store.claim_due(now_ms=activated["nextAttemptAt"])
    assert claimed is not None
    assert claimed["status"] == "processing"
    assert claimed["attempts"] == 1

    restarted = AlertOutboxStore(store_path)
    assert restarted.recover_incomplete() == 1
    recovered = restarted.claim_due(now_ms=int(time.time() * 1000) + 1_000)
    assert recovered is not None
    assert recovered["deliveryId"] == staged["deliveryId"]
    assert recovered["attempts"] == 2


def test_outbox_prunes_only_terminal_rows(tmp_path: Path) -> None:
    store = AlertOutboxStore(tmp_path / "bounded-outbox.sqlite3")
    deliveries: list[str] = []
    for index in range(6):
        entry = store.stage(
            {"id": f"event-{index}", "ruleId": "rule-1", "message": "hit"},
            {"type": "webhook", "config": {"url": "https://hooks.example.com/a"}},
        )
        deliveries.append(entry["deliveryId"])
    for delivery_id in deliveries[:4]:
        store.mark_delivered(delivery_id, "http_204")
    store.mark_dead_letter(deliveries[4], "http_400")

    removed = store.prune_terminal(retain_delivered=2, retain_dead_letter=0)
    snapshot = store.snapshot()

    assert removed == 3
    assert snapshot["delivered"] == 2
    assert snapshot["deadLetter"] == 0
    assert snapshot["staged"] == 1
    assert snapshot["totalDelivered"] == 4
    assert snapshot["totalDeadLetter"] == 1


def test_outbox_cumulative_metrics_are_idempotent_and_survive_reopen(tmp_path: Path) -> None:
    store_path = tmp_path / "metrics-outbox.sqlite3"
    store = AlertOutboxStore(store_path)
    entry = store.stage(
        {"id": "event-metrics", "ruleId": "rule-1", "message": "hit"},
        {"type": "webhook", "config": {"url": "https://hooks.example.com/a"}},
    )
    store.activate_event("event-metrics")
    claimed = store.claim_due(now_ms=entry["nextAttemptAt"] + 1_000)
    assert claimed is not None
    store.mark_retry(entry["deliveryId"], "http_503", entry["nextAttemptAt"] + 2_000)
    retried = store.claim_due(now_ms=entry["nextAttemptAt"] + 3_000)
    assert retried is not None
    store.mark_delivered(entry["deliveryId"], "http_204")
    store.mark_delivered(entry["deliveryId"], "duplicate completion")
    assert store.prune_terminal(retain_delivered=0, retain_dead_letter=0) == 1

    snapshot = AlertOutboxStore(store_path).snapshot()

    assert snapshot["delivered"] == 0
    assert snapshot["totalAttempts"] == 2
    assert snapshot["totalRetryScheduled"] == 1
    assert snapshot["totalDelivered"] == 1
    assert snapshot["totalDeadLetter"] == 0


def test_outbox_backfills_cumulative_metrics_when_upgrading_legacy_database(
    tmp_path: Path,
) -> None:
    store_path = tmp_path / "legacy-outbox.sqlite3"
    store = AlertOutboxStore(store_path)
    entry = store.stage(
        {"id": "legacy-event", "ruleId": "rule-1", "message": "hit"},
        {"type": "webhook", "config": {"url": "https://hooks.example.com/a"}},
    )
    store.activate_event("legacy-event")
    assert store.claim_due(now_ms=entry["nextAttemptAt"] + 1_000) is not None
    store.mark_delivered(entry["deliveryId"], "http_204")
    with sqlite3.connect(store_path) as connection:
        connection.execute("DROP TABLE alert_delivery_metrics")

    snapshot = AlertOutboxStore(store_path).snapshot()

    assert snapshot["totalAttempts"] == 1
    assert snapshot["totalDelivered"] == 1
    assert snapshot["totalRetryScheduled"] == 0
    assert snapshot["totalDeadLetter"] == 0


def test_retry_schedule_survives_worker_recreation(tmp_path: Path) -> None:
    async def _run() -> None:
        settings = _settings(tmp_path)
        facade = AlertFacade(
            store_path=tmp_path / "alerts.json",
            webhook_settings=settings,
            webhook_sender=SequenceSender([
                WebhookDeliveryResult(False, True, "http_503", 503),
            ]),  # type: ignore[arg-type]
        )
        rule = facade.save_rule(_rule_payload())
        await facade.emit_triggered({
            "ruleId": rule["id"],
            "message": "retry me",
            "actions": rule["actions"],
        })
        assert facade.outbox_worker is not None
        initial = facade.outbox_worker.store.list_entries()[0]
        await facade.outbox_worker.run_once(now_ms=initial["nextAttemptAt"])
        retrying = facade.outbox_worker.store.list_entries()[0]
        assert retrying["status"] == "retrying"
        assert retrying["attempts"] == 1

        replacement_sender = SequenceSender([
            WebhookDeliveryResult(True, False, "http_200", 200),
        ])
        replacement = AlertOutboxWorker(
            AlertOutboxStore(settings.outbox_path),  # type: ignore[arg-type]
            replacement_sender,
            settings,
            receipt_callback=facade.record_dispatch_receipt,
        )
        await replacement.run_once(now_ms=retrying["nextAttemptAt"])
        delivered = replacement.store.list_entries()[0]
        assert delivered["status"] == "delivered"
        assert delivered["attempts"] == 2
        assert facade.list_history(rule_id=rule["id"])[0]["dispatch"][0]["status"] == "delivered"

    asyncio.run(_run())


@pytest.mark.parametrize(
    "failure,expected",
    [
        (ValueError("not allowed"), "dead_letter"),
        (RuntimeError("sender down"), "retrying"),
    ],
)
def test_sender_exception_leaves_claim_retryable_or_terminal(
    tmp_path: Path, failure, expected
) -> None:
    class FailingSender:
        async def send(self, entry):
            raise failure

    async def run():
        settings = _settings(tmp_path)
        store = AlertOutboxStore(settings.outbox_path)
        store.stage(
            {"id": "event-failure", "ruleId": "rule-1"},
            {"type": "webhook", "config": {"url": "https://hooks.example.com/a"}},
        )
        store.activate_event("event-failure")
        worker = AlertOutboxWorker(store, FailingSender(), settings)
        for attempt in range(1, 4):
            entry = store.list_entries()[0]
            await worker.run_once(now_ms=entry["nextAttemptAt"])
            updated = store.list_entries()[0]
            assert updated["attempts"] == attempt
            assert updated["status"] == (expected if attempt < 3 else "dead_letter")
            if updated["status"] == "dead_letter":
                break

    asyncio.run(run())


def test_terminal_outbox_state_waits_for_history_receipt(tmp_path: Path) -> None:
    async def _run() -> None:
        settings = _settings(tmp_path)
        store = AlertOutboxStore(tmp_path / "receipt-order.sqlite3")
        staged = store.stage(
            {"id": "event-receipt", "ruleId": "rule-1", "message": "hit"},
            {"type": "webhook", "config": {"url": "https://hooks.example.com/a"}},
        )
        store.activate_event("event-receipt")

        def broken_receipt(*_args, **_kwargs):
            raise OSError("injected history write failure")

        worker = AlertOutboxWorker(
            store,
            SequenceSender([WebhookDeliveryResult(True, False, "http_204", 204)]),
            settings,
            receipt_callback=broken_receipt,
        )
        with pytest.raises(OSError, match="history write failure"):
            await worker.run_once(now_ms=staged["nextAttemptAt"] + 1_000)

        interrupted = store.list_entries()[0]
        assert interrupted["status"] == "processing"
        assert interrupted["attempts"] == 1
        assert store.recover_incomplete() == 1
        assert store.list_entries()[0]["status"] == "pending"

    asyncio.run(_run())


def test_webhook_sender_signs_canonical_payload_and_does_not_follow_redirects(tmp_path: Path) -> None:
    async def _run() -> None:
        captured: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured.append(request)
            return httpx.Response(204)

        async def resolver(_host: str, _port: int) -> list[str]:
            return ["93.184.216.34"]

        settings = _settings(tmp_path)
        sender = WebhookSender(
            settings,
            resolver=resolver,
            transport=httpx.MockTransport(handler),
        )
        entry = {
            "deliveryId": "delivery-1",
            "destination": "https://hooks.example.com/candlescope",
            "payload": {"schemaVersion": 1, "eventId": "event-1", "message": "命中"},
        }
        result = await sender.send(entry)

        assert result.delivered is True
        assert len(captured) == 1
        request = captured[0]
        timestamp = request.headers["X-CandleScope-Timestamp"]
        expected = hmac.new(
            settings.secret.encode("utf-8"),
            timestamp.encode("ascii") + b"." + request.content,
            hashlib.sha256,
        ).hexdigest()
        assert request.headers["X-CandleScope-Delivery"] == "delivery-1"
        assert request.headers["X-CandleScope-Signature"] == f"sha256={expected}"
        assert json.loads(request.content)["message"] == "命中"

    asyncio.run(_run())


def test_webhook_sender_rejects_private_resolution_before_http(tmp_path: Path) -> None:
    async def _run() -> None:
        called = False

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal called
            called = True
            return httpx.Response(204)

        async def resolver(_host: str, _port: int) -> list[str]:
            return ["127.0.0.1"]

        sender = WebhookSender(
            _settings(tmp_path),
            resolver=resolver,
            transport=httpx.MockTransport(handler),
        )
        result = await sender.send({
            "deliveryId": "delivery-private",
            "destination": "https://internal.example.test/hook",
            "payload": {},
        })

        assert result.delivered is False
        assert result.retryable is False
        assert result.detail == "destination_not_public"
        assert called is False

    asyncio.run(_run())


def test_pinned_webhook_transport_preserves_retry_after(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run() -> None:
        async def resolver(_host: str, _port: int) -> list[str]:
            return ["93.184.216.34"]

        monkeypatch.setattr(
            webhook_module,
            "_pinned_post",
            lambda *_args: (429, {"retry-after": "7"}),
        )
        sender = WebhookSender(_settings(tmp_path), resolver=resolver)
        result = await sender.send({
            "deliveryId": "delivery-retry-after",
            "destination": "https://hooks.example.com/candlescope",
            "payload": {},
        })

        assert result.delivered is False
        assert result.retryable is True
        assert result.status_code == 429
        assert result.retry_after_ms == 7_000

    asyncio.run(_run())
