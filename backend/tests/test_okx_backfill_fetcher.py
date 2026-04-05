from __future__ import annotations

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import BackfillTask
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import DataSource, RawMessage, StreamType, TransportRequest


class _FakeOkxTransport:
    def __init__(self, bars: list[list[str]], page_cap: int = 300) -> None:
        self._bars = list(bars)
        self._page_cap = page_cap
        self.requests: list[TransportRequest] = []

    async def http_fetch(self, req: TransportRequest) -> list[RawMessage]:
        self.requests.append(req)
        start_ms = req.start_ms if req.start_ms is not None else -1
        end_ms = req.end_ms if req.end_ms is not None else 2**63 - 1
        limit = min(int(req.limit or 1), self._page_cap)

        eligible = [
            row for row in self._bars
            if start_ms <= int(row[0]) <= end_ms
        ]
        eligible.sort(key=lambda row: int(row[0]), reverse=True)
        page = eligible[:limit]

        return [
            RawMessage(
                payload=row,
                source=DataSource.HTTP,
                stream_type=StreamType.KLINE,
                received_at_ms=end_ms,
                endpoint="https://www.okx.com",
            )
            for row in page
        ]


def _make_okx_rows(count: int, interval_ms: int) -> list[list[str]]:
    rows: list[list[str]] = []
    for idx in range(count):
        open_time = idx * interval_ms
        rows.append([
            str(open_time),
            "100",
            "110",
            "90",
            "105",
            "1.5",
            "157.5",
            "157.5",
            "1",
        ])
    return rows


def test_okx_backfill_paginates_past_exchange_page_cap() -> None:
    interval_ms = 60_000
    total_bars = 650
    rows = _make_okx_rows(total_bars, interval_ms)
    transport = _FakeOkxTransport(rows, page_cap=300)
    fetcher = HistoricalFetcher(
        BackfillConfig(
            fetch_batch_size=1000,
            fetch_rate_limit_delay=0,
            fetch_concurrency=1,
        ),
        transport,
        IngestionConfig(),
    )
    task = BackfillTask(
        symbol="BTC-USDT",
        interval="1m",
        start_ms=0,
        end_ms=(total_bars - 1) * interval_ms,
        estimated_bars=total_bars,
        exchange="okx",
        market_type="spot",
    )

    results = asyncio.run(fetcher.fetch([task]))

    assert len(results) == 1
    result = results[0]
    assert result.bars_count == total_bars
    assert len(transport.requests) == 3
    assert [bar.open_time for bar in result.bars] == [idx * interval_ms for idx in range(total_bars)]
