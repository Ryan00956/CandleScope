from __future__ import annotations

import asyncio
from types import SimpleNamespace

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

    async def ensure_stream(self, *args, **kwargs) -> None:
        return None

    def query_latest(self, *args, **kwargs):
        self.query_calls += 1
        return SimpleNamespace(bars=self.bars)


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
