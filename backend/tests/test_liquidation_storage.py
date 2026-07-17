from __future__ import annotations

import asyncio
import sqlite3
from functools import wraps

import pytest

from app.data_engine.storage.liquidation_store import (
    LiquidationRollupStore,
    SQLiteLiquidationRollupStore,
    init_liquidation_storage,
)
from app.data_engine.storage.liquidation_writer import LiquidationRollupWriter


MINUTE = 60_000
START_MS = 1_700_000_040_000


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _rollup(
    bucket_open_ms: int = START_MS,
    *,
    position_side: str = "long",
    revision: int = 100,
    received_at_ms: int | None = None,
    is_final: bool = False,
    filled_quantity: float = 2.0,
    filled_notional: float = 200.0,
) -> dict:
    received = revision if received_at_ms is None else received_at_ms
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "bucket_open_ms": bucket_open_ms,
        "bucket_close_ms": bucket_open_ms + MINUTE,
        "position_side": position_side,
        "filled_quantity": filled_quantity,
        "filled_notional": filled_notional,
        "event_count": 2,
        "max_event_notional": min(filled_notional, 120.0),
        "first_event_time_ms": bucket_open_ms + 1_000,
        "last_event_time_ms": bucket_open_ms + 50_000,
        "is_final": is_final,
        "revision": revision,
        "source": "websocket",
        "received_at_ms": received,
    }


@_async_test
async def test_sqlite_store_schema_revision_finality_side_filter_and_ordering(
    tmp_path,
) -> None:
    db_path = tmp_path / "liquidation.sqlite"
    init_liquidation_storage(db_path)
    with sqlite3.connect(db_path) as conn:
        columns = conn.execute(
            "PRAGMA table_info(liquidation_rollup_1m)"
        ).fetchall()
    primary_key = [row[1] for row in columns if row[5]]
    assert primary_key == [
        "exchange",
        "market_type",
        "symbol",
        "bucket_open_ms",
        "position_side",
    ]

    store = SQLiteLiquidationRollupStore(db_path)
    assert isinstance(store, LiquidationRollupStore)
    await store.upsert_rollups(
        [
            _rollup(START_MS, position_side="long", revision=100),
            _rollup(
                START_MS,
                position_side="short",
                revision=100,
                filled_notional=150.0,
            ),
            _rollup(START_MS + MINUTE, position_side="long", revision=100),
            _rollup(START_MS + 2 * MINUTE, position_side="long", revision=100),
        ]
    )

    # Newer receive time wins.  At equal receive time, revision breaks the tie.
    await store.upsert_rollups(
        [
            _rollup(
                START_MS,
                position_side="long",
                revision=200,
                received_at_ms=200,
                filled_notional=300.0,
            ),
            _rollup(
                START_MS,
                position_side="long",
                revision=199,
                received_at_ms=200,
                filled_notional=999.0,
            ),
        ]
    )
    row = (
        await store.query_rollups(
            exchange=" BINANCE ",
            market_type=" FUTURES ",
            symbol=" btcusdt ",
            start_ms=START_MS,
            end_ms=START_MS,
            position_side=" LONG ",
        )
    )[0]
    assert row["filled_notional"] == 300.0
    assert row["revision"] == 200

    await store.upsert_rollups(
        [
            _rollup(
                START_MS,
                position_side="long",
                revision=300,
                received_at_ms=300,
                is_final=True,
                filled_notional=400.0,
            )
        ]
    )
    await store.upsert_rollups(
        [
            _rollup(
                START_MS,
                position_side="long",
                revision=400,
                received_at_ms=400,
                is_final=False,
                filled_notional=999.0,
            )
        ]
    )
    final = (
        await store.query_rollups(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            start_ms=START_MS,
            end_ms=START_MS,
            position_side="long",
        )
    )[0]
    assert final["filled_notional"] == 400.0
    assert final["is_final"] == 1
    assert final["revision"] == 300

    history = await store.query_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        position_side="long",
        limit=2,
    )
    recent = await store.query_recent_rollups(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        position_side="long",
        limit=2,
    )
    assert [item["bucket_open_ms"] for item in history] == [
        START_MS,
        START_MS + MINUTE,
    ]
    assert [item["bucket_open_ms"] for item in recent] == [
        START_MS + MINUTE,
        START_MS + 2 * MINUTE,
    ]
    diagnostics = await store.diagnostics()
    assert diagnostics["backend"] == "sqlite"
    assert diagnostics["state"] == "ready"
    assert diagnostics["rollups"]["rows"] == 4
    assert diagnostics["rollups"]["long_rows"] == 3
    assert diagnostics["rollups"]["short_rows"] == 1


@pytest.mark.parametrize(
    "change, message",
    [
        ({"bucket_open_ms": START_MS + 1}, "aligned to one minute"),
        ({"bucket_close_ms": START_MS + MINUTE + 1}, "must equal"),
        ({"position_side": "flat"}, "long.*short"),
        ({"filled_quantity": -1}, "cannot be negative"),
        ({"filled_notional": float("nan")}, "must be finite"),
        ({"event_count": 1.5}, "non-negative integer"),
        ({"max_event_notional": -1}, "cannot be negative"),
        (
            {
                "first_event_time_ms": START_MS + 10,
                "last_event_time_ms": START_MS + 9,
            },
            "cannot exceed",
        ),
        ({"is_final": "yes"}, "must be a boolean"),
    ],
)
def test_sqlite_store_validates_rollup_rows(tmp_path, change, message) -> None:
    async def _exercise() -> None:
        store = SQLiteLiquidationRollupStore(tmp_path / "invalid.sqlite")
        row = _rollup()
        row.update(change)
        if "bucket_open_ms" in change and "bucket_close_ms" not in change:
            row["bucket_close_ms"] = row["bucket_open_ms"] + MINUTE
        with pytest.raises(ValueError, match=message):
            await store.upsert_rollups([row])

    asyncio.run(_exercise())


@_async_test
async def test_sqlite_store_validates_queries_and_close_boundary(tmp_path) -> None:
    store = SQLiteLiquidationRollupStore(tmp_path / "boundary.sqlite")
    with pytest.raises(ValueError, match="start_ms cannot exceed end_ms"):
        await store.query_rollups(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            start_ms=START_MS + MINUTE,
            end_ms=START_MS,
        )
    with pytest.raises(ValueError, match="long.*short"):
        await store.query_recent_rollups(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            position_side="both",
        )
    with pytest.raises(ValueError, match="positive integer"):
        await store.query_recent_rollups(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            limit=0,
        )

    await store.upsert_rollups([_rollup()])
    await store.close()
    assert (await store.diagnostics())["state"] == "closed"
    with pytest.raises(RuntimeError, match="store is closed"):
        await store.query_rollups(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
        )
    with pytest.raises(RuntimeError, match="store is closed"):
        await store.upsert_rollups([_rollup()])


@_async_test
async def test_writer_coalesces_per_side_evicts_and_flushes_on_close(tmp_path) -> None:
    store = SQLiteLiquidationRollupStore(tmp_path / "writer.sqlite")
    writer = LiquidationRollupWriter(
        store,
        flush_interval_seconds=60,
        max_pending_provisional=2,
    )
    assert writer.offer(_rollup(position_side="long", revision=100)) is True
    assert writer.offer(_rollup(position_side="long", revision=200)) is True
    assert writer.offer(_rollup(position_side="short", revision=100)) is True
    assert (
        writer.offer(
            _rollup(
                START_MS + MINUTE,
                position_side="long",
                revision=100,
            )
        )
        is True
    )
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
    # The long and short rows are distinct keys.  With capacity two, adding the
    # next minute evicts the oldest retained key (the coalesced long row).
    assert [(row["bucket_open_ms"], row["position_side"]) for row in rows] == [
        (START_MS, "short"),
        (START_MS + MINUTE, "long"),
    ]
    diagnostics = writer.diagnostics()
    assert diagnostics["state"] == "closed"
    assert diagnostics["coalesced"] == 1
    assert diagnostics["provisional_evicted"] == 1
    assert diagnostics["offer_rejected_final"] == 1


@_async_test
async def test_writer_durable_write_bypasses_provisional_timer() -> None:
    class _MemoryStore:
        def __init__(self) -> None:
            self.calls: list[list[dict]] = []

        async def upsert_rollups(self, rows) -> int:
            copied = list(rows)
            self.calls.append(copied)
            return len(copied)

    store = _MemoryStore()
    writer = LiquidationRollupWriter(  # type: ignore[arg-type]
        store,
        flush_interval_seconds=10,
    )
    written = await asyncio.wait_for(
        writer.write([_rollup(revision=1, is_final=True)]),
        timeout=0.25,
    )
    assert written == 1
    assert len(store.calls) == 1
    await writer.close()


@_async_test
async def test_writer_enqueue_returns_before_slow_storage_ack() -> None:
    class _BlockingStore:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def upsert_rollups(self, rows) -> int:
            copied = list(rows)
            self.started.set()
            await self.release.wait()
            return len(copied)

    store = _BlockingStore()
    writer = LiquidationRollupWriter(  # type: ignore[arg-type]
        store,
        flush_interval_seconds=10,
    )
    acknowledgement = await writer.enqueue([_rollup(revision=1, is_final=True)])
    assert acknowledgement is not None
    await asyncio.wait_for(store.started.wait(), timeout=0.25)
    assert not acknowledgement.done()
    store.release.set()
    assert await asyncio.wait_for(acknowledgement, timeout=0.25) == 1
    await writer.close()


@_async_test
async def test_writer_retries_and_shutdown_drains_durable_ack() -> None:
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
    writer = LiquidationRollupWriter(  # type: ignore[arg-type]
        store,
        flush_interval_seconds=10,
        max_write_attempts=3,
        retry_base_seconds=0,
    )
    acknowledgement = await writer.enqueue([_rollup(revision=1, is_final=True)])
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
async def test_writer_exhaustion_is_sticky_and_ack_fails() -> None:
    class _FailedStore:
        def __init__(self) -> None:
            self.calls = 0

        async def upsert_rollups(self, rows) -> int:
            list(rows)
            self.calls += 1
            raise OSError("sqlite disk I/O error")

    store = _FailedStore()
    writer = LiquidationRollupWriter(  # type: ignore[arg-type]
        store,
        max_write_attempts=3,
        retry_base_seconds=0,
    )
    acknowledgement = await writer.enqueue([_rollup(revision=1, is_final=True)])
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
