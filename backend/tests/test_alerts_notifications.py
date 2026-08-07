from __future__ import annotations

import asyncio
from pathlib import Path

from app.alerts.facade import AlertFacade
from app.alerts.notifications import AlertNotificationBroker, BrowserOwnedAlertChannel


def test_browser_owned_channel_publishes_to_active_subscriber() -> None:
    async def _run() -> None:
        broker = AlertNotificationBroker(queue_size=2)
        subscription = broker.subscribe()
        channel = BrowserOwnedAlertChannel("in_app", broker)

        outcome = await channel.dispatch(
            {
                "id": "event-1",
                "ruleId": "rule-1",
                "message": "hit",
                "target": {"symbol": "BTCUSDT"},
                "values": {"close": 1},
                "createdAt": 1,
            },
            {"type": "in_app", "enabled": True, "config": {}},
        )
        await asyncio.sleep(0)
        delivered = subscription.queue.get_nowait()

        assert outcome["status"] == "published"
        assert outcome["subscriberCount"] == 1
        assert delivered["dispatchId"] == outcome["dispatchId"]
        assert delivered["action"]["type"] == "in_app"
        broker.unsubscribe(subscription)
        assert broker.snapshot()["subscribers"] == 0

    asyncio.run(_run())


def test_notification_broker_is_bounded_and_reports_drops() -> None:
    broker = AlertNotificationBroker(queue_size=1)
    subscription = broker.subscribe()

    broker.publish({"dispatchId": "first"})
    broker.publish({"dispatchId": "second"})

    assert subscription.queue.qsize() == 1
    assert subscription.queue.get_nowait()["dispatchId"] == "second"
    assert broker.snapshot()["dropped"] == 1


def test_facade_persists_dispatch_before_client_receives_event(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        rule = facade.save_rule({
            "name": "probe",
            "target": {
                "exchange": "binance",
                "marketType": "spot",
                "symbol": "BTCUSDT",
                "interval": "1m",
            },
            "expression": {
                "left": "close",
                "comparator": ">",
                "right": {"type": "number", "value": 1},
            },
            "actions": [{"type": "in_app", "enabled": True, "config": {}}],
            "maxTriggers": 1,
        })
        subscription = facade.notification_broker.subscribe()

        event = await facade.emit_triggered({
            "ruleId": rule["id"],
            "message": "hit",
            "values": {"close": 2},
        })
        await asyncio.sleep(0)
        notification = subscription.queue.get_nowait()
        persisted = facade.list_history(rule_id=rule["id"])[0]

        assert event is not None
        assert persisted["dispatch"][0]["dispatchId"] == notification["dispatchId"]
        assert persisted["dispatch"][0]["status"] == "published"

    asyncio.run(_run())
