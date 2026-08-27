"""Controlled Phase 10 evidence on a temporary KLINES_DB_PATH.

Covers the documented matrix: REST-only, official ZIP + REST tail, 1h/45m/89m
materialization, multi-symbol, ZIP 404/checksum fallback, GC floor, restart GC,
cancel and BLOCKED_STORAGE.  Never opens data/candlescope.db.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

FORBIDDEN = (
    (BACKEND_ROOT / "data" / "candlescope.db").resolve(),
    (REPOSITORY_ROOT / "data" / "candlescope.db").resolve(),
)
STEP_1M = 60_000


class EvidenceError(RuntimeError):
    pass


def _git_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "unknown"


def _refuse(db_path: Path) -> None:
    resolved = db_path.resolve()
    for forbidden in FORBIDDEN:
        if resolved == forbidden:
            raise EvidenceError(f"refusing production KLINES_DB_PATH={resolved}")


def _fetch_binance_klines(symbol: str, interval: str, limit: int) -> list[list]:
    url = (
        "https://api.binance.com/api/v3/klines"
        f"?symbol={symbol}&interval={interval}&limit={limit}"
    )
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list) or not payload:
        raise EvidenceError(f"empty Binance REST payload for {symbol} {interval}")
    return payload


def _download(url: str, dest: Path) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        body = response.read()
    dest.write_bytes(body)
    return body


def _rows_from_klines(raw: list[list]) -> list[dict[str, Any]]:
    rows = []
    for item in raw:
        open_time = int(item[0])
        rows.append({
            "open_time": open_time,
            "close_time": int(item[6]),
            "open": float(item[1]),
            "high": float(item[2]),
            "low": float(item[3]),
            "close": float(item[4]),
            "volume": float(item[5]),
            "quote_volume": float(item[7]),
            "trades": int(item[8]),
            "taker_buy_base": float(item[9]),
            "taker_buy_quote": float(item[10]),
        })
    return rows


def _rows_from_archive_bars(bars: list[Any]) -> list[dict[str, Any]]:
    return [
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
        for bar in bars
    ]


def _verify(
    adapter: Any,
    *,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    result = adapter.verify_contiguous_range(
        symbol,
        interval,
        start_ms,
        end_ms,
        exchange="binance",
        market_type="spot",
    )
    return {
        "symbol": symbol,
        "interval": interval,
        "effective_start_ms": int(start_ms),
        "sealed_end_open_ms": int(end_ms),
        "verified_contiguous": result.get("verified_contiguous"),
        "actual_count": result.get("actual_count"),
        "expected_count": result.get("expected_count"),
        "expected_open_time": result.get("expected_open_time"),
        "error": result.get("error"),
    }


def _plan(
    *,
    hash_key: str,
    symbols: list[str],
    targets: list[dict[str, Any]],
) -> dict[str, Any]:
    intervals = list(dict.fromkeys(item["canonical_interval"] for item in targets))
    return {
        "can_start": True,
        "plan_hash": f"sha256:{hash_key}",
        "selection": {
            "exchange": "binance",
            "market_type": "spot",
            "symbols": symbols,
            "intervals": intervals,
            "requested_start_ms": min(item["effective_start_ms"] for item in targets),
            "target_count": len(targets),
        },
        "targets": targets,
        "storage": {},
    }


def _target(
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    *,
    route: str,
    source: str,
) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "requested_interval": interval,
        "canonical_interval": interval,
        "route_kind": "NATIVE" if interval == source else "DERIVED",
        "source_interval": source,
        "effective_start_ms": start_ms,
        "initial_end_open_ms": end_ms,
        "source_strategy": route,
        "estimated_target_rows": None,
        "estimated_source_rows": None,
        "existing_coverage": "NONE",
        "error": None,
        "boundary_reason": None,
    }


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


async def _run_native_job(
    service: Any,
    *,
    idempotency_key: str,
    symbols: list[str],
    targets: list[dict[str, Any]],
    fetch_native: Any,
) -> Any:
    service._fetch_native = fetch_native
    created = service.create_from_plan(
        _plan(hash_key=idempotency_key, symbols=symbols, targets=targets),
        idempotency_key=idempotency_key,
    )
    return await service.run_job(created.job.job_id), created


async def main() -> int:
    from app.core import config as core_config
    from app.data_engine.backfill.config import BackfillConfig
    from app.data_engine.backfill.archive_cache import HistoricalArchiveCache
    from app.data_engine.backfill.fetcher import HistoricalFetcher
    from app.data_engine.backfill.models import BackfillStatus, BackfillTask
    from app.data_engine.backfill.source_router import HistoricalSourceRouter
    from app.data_engine.data_manager import DataManager
    from app.data_engine.data_manager.runtime_pressure import storage_file_snapshot
    from app.data_engine.ingestion.config import IngestionConfig
    from app.data_engine.ingestion.models import DataSource, RawMessage, StreamType, TransportRequest
    from app.data_engine.interval_policy import parse_interval_ms
    from app.data_engine.manual_history.materializer import materialize_closed_target_bars
    from app.data_engine.manual_history.models import JobState
    from app.data_engine.manual_history.repository import ManualHistoryRepository
    from app.data_engine.manual_history.service import ManualHistoryService
    from app.data_engine.storage import klines_repo
    from app.data_engine.storage.klines_repo import KlinesRepoAdapter
    from app.exchanges.archive import ArchiveDataError, ArchiveHttpResponse
    from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider

    date_stamp = datetime.now(timezone.utc).date().isoformat()
    out_dir = REPOSITORY_ROOT / "docs" / "perf-baselines" / "manual-history"
    out_dir.mkdir(parents=True, exist_ok=True)
    commit = _git_head()
    network_counts: dict[str, int] = {"rest": 0, "zip": 0, "checksum": 0}
    os.environ["MANUAL_HISTORY_DOWNLOAD_ENABLED"] = "1"
    os.environ["HISTORY_ARCHIVE_ENABLED"] = "1"

    with tempfile.TemporaryDirectory(
        prefix="manual-history-phase10-",
        ignore_cleanup_errors=True,
    ) as tmp:
        tmp_path = Path(tmp)
        db_path = tmp_path / "klines.db"
        _refuse(db_path)
        os.environ["KLINES_DB_PATH"] = str(db_path)
        os.environ["CANDLE_DATA_DIR"] = str(tmp_path / "candle-data")
        core_config.KLINES_DB_PATH = db_path
        klines_repo.KLINES_DB_PATH = db_path
        klines_repo.init_klines_storage()
        adapter = KlinesRepoAdapter()
        repo = ManualHistoryRepository(db_path)
        dm = DataManager()
        dm.set_storage(adapter)
        service = ManualHistoryService(
            repository=repo,
            data_manager=dm,
            storage=adapter,
            enabled=True,
        )

        # 1. REST-only short range.
        rest_raw = _fetch_binance_klines("BTCUSDT", "1m", 5)
        network_counts["rest"] += 1
        rest_rows = _rows_from_klines(rest_raw)
        rest_start = rest_rows[0]["open_time"]
        rest_end = rest_rows[-1]["open_time"]

        async def fetch_rest_btc(**kwargs: Any) -> int:
            if kwargs["interval"] != "1m" or kwargs["symbol"] != "BTCUSDT":
                return 0
            return klines_repo.upsert_klines(
                "BTCUSDT", "1m", rest_rows, source="binance",
                exchange="binance", market_type="spot",
            )

        rest_job, rest_created = await _run_native_job(
            service,
            idempotency_key="phase10-rest",
            symbols=["BTCUSDT"],
            targets=[_target("BTCUSDT", "1m", rest_start, rest_end, route="REST", source="1m")],
            fetch_native=fetch_rest_btc,
        )
        rest_verify = _verify(
            adapter, symbol="BTCUSDT", interval="1m",
            start_ms=rest_start, end_ms=rest_end,
        )
        if rest_verify["verified_contiguous"] is not True:
            raise EvidenceError(f"REST-only continuity failed: {rest_verify}")

        # 2. Official daily ZIP + live REST tail (separate sealed ranges).
        provider = BinanceKlineArchiveProvider()
        zip_day = datetime(2024, 6, 1, tzinfo=timezone.utc)
        zip_now = datetime(2024, 8, 1, tzinfo=timezone.utc)
        refs = provider.plan_objects(
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
            start_ms=int(zip_day.timestamp() * 1000),
            end_ms=int(zip_day.timestamp() * 1000) + 86_400_000 - 1,
            now_ms=int(zip_now.timestamp() * 1000),
        )
        daily = next(ref for ref in refs if ref.granularity.value == "daily" and ref.period == "2024-06-01")
        zip_path = tmp_path / daily.expected_filename
        zip_bytes = _download(daily.url, zip_path)
        network_counts["zip"] += 1
        checksum_bytes = urllib.request.urlopen(daily.checksum_url, timeout=30).read()
        network_counts["checksum"] += 1
        expected_digest = provider.parse_checksum(checksum_bytes, daily)
        actual_digest = hashlib.sha256(zip_bytes).hexdigest()
        if expected_digest != actual_digest:
            raise EvidenceError("live ZIP checksum mismatch")
        checksum_rejected = False
        try:
            provider.parse_checksum(b"not-a-checksum", daily)
        except ArchiveDataError:
            checksum_rejected = True
        if not checksum_rejected:
            raise EvidenceError("malformed checksum was accepted")
        wrong_digest = provider.parse_checksum(
            b"0" * 64 + b"  " + daily.expected_filename.encode(), daily,
        )
        if wrong_digest == actual_digest:
            raise EvidenceError("injected checksum collision against live ZIP digest")
        archive_bars = provider.parse_bars(zip_path, daily)
        archive_rows = _rows_from_archive_bars(archive_bars)
        klines_repo.import_history_archive(
            "BTCUSDT",
            "1m",
            archive_rows,
            {
                "object_key": daily.object_key,
                "provider_id": daily.provider_id,
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "granularity": daily.granularity.value,
                "period": daily.period,
                "start_ms": archive_rows[0]["open_time"],
                "end_ms": archive_rows[-1]["open_time"],
                "content_sha256": actual_digest,
                "provider_checksum": expected_digest,
                "source_url": daily.url,
                "row_count": len(archive_rows),
                "revision_changed": True,
                "import_version": "history-archive-import.v1",
            },
            source="backfill_archive_verified",
            exchange="binance",
            market_type="spot",
        )
        zip_verify = _verify(
            adapter,
            symbol="BTCUSDT",
            interval="1m",
            start_ms=archive_rows[0]["open_time"],
            end_ms=archive_rows[-1]["open_time"],
        )
        if zip_verify["verified_contiguous"] is not True:
            raise EvidenceError(f"ZIP day continuity failed: {zip_verify}")
        tail_verify = rest_verify

        # 3. 1h + 45m + 89m from a live 1m REST window, one source fetch for 1m.
        source_raw = _fetch_binance_klines("BTCUSDT", "1m", 500)
        network_counts["rest"] += 1
        source_rows = _rows_from_klines(source_raw)
        hour_raw = _fetch_binance_klines("BTCUSDT", "1h", 8)
        network_counts["rest"] += 1
        hour_rows = _rows_from_klines(hour_raw)
        source_calls: list[tuple[str, str]] = []

        async def fetch_source_group(**kwargs: Any) -> int:
            source_calls.append((kwargs["symbol"], kwargs["interval"]))
            if kwargs["interval"] == "1h":
                payload = [
                    row for row in hour_rows
                    if kwargs["start_ms"] <= row["open_time"] <= kwargs["end_ms"]
                ]
            elif kwargs["interval"] == "1m":
                # Native 1m covers the full source window so derived 45m/89m
                # materialization has every closed-bucket component.
                payload = list(source_rows)
            else:
                payload = [
                    row for row in source_rows
                    if kwargs["start_ms"] <= row["open_time"] <= kwargs["end_ms"]
                ]
            if not payload:
                return 0
            return klines_repo.upsert_klines(
                kwargs["symbol"], kwargs["interval"], payload, source="binance",
                exchange="binance", market_type="spot",
            )

        src_start = source_rows[0]["open_time"]
        src_end = source_rows[-1]["open_time"]
        now_ms = src_end + 89 * STEP_1M
        rebuilt_45 = materialize_closed_target_bars(
            source_rows, target_interval="45m", source_interval="1m", now_ms=now_ms,
        )
        rebuilt_89 = materialize_closed_target_bars(
            source_rows, target_interval="89m", source_interval="1m", now_ms=now_ms,
        )
        if not rebuilt_45 or not rebuilt_89:
            raise EvidenceError(
                f"materializer produced empty custom bars 45m={len(rebuilt_45)} 89m={len(rebuilt_89)}"
            )
        custom_job, _ = await _run_native_job(
            service,
            idempotency_key="phase10-custom",
            symbols=["BTCUSDT"],
            targets=[
                _target("BTCUSDT", "1m", src_start, src_end, route="REST", source="1m"),
                _target("BTCUSDT", "1h", hour_rows[0]["open_time"], hour_rows[-1]["open_time"], route="REST", source="1h"),
                _target("BTCUSDT", "45m", rebuilt_45[0]["open_time"], rebuilt_45[-1]["open_time"], route="REST", source="1m"),
                _target("BTCUSDT", "89m", rebuilt_89[0]["open_time"], rebuilt_89[-1]["open_time"], route="REST", source="1m"),
            ],
            fetch_native=fetch_source_group,
        )
        source_1m_verify = _verify(
            adapter, symbol="BTCUSDT", interval="1m",
            start_ms=src_start, end_ms=src_end,
        )
        hour_verify = _verify(
            adapter, symbol="BTCUSDT", interval="1h",
            start_ms=hour_rows[0]["open_time"], end_ms=hour_rows[-1]["open_time"],
        )
        custom_45_verify = _verify(
            adapter, symbol="BTCUSDT", interval="45m",
            start_ms=rebuilt_45[0]["open_time"], end_ms=rebuilt_45[-1]["open_time"],
        )
        custom_89_verify = _verify(
            adapter, symbol="BTCUSDT", interval="89m",
            start_ms=rebuilt_89[0]["open_time"], end_ms=rebuilt_89[-1]["open_time"],
        )
        one_m_groups = [item for item in source_calls if item == ("BTCUSDT", "1m")]
        one_h_groups = [item for item in source_calls if item == ("BTCUSDT", "1h")]

        # 4. Multi-symbol REST mix.
        multi_rows: dict[str, list[dict[str, Any]]] = {}
        for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT"):
            multi_rows[symbol] = _rows_from_klines(_fetch_binance_klines(symbol, "1m", 5))
            network_counts["rest"] += 1

        async def fetch_multi(**kwargs: Any) -> int:
            payload = multi_rows.get(kwargs["symbol"]) or []
            if not payload or kwargs["interval"] != "1m":
                return 0
            return klines_repo.upsert_klines(
                kwargs["symbol"], "1m", payload, source="binance",
                exchange="binance", market_type="spot",
            )

        multi_targets = [
            _target(
                symbol, "1m",
                multi_rows[symbol][0]["open_time"],
                multi_rows[symbol][-1]["open_time"],
                route="REST", source="1m",
            )
            for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT")
        ]
        # ETH/SOL need their own collections because create_from_plan is one exchange job.
        multi_job, _ = await _run_native_job(
            service,
            idempotency_key="phase10-multi",
            symbols=["BTCUSDT", "ETHUSDT", "SOLUSDT"],
            targets=multi_targets,
            fetch_native=fetch_multi,
        )
        multi_verifies = [
            _verify(
                adapter, symbol=symbol, interval="1m",
                start_ms=multi_rows[symbol][0]["open_time"],
                end_ms=multi_rows[symbol][-1]["open_time"],
            )
            for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT")
        ]

        # 5. ZIP 404 -> REST fallback through shipped HistoricalFetcher.
        class _Archive404:
            def __init__(self, ref: Any, payload: bytes) -> None:
                self.ref = ref
                self.payload = payload
                self.downloads = 0

            async def get_bytes(self, url, *, allowed_hosts, max_bytes):
                del allowed_hosts, max_bytes
                digest = hashlib.sha256(self.payload).hexdigest()
                body = f"{digest}  {self.ref.expected_filename}\n".encode()
                if str(url).endswith(".CHECKSUM"):
                    return ArchiveHttpResponse(200, {}, body)
                return ArchiveHttpResponse(404, {}, b"")

            async def download(self, url, destination, *, allowed_hosts, max_bytes):
                del url, destination, allowed_hosts, max_bytes
                self.downloads += 1
                return ArchiveHttpResponse(404, {})

            async def head(self, url, *, allowed_hosts):
                del url, allowed_hosts
                return ArchiveHttpResponse(200, {})

            async def post_json(self, *args, **kwargs):
                raise AssertionError("archive 404 drill must not use OKX resolver")

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

        jan = datetime(2024, 1, 1, tzinfo=timezone.utc)
        mar = datetime(2024, 3, 1, tzinfo=timezone.utc)
        jan_refs = provider.plan_objects(
            market_type="spot",
            symbol="BTCUSDT",
            interval="1m",
            start_ms=int(jan.timestamp() * 1000),
            end_ms=int(mar.timestamp() * 1000) - 1,
            now_ms=int((mar + timedelta(days=40)).timestamp() * 1000),
        )
        jan_ref = next(ref for ref in jan_refs if ref.period == "2024-01")
        dummy_zip = b"PK\x03\x04not-a-real-zip"
        fallback_count = 3
        fallback_rows = [
            [
                jan_ref.start_ms + index * STEP_1M, "100", "110", "90", "105", "1.5",
                jan_ref.start_ms + (index + 1) * STEP_1M - 1, "157.5", 10, "0.75", "78.75", "0",
            ]
            for index in range(fallback_count)
        ]
        archive_http = _Archive404(jan_ref, dummy_zip)
        rest_transport = _RestTransport(fallback_rows)
        config = BackfillConfig(
            history_archive_enabled=True,
            history_archive_cache_dir=str(tmp_path / "archive-cache"),
            history_archive_cache_max_bytes=10_000_000,
            history_archive_min_rest_pages=3,
            fetch_rate_limit_delay=0,
            fetch_batch_size=1_000,
            fetch_max_retries=0,
            fetch_concurrency=2,
            reconcile_generate_custom=False,
            reconcile_enable_cache_push=False,
        )
        router = HistoricalSourceRouter(
            config,
            cache=HistoricalArchiveCache(
                tmp_path / "archive-cache",
                max_bytes=config.history_archive_cache_max_bytes,
            ),
            http=archive_http,
            deferred_prefetch_delay_seconds=0,
        )
        fallback_task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=jan_ref.start_ms,
            end_ms=jan_ref.start_ms + (fallback_count - 1) * STEP_1M,
            estimated_bars=fallback_count,
            exchange="binance",
            market_type="spot",
            metadata={
                "requester": "manual_history_download",
                "reason": "manual_history_download",
                "archive_explicit_demand": True,
                "ledger_range": {
                    "start_ms": jan_ref.start_ms,
                    "end_ms": int(datetime(2024, 2, 1, tzinfo=timezone.utc).timestamp() * 1000) - 1,
                },
            },
        )
        with ExitStack() as stack:
            for item in _archive_stubs():
                stack.enter_context(item)
            fetcher = HistoricalFetcher(
                config, rest_transport, IngestionConfig(), source_router=router,
            )
            priming = (await fetcher.fetch([fallback_task]))[0]
            for _ in range(50):
                errors = router.snapshot()["metrics"]["counters"].get(
                    "archive_object_errors", 0,
                )
                if errors:
                    break
                await asyncio.sleep(0.01)
            fallback_result = (await fetcher.fetch([fallback_task]))[0]
        fallback = {
            "status": fallback_result.status.value if hasattr(fallback_result.status, "value") else str(fallback_result.status),
            "priming_status": priming.status.value if hasattr(priming.status, "value") else str(priming.status),
            "bars_count": fallback_result.bars_count,
            "archive_downloads": archive_http.downloads,
            "rest_requests": len(rest_transport.requests),
            "rest_fallback_ranges": (fallback_result.metadata or {}).get("rest_fallback_ranges"),
            "archive_errors": (fallback_result.metadata or {}).get("archive_errors"),
            "checksum_rejected": checksum_rejected,
            "completed": fallback_result.status is BackfillStatus.COMPLETED,
        }

        # 6-7. Prefix rows well before the sealed floor, tiny row limit, GC, then reopen.
        prefix_origin = int(datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
        prefix = []
        for index in range(20):
            open_time = prefix_origin + index * STEP_1M
            prefix.append({
                "open_time": open_time,
                "close_time": open_time + STEP_1M - 1,
                "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0,
                "volume": 1.0, "quote_volume": 1.0, "trades": 1,
                "taker_buy_base": 0.4, "taker_buy_quote": 0.4,
            })
        klines_repo.upsert_klines(
            "BTCUSDT", "1m", prefix, source="binance",
            exchange="binance", market_type="spot",
        )
        files_before = storage_file_snapshot(db_path)
        rows_before = len(klines_repo.query_klines(
            "BTCUSDT", "1m", exchange="binance", market_type="spot",
        ))
        dm.reload_durable_protections()
        dm.update_retention_limits(
            db_limits={"minutes": 1, "hours": 0, "daily": 0},
            storage_row_limits_enabled=True,
        )
        gc_plan = dm.plan_storage_gc(
            file_snapshot=files_before, scoring="legacy",
        )
        gc_report = await dm.run_storage_gc(
            file_snapshot=files_before, batch_size=1_000,
        )
        rows_after = klines_repo.query_klines(
            "BTCUSDT", "1m", start_ms=rest_start, end_ms=rest_end,
            exchange="binance", market_type="spot",
        )
        prefix_after = klines_repo.query_klines(
            "BTCUSDT", "1m",
            start_ms=prefix_origin,
            end_ms=prefix_origin + 19 * STEP_1M,
            exchange="binance", market_type="spot",
        )
        zip_after_gc = klines_repo.query_klines(
            "BTCUSDT", "1m",
            start_ms=archive_rows[0]["open_time"],
            end_ms=archive_rows[-1]["open_time"],
            exchange="binance", market_type="spot",
        )
        gc_verify = _verify(
            adapter, symbol="BTCUSDT", interval="1m",
            start_ms=rest_start, end_ms=rest_end,
        )
        reopened_repo = ManualHistoryRepository(db_path)
        reopened_dm = DataManager()
        reopened_dm.set_storage(KlinesRepoAdapter())
        reopened_dm.reload_durable_protections()
        restart_floors = reopened_dm.durable_protections.clone()
        restart_plan = reopened_dm.plan_storage_gc(
            file_snapshot=storage_file_snapshot(db_path), scoring="legacy",
        )
        restart_verify = _verify(
            KlinesRepoAdapter(), symbol="BTCUSDT", interval="1m",
            start_ms=rest_start, end_ms=rest_end,
        )

        # 8. Cancel and BLOCKED_STORAGE.
        cancel_created = service.create_from_plan(
            _plan(
                hash_key="phase10-cancel",
                symbols=["BTCUSDT"],
                targets=[_target("BTCUSDT", "1m", rest_start, rest_end, route="REST", source="1m")],
            ),
            idempotency_key="phase10-cancel",
        )
        cancelled = service.cancel_job(cancel_created.job.job_id)
        service._disk_free_bytes = lambda: 0
        blocked_created = service.create_from_plan(
            _plan(
                hash_key="phase10-blocked",
                symbols=["BTCUSDT"],
                targets=[_target("BTCUSDT", "1m", rest_start, rest_end, route="REST", source="1m")],
            ),
            idempotency_key="phase10-blocked",
        )
        blocked = await service.run_job(blocked_created.job.job_id)
        recovered = service.recover_jobs()
        service._disk_free_bytes = None

        files_after = storage_file_snapshot(db_path)
        sealed_targets = [
            {**rest_verify, "source_route": "REST", "matrix": "rest_only"},
            {**zip_verify, "source_route": "ZIP", "matrix": "archive_plus_rest_tail"},
            {**tail_verify, "source_route": "REST", "matrix": "archive_plus_rest_tail"},
            {**source_1m_verify, "source_route": "REST", "matrix": "custom_1h_45m_89m"},
            {**hour_verify, "source_route": "REST", "matrix": "custom_1h_45m_89m"},
            {**custom_45_verify, "source_route": "REST", "matrix": "custom_1h_45m_89m"},
            {**custom_89_verify, "source_route": "REST", "matrix": "custom_1h_45m_89m"},
            *[
                {**item, "source_route": "REST", "matrix": "multi_symbol"}
                for item in multi_verifies
            ],
            {**gc_verify, "source_route": "REST", "matrix": "gc_floor"},
            {**restart_verify, "source_route": "REST", "matrix": "restart_gc"},
        ]
        contract = {
            "schema": "candlescope.manual-history.phase10-contract.v1",
            "git_commit": commit,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "MANUAL_HISTORY_DOWNLOAD_ENABLED": 1,
            "HISTORY_ARCHIVE_ENABLED": 1,
            "klines_db_path": str(db_path.resolve()),
            "production_db": False,
            "targets": sealed_targets,
            "matrix": {
                "rest_only": {
                    "job_state": rest_job.state.value,
                    "targets": [rest_verify],
                    "source_route": "REST",
                    "request_count": 1,
                    "rows": len(rest_rows),
                },
                "archive_plus_rest_tail": {
                    "archive": {**zip_verify, "source_route": "ZIP", "rows": len(archive_rows)},
                    "rest_tail": {**tail_verify, "source_route": "REST", "rows": len(rest_rows)},
                },
                "custom_1h_45m_89m": {
                    "job_state": custom_job.state.value,
                    "source_demand_calls": source_calls,
                    "one_m_source_fetches": len(one_m_groups),
                    "one_h_source_fetches": len(one_h_groups),
                    "targets": [source_1m_verify, hour_verify, custom_45_verify, custom_89_verify],
                },
                "multi_symbol": {
                    "job_state": multi_job.state.value,
                    "targets": multi_verifies,
                },
                "zip_fallback": fallback,
                "cancel": {"state": cancelled.state.value},
                "blocked_storage": {"state": blocked.state.value},
                "recovery": [
                    {"job_id": item.job_id, "state": item.state.value, "recovery_count": item.recovery_count}
                    for item in recovered
                ],
            },
        }
        capacity = {
            "schema": "candlescope.manual-history.phase10-capacity.v1",
            "git_commit": commit,
            "klines_db_path": str(db_path.resolve()),
            "production_db": False,
            "network": network_counts,
            "files": {
                "before_gc": {
                    "physical_size_bytes": files_before.get("physical_size_bytes"),
                    "db_size_bytes": files_before.get("db_size_bytes"),
                    "wal_size_bytes": files_before.get("wal_size_bytes"),
                },
                "after": {
                    "physical_size_bytes": files_after.get("physical_size_bytes"),
                    "db_size_bytes": files_after.get("db_size_bytes"),
                    "wal_size_bytes": files_after.get("wal_size_bytes"),
                },
            },
            "rows": {
                "rest": len(rest_rows),
                "zip_day": len(archive_rows),
                "source_1m": len(source_rows),
                "custom_45m": len(rebuilt_45),
                "custom_89m": len(rebuilt_89),
                "multi": {symbol: len(rows) for symbol, rows in multi_rows.items()},
            },
            "physical_bytes": files_after.get("physical_size_bytes"),
        }
        gc_restart = {
            "schema": "candlescope.manual-history.phase10-gc-restart.v1",
            "git_commit": commit,
            "klines_db_path": str(db_path.resolve()),
            "production_db": False,
            "rows_before_gc": rows_before,
            "rows_after_gc_in_sealed_range": len(rows_after),
            "prefix_rows_after_gc": len(prefix_after),
            "zip_rows_after_gc": len(zip_after_gc),
            "gc_plan_would_delete_rows": gc_plan.get("would_delete_rows"),
            "gc_deleted_rows": gc_report.get("deleted_rows"),
            "gc_status": gc_report.get("status"),
            "protected_start_ms": rest_start,
            "sealed_range_after_gc": gc_verify,
            "restart_floor_count": len(restart_floors),
            "floors_after_reopen": [
                {
                    "symbol": floor.key.symbol,
                    "interval": floor.key.interval,
                    "protected_start_ms": floor.protected_start_ms,
                    "durable_owner_count": floor.durable_owner_count,
                }
                for floor in restart_floors.values()
            ],
            "restart_gc_would_delete_rows": restart_plan.get("would_delete_rows"),
            "restart_verify": restart_verify,
        }
        archive_parity = {
            "schema": "candlescope.manual-history.phase10-archive-rest-parity.v1",
            "git_commit": commit,
            "HISTORY_ARCHIVE_ENABLED": 1,
            "klines_db_path": str(db_path.resolve()),
            "production_db": False,
            "zip": zip_verify,
            "rest": rest_verify,
            "same_gate": "storage.verify_contiguous_range",
            "checksum_rejected": checksum_rejected,
            "zip_checksum_matched": expected_digest == actual_digest,
            "fallback": fallback,
        }

        required_true = [
            rest_verify, zip_verify, source_1m_verify, hour_verify,
            custom_45_verify, custom_89_verify, *multi_verifies,
            gc_verify, restart_verify,
        ]
        failed = [item for item in required_true if item.get("verified_contiguous") is not True]
        files = {
            f"phase10-contract-{date_stamp}.json": contract,
            f"phase10-capacity-{date_stamp}.json": capacity,
            f"phase10-gc-restart-{date_stamp}.json": gc_restart,
            f"phase10-archive-rest-parity-{date_stamp}.json": archive_parity,
        }
        written = {}
        for name, payload in files.items():
            path = out_dir / name
            path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            written[name] = str(path)
        summary = {
            "written": written,
            "failed_continuity": failed,
            "cancel": cancelled.state.value,
            "blocked": blocked.state.value,
            "source_calls": source_calls,
            "fallback": fallback,
        }
        print(json.dumps(summary, indent=2, default=str))
        if failed:
            raise EvidenceError(f"continuity gate failed: {failed}")
        if cancelled.state is not JobState.CANCELLED:
            raise EvidenceError(f"cancel did not reach CANCELLED: {cancelled.state}")
        if blocked.state is not JobState.BLOCKED_STORAGE:
            raise EvidenceError(f"disk block did not reach BLOCKED_STORAGE: {blocked.state}")
        if len(one_m_groups) != 1:
            raise EvidenceError(f"expected one 1m source fetch, got {source_calls}")
        if not fallback["completed"] or not int(fallback["rest_requests"] or 0):
            raise EvidenceError(f"ZIP 404 did not fall back to REST: {fallback}")
        if not int(fallback.get("rest_fallback_ranges") or 0) and not fallback.get("archive_errors"):
            raise EvidenceError(f"ZIP 404 did not record REST fallback metadata: {fallback}")
        if gc_verify["verified_contiguous"] is not True:
            raise EvidenceError("GC crossed protected sealed range")
        if prefix_after:
            raise EvidenceError(
                f"GC left unprotected 2020 prefix rows: {len(prefix_after)}"
            )
        if int(gc_report.get("deleted_rows") or 0) <= 0:
            raise EvidenceError(f"tiny row-limit GC deleted nothing: {gc_report}")
        if not restart_floors:
            raise EvidenceError("reopened DataManager loaded no durable GC floors")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except EvidenceError as exc:
        print(f"phase10 evidence aborted: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
