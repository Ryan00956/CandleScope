from __future__ import annotations

import asyncio
import hashlib
import io
import zipfile
from datetime import datetime, timedelta, timezone

import pytest

from app.data_engine.backfill.archive_cache import HistoricalArchiveCache
from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import (
    BackfillPlan,
    BackfillStatus,
    BackfillTask,
)
from app.data_engine.backfill.reconciler import Reconciler
from app.data_engine.backfill.source_router import (
    ArchiveObjectResult,
    ArchiveRoutePlan,
    HistoricalSourceRouter,
    _filter_daily_candidates,
)
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamType,
    TransportRequest,
)
from app.exchanges.archive import ArchiveHttpResponse
from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider
from app.exchanges.rate_limits import (
    RateLimitAdmission,
    RateLimitDeferred,
    RateLimitManager,
)


UTC = timezone.utc
MINUTE_MS = 60_000


@pytest.fixture(autouse=True)
def _isolate_archive_routing_from_production_cold_start(monkeypatch) -> None:
    """Keep archive-routing tests focused on source selection, not shared budgets."""

    class _ArchivePlugin:
        @staticmethod
        def history_archive_provider(_config=None):
            return BinanceKlineArchiveProvider()

    class _ArchiveRegistry:
        @staticmethod
        def get_plugin(exchange: str):
            if exchange != "binance":
                raise KeyError(exchange)
            return _ArchivePlugin()

    monkeypatch.setattr(
        "app.data_engine.backfill.fetcher.get_shared_rate_limit_manager",
        lambda: RateLimitManager(),
    )
    monkeypatch.setattr(
        "app.data_engine.backfill.source_router.get_exchange_registry",
        lambda: _ArchiveRegistry(),
    )


def _ms(value: datetime) -> int:
    return int(value.timestamp() * 1_000)


def _january_ref():
    provider = BinanceKlineArchiveProvider()
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = datetime(2024, 3, 1, tzinfo=UTC)
    refs = provider.plan_objects(
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        start_ms=_ms(start),
        end_ms=_ms(end) - 1,
        now_ms=_ms(end + timedelta(days=40)),
    )
    return next(ref for ref in refs if ref.period == "2024-01")


def _archive_payload(ref, count: int, *, interval_ms: int = MINUTE_MS) -> bytes:
    rows = []
    for index in range(count):
        open_ms = ref.start_ms + index * interval_ms
        rows.append(
            f"{open_ms},100,110,90,105,1.5,{open_ms + interval_ms - 1},"
            "157.5,10,0.75,78.75,0\n"
        )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(ref.expected_filename[:-4] + ".csv", "".join(rows))
    return output.getvalue()


class _ArchiveHttp:
    def __init__(self, ref, payload: bytes, *, status: int = 200) -> None:
        self.ref = ref
        self.payload = payload
        self.status = status
        self.downloads = 0

    async def get_bytes(self, url, *, allowed_hosts, max_bytes):
        del url, allowed_hosts, max_bytes
        digest = hashlib.sha256(self.payload).hexdigest()
        body = f"{digest}  {self.ref.expected_filename}\n".encode()
        return ArchiveHttpResponse(200, {}, body)

    async def download(self, url, destination, *, allowed_hosts, max_bytes):
        del url, allowed_hosts, max_bytes
        self.downloads += 1
        await asyncio.sleep(0.01)
        if self.status == 200:
            destination.write_bytes(self.payload)
        return ArchiveHttpResponse(self.status, {})

    async def head(self, url, *, allowed_hosts):
        del url, allowed_hosts
        return ArchiveHttpResponse(200, {})

    async def post_json(self, *args, **kwargs):
        raise AssertionError("Binance archive routing must not use the OKX resolver")


class _ArchiveHttpMany:
    def __init__(self, payloads: dict[str, bytes]) -> None:
        self.payloads = payloads
        self.downloads: list[str] = []

    @staticmethod
    def _filename(url: str) -> str:
        return url.rsplit("/", 1)[-1].removesuffix(".CHECKSUM")

    async def get_bytes(self, url, *, allowed_hosts, max_bytes):
        del allowed_hosts, max_bytes
        filename = self._filename(url)
        payload = self.payloads[filename]
        digest = hashlib.sha256(payload).hexdigest()
        return ArchiveHttpResponse(
            200,
            {},
            f"{digest}  {filename}\n".encode(),
        )

    async def download(self, url, destination, *, allowed_hosts, max_bytes):
        del allowed_hosts, max_bytes
        filename = self._filename(url)
        self.downloads.append(filename)
        await asyncio.sleep(0.01)
        destination.write_bytes(self.payloads[filename])
        return ArchiveHttpResponse(200, {})

    async def head(self, url, *, allowed_hosts):
        del url, allowed_hosts
        return ArchiveHttpResponse(200, {})

    async def post_json(self, *args, **kwargs):
        raise AssertionError("Binance archive routing must not use the OKX resolver")


class _RestTransport:
    def __init__(self, rows: list[list[object]]) -> None:
        self.rows = rows
        self.requests: list[TransportRequest] = []

    async def http_fetch(self, request: TransportRequest) -> list[RawMessage]:
        self.requests.append(request)
        start_ms = int(request.start_ms or 0)
        end_ms = int(request.end_ms or 2**63 - 1)
        return [
            RawMessage(
                payload=row,
                source=DataSource.HTTP,
                stream_type=StreamType.KLINE,
                received_at_ms=end_ms,
                endpoint="https://api.binance.com",
            )
            for row in self.rows
            if start_ms <= int(row[0]) <= end_ms
        ]


def _rest_rows(start_ms: int, count: int) -> list[list[object]]:
    return [
        [
            start_ms + index * MINUTE_MS,
            "100",
            "110",
            "90",
            "105",
            "1.5",
            start_ms + (index + 1) * MINUTE_MS - 1,
            "157.5",
            10,
            "0.75",
            "78.75",
            "0",
        ]
        for index in range(count)
    ]


def _config(tmp_path) -> BackfillConfig:
    return BackfillConfig(
        history_archive_enabled=True,
        history_archive_cache_dir=str(tmp_path),
        history_archive_cache_max_bytes=10_000_000,
        history_archive_min_rest_pages=3,
        fetch_rate_limit_delay=0,
        fetch_batch_size=1_000,
        fetch_max_retries=0,
        fetch_concurrency=2,
        reconcile_generate_custom=False,
        reconcile_enable_cache_push=False,
    )


def _task(ref, start_index: int, end_index: int) -> BackfillTask:
    return BackfillTask(
        symbol="BTCUSDT",
        interval="1m",
        start_ms=ref.start_ms + start_index * MINUTE_MS,
        end_ms=ref.start_ms + end_index * MINUTE_MS,
        estimated_bars=end_index - start_index + 1,
        exchange="binance",
        market_type="spot",
        metadata={
            "requester": "klines_history",
            # Models the scheduler's parent 89m/deep-history range.  The
            # physical task itself is deliberately far below three pages.
            "ledger_range": {
                "start_ms": ref.start_ms,
                "end_ms": _ms(datetime(2024, 2, 1, tzinfo=UTC)) - 1,
            },
        },
    )


def test_archive_routed_rest_deferral_is_not_downgraded_to_partial(tmp_path) -> None:
    async def _run() -> RateLimitDeferred:
        ref = _january_ref()
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=ref.end_ms - MINUTE_MS + 1,
            end_ms=ref.end_ms + MINUTE_MS,
            exchange="binance",
            market_type="futures",
        )
        archive_result = ArchiveObjectResult(
            ref=ref,
            bars=(),
            content_sha256="0" * 64,
            provider_checksum=None,
            cache_hit=True,
            revision_changed=False,
            size_bytes=0,
            cache_elapsed_ms=0,
            download_elapsed_ms=0,
            verify_elapsed_ms=0,
            parse_elapsed_ms=0,
        )
        future = asyncio.create_task(asyncio.sleep(0, result=archive_result))
        plan = ArchiveRoutePlan(
            refs_by_task={task.task_key: (ref,)},
            futures={ref.object_key: future},
            owner_task_by_object={ref.object_key: task.task_key},
        )
        fetcher = HistoricalFetcher(
            _config(tmp_path),
            _RestTransport([]),
            IngestionConfig(),
        )
        retry_at_monotonic = asyncio.get_running_loop().time() + 0.05
        deferred = RateLimitDeferred(RateLimitAdmission(
            allowed=False,
            bucket_key="binance:futures:request_weight:ip",
            cost=5,
            reason="circuit_open",
            retry_after_seconds=0.05,
            retry_at_monotonic=retry_at_monotonic,
            retry_at_ms=int(datetime.now(tz=UTC).timestamp() * 1000) + 50,
            rule_name="binance_futures_klines",
            status_code=418,
            body_code="-1003",
            circuit_key="binance:ip",
        ))

        async def _defer_rest(_task):
            raise deferred

        fetcher._fetch_rest_task = _defer_rest  # type: ignore[method-assign]
        with pytest.raises(RateLimitDeferred) as caught:
            await fetcher._fetch_routed_task(task, (ref,), plan)
        return caught.value

    caught = asyncio.run(_run())
    assert caught.status_code == 418
    assert caught.reason == "circuit_open"


def test_parent_range_routes_page_chunks_to_one_archive_import(tmp_path) -> None:
    async def _run() -> None:
        ref = _january_ref()
        payload = _archive_payload(ref, 4)
        archive_http = _ArchiveHttp(ref, payload)
        config = _config(tmp_path)
        router = HistoricalSourceRouter(
            config,
            cache=HistoricalArchiveCache(
                tmp_path,
                max_bytes=config.history_archive_cache_max_bytes,
            ),
            http=archive_http,
            deferred_prefetch_delay_seconds=0,
        )
        rest = _RestTransport(_rest_rows(ref.start_ms, 4))
        fetcher = HistoricalFetcher(
            config,
            rest,
            IngestionConfig(),
            source_router=router,
        )
        tasks = [_task(ref, 0, 1), _task(ref, 2, 3)]

        priming = await fetcher.fetch(tasks)
        assert sum(result.bars_count for result in priming) == 4
        assert len(rest.requests) == 2
        for _ in range(50):
            loaded = router.snapshot()["metrics"]["counters"].get(
                "archive_objects_loaded",
                0,
            )
            if loaded == 1:
                break
            await asyncio.sleep(0.01)

        results = await fetcher.fetch(tasks)

        assert archive_http.downloads == 1
        assert len(rest.requests) == 2
        assert [result.status for result in results] == [
            BackfillStatus.COMPLETED,
            BackfillStatus.COMPLETED,
        ]
        assert sum(result.bars_count for result in results) == 4
        assert sum(
            len(result.metadata["archive_objects"])
            for result in results
        ) == 1
        assert sum(
            result.metadata["archive_object_count"]
            for result in results
        ) == 1

        repeated = await fetcher.fetch(tasks)
        assert archive_http.downloads == 1
        assert sum(result.bars_count for result in repeated) == 4
        router_snapshot = router.snapshot()
        assert (
            router_snapshot["metrics"]["counters"]["archive_rows_parsed"]
            == 4
        )
        assert (
            router_snapshot["metrics"]["counters"]["archive_parsed_cache_hits"]
            == 2
        )

        class _Storage:
            def __init__(self) -> None:
                self.writes = []
                self.receipts = []

            async def upsert_bars(self, symbol, interval, rows, **kwargs):
                self.writes.append((symbol, interval, list(rows), dict(kwargs)))
                return len(rows)

            async def record_history_archive_imports(self, receipts):
                self.receipts.extend(receipts)
                return len(receipts)

        storage = _Storage()
        reconcile = await Reconciler(config, storage).reconcile(
            results,
            BackfillPlan(gaps=[], tasks=tasks),
        )
        archive_writes = [
            item for item in storage.writes
            if item[3]["source"] == "backfill_archive_verified"
        ]
        assert len(archive_writes) == 1
        assert len(archive_writes[0][2]) == 4
        assert len(storage.receipts) == 1
        assert reconcile.archive_objects_imported == 1

    asyncio.run(_run())


def test_parent_range_prefetch_keeps_first_foreground_page_on_rest(tmp_path) -> None:
    async def _run() -> None:
        provider = BinanceKlineArchiveProvider()
        start = datetime(2024, 1, 1, tzinfo=UTC)
        end = datetime(2024, 3, 1, tzinfo=UTC)
        refs = [
            ref
            for ref in provider.plan_objects(
                market_type="spot",
                symbol="BTCUSDT",
                interval="1m",
                start_ms=_ms(start),
                end_ms=_ms(end) - 1,
                now_ms=_ms(end + timedelta(days=40)),
            )
            if ref.granularity.value == "monthly"
        ]
        assert [ref.period for ref in refs] == ["2024-01", "2024-02"]
        archive_http = _ArchiveHttpMany({
            ref.expected_filename: _archive_payload(ref, 2)
            for ref in refs
        })
        config = _config(tmp_path)
        router = HistoricalSourceRouter(
            config,
            cache=HistoricalArchiveCache(
                tmp_path,
                max_bytes=config.history_archive_cache_max_bytes,
            ),
            http=archive_http,
            deferred_prefetch_delay_seconds=0,
        )
        rest = _RestTransport(_rest_rows(refs[0].start_ms, 2))
        fetcher = HistoricalFetcher(
            config,
            rest,
            IngestionConfig(),
            source_router=router,
        )
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=refs[0].start_ms,
            end_ms=refs[0].start_ms + MINUTE_MS,
            estimated_bars=2,
            exchange="binance",
            market_type="spot",
            metadata={
                "requester": "klines_history",
                "ledger_range": {
                    "start_ms": refs[0].start_ms,
                    "end_ms": refs[1].end_ms,
                },
            },
        )

        result = (await fetcher.fetch([task]))[0]
        for _ in range(50):
            loaded = (
                router.snapshot()["metrics"]["counters"].get(
                    "archive_objects_loaded",
                    0,
                )
            )
            if loaded == 2:
                break
            await asyncio.sleep(0.01)

        assert result.status is BackfillStatus.COMPLETED
        assert result.bars_count == 2
        assert all(bar.source == "backfill" for bar in result.bars)
        assert result.metadata.get("archive_object_count", 0) == 0
        assert len(rest.requests) == 1
        assert sorted(archive_http.downloads) == sorted(
            ref.expected_filename for ref in refs
        )
        snapshot = router.snapshot()
        assert snapshot["metrics"]["counters"][
            "archive_foreground_rest_bypasses"
        ] == 1
        assert snapshot["metrics"]["counters"][
            "archive_background_prefetch_objects"
        ] == 2
        assert snapshot["metrics"]["counters"]["archive_objects_loaded"] == 2

        repeated = (await fetcher.fetch([task]))[0]
        # After the one-time foreground grace, the touching task owns the
        # bounded parent batch so downstream reconciliation can import and
        # materialize both months in one pass.
        assert repeated.bars_count == 4
        assert repeated.metadata["archive_object_count"] == 2
        assert len(archive_http.downloads) == 2
        assert len(rest.requests) == 1
        assert router.snapshot()["metrics"]["counters"][
            "archive_parent_batch_objects"
        ] == 1

        fetcher.acknowledge_archive_imports([repeated])
        after_ack = (await fetcher.fetch([task]))[0]
        assert after_ack.bars_count == 2
        assert after_ack.metadata["archive_object_count"] == 1
        assert len(archive_http.downloads) == 2
        assert router.snapshot()["acknowledged_import_objects"] == 2

    asyncio.run(_run())


def test_background_prefetch_parks_until_real_foreground_demand(tmp_path) -> None:
    async def _run() -> None:
        ref = _january_ref()
        archive_http = _ArchiveHttp(ref, _archive_payload(ref, 2))
        config = _config(tmp_path)
        router = HistoricalSourceRouter(
            config,
            cache=HistoricalArchiveCache(
                tmp_path,
                max_bytes=config.history_archive_cache_max_bytes,
            ),
            http=archive_http,
            deferred_prefetch_delay_seconds=0,
        )
        rest = _RestTransport(_rest_rows(ref.start_ms, 2))
        fetcher = HistoricalFetcher(
            config,
            rest,
            IngestionConfig(),
            source_router=router,
        )
        task = _task(ref, 0, 1)
        task.metadata.update({
            "requester": "warm_start_custom_seed",
            "reason": "background_prefetch",
            "source": "background-prefetch",
        })

        background = (await fetcher.fetch([task]))[0]
        await asyncio.sleep(0.03)

        assert background.bars_count == 2
        assert archive_http.downloads == 0
        parked = router.snapshot()
        assert parked["foreground_archive_ready"] is False
        assert parked["deferred_prefetch_objects"] == 1
        assert parked["metrics"]["counters"][
            "archive_prefetch_parked_for_foreground"
        ] == 1

        task.metadata.update({
            "requester": "klines_history",
            "reason": "initial_history",
            "source": "foreground",
        })
        foreground = (await fetcher.fetch([task]))[0]
        for _ in range(50):
            if archive_http.downloads == 1:
                break
            await asyncio.sleep(0.01)

        assert foreground.bars_count == 2
        assert archive_http.downloads == 1
        assert router.snapshot()["foreground_archive_ready"] is True

    asyncio.run(_run())


def test_archive_404_falls_back_to_rest_without_becoming_boundary(tmp_path) -> None:
    async def _run() -> None:
        ref = _january_ref()
        count = 3
        archive_http = _ArchiveHttp(
            ref,
            _archive_payload(ref, count),
            status=404,
        )
        config = _config(tmp_path)
        router = HistoricalSourceRouter(
            config,
            cache=HistoricalArchiveCache(
                tmp_path,
                max_bytes=config.history_archive_cache_max_bytes,
            ),
            http=archive_http,
            deferred_prefetch_delay_seconds=0,
        )
        rest = _RestTransport(_rest_rows(ref.start_ms, count))
        fetcher = HistoricalFetcher(
            config,
            rest,
            IngestionConfig(),
            source_router=router,
        )

        task = _task(ref, 0, count - 1)
        priming = (await fetcher.fetch([task]))[0]
        assert priming.status is BackfillStatus.COMPLETED
        assert priming.bars_count == count
        for _ in range(50):
            errors = router.snapshot()["metrics"]["counters"].get(
                "archive_object_errors",
                0,
            )
            if errors == 1:
                break
            await asyncio.sleep(0.01)

        result = (await fetcher.fetch([task]))[0]

        assert result.status is BackfillStatus.COMPLETED
        assert result.bars_count == count
        assert all(bar.source == "backfill" for bar in result.bars)
        assert result.metadata["rest_fallback_ranges"] == 1
        assert result.metadata["archive_errors"]
        assert len(rest.requests) == 2
        assert result.source_complete is False
        assert result.exhausted_before_ms is None

        repeated = (await fetcher.fetch([task]))[0]
        assert repeated.status is BackfillStatus.COMPLETED
        assert repeated.bars_count == count
        assert archive_http.downloads == 1
        assert len(rest.requests) == 3
        assert (
            router.snapshot()["metrics"]["counters"][
                "archive_negative_cache_hits"
            ]
            == 2
        )

    asyncio.run(_run())


def test_small_range_without_parent_demand_stays_on_rest(tmp_path) -> None:
    async def _run() -> None:
        ref = _january_ref()
        count = 3
        archive_http = _ArchiveHttp(ref, _archive_payload(ref, count))
        config = _config(tmp_path)
        router = HistoricalSourceRouter(config, http=archive_http)
        rest = _RestTransport(_rest_rows(ref.start_ms, count))
        fetcher = HistoricalFetcher(
            config,
            rest,
            IngestionConfig(),
            source_router=router,
        )
        task = _task(ref, 0, count - 1)
        task.metadata.clear()

        result = (await fetcher.fetch([task]))[0]

        assert result.bars_count == count
        assert archive_http.downloads == 0
        assert len(rest.requests) == 1
        assert result.metadata["history_lane"] == "rest"

    asyncio.run(_run())


def test_complete_month_uses_monthly_archive_below_daily_page_threshold(
    tmp_path,
) -> None:
    async def _run() -> None:
        provider = BinanceKlineArchiveProvider()
        start = datetime(2024, 1, 1, tzinfo=UTC)
        end = datetime(2024, 2, 1, tzinfo=UTC)
        ref = next(
            item
            for item in provider.plan_objects(
                market_type="spot",
                symbol="BTCUSDT",
                interval="1h",
                start_ms=_ms(start),
                end_ms=_ms(end) - 1,
                now_ms=_ms(end + timedelta(days=40)),
            )
            if item.granularity.value == "monthly"
        )
        hour_ms = 60 * MINUTE_MS
        row_count = 31 * 24
        archive_http = _ArchiveHttp(
            ref,
            _archive_payload(ref, row_count, interval_ms=hour_ms),
        )
        config = _config(tmp_path)
        router = HistoricalSourceRouter(
            config,
            cache=HistoricalArchiveCache(
                tmp_path,
                max_bytes=config.history_archive_cache_max_bytes,
            ),
            http=archive_http,
        )
        rest = _RestTransport([])
        fetcher = HistoricalFetcher(
            config,
            rest,
            IngestionConfig(),
            source_router=router,
        )
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1h",
            start_ms=ref.start_ms,
            end_ms=ref.end_ms,
            estimated_bars=row_count,
            exchange="binance",
            market_type="spot",
        )

        result = (await fetcher.fetch([task]))[0]

        assert row_count < config.history_archive_min_rest_pages * 1_000
        assert archive_http.downloads == 1
        assert rest.requests == []
        assert result.bars_count == row_count
        assert result.metadata["archive_object_count"] == 1

    asyncio.run(_run())


def test_partial_closed_month_uses_monthly_only_above_rest_threshold() -> None:
    provider = BinanceKlineArchiveProvider()
    now_ms = _ms(datetime(2024, 4, 1, tzinfo=UTC))

    def _selected(days: int):
        start = datetime(2024, 1, 10, tzinfo=UTC)
        end = start + timedelta(days=days) - timedelta(milliseconds=1)
        candidates = provider.plan_objects(
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
            start_ms=_ms(start),
            end_ms=_ms(end),
            now_ms=now_ms,
        )
        return _filter_daily_candidates(
            candidates,
            range_start_ms=_ms(start),
            range_end_ms=_ms(end),
            interval="1m",
            rest_page_size=1_000,
            minimum_pages=3,
        )

    five_days = _selected(5)
    assert [(ref.granularity.value, ref.period) for ref in five_days] == [
        ("monthly", "2024-01"),
    ]
    assert _selected(1) == []
