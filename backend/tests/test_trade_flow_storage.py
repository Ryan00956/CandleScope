from __future__ import annotations

import asyncio
import threading
import time
from functools import wraps

import pytest

from app.data_engine.storage import raw_trade_archive as archive_module
from app.data_engine.storage.raw_trade_archive import (
    DisabledRawAggTradeArchive,
    ParquetRawAggTradeArchive,
    RawAggTradeArchiveWriter,
    RawAggTradeScanLimitError,
)
from app.data_engine.storage.trade_flow_store import (
    SQLiteTradeFlowRollupStore,
    TradeFlowRollupStore,
)
from app.data_engine.storage.trade_flow_writer import TradeFlowRollupWriter


MINUTE = 60_000
DAY = 86_400_000
START_MS = 1_700_000_040_000


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _rollup(
    bucket_open_ms: int,
    *,
    revision: int,
    is_final: bool = False,
    is_complete: bool = True,
    buy_base: float = 2.0,
) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "bucket_open_ms": bucket_open_ms,
        "bucket_close_ms": bucket_open_ms + MINUTE,
        "buy_base_volume": buy_base,
        "sell_base_volume": 1.0,
        "buy_quote_volume": buy_base * 100.0,
        "sell_quote_volume": 100.0,
        "base_volume_delta": buy_base - 1.0,
        "quote_volume_delta": buy_base * 100.0 - 100.0,
        "agg_trade_count": 2,
        "trade_count": 3,
        "buy_trade_count": 2,
        "sell_trade_count": 1,
        "max_agg_trade_quote": 120.0,
        "first_agg_trade_id": 10,
        "last_agg_trade_id": 11,
        "is_final": is_final,
        "is_complete": is_complete,
        "revision": revision,
        "source": "websocket",
        "received_at_ms": revision,
    }


def _raw_trade(
    agg_trade_id: int,
    *,
    trade_time_ms: int,
    received_at_ms: int | None = None,
    price: float = 100.0,
) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "agg_trade_id": agg_trade_id,
        "first_trade_id": agg_trade_id * 2,
        "last_trade_id": agg_trade_id * 2 + 1,
        "price": price,
        "quantity": 0.5,
        "trade_time_ms": trade_time_ms,
        "event_time_ms": trade_time_ms + 2,
        "received_at_ms": received_at_ms or trade_time_ms + 5,
        "is_buyer_maker": agg_trade_id % 2 == 0,
        "source": "websocket",
    }


@_async_test
async def test_sqlite_rollup_store_revision_finality_and_query_directions(
    tmp_path,
) -> None:
    store = SQLiteTradeFlowRollupStore(tmp_path / "trade-flow.sqlite")
    assert isinstance(store, TradeFlowRollupStore)
    await store.upsert_rollups(
        [
            _rollup(START_MS, revision=100, buy_base=2.0),
            _rollup(START_MS + MINUTE, revision=100, buy_base=3.0),
            _rollup(START_MS + 2 * MINUTE, revision=100, buy_base=4.0),
        ]
    )

    # A newer engine revision may discover a gap (complete -> incomplete),
    # then a later repaired/final revision restores completeness.
    await store.upsert_rollups(
        [
            _rollup(
                START_MS,
                revision=200,
                is_complete=False,
                buy_base=5.0,
            )
        ]
    )
    downgraded = await store.query_rollups(
        exchange="BINANCE",
        market_type="FUTURES",
        symbol="btcusdt",
        start_ms=START_MS,
        end_ms=START_MS,
    )
    assert downgraded[0]["is_complete"] == 0
    assert downgraded[0]["revision"] == 200

    await store.upsert_rollups(
        [
            _rollup(
                START_MS,
                revision=300,
                is_final=True,
                is_complete=True,
                buy_base=6.0,
            )
        ]
    )
    # Even a newer revision cannot make a final bucket provisional again.
    await store.upsert_rollups(
        [
            _rollup(
                START_MS,
                revision=400,
                is_final=False,
                is_complete=False,
                buy_base=99.0,
            )
        ]
    )
    final = await store.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=START_MS,
        end_ms=START_MS,
    )
    assert final[0]["buy_base_volume"] == 6.0
    assert final[0]["is_final"] == 1
    assert final[0]["is_complete"] == 1
    assert final[0]["revision"] == 300

    history = await store.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        limit=2,
    )
    recent = await store.query_recent_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        limit=2,
    )
    assert [row["bucket_open_ms"] for row in history] == [
        START_MS,
        START_MS + MINUTE,
    ]
    assert [row["bucket_open_ms"] for row in recent] == [
        START_MS + MINUTE,
        START_MS + 2 * MINUTE,
    ]
    diagnostics = await store.diagnostics()
    assert diagnostics["backend"] == "sqlite"
    assert diagnostics["rollups"]["rows"] == 3


@_async_test
async def test_rollup_writer_coalesces_provisional_and_flushes_close(tmp_path) -> None:
    store = SQLiteTradeFlowRollupStore(tmp_path / "writer.sqlite")
    writer = TradeFlowRollupWriter(
        store,
        flush_interval_seconds=60,
        max_pending_provisional=2,
    )
    assert writer.offer(_rollup(START_MS, revision=100, buy_base=2.0)) is True
    assert writer.offer(_rollup(START_MS, revision=200, buy_base=3.0)) is True
    assert (
        writer.offer(
            _rollup(START_MS + MINUTE, revision=100, is_final=True)
        )
        is False
    )

    await writer.close()
    rows = await store.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert len(rows) == 1
    assert rows[0]["buy_base_volume"] == 3.0
    diagnostics = writer.diagnostics()
    assert diagnostics["state"] == "closed"
    assert diagnostics["coalesced"] == 1
    assert diagnostics["offer_rejected_final"] == 1


@_async_test
async def test_rollup_writer_durable_write_does_not_wait_for_provisional_timer() -> None:
    class _MemoryStore:
        def __init__(self) -> None:
            self.calls: list[list[dict]] = []

        async def upsert_rollups(self, rows) -> int:
            copied = list(rows)
            self.calls.append(copied)
            return len(copied)

    store = _MemoryStore()
    writer = TradeFlowRollupWriter(store, flush_interval_seconds=10)  # type: ignore[arg-type]

    written = await asyncio.wait_for(
        writer.write([_rollup(START_MS, revision=1, is_final=True)]),
        timeout=0.25,
    )

    assert written == 1
    assert len(store.calls) == 1
    await writer.close()


@_async_test
async def test_rollup_writer_enqueue_returns_before_slow_store_acknowledges() -> None:
    class _BlockingStore:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.calls: list[list[dict]] = []

        async def upsert_rollups(self, rows) -> int:
            copied = list(rows)
            self.calls.append(copied)
            self.started.set()
            await self.release.wait()
            return len(copied)

    store = _BlockingStore()
    writer = TradeFlowRollupWriter(store, flush_interval_seconds=10)  # type: ignore[arg-type]

    first = await writer.enqueue(
        [_rollup(START_MS, revision=1, is_final=True)]
    )
    second = await writer.enqueue(
        [_rollup(START_MS + MINUTE, revision=1, is_final=True)]
    )
    assert first is not None and second is not None
    await asyncio.wait_for(store.started.wait(), timeout=0.25)
    assert not first.done()
    assert not second.done()

    store.release.set()
    assert await asyncio.wait_for(first, timeout=0.25) == 1
    assert await asyncio.wait_for(second, timeout=0.25) == 1
    assert len(store.calls) == 1
    await writer.close()


@_async_test
async def test_rollup_writer_retries_final_batch_and_shutdown_drains_ack() -> None:
    class _FlakyStore:
        def __init__(self) -> None:
            self.calls = 0

        async def upsert_rollups(self, rows) -> int:
            copied = list(rows)
            self.calls += 1
            if self.calls <= 2:
                raise OSError("sqlite is temporarily locked")
            return len(copied)

    store = _FlakyStore()
    writer = TradeFlowRollupWriter(
        store,  # type: ignore[arg-type]
        flush_interval_seconds=10,
        max_write_attempts=3,
        retry_base_seconds=0,
    )
    acknowledgement = await writer.enqueue(
        [_rollup(START_MS, revision=1, is_final=True)],
    )
    assert acknowledgement is not None

    await writer.close()

    assert acknowledgement.result() == 1
    diagnostics = writer.diagnostics()
    assert store.calls == 3
    assert diagnostics["state"] == "closed"
    assert diagnostics["degraded"] is False
    assert diagnostics["retry_attempts"] == 2
    assert diagnostics["write_failures"] == 2
    assert diagnostics["failed_batches"] == 0
    assert diagnostics["last_error"] is None


@_async_test
async def test_rollup_writer_exhaustion_is_sticky_and_ack_fails() -> None:
    class _FailedStore:
        def __init__(self) -> None:
            self.calls = 0

        async def upsert_rollups(self, rows) -> int:
            list(rows)
            self.calls += 1
            raise OSError("sqlite disk I/O error")

    store = _FailedStore()
    writer = TradeFlowRollupWriter(
        store,  # type: ignore[arg-type]
        max_write_attempts=3,
        retry_base_seconds=0,
    )
    acknowledgement = await writer.enqueue(
        [_rollup(START_MS, revision=1, is_final=True)],
    )
    assert acknowledgement is not None

    with pytest.raises(OSError, match="sqlite disk I/O error"):
        await acknowledgement
    await writer.close()

    diagnostics = writer.diagnostics()
    assert store.calls == 3
    assert diagnostics["state"] == "failed"
    assert diagnostics["degraded"] is True
    assert diagnostics["retry_attempts"] == 2
    assert diagnostics["write_failures"] == 3
    assert diagnostics["failed_batches"] == 1
    assert diagnostics["failed_rows"] == 1
    assert diagnostics["last_error"] == "sqlite disk I/O error"
    assert diagnostics["durable_batches_pending"] == 0


@_async_test
async def test_parquet_archive_is_immutable_deduplicated_and_reports_gaps(
    tmp_path,
) -> None:
    pytest.importorskip("pyarrow")
    root = tmp_path / "raw-trades"
    archive = ParquetRawAggTradeArchive(root, max_rows_per_file=2)
    writer = RawAggTradeArchiveWriter(
        archive,
        flush_interval_seconds=0,
        max_pending_batches=2,
    )
    await writer.write(
        [
            _raw_trade(1, trade_time_ms=START_MS),
            _raw_trade(3, trade_time_ms=START_MS + 2),
        ]
    )
    await writer.write(
        [
            _raw_trade(
                1,
                trade_time_ms=START_MS,
                received_at_ms=START_MS + 100,
                price=101.0,
            )
        ]
    )

    files_before_repair = list(root.rglob("*.parquet"))
    assert len(files_before_repair) == 2
    assert not list(root.rglob("*.tmp"))
    assert "exchange=binance" in str(files_before_repair[0])
    assert "market_type=futures" in str(files_before_repair[0])
    assert "symbol=BTCUSDT" in str(files_before_repair[0])
    assert "date=2023-11-14" in str(files_before_repair[0])

    replay = archive.scan_range(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert [row["agg_trade_id"] for row in replay] == [1, 3]
    assert replay[0]["price"] == 101.0
    assert replay[0]["quote_quantity"] == 50.5
    coverage = archive.coverage(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        expected_start_agg_trade_id=1,
        expected_end_agg_trade_id=3,
    )
    assert coverage.enabled is True
    assert coverage.backend == "parquet-pyarrow"
    assert coverage.complete is False
    assert coverage.gaps[0].start_agg_trade_id == 2
    assert coverage.gaps[0].end_agg_trade_id == 2

    await writer.write([_raw_trade(2, trade_time_ms=START_MS + 1)])
    await writer.close()
    repaired = archive.coverage(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        expected_start_agg_trade_id=1,
        expected_end_agg_trade_id=3,
    )
    assert repaired.complete is True
    assert repaired.gaps == ()
    bounded = archive.scan_range(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_agg_trade_id=2,
        end_agg_trade_id=3,
        limit=1,
    )
    assert [row["agg_trade_id"] for row in bounded] == [2]
    assert writer.diagnostics()["rows_archived"] == 4


def test_parquet_archive_prunes_utc_date_partitions_and_uses_sidecars(
    tmp_path,
) -> None:
    pytest.importorskip("pyarrow")
    root = tmp_path / "raw-trades"
    archive = ParquetRawAggTradeArchive(root, max_rows_per_file=2)
    archive.append([_raw_trade(1, trade_time_ms=START_MS)])
    archive.append([_raw_trade(2, trade_time_ms=START_MS + DAY)])

    parquet_files = sorted(root.rglob("*.parquet"))
    sidecars = sorted(root.rglob("*.parquet.manifest.json"))
    assert len(parquet_files) == 2
    assert len(sidecars) == 2

    # A corrupt out-of-range file proves the bounded read never opens the old
    # UTC partition after date pruning.
    parquet_files[0].write_bytes(b"not parquet")
    replay = archive.scan_range(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=START_MS + DAY,
        end_time_ms=START_MS + DAY,
    )
    assert [row["agg_trade_id"] for row in replay] == [2]


def test_parquet_coverage_fails_closed_before_unbounded_row_scan(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    archive = ParquetRawAggTradeArchive(
        tmp_path / "raw-trades",
        max_scan_rows=2,
    )
    archive.append(
        [_raw_trade(item, trade_time_ms=START_MS + item) for item in range(1, 4)]
    )

    coverage = archive.coverage(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        expected_start_agg_trade_id=1,
        expected_end_agg_trade_id=3,
    )
    assert coverage.status == "scan_limit_exceeded"
    assert coverage.complete is False
    assert coverage.truncated is True
    assert coverage.row_count == 0
    assert coverage.estimated_row_count == 3
    assert coverage.estimated_physical_row_count == 3
    assert coverage.scanned_row_count == 0
    assert coverage.limit_kind == "matched_rows"
    assert "aggregate-ID bounds" in str(coverage.error)


def test_parquet_coverage_expected_ids_are_the_actual_query_slice(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    archive = ParquetRawAggTradeArchive(
        tmp_path / "raw-trades",
        # The physical file contains three rows, but only one belongs to the
        # requested replay interval.  The narrow ID slice must remain usable.
        max_scan_rows=1,
    )
    archive.append(
        [_raw_trade(item, trade_time_ms=START_MS + item) for item in range(1, 4)]
    )

    coverage = archive.coverage(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        expected_start_agg_trade_id=2,
        expected_end_agg_trade_id=2,
    )
    assert coverage.status == "ready"
    assert coverage.complete is True
    assert coverage.row_count == 1
    assert coverage.estimated_row_count == 1
    assert coverage.estimated_physical_row_count == 3
    assert coverage.scanned_row_count == 3
    assert coverage.earliest_agg_trade_id == 2
    assert coverage.latest_agg_trade_id == 2
    assert coverage.gaps == ()


def test_parquet_coverage_has_independent_hard_physical_scan_cap(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    root = tmp_path / "raw-trades"
    archive = ParquetRawAggTradeArchive(
        root,
        max_scan_rows=100,
        max_physical_scan_rows=2,
    )
    # Retry overlap makes every file relevant to the same one-ID query.  The
    # matched-row budget alone would allow this to grow without bound.
    for received_at_ms in range(START_MS + 10, START_MS + 13):
        archive.append(
            [
                _raw_trade(
                    2,
                    trade_time_ms=START_MS + 2,
                    received_at_ms=received_at_ms,
                )
            ]
        )

    # If coverage opens any candidate file instead of rejecting from sidecar
    # totals, corrupt Parquet makes the test fail noisily.
    for path in root.rglob("*.parquet"):
        path.write_bytes(b"must not be scanned")
    coverage = archive.coverage(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        expected_start_agg_trade_id=2,
        expected_end_agg_trade_id=2,
    )
    assert coverage.status == "scan_limit_exceeded"
    assert coverage.complete is False
    assert coverage.limit_kind == "physical_rows"
    assert coverage.estimated_row_count == 3
    assert coverage.estimated_physical_row_count == 3
    assert coverage.scanned_row_count == 0
    assert "estimated physical rows=3/2" in str(coverage.error)
    diagnostics = archive.diagnostics()
    assert diagnostics["max_physical_scan_rows"] == 2
    assert diagnostics["scan_limit_rejections"] == 1
    with pytest.raises(
        RawAggTradeScanLimitError,
        match="max_physical_scan_rows",
    ):
        archive.scan_range(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            start_agg_trade_id=2,
            end_agg_trade_id=2,
        )


def test_archive_disabled_and_missing_engine_boundaries(tmp_path, monkeypatch) -> None:
    disabled = DisabledRawAggTradeArchive()
    assert disabled.append([_raw_trade(1, trade_time_ms=START_MS)]) == 0
    assert disabled.scan_range(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    ) == []
    assert disabled.diagnostics()["enabled"] is False

    def _missing_engine():
        raise ModuleNotFoundError("No module named 'pyarrow'")

    monkeypatch.setattr(archive_module, "_load_pyarrow", _missing_engine)
    with pytest.raises(RuntimeError, match="pyarrow.*disable raw trade archival"):
        ParquetRawAggTradeArchive(tmp_path / "missing")


class _SlowArchive:
    enabled = True

    def __init__(self) -> None:
        self.worker_thread_id: int | None = None

    def append(self, rows) -> int:
        copied = list(rows)
        self.worker_thread_id = threading.get_ident()
        time.sleep(0.05)
        return len(copied)

    def diagnostics(self) -> dict:
        return {"enabled": True, "backend": "slow-test"}


@_async_test
async def test_raw_archive_writer_keeps_disk_io_off_event_loop() -> None:
    archive = _SlowArchive()
    writer = RawAggTradeArchiveWriter(archive, flush_interval_seconds=0)
    event_loop_thread_id = threading.get_ident()
    write_task = asyncio.create_task(
        writer.write([_raw_trade(1, trade_time_ms=START_MS)])
    )
    await asyncio.sleep(0.01)
    assert not write_task.done()
    assert await write_task == 1
    assert archive.worker_thread_id != event_loop_thread_id
    await writer.close()


@_async_test
async def test_raw_archive_enqueue_returns_before_debounced_durable_ack() -> None:
    archive = _SlowArchive()
    writer = RawAggTradeArchiveWriter(
        archive,
        flush_interval_seconds=0.1,
    )

    acknowledgement = await asyncio.wait_for(
        writer.enqueue([_raw_trade(1, trade_time_ms=START_MS)]),
        timeout=0.05,
    )
    assert acknowledgement is not None
    assert not acknowledgement.done()
    assert await asyncio.wait_for(acknowledgement, timeout=0.5) == 1
    await writer.close()


class _FlakyArchive:
    enabled = True

    def __init__(self, failures: int) -> None:
        self.failures = failures
        self.calls = 0
        self.durability_error: str | None = None

    def append(self, rows) -> int:
        copied = list(rows)
        self.calls += 1
        if self.calls <= self.failures:
            raise OSError(f"disk failure {self.calls}")
        return len(copied)

    def record_writer_failure(self, error: str) -> None:
        self.durability_error = error

    def diagnostics(self) -> dict:
        return {
            "enabled": True,
            "backend": "flaky-test",
            "durability_error": self.durability_error,
        }


@_async_test
async def test_raw_archive_writer_retries_then_acknowledges_success() -> None:
    archive = _FlakyArchive(failures=2)
    writer = RawAggTradeArchiveWriter(
        archive,  # type: ignore[arg-type]
        flush_interval_seconds=0,
        max_write_attempts=3,
        retry_base_seconds=0,
    )

    assert await writer.write([_raw_trade(1, trade_time_ms=START_MS)]) == 1
    diagnostics = writer.diagnostics()
    assert archive.calls == 3
    assert diagnostics["retry_attempts"] == 2
    assert diagnostics["write_failures"] == 2
    assert diagnostics["failed_batches"] == 0
    assert diagnostics["state"] == "running"
    await writer.close()


@_async_test
async def test_raw_archive_writer_exhaustion_is_sticky_and_fail_closed(
    tmp_path,
    monkeypatch,
) -> None:
    pytest.importorskip("pyarrow")
    archive = ParquetRawAggTradeArchive(tmp_path / "raw-trades")

    def _fail(_rows) -> int:
        raise OSError("disk full")

    monkeypatch.setattr(archive, "append", _fail)
    writer = RawAggTradeArchiveWriter(
        archive,
        flush_interval_seconds=0,
        max_write_attempts=2,
        retry_base_seconds=0,
    )

    with pytest.raises(OSError, match="disk full"):
        await writer.write([_raw_trade(1, trade_time_ms=START_MS)])
    diagnostics = writer.diagnostics()
    assert diagnostics["state"] == "failed"
    assert diagnostics["failed_batches"] == 1
    assert diagnostics["failed_rows"] == 1
    assert diagnostics["retry_attempts"] == 1
    coverage = archive.coverage(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        expected_start_agg_trade_id=1,
        expected_end_agg_trade_id=1,
    )
    assert coverage.status == "degraded"
    assert coverage.complete is False
    assert "disk full" in str(coverage.error)
    await writer.close()

    marker = tmp_path / "raw-trades" / "_archive_health.json"
    assert marker.is_file()

    # A fresh backend instance must retain the failure boundary, including
    # after a later append succeeds.  Recovery requires an explicit operator
    # workflow; normal writes never erase the marker.
    restarted = ParquetRawAggTradeArchive(tmp_path / "raw-trades")
    assert restarted.diagnostics()["state"] == "degraded"
    restarted.append([_raw_trade(2, trade_time_ms=START_MS + 1)])
    assert restarted.diagnostics()["state"] == "degraded"
    restarted_coverage = restarted.coverage(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        expected_start_agg_trade_id=2,
        expected_end_agg_trade_id=2,
    )
    assert restarted_coverage.status == "degraded"
    assert restarted_coverage.complete is False
    assert "disk full" in str(restarted_coverage.error)


@_async_test
async def test_health_marker_write_failure_stays_degraded_without_task_crash(
    tmp_path,
    monkeypatch,
) -> None:
    pytest.importorskip("pyarrow")
    archive = ParquetRawAggTradeArchive(tmp_path / "raw-trades")

    def _append_failure(_rows) -> int:
        raise OSError("archive device unavailable")

    def _marker_failure(_error: str) -> None:
        raise OSError("marker device unavailable")

    monkeypatch.setattr(archive, "append", _append_failure)
    monkeypatch.setattr(archive, "_persist_health_marker", _marker_failure)
    writer = RawAggTradeArchiveWriter(
        archive,
        flush_interval_seconds=0,
        max_write_attempts=1,
    )

    with pytest.raises(OSError, match="archive device unavailable"):
        await writer.write([_raw_trade(1, trade_time_ms=START_MS)])
    diagnostics = writer.diagnostics()
    assert diagnostics["state"] == "failed"
    assert diagnostics["archive"]["state"] == "degraded"
    assert "failed to persist health marker" in str(
        diagnostics["archive"]["health_marker_error"],
    )
    await writer.close()
