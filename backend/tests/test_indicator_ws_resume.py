from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import pytest

from app.api.v1.stream_indicator_payloads import store_indicator_seed_cache
from app.api.v1.stream_indicators import (
    _handle_indicator_subscribe,
    _queue_indicator_critical_message,
    _queue_indicator_message,
)
from app.data_engine.data_manager.models import BarData
from app.indicator import create_engine
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.series_revision import SeriesRevisionRegistry
from app.core import config


def _bars(count: int = 100) -> list[BarData]:
    return [
        BarData(
            time=1_700_000_000 + index * 60,
            open=100 + index,
            high=101 + index,
            low=99 + index,
            close=100 + index,
            volume=10 + index,
        )
        for index in range(count)
    ]


class _DataManager:
    def __init__(self, bars: list[BarData]) -> None:
        self.bars = bars
        self.query_calls = 0
        self.query_kwargs: list[dict] = []
        self.ensure_stream_calls: list[tuple[tuple, dict]] = []
        self.subscriptions: list[dict] = []

    async def ensure_stream(self, *args, **kwargs) -> None:
        self.ensure_stream_calls.append((args, kwargs))
        return None

    def query_latest(self, *args, **kwargs):
        self.query_calls += 1
        self.query_kwargs.append(dict(kwargs))
        return SimpleNamespace(bars=self.bars)

    def subscribe(self, **kwargs):
        self.subscriptions.append(kwargs)
        return f"handle-{len(self.subscriptions)}"

    def unsubscribe(self, _handle) -> None:
        return None


class _ScriptRuntimeService:
    """Minimal routed sidecar boundary; these tests exercise stream setup only."""

    async def start(self) -> None:
        return None

    def route_for(self, language: str) -> SimpleNamespace:
        assert language == "pyne"
        return SimpleNamespace(mode="sidecar", runtime_id="test.pyne")


@pytest.mark.parametrize(
    ("requested", "canonical"),
    [
        ("45m", "45m"),
        ("47m", "47m"),
        ("60m", "1h"),
        ("1M", "1M"),
    ],
)
@pytest.mark.parametrize("kind", ["builtin", "script"])
def test_indicator_ws_canonicalizes_custom_intervals_before_subscription(
    requested: str,
    canonical: str,
    kind: str,
) -> None:
    async def _run() -> None:
        dm = _DataManager(_bars())
        engine = create_engine()
        subscribed = {}
        client_meta = {}
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        message = {
            "action": "subscribe",
            "clientId": f"{kind}-{requested}",
            "kind": kind,
            "symbol": "BTCUSDT",
            "interval": requested,
            "historyLimit": 100,
        }
        if kind == "builtin":
            message["name"] = "VOL"
        else:
            message["script"] = 'plot(close, title="Close")'

        await _handle_indicator_subscribe(
            websocket=SimpleNamespace(headers={}),
            dm=dm,
            indicator_engine=engine,
            subscribed=subscribed,
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta=client_meta,
            seed_query_cache={},
            send_json=send_json,
            msg=message,
            runtime_service=_ScriptRuntimeService(),
        )

        acknowledgement = next(
            item for item in sent if item["type"] == "indicator.subscribed"
        )
        assert acknowledgement["subscriptionStatus"] == "accepted"
        assert acknowledgement["requestedInterval"] == requested
        assert acknowledgement["canonicalInterval"] == canonical
        assert acknowledgement["interval"] == canonical
        assert dm.ensure_stream_calls[0][0][1] == canonical
        assert client_meta[message["clientId"]]["interval"] == canonical
        if kind == "builtin":
            assert next(iter(subscribed.values())).interval == canonical
        else:
            assert dm.subscriptions[0]["interval"] == canonical

    asyncio.run(_run())


@pytest.mark.parametrize("kind", ["builtin", "script"])
def test_indicator_ws_stream_failure_is_a_terminal_failed_ack(kind: str) -> None:
    class _FailingDataManager(_DataManager):
        async def ensure_stream(self, *args, **kwargs) -> None:
            self.ensure_stream_calls.append((args, kwargs))
            raise RuntimeError("stream start failed")

    async def _run() -> None:
        dm = _FailingDataManager(_bars())
        sent: list[dict] = []
        subscribed = {}
        client_meta = {}

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        message = {
            "action": "subscribe",
            "clientId": f"failed-{kind}",
            "kind": kind,
            "symbol": "BTCUSDT",
            "interval": "60m",
        }
        if kind == "builtin":
            message["name"] = "VOL"
        else:
            message["script"] = 'plot(close, title="Close")'

        await _handle_indicator_subscribe(
            websocket=SimpleNamespace(headers={}),
            dm=dm,
            indicator_engine=create_engine(),
            subscribed=subscribed,
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta=client_meta,
            seed_query_cache={},
            send_json=send_json,
            msg=message,
            runtime_service=_ScriptRuntimeService(),
        )

        assert len(sent) == 1
        acknowledgement = sent[0]
        assert acknowledgement["type"] == "indicator.subscribed"
        assert acknowledgement["ok"] is False
        assert acknowledgement["subscriptionStatus"] == "failed"
        assert acknowledgement["realtimeStatus"] == "unavailable"
        assert acknowledgement["requestedInterval"] == "60m"
        assert acknowledgement["canonicalInterval"] == "1h"
        assert (
            acknowledgement["failure"]["code"] == "INDICATOR_STREAM_SUBSCRIPTION_FAILED"
        )
        assert subscribed == {}
        assert client_meta == {}

    asyncio.run(_run())


def test_builtin_subscribe_coalesces_seed_query_and_sends_small_resume_patch():
    async def _run() -> None:
        bars = _bars()
        dm = _DataManager(bars)
        engine = create_engine()
        revisions = SeriesRevisionRegistry(server_epoch="server-a")
        service = IndicatorRangeResultService(revision_registry=revisions)
        service.bind_engine(engine)
        subscribed = {}
        client_meta = {}
        seed_query_cache = {}
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        common = {
            "websocket": SimpleNamespace(),
            "dm": dm,
            "indicator_engine": engine,
            "subscribed": subscribed,
            "custom_handles": {},
            "custom_tasks": {},
            "queue": asyncio.Queue(),
            "client_meta": client_meta,
            "seed_query_cache": seed_query_cache,
            "send_json": send_json,
        }
        await _handle_indicator_subscribe(
            **common,
            msg={
                "action": "subscribe",
                "clientId": "vol",
                "name": "VOL",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 100,
            },
        )
        await _handle_indicator_subscribe(
            **common,
            msg={
                "action": "subscribe",
                "clientId": "boll",
                "name": "BOLL",
                "params": {"period": 20},
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 100,
                "resumeFrom": bars[-4].time,
                "serverEpoch": "server-a",
                "correctionRevision": 0,
            },
        )

        assert dm.query_calls == 1
        assert dm.query_kwargs[0]["auto_backfill"] is False
        first_ack = next(item for item in sent if item.get("clientId") == "vol")
        second_messages = [item for item in sent if item.get("clientId") == "boll"]
        assert first_ack["resumeStatus"] == "history_required"
        assert second_messages[0]["type"] == "indicator.subscribed"
        assert second_messages[0]["resumeStatus"] == "patch"
        assert second_messages[1]["type"] == "indicator.patch"
        assert second_messages[1]["range"] == {
            "start": bars[-3].time,
            "end": bars[-1].time,
        }

    asyncio.run(_run())


def test_indicator_critical_queue_evicts_preview_and_preserves_final_fifo() -> None:
    async def _run() -> None:
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=1)
        _queue_indicator_message(queue, {
            "type": "indicator.patch",
            "reason": "bar_update",
            "clientId": "preview",
        })
        await _queue_indicator_critical_message(queue, {
            "type": "indicator.update",
            "clientId": "final-1",
        })
        assert (await queue.get())["clientId"] == "final-1"

        queue.put_nowait({
            "type": "indicator.update",
            "clientId": "final-2",
        })
        pending = asyncio.create_task(
            _queue_indicator_critical_message(queue, {
                "type": "indicator.recomputed",
                "clientId": "final-3",
            })
        )
        await asyncio.sleep(0)
        assert not pending.done()
        assert (await queue.get())["clientId"] == "final-2"
        await asyncio.wait_for(pending, timeout=1)
        assert (await queue.get())["clientId"] == "final-3"

    asyncio.run(_run())


def test_indicator_seed_cache_is_bounded_lru() -> None:
    cache: dict = {}
    cap = max(1, int(config.INDICATOR_WS_MAX_SUBSCRIPTIONS))
    for index in range(cap + 5):
        key = ("binance", "spot", "BTCUSDT", f"{index + 2}m", 500)
        store_indicator_seed_cache(cache, key, {
            "at": 10**12,
            "result": SimpleNamespace(bars=[]),
            "correctionRevision": "0",
            "closedThrough": 0,
        })

    assert len(cache) == cap
    assert ("binance", "spot", "BTCUSDT", "2m", 500) not in cache
    assert ("binance", "spot", "BTCUSDT", f"{cap + 6}m", 500) in cache


def test_builtin_unsubscribe_clears_seed_cache_before_fast_reopen() -> None:
    async def _run() -> None:
        closed = _bars(5)
        forming = BarData(
            time=closed[-1].time + 60,
            open=200,
            high=202,
            low=198,
            close=201,
            volume=20,
            is_closed=False,
        )
        dm = _DataManager(closed + [forming])
        engine = create_engine()
        subscribed: dict[str, object] = {}
        client_meta: dict[str, dict] = {}
        seed_cache: dict = {}
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        kwargs = dict(
            websocket=SimpleNamespace(),
            dm=dm,
            indicator_engine=engine,
            subscribed=subscribed,
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta=client_meta,
            seed_query_cache=seed_cache,
            send_json=send_json,
            msg={
                "action": "subscribe",
                "clientId": "fast-switch",
                "kind": "builtin",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 5,
                "name": "VOL",
            },
        )
        await _handle_indicator_subscribe(**kwargs)
        assert dm.query_calls == 1
        assert dm.query_kwargs[-1]["limit"] == 6
        assert seed_cache

        dm.bars[-1] = BarData(
            time=forming.time,
            open=forming.open,
            high=forming.high,
            low=forming.low,
            close=205,
            volume=25,
            is_closed=True,
        )
        await _handle_indicator_subscribe(**kwargs)

        assert dm.query_calls == 2
        key = subscribed["fast-switch"]
        result = engine.get_result(key)
        assert result is not None
        assert max(
            point.timestamp
            for output in result.outputs.values()
            for point in output.data
        ) == forming.time

    asyncio.run(_run())


def test_builtin_seed_retries_when_correction_lands_during_query() -> None:
    async def _run() -> None:
        stale_bars = _bars(3)
        fresh_bars = [
            BarData(
                time=bar.time,
                open=bar.open,
                high=bar.high,
                low=bar.low,
                close=bar.close,
                volume=1_000 + index,
            )
            for index, bar in enumerate(stale_bars)
        ]
        engine = create_engine()
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="seed-race")
        )
        service.bind_engine(engine)

        class RacingDataManager(_DataManager):
            def query_latest(self, *args, **kwargs):
                self.query_calls += 1
                self.query_kwargs.append(dict(kwargs))
                if self.query_calls == 1:
                    service.note_correction(
                        series_key="binance:spot:BTCUSDT:1m",
                        start=stale_bars[0].time,
                        end=stale_bars[-1].time,
                        event_id="seed-race-1",
                    )
                    return SimpleNamespace(bars=stale_bars)
                return SimpleNamespace(bars=fresh_bars)

        dm = RacingDataManager(stale_bars)
        subscribed = {}
        client_meta = {}
        seed_query_cache = {}
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        await _handle_indicator_subscribe(
            websocket=SimpleNamespace(),
            dm=dm,
            indicator_engine=engine,
            subscribed=subscribed,
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta=client_meta,
            seed_query_cache=seed_query_cache,
            send_json=send_json,
            msg={
                "action": "subscribe",
                "clientId": "vol-race",
                "name": "VOL",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 100,
            },
        )

        acknowledgement = sent[0]
        assert acknowledgement["ok"] is True
        assert acknowledgement["dataRevision"]["correctionRevision"] == 1
        assert dm.query_calls == 2
        assert all(
            kwargs["auto_backfill"] is False for kwargs in dm.query_kwargs
        )
        key = subscribed["vol-race"]
        result = engine.get_result(key)
        assert result is not None
        assert result.outputs["vol"].data[-1].value == fresh_bars[-1].volume
        cached = next(iter(seed_query_cache.values()))
        assert cached["correctionRevision"] == "1"

    asyncio.run(_run())


def test_builtin_seed_fails_closed_when_revision_never_stabilizes() -> None:
    async def _run() -> None:
        bars = _bars(3)
        engine = create_engine()
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="seed-race")
        )
        service.bind_engine(engine)

        class AlwaysRacingDataManager(_DataManager):
            def query_latest(self, *args, **kwargs):
                self.query_calls += 1
                self.query_kwargs.append(dict(kwargs))
                service.note_correction(
                    series_key="binance:spot:BTCUSDT:1m",
                    start=bars[0].time,
                    end=bars[-1].time,
                    event_id=f"seed-race-{self.query_calls}",
                )
                return SimpleNamespace(bars=bars)

        dm = AlwaysRacingDataManager(bars)
        subscribed = {}
        client_meta = {}
        seed_query_cache = {}
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        await _handle_indicator_subscribe(
            websocket=SimpleNamespace(),
            dm=dm,
            indicator_engine=engine,
            subscribed=subscribed,
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta=client_meta,
            seed_query_cache=seed_query_cache,
            send_json=send_json,
            msg={
                "action": "subscribe",
                "clientId": "vol-race",
                "name": "VOL",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 100,
            },
        )

        assert dm.query_calls == 2
        assert sent[0]["ok"] is False
        assert sent[0]["subscriptionStatus"] == "failed"
        assert subscribed == {}
        assert client_meta == {}
        assert seed_query_cache == {}
        assert engine.list_instances() == []

    asyncio.run(_run())


def test_builtin_seed_retries_when_closed_bar_lands_during_query() -> None:
    async def _run() -> None:
        stale_bars = _bars(3)
        new_bar = BarData(
            time=stale_bars[-1].time + 60,
            open=200,
            high=201,
            low=199,
            close=200,
            volume=999,
        )
        fresh_bars = [*stale_bars, new_bar]
        engine = create_engine()
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="closed-race")
        )
        service.bind_engine(engine)

        class ClosedRaceDataManager(_DataManager):
            def query_latest(self, *args, **kwargs):
                self.query_calls += 1
                self.query_kwargs.append(dict(kwargs))
                if self.query_calls == 1:
                    service.note_closed(
                        series_key="binance:spot:BTCUSDT:1m",
                        closed_through=new_bar.time,
                    )
                    return SimpleNamespace(bars=stale_bars)
                return SimpleNamespace(bars=fresh_bars)

        dm = ClosedRaceDataManager(stale_bars)
        subscribed = {}
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        await _handle_indicator_subscribe(
            websocket=SimpleNamespace(),
            dm=dm,
            indicator_engine=engine,
            subscribed=subscribed,
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta={},
            seed_query_cache={},
            send_json=send_json,
            msg={
                "action": "subscribe",
                "clientId": "vol-closed-race",
                "name": "VOL",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 100,
            },
        )

        assert dm.query_calls == 2
        assert sent[0]["dataRevision"]["closedThrough"] == new_bar.time
        result = engine.get_result(subscribed["vol-closed-race"])
        assert result is not None
        assert result.outputs["vol"].data[-1].timestamp == new_bar.time

    asyncio.run(_run())


def test_builtin_seed_storage_query_does_not_block_event_loop() -> None:
    async def _run() -> None:
        query_started = threading.Event()
        release_query = threading.Event()

        class BlockingDataManager(_DataManager):
            def query_latest(self, *args, **kwargs):
                self.query_calls += 1
                self.query_kwargs.append(dict(kwargs))
                query_started.set()
                release_query.wait(timeout=1.0)
                return SimpleNamespace(bars=self.bars)

        dm = BlockingDataManager(_bars(3))
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        fallback_release = threading.Timer(1.0, release_query.set)
        fallback_release.start()
        loop = asyncio.get_running_loop()
        started_at = loop.time()
        task = asyncio.create_task(_handle_indicator_subscribe(
            websocket=SimpleNamespace(),
            dm=dm,
            indicator_engine=create_engine(),
            subscribed={},
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta={},
            seed_query_cache={},
            send_json=send_json,
            msg={
                "action": "subscribe",
                "clientId": "vol-nonblocking",
                "name": "VOL",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 100,
            },
        ))
        try:
            while not query_started.is_set():
                await asyncio.sleep(0)
            assert loop.time() - started_at < 0.3
            await asyncio.sleep(0.01)
            assert task.done() is False
            release_query.set()
            await task
        finally:
            release_query.set()
            fallback_release.cancel()

        assert sent[0]["ok"] is True

    asyncio.run(_run())


def test_builtin_subscribe_replays_forming_preview_after_acknowledgement():
    async def _run() -> None:
        closed_bars = _bars(3)
        forming_bar = BarData(
            time=closed_bars[-1].time + 60,
            open=closed_bars[-1].close,
            high=closed_bars[-1].close + 5,
            low=closed_bars[-1].close - 2,
            close=closed_bars[-1].close + 3,
            volume=987.5,
            is_closed=False,
        )
        dm = _DataManager([*closed_bars, forming_bar])
        engine = create_engine()
        sent: list[dict] = []

        async def send_json(payload: dict) -> bool:
            sent.append(payload)
            return True

        await _handle_indicator_subscribe(
            websocket=SimpleNamespace(),
            dm=dm,
            indicator_engine=engine,
            subscribed={},
            custom_handles={},
            custom_tasks={},
            queue=asyncio.Queue(),
            client_meta={},
            seed_query_cache={},
            send_json=send_json,
            msg={
                "action": "subscribe",
                "clientId": "vol",
                "name": "VOL",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "historyLimit": 100,
            },
        )

        assert [item["type"] for item in sent] == [
            "indicator.subscribed",
            "indicator.preview",
        ]
        preview = sent[1]
        assert preview["barTime"] == forming_bar.time
        assert preview["bar"]["is_closed"] is False
        assert preview["values"] == {"vol": forming_bar.volume}

        key = engine.list_instances(symbol="BTCUSDT", interval="1m")[0]
        # Preview remains non-committing: reconnecting/receiving a close event
        # cannot duplicate the forming point in durable indicator history.
        result = engine.get_result(key)
        assert result is not None
        assert result.outputs["vol"].data[-1].timestamp == closed_bars[-1].time

    asyncio.run(_run())
