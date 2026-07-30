from __future__ import annotations

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.data_engine.backfill import BackfillEngine
from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import (
    BackfillStatus,
    BackfillTask,
    GapInfo,
    GapType,
)
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import DataSource, RawMessage, StreamType, TransportRequest


class _FakeBinanceTransport:
    def __init__(self, bars: list[list[object]], page_cap: int = 1_000) -> None:
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
        eligible.sort(key=lambda row: int(row[0]))
        return [
            RawMessage(
                payload=row,
                source=DataSource.HTTP,
                stream_type=StreamType.KLINE,
                received_at_ms=end_ms,
                endpoint="https://api.binance.com",
            )
            for row in eligible[:limit]
        ]


def _make_binance_rows(count: int, interval_ms: int) -> list[list[object]]:
    return [
        [
            idx * interval_ms,
            "100",
            "110",
            "90",
            "105",
            "1.5",
            (idx + 1) * interval_ms - 1,
            "157.5",
            10,
            "0.75",
            "78.75",
            "0",
        ]
        for idx in range(count)
    ]


def test_binance_backfill_advances_start_time_past_first_page() -> None:
    interval_ms = 60_000
    total_bars = 2_050
    transport = _FakeBinanceTransport(
        _make_binance_rows(total_bars, interval_ms),
        page_cap=1_000,
    )
    fetcher = HistoricalFetcher(
        BackfillConfig(
            fetch_batch_size=1_000,
            fetch_rate_limit_delay=0,
            fetch_concurrency=1,
        ),
        transport,
        IngestionConfig(),
    )
    task = BackfillTask(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=0,
        end_ms=(total_bars - 1) * interval_ms,
        estimated_bars=total_bars,
        exchange="binance",
        market_type="spot",
    )

    results = asyncio.run(fetcher.fetch([task]))

    assert len(results) == 1
    assert results[0].bars_count == total_bars
    assert len(transport.requests) == 3
    assert [request.start_ms for request in transport.requests] == [
        0,
        999 * interval_ms + 1,
        1_999 * interval_ms + 1,
    ]
    assert [bar.open_time for bar in results[0].bars] == [
        idx * interval_ms for idx in range(total_bars)
    ]


def test_91m_engine_fetches_page_bounded_components_and_persists_target() -> None:
    class _Detector:
        async def detect(self, **kwargs):
            assert kwargs["intervals"] == ["91m"]
            return [GapInfo(
                symbol="BTCUSDT",
                interval="91m",
                gap_type=GapType.INTERIOR,
                start_ms=0,
                end_ms=14 * 91 * 60_000,
                missing_bars=15,
                exchange="binance",
                market_type="spot",
            )]

    class _MemoryStorage:
        def __init__(self) -> None:
            self.rows: dict[tuple[str, str, str, str], dict[int, dict]] = {}

        async def get_existing_open_times(
            self,
            symbol,
            interval,
            start_ms,
            end_ms,
            *,
            exchange,
            market_type,
        ):
            series = self.rows.get(
                (exchange, market_type, symbol, interval),
                {},
            )
            return {
                open_time for open_time in series
                if start_ms <= open_time <= end_ms
            }

        async def upsert_bars(
            self,
            symbol,
            interval,
            rows,
            *,
            source,
            exchange,
            market_type,
        ):
            series = self.rows.setdefault(
                (exchange, market_type, symbol, interval),
                {},
            )
            for row in rows:
                stored = dict(row)
                stored["source"] = source
                series[int(stored["open_time"])] = stored
            return len(rows)

    async def _run() -> None:
        interval_ms = 60_000
        component_count = 15 * 91
        transport = _FakeBinanceTransport(
            _make_binance_rows(component_count, interval_ms),
        )
        storage = _MemoryStorage()
        engine = BackfillEngine(
            config=BackfillConfig(
                fetch_batch_size=1_000,
                fetch_rate_limit_delay=0,
                fetch_concurrency=1,
                reconcile_generate_custom=True,
                reconcile_enable_cache_push=False,
                publish_mode="log",
            ),
            storage=storage,
            transport=transport,
            ingestion_config=IngestionConfig(),
        )
        engine._detector = _Detector()

        async def _no_rate_limit() -> None:
            return None

        engine.fetcher.set_rate_limiter(_no_rate_limit)
        report = await engine.run(
            symbol="BTCUSDT",
            intervals=["91m"],
            range_start_ms=0,
            range_end_ms=14 * 91 * interval_ms,
            exchange="binance",
            market_type="spot",
        )

        one_minute = storage.rows[
            ("binance", "spot", "BTCUSDT", "1m")
        ]
        ninety_one_minute = storage.rows[
            ("binance", "spot", "BTCUSDT", "91m")
        ]
        assert report.status is BackfillStatus.COMPLETED
        assert report.plan is not None
        assert [task.estimated_bars for task in report.plan.tasks] == [1_000, 365]
        assert len(transport.requests) == 2
        assert [request.start_ms for request in transport.requests] == [
            0,
            1_000 * interval_ms,
        ]
        assert len(one_minute) == component_count
        assert len(ninety_one_minute) == 15
        assert sorted(ninety_one_minute) == [
            index * 91 * interval_ms for index in range(15)
        ]
        assert report.reconcile_result is not None
        assert report.reconcile_result.bars_written == component_count
        assert report.reconcile_result.custom_bars_written == 15
        assert {
            written.interval for written in report.reconcile_result.written_ranges
        } == {"1m", "91m"}

    asyncio.run(_run())
