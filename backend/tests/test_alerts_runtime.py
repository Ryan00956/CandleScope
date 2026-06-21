from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from app.alerts.facade import AlertFacade
from app.alerts.runtime import AlertRuntimeEngine
from app.data_engine.data_manager.models import BarData, DataEvent, DataEventType, SeriesKey, SubscriptionHandle


class FakeDataManager:
    def __init__(self, seed_bars: list[BarData] | None = None) -> None:
        self.seed_bars = seed_bars or []
        self.subscriptions: list[dict] = []
        self.ensure_calls: list[dict] = []
        self.release_calls: list[dict] = []
        self.unsubscribed: list[str] = []

    def query_latest(self, *args, **kwargs):
        return SimpleNamespace(bars=self.seed_bars)

    def subscribe(self, **kwargs) -> SubscriptionHandle:
        handle = SubscriptionHandle()
        self.subscriptions.append({**kwargs, "handle": handle})
        return handle

    def unsubscribe(self, handle: SubscriptionHandle) -> None:
        self.unsubscribed.append(handle.id)

    async def ensure_stream(self, symbol: str, interval: str, **kwargs) -> None:
        self.ensure_calls.append({"symbol": symbol, "interval": interval, **kwargs})

    async def release_stream(self, symbol: str, interval: str, **kwargs) -> None:
        self.release_calls.append({"symbol": symbol, "interval": interval, **kwargs})


def _rule_payload(**overrides) -> dict:
    payload = {
        "name": "BTC break",
        "target": {
            "exchange": "binance",
            "marketType": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
        },
        "triggerOn": "bar_close",
        "expression": {
            "left": "close",
            "comparator": "crossesAbove",
            "right": {"type": "number", "value": 100},
        },
        "actions": [
            {
                "type": "in_app",
                "enabled": True,
                "config": {"template": "{{symbol}} {{interval}} close={{close}}"},
            },
        ],
        "cooldownMs": 0,
        "maxTriggers": 3,
    }
    payload.update(overrides)
    return payload


def _bar_event(close: float, *, timestamp_ms: int = 2_000) -> DataEvent:
    return DataEvent(
        event_type=DataEventType.BAR_CLOSED,
        key=SeriesKey("BTCUSDT", "1m"),
        bar=BarData(time=timestamp_ms // 1000, open=close, high=close, low=close, close=close, volume=1),
        timestamp_ms=timestamp_ms,
    )


def test_alert_runtime_subscribes_and_triggers_on_bar_event(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        rule = facade.save_rule(_rule_payload())
        dm = FakeDataManager([BarData(time=1, open=99, high=99, low=99, close=99, volume=1)])
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)

        await runtime.start()
        assert dm.subscriptions[0]["symbol"] == "BTCUSDT"
        assert dm.subscriptions[0]["event_types"] == {DataEventType.BAR_CLOSED}
        assert dm.ensure_calls[0]["consumer_id"] == f"alert:rule:{rule['id']}"

        emitted = await runtime.evaluate_event(rule["id"], _bar_event(101))

        assert emitted is not None
        assert emitted["message"] == "BTCUSDT 1m close=101"
        history = facade.list_history(rule_id=rule["id"])
        assert len(history) == 1
        assert history[0]["values"]["close"] == 101
        assert facade.get_rule(rule["id"])["triggerCount"] == 1

    asyncio.run(_run())


def test_alert_runtime_respects_max_triggers(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        payload = _rule_payload(maxTriggers=1)
        payload["expression"] = {
            "left": "close",
            "comparator": ">",
            "right": {"type": "number", "value": 100},
        }
        rule = facade.save_rule(payload)
        dm = FakeDataManager([BarData(time=1, open=99, high=99, low=99, close=99, volume=1)])
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)
        await runtime.start()

        first = await runtime.evaluate_event(rule["id"], _bar_event(101, timestamp_ms=2_000))
        second = await runtime.evaluate_event(rule["id"], _bar_event(102, timestamp_ms=3_000))

        assert first is not None
        assert second is None
        assert len(facade.list_history(rule_id=rule["id"])) == 1

    asyncio.run(_run())


def test_alert_runtime_resubscribes_when_trigger_event_type_changes(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        rule = facade.save_rule(_rule_payload())
        dm = FakeDataManager()
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)
        await runtime.start()

        updated = facade.save_rule({**rule, "triggerOn": "bar_update"})
        await runtime.sync_rule(updated)

        assert dm.unsubscribed
        assert dm.release_calls[0]["consumer_id"] == f"alert:rule:{rule['id']}"
        assert dm.subscriptions[-1]["event_types"] == {
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_CLOSED,
            DataEventType.BAR_AMENDED,
        }

    asyncio.run(_run())


def test_alert_runtime_releases_stream_when_rule_disabled(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        rule = facade.save_rule(_rule_payload())
        dm = FakeDataManager()
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)

        await runtime.start()
        disabled = facade.set_enabled(rule["id"], False)
        await runtime.sync_rule(disabled)

        assert dm.unsubscribed
        assert dm.release_calls[0]["consumer_id"] == f"alert:rule:{rule['id']}"
        assert runtime.snapshot()["subscriptions"] == []

    asyncio.run(_run())
