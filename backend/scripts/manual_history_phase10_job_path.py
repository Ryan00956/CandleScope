"""Phase 10 ZIP+REST tail as ONE job through the shipped coordinator/fetcher path."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from manual_history_evidence_identity import build_source_identity

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

STEP = 60_000


def _git_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "unknown"


def _archive_stubs():
    from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider
    from app.exchanges.plugins.binance.normalizer import BinanceNormalizer
    from app.exchanges.rate_limits import RateLimitManager, RateLimitPolicy

    class _Plugin:
        @staticmethod
        def history_archive_provider(_config=None):
            return BinanceKlineArchiveProvider()

        def rate_limit_policy(self, cfg):
            return RateLimitPolicy(
                default_concurrency=getattr(cfg, "fetch_concurrency", 2),
                default_delay_seconds=0.0,
                default_retry_429_backoff_seconds=0.0,
            )

        def pagination_policy(self, _cfg):
            from app.exchanges.pagination import ReverseTimePaginationPolicy
            return ReverseTimePaginationPolicy()

        def protocol(self):
            class _Protocol:
                def rest_path(self, stream_type, market_type):
                    del stream_type, market_type
                    return "kline"
            return _Protocol()

        def normalizer(self, config, descriptor):
            return BinanceNormalizer(config, descriptor)

    class _Registry:
        @staticmethod
        def get_plugin(exchange: str):
            if exchange != "binance":
                raise KeyError(exchange)
            return _Plugin()

        @staticmethod
        def get_capabilities(exchange: str):
            del exchange

            class _Caps:
                capability_schema_version = 1

                def channel_capability(self, *args, **kwargs):
                    del args, kwargs
                    return None

            return _Caps()

    registry = _Registry()
    manager = RateLimitManager()
    return [
        patch("app.exchanges.bootstrap_default_adapters", lambda: registry),
        patch("app.exchanges.registry.bootstrap_default_adapters", lambda: registry),
        patch("app.exchanges.get_exchange_registry", lambda: registry),
        patch("app.data_engine.backfill.source_router.bootstrap_default_adapters", lambda: registry),
        patch("app.data_engine.backfill.source_router.get_exchange_registry", lambda: registry),
        patch("app.data_engine.backfill.fetcher.bootstrap_default_adapters", lambda: registry),
        patch("app.data_engine.backfill.fetcher.get_exchange_registry", lambda: registry),
        patch("app.data_engine.backfill.fetcher.get_shared_rate_limit_manager", lambda: manager),
        patch("app.data_engine.ingestion.normalizers.bootstrap_default_adapters", lambda: registry),
        patch("app.data_engine.ingestion.normalizers.get_exchange_registry", lambda: registry),
    ]


class _LiveArchiveHttp:
    async def get_bytes(self, url, *, allowed_hosts, max_bytes):
        del allowed_hosts, max_bytes
        import urllib.request
        from app.exchanges.archive import ArchiveHttpResponse
        with urllib.request.urlopen(url, timeout=60) as response:
            return ArchiveHttpResponse(200, {}, response.read())

    async def download(self, url, destination, *, allowed_hosts, max_bytes):
        del allowed_hosts, max_bytes
        import urllib.request
        from app.exchanges.archive import ArchiveHttpResponse
        with urllib.request.urlopen(url, timeout=120) as response:
            destination.write_bytes(response.read())
        return ArchiveHttpResponse(200, {})

    async def head(self, url, *, allowed_hosts):
        del url, allowed_hosts
        from app.exchanges.archive import ArchiveHttpResponse
        return ArchiveHttpResponse(200, {})

    async def post_json(self, *args, **kwargs):
        raise AssertionError("Binance archive must not use the OKX resolver")


class _LiveTransport:
    async def http_fetch(self, request):
        from app.data_engine.ingestion.models import DataSource, RawMessage, StreamType
        import urllib.request

        symbol = request.descriptor.symbol
        interval = request.descriptor.interval
        start_ms = int(request.start_ms or 0)
        end_ms = int(request.end_ms or 0)
        url = (
            "https://api.binance.com/api/v3/klines"
            f"?symbol={symbol}&interval={interval}&startTime={start_ms}"
            f"&endTime={end_ms}&limit=1000"
        )
        with urllib.request.urlopen(url, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return [
            RawMessage(
                payload=row,
                source=DataSource.HTTP,
                stream_type=StreamType.KLINE,
                received_at_ms=end_ms,
                endpoint="https://api.binance.com",
            )
            for row in payload
        ]


class _ShippedCoordinator:
    def __init__(self, fetcher: Any) -> None:
        self.fetcher = fetcher
        self.requests: list[Any] = []

    async def request_and_wait(self, request: Any) -> None:
        from app.data_engine.backfill.models import BackfillTask
        from app.data_engine.storage import klines_repo

        self.requests.append(request)
        task = BackfillTask(
            symbol=request.symbol,
            interval=request.interval,
            start_ms=request.start_ms,
            end_ms=request.end_ms,
            estimated_bars=max(1, (request.end_ms - request.start_ms) // STEP + 1),
            exchange=request.exchange,
            market_type=request.market_type,
            metadata=dict(request.metadata or {}),
        )
        result = (await self.fetcher.fetch([task]))[0]
        rows = [
            {
                "open_time": int(bar.open_time),
                "close_time": int(bar.close_time),
                "open": float(bar.open),
                "high": float(bar.high),
                "low": float(bar.low),
                "close": float(bar.close),
                "volume": float(bar.volume),
                "quote_volume": float(bar.quote_volume),
                "trades": int(bar.trades),
                "taker_buy_base": float(bar.taker_buy_base),
                "taker_buy_quote": float(bar.taker_buy_quote),
            }
            for bar in (result.bars or ())
        ]
        if rows:
            klines_repo.upsert_klines(
                request.symbol,
                request.interval,
                rows,
                source="backfill",
                exchange=request.exchange,
                market_type=request.market_type,
            )


async def main() -> int:
    from app.core import config as core_config
    from app.data_engine.backfill.archive_cache import HistoricalArchiveCache
    from app.data_engine.backfill.config import BackfillConfig
    from app.data_engine.backfill.fetcher import HistoricalFetcher
    from app.data_engine.backfill.source_router import HistoricalSourceRouter
    from app.data_engine.data_manager import DataManager
    from app.data_engine.ingestion.config import IngestionConfig
    from app.data_engine.manual_history.repository import ManualHistoryRepository
    from app.data_engine.manual_history.service import ManualHistoryService
    from app.data_engine.storage import klines_repo
    from app.data_engine.storage.klines_repo import KlinesRepoAdapter

    start_ms = int(datetime(2024, 6, 1, tzinfo=timezone.utc).timestamp() * 1000)
    seal_now = int(datetime(2024, 6, 2, 3, 0, tzinfo=timezone.utc).timestamp() * 1000)
    out_dir = REPOSITORY_ROOT / "docs" / "perf-baselines" / "manual-history"
    out_dir.mkdir(parents=True, exist_ok=True)
    date_stamp = datetime.now(timezone.utc).date().isoformat()
    source_identity = build_source_identity(REPOSITORY_ROOT)

    with tempfile.TemporaryDirectory(prefix="manual-history-job-path-", ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        db_path = tmp_path / "klines.db"
        os.environ["KLINES_DB_PATH"] = str(db_path)
        os.environ["HISTORY_ARCHIVE_ENABLED"] = "1"
        core_config.KLINES_DB_PATH = db_path
        klines_repo.KLINES_DB_PATH = db_path
        klines_repo.init_klines_storage()
        adapter = KlinesRepoAdapter()
        repo = ManualHistoryRepository(db_path)
        dm = DataManager()
        dm.set_storage(adapter)
        config = BackfillConfig(
            history_archive_enabled=True,
            history_archive_cache_dir=str(tmp_path / "archive-cache"),
            history_archive_cache_max_bytes=50_000_000,
            history_archive_min_rest_pages=1,
            fetch_rate_limit_delay=0,
            fetch_batch_size=1_000,
            fetch_max_retries=0,
        )
        with ExitStack() as stack:
            for item in _archive_stubs():
                stack.enter_context(item)
            router = HistoricalSourceRouter(
                config,
                cache=HistoricalArchiveCache(
                    tmp_path / "archive-cache",
                    max_bytes=config.history_archive_cache_max_bytes,
                ),
                http=_LiveArchiveHttp(),
                deferred_prefetch_delay_seconds=0,
            )
            fetcher = HistoricalFetcher(
                config, _LiveTransport(), IngestionConfig(), source_router=router,
            )
            coordinator = _ShippedCoordinator(fetcher)
            service = ManualHistoryService(
                repository=repo,
                data_manager=dm,
                coordinator=coordinator,
                storage=adapter,
                fetch_native=None,
                enabled=True,
                clock_ms=lambda: seal_now,
            )
            plan = {
                "can_start": True,
                "plan_hash": "sha256:phase10-job-path",
                "selection": {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbols": ["BTCUSDT"],
                    "intervals": ["1m"],
                    "requested_start_ms": start_ms,
                    "target_count": 1,
                },
                "targets": [{
                    "symbol": "BTCUSDT",
                    "requested_interval": "1m",
                    "canonical_interval": "1m",
                    "route_kind": "NATIVE",
                    "source_interval": "1m",
                    "effective_start_ms": start_ms,
                    "initial_end_open_ms": start_ms + 86_400_000 - STEP,
                    "source_strategy": "ARCHIVE",
                    "estimated_target_rows": None,
                    "estimated_source_rows": None,
                    "existing_coverage": "NONE",
                    "error": None,
                    "boundary_reason": None,
                }],
                "storage": {},
            }
            created = service.create_from_plan(plan, idempotency_key="phase10-job-path")
            job = await service.run_job(created.job.job_id)
            sealed_end = service._seal_end_open_ms("1m", fallback=start_ms)
            verify = adapter.verify_contiguous_range(
                "BTCUSDT", "1m", start_ms, sealed_end,
                exchange="binance", market_type="spot",
            )
            payload = {
                "schema": "candlescope.manual-history.phase10-job-path.v1",
                "git_commit": _git_head(),
                "source_identity": source_identity,
                "klines_db_path": str(db_path.resolve()),
                "production_db": False,
                "job_state": job.state.value,
                "collection_state": repo.get_collection(
                    created.collection.collection_id
                ).status.value,
                "coordinator_requests": len(coordinator.requests),
                "archive_explicit_demand": all(
                    (item.metadata or {}).get("archive_explicit_demand") is True
                    for item in coordinator.requests
                ),
                "verify": verify,
            }
            path = out_dir / f"phase10-job-path-{date_stamp}.json"
            path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(payload, indent=2, default=str))
            if verify.get("verified_contiguous") is not True:
                raise SystemExit(f"job-path continuity failed: {verify}")
            if job.state.value not in {"SUCCEEDED", "PARTIAL"}:
                raise SystemExit(f"job did not succeed: {job.state}")
            if payload["collection_state"] != "ACTIVE":
                raise SystemExit(
                    f"completed collection is not ACTIVE: {payload['collection_state']}"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
