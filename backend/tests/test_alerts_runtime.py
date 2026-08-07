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


class TransientEnsureFailureDataManager(FakeDataManager):
    def __init__(self) -> None:
        super().__init__()
        self.should_fail = True

    async def ensure_stream(self, symbol: str, interval: str, **kwargs) -> None:
        await super().ensure_stream(symbol, interval, **kwargs)
        if self.should_fail:
            raise RuntimeError("temporary stream failure")


class OrderedDataManager(FakeDataManager):
    def __init__(self, seed_bars: list[BarData] | None = None) -> None:
        super().__init__(seed_bars)
        self.call_order: list[str] = []

    def query_latest(self, *args, **kwargs):
        self.call_order.append("query_latest")
        return super().query_latest(*args, **kwargs)

    async def ensure_stream(self, symbol: str, interval: str, **kwargs) -> None:
        self.call_order.append("ensure_stream")
        await super().ensure_stream(symbol, interval, **kwargs)


class WarmupDataManager(FakeDataManager):
    def query_latest(self, *args, **kwargs):
        if self.seed_bars:
            return SimpleNamespace(bars=self.seed_bars, metadata={})
        return SimpleNamespace(
            bars=[],
            metadata={"backfill_request_ids": ["alert-warmup-request"]},
        )


class CompletingBackfillCoordinator:
    def __init__(self, data_manager: WarmupDataManager) -> None:
        self.data_manager = data_manager

    async def wait_for_request(self, request_id: str) -> dict:
        assert request_id == "alert-warmup-request"
        self.data_manager.seed_bars = [
            BarData(
                time=index,
                open=float(index),
                high=float(index),
                low=float(index),
                close=float(index),
                volume=1,
            )
            for index in range(1, 61)
        ]
        return {"status": "completed"}


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
        assert dm.subscriptions[0]["event_types"] == {
            DataEventType.BAR_CLOSED,
            DataEventType.BAR_AMENDED,
        }
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
        assert facade.get_rule(rule["id"])["enabled"] is False
        assert runtime.snapshot()["subscriptions"] == []

    asyncio.run(_run())


def test_alert_runtime_ensures_stream_before_querying_seed_history(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        facade.save_rule(_rule_payload())
        dm = OrderedDataManager()
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)

        await runtime.start()

        assert dm.call_order[:2] == ["ensure_stream", "query_latest"]
        await runtime.stop()

    asyncio.run(_run())


def test_alert_runtime_computes_indicator_values_from_seed_history(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        payload = _rule_payload(maxTriggers=1)
        payload["expression"] = {
            "left": "rsi",
            "comparator": ">",
            "right": {"type": "number", "value": 70},
        }
        rule = facade.save_rule(payload)
        seed = [
            BarData(
                time=index,
                open=float(index),
                high=float(index),
                low=float(index),
                close=float(index),
                volume=1,
            )
            for index in range(1, 61)
        ]
        dm = FakeDataManager(seed)
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)
        await runtime.start()

        emitted = await runtime.evaluate_event(rule["id"], _bar_event(61, timestamp_ms=61_000))

        assert emitted is not None
        assert emitted["values"]["rsi"] == 100
        assert emitted["values"]["ma20"] is not None
        assert emitted["values"]["macdHist"] is not None
        diagnostics = runtime.snapshot()["ruleDiagnostics"]
        # Auto-disable removes active runtime state after the one allowed trigger.
        assert diagnostics == {}

    asyncio.run(_run())


def test_alert_store_normalizes_post_trigger_behavior(tmp_path: Path) -> None:
    facade = AlertFacade(store_path=tmp_path / "alerts.json")

    keep = facade.save_rule(_rule_payload(afterTrigger="keep", maxTriggers=3))
    pause = facade.save_rule(_rule_payload(afterTrigger="pause", maxTriggers=None))

    assert keep["afterTrigger"] == "keep"
    assert keep["maxTriggers"] is None
    assert pause["afterTrigger"] == "pause"
    assert pause["maxTriggers"] == 1


def test_alert_rule_reenable_and_material_edit_rearm_lifecycle(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        payload = _rule_payload(maxTriggers=1, afterTrigger="auto_disable")
        payload["expression"] = {
            "left": "close",
            "comparator": ">",
            "right": {"type": "number", "value": 100},
        }
        rule = facade.save_rule(payload)
        emitted = await facade.emit_triggered({
            "ruleId": rule["id"],
            "message": "first lifecycle",
            "values": {"close": 101},
            "actions": rule["actions"],
        })
        assert emitted is not None
        exhausted = facade.get_rule(rule["id"])
        assert exhausted["enabled"] is False
        assert exhausted["triggerCount"] == 1

        rearmed = facade.set_enabled(rule["id"], True)
        assert rearmed["enabled"] is True
        assert rearmed["triggerCount"] == 0
        assert rearmed["lastTriggeredAt"] is None

        second = await facade.emit_triggered({
            "ruleId": rule["id"],
            "message": "second lifecycle",
            "values": {"close": 102},
            "actions": rule["actions"],
        })
        assert second is not None

        renamed = facade.save_rule({**facade.get_rule(rule["id"]), "name": "renamed"})
        assert renamed["triggerCount"] == 1
        changed = facade.save_rule({
            **renamed,
            "expression": {
                "left": "close",
                "comparator": ">",
                "right": {"type": "number", "value": 200},
            },
        })
        assert changed["triggerCount"] == 0
        assert changed["lastTriggeredAt"] is None

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


def test_alert_runtime_clears_transient_rule_error_after_resubscribe(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        rule = facade.save_rule(_rule_payload())
        dm = TransientEnsureFailureDataManager()
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)

        await runtime.start()
        assert runtime.snapshot()["status"] == "error"
        assert "temporary stream failure" in runtime.snapshot()["lastError"]

        dm.should_fail = False
        await runtime.sync_rule(rule)

        assert runtime.snapshot()["status"] == "running"
        assert runtime.snapshot()["lastError"] is None
        assert len(runtime.snapshot()["subscriptions"]) == 1

    asyncio.run(_run())


def test_alert_runtime_automatically_recovers_transient_subscription_failure(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        facade.save_rule(_rule_payload())
        dm = TransientEnsureFailureDataManager()
        runtime = AlertRuntimeEngine(
            facade=facade,
            data_manager=dm,
            reconcile_interval_seconds=0.01,
        )

        await runtime.start()
        assert runtime.snapshot()["status"] == "error"
        dm.should_fail = False
        for _ in range(20):
            if runtime.snapshot()["subscriptions"]:
                break
            await asyncio.sleep(0.01)

        assert runtime.snapshot()["status"] == "running"
        assert len(runtime.snapshot()["subscriptions"]) == 1
        await runtime.stop()

    asyncio.run(_run())


def test_alert_runtime_uses_amendments_only_to_maintain_frontier_state(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        rule = facade.save_rule(_rule_payload())
        dm = FakeDataManager([
            BarData(time=1, open=99, high=99, low=99, close=99, volume=1),
        ])
        runtime = AlertRuntimeEngine(facade=facade, data_manager=dm)
        await runtime.start()

        amended = DataEvent(
            event_type=DataEventType.BAR_AMENDED,
            key=SeriesKey("BTCUSDT", "1m"),
            bar=BarData(time=1, open=99, high=150, low=99, close=150, volume=1),
            timestamp_ms=2_000,
        )
        assert await runtime.evaluate_event(rule["id"], amended) is None
        assert facade.list_history(rule_id=rule["id"]) == []

        # The amended 150 close is now the frontier, so 151 is not a new
        # cross above 100 and must not manufacture a delayed alert.
        assert await runtime.evaluate_event(rule["id"], _bar_event(151, timestamp_ms=3_000)) is None
        assert facade.list_history(rule_id=rule["id"]) == []
        assert runtime.snapshot()["ruleDiagnostics"][rule["id"]]["lastEventType"] == "bar.closed"
        await runtime.stop()

    asyncio.run(_run())


def test_alert_runtime_reports_warming_then_ready_after_backfill(tmp_path: Path) -> None:
    async def _run() -> None:
        facade = AlertFacade(store_path=tmp_path / "alerts.json")
        payload = _rule_payload()
        payload["expression"] = {
            "left": "rsi",
            "comparator": ">",
            "right": {"type": "number", "value": 101},
        }
        rule = facade.save_rule(payload)
        dm = WarmupDataManager()
        coordinator = CompletingBackfillCoordinator(dm)
        runtime = AlertRuntimeEngine(
            facade=facade,
            data_manager=dm,
            backfill_coordinator=coordinator,
        )

        await runtime.start()
        initial_state = next(item for item in runtime.snapshot()["rules"] if item["ruleId"] == rule["id"])
        assert initial_state["state"] == "warming"

        for _ in range(20):
            state = next(item for item in runtime.snapshot()["rules"] if item["ruleId"] == rule["id"])
            if state["state"] == "ready":
                break
            await asyncio.sleep(0.01)

        assert state["state"] == "ready"
        assert state["historyBars"] == 60
        assert state["indicatorReady"]["rsi"] is True
        await runtime.stop()

    asyncio.run(_run())
