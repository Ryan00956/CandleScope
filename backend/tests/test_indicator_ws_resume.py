from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.api.v1.stream_indicators import _handle_indicator_subscribe
from app.data_engine.data_manager.models import BarData
from app.indicator import create_engine
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.series_revision import SeriesRevisionRegistry


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
        self.ensure_stream_calls: list[tuple[tuple, dict]] = []
        self.subscriptions: list[dict] = []

    async def ensure_stream(self, *args, **kwargs) -> None:
        self.ensure_stream_calls.append((args, kwargs))
        return None

    def query_latest(self, *args, **kwargs):
        self.query_calls += 1
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
            websocket=SimpleNamespace(),
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
            websocket=SimpleNamespace(),
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
