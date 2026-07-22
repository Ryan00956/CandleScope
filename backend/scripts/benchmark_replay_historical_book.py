"""Benchmark verified historical-book import and exact projection reconstruction."""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
import tempfile
import time
import tracemalloc
from contextlib import closing
from hashlib import sha256
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.canonical import canonical_sha256  # noqa: E402
from app.replay.storage import ReplaySQLiteStore  # noqa: E402
from app.replay.training.historical_book import (  # noqa: E402
    ARCHIVE_PROTOCOL,
    ARCHIVE_SCHEMA_VERSION,
    ARCHIVE_SOURCE_CONTRACT_URL,
    BOOK_EXECUTION_FIDELITY,
    HistoricalBookArchiveManager,
    verify_historical_book_archive,
)
from app.replay.training.schema import migrate_training_schema  # noqa: E402


START_MS = 1_700_000_000_000
SNAPSHOT_UPDATE_ID = 1_000_000


def _levels(value: list[list[str]]) -> str:
    return json.dumps(value, separators=(",", ":"))


def _delta_rows(frames: int):
    previous_u = SNAPSHOT_UPDATE_ID
    for ordinal in range(1, frames + 1):
        final_u = previous_u + 1
        if ordinal % 2:
            bids = [["99", "0"], ["99.5", "20"]]
            asks = [["101", "0"], ["101.5", "20"]]
        else:
            bids = [["99.5", "0"], ["99", "20"]]
            asks = [["101.5", "0"], ["101", "20"]]
        yield (
            ordinal,
            "DELTA",
            START_MS + ordinal,
            START_MS + ordinal,
            previous_u if ordinal == 1 else final_u,
            final_u,
            previous_u,
            _levels(bids),
            _levels(asks),
        )
        previous_u = final_u


def _build_archive(path: Path, *, frames: int) -> None:
    dataset_epoch = "sha256:" + sha256(
        f"historical-book-benchmark:{frames}:v1".encode()
    ).hexdigest()
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE archive_meta (
                singleton INTEGER PRIMARY KEY,
                protocol TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                range_start_ms INTEGER NOT NULL,
                range_end_ms INTEGER NOT NULL,
                dataset_epoch TEXT NOT NULL,
                source TEXT NOT NULL,
                source_contract_url TEXT NOT NULL,
                max_depth_levels INTEGER NOT NULL
            );
            CREATE TABLE book_frame (
                ordinal INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                event_time_ms INTEGER NOT NULL,
                transaction_time_ms INTEGER NOT NULL,
                first_update_id INTEGER,
                final_update_id INTEGER NOT NULL,
                previous_final_update_id INTEGER,
                bids_json TEXT NOT NULL,
                asks_json TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO archive_meta VALUES (
                1, ?, ?, 'binance', 'futures', 'BTCUSDT', ?, ?, ?,
                'BINANCE_USDM_DIFF_DEPTH_CAPTURE', ?, 1000
            )
            """,
            (
                ARCHIVE_PROTOCOL,
                ARCHIVE_SCHEMA_VERSION,
                START_MS,
                START_MS + frames,
                dataset_epoch,
                ARCHIVE_SOURCE_CONTRACT_URL,
            ),
        )
        connection.execute(
            """
            INSERT INTO book_frame VALUES (
                0, 'SNAPSHOT', ?, ?, NULL, ?, NULL, ?, ?
            )
            """,
            (
                START_MS,
                START_MS,
                SNAPSHOT_UPDATE_ID,
                _levels([["99", "20"], ["98", "30"]]),
                _levels([["101", "20"], ["102", "30"]]),
            ),
        )
        connection.executemany(
            "INSERT INTO book_frame VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            _delta_rows(frames),
        )
        connection.commit()


async def _benchmark(*, frames: int, max_python_heap_bytes: int) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="replay-phase9-benchmark-") as raw_root:
        root = Path(raw_root)
        source = root / "trusted-source.sqlite3"
        build_started = time.perf_counter()
        _build_archive(source, frames=frames)
        build_seconds = time.perf_counter() - build_started

        verify_started = time.perf_counter()
        verified = verify_historical_book_archive(
            source,
            trusted_origin="PHASE9_BENCHMARK",
        )
        verify_seconds = time.perf_counter() - verify_started

        store = ReplaySQLiteStore(root / "replay.db", now_ms=lambda: START_MS)
        await store.run_extension_write(
            lambda connection: migrate_training_schema(
                connection,
                now_ms=START_MS,
            )
        )
        manager = HistoricalBookArchiveManager(
            store,
            enabled=True,
            max_archive_bytes=max(verified.byte_size * 2, 1),
            root=root / "owned",
        )
        await manager.start()
        try:
            import_started = time.perf_counter()
            imported = await manager.import_archive(
                source,
                trusted_origin="PHASE9_BENCHMARK",
            )
            import_seconds = time.perf_counter() - import_started

            cache_key = ("benchmark-run", "benchmark-track")
            prime_started = time.perf_counter()
            await manager.prepare_binding(
                exchange="binance",
                market_type="futures",
                symbol="BTCUSDT",
                range_start_ms=START_MS,
                range_end_ms=START_MS + frames,
                actual_time_ms=START_MS,
                virtual_time_ms=START_MS,
                projection_cache_key=cache_key,
            )
            initial_projection_seconds = time.perf_counter() - prime_started

            projection_started = time.perf_counter()
            cold = await manager.prepare_binding(
                exchange="binance",
                market_type="futures",
                symbol="BTCUSDT",
                range_start_ms=START_MS,
                range_end_ms=START_MS + frames,
                actual_time_ms=START_MS + frames,
                virtual_time_ms=START_MS + frames,
                projection_cache_key=cache_key,
            )
            cold_projection_seconds = time.perf_counter() - projection_started

            repeat_started = time.perf_counter()
            repeated = await manager.prepare_binding(
                exchange="binance",
                market_type="futures",
                symbol="BTCUSDT",
                range_start_ms=START_MS,
                range_end_ms=START_MS + frames,
                actual_time_ms=START_MS + frames,
                virtual_time_ms=START_MS + frames,
                projection_cache_key=cache_key,
            )
            repeat_projection_seconds = time.perf_counter() - repeat_started
        finally:
            await store.close()

        _current_heap, peak_python_heap_bytes = tracemalloc.get_traced_memory()
        projection = cold.projection
        projection_storage = projection.to_storage()
        deterministic = {
            "frames": frames,
            "archive_id": verified.archive_id,
            "checksum_sha256": verified.checksum_sha256,
            "snapshot_count": verified.snapshot_count,
            "delta_count": verified.delta_count,
            "last_update_id": projection.last_update_id,
            "book_hash": projection.book_hash,
            "repeat_book_hash": repeated.projection.book_hash,
            "execution_fidelity": BOOK_EXECUTION_FIDELITY,
            "queue_exact": False,
        }
        checks = {
            "verified_frame_count": verified.delta_count == frames,
            "import_identity_match": imported["archive_id"] == verified.archive_id,
            "final_sequence_match": (
                projection.last_update_id == SNAPSHOT_UPDATE_ID + frames
            ),
            "deterministic_repeat": (
                repeated.projection.book_hash == projection.book_hash
            ),
            "book_nonempty_and_uncrossed": (
                bool(projection.bids)
                and bool(projection.asks)
                and float(projection.bids[0][0]) < float(projection.asks[0][0])
            ),
            "python_heap_within_budget": (
                peak_python_heap_bytes <= max_python_heap_bytes
            ),
            "queue_exact_not_claimed": (
                projection_storage["queue_exact"] == 0
                and projection_storage["execution_fidelity"]
                == BOOK_EXECUTION_FIDELITY
            ),
        }
        return {
            "schema_version": "replay.historical-book.benchmark.v1",
            "parameters": {
                "frames": frames,
                "max_python_heap_bytes": max_python_heap_bytes,
            },
            "archive": {
                "bytes": verified.byte_size,
                "snapshot_count": verified.snapshot_count,
                "delta_count": verified.delta_count,
                "checksum_sha256": verified.checksum_sha256,
            },
            "timings_seconds": {
                "fixture_build": round(build_seconds, 6),
                "full_verify": round(verify_seconds, 6),
                "verified_import": round(import_seconds, 6),
                "initial_snapshot_projection": round(
                    initial_projection_seconds,
                    6,
                ),
                "cold_end_projection": round(cold_projection_seconds, 6),
                "repeat_end_projection": round(repeat_projection_seconds, 6),
            },
            "throughput": {
                "verify_frames_per_second": round(frames / verify_seconds, 2),
                "cold_projection_frames_per_second": round(
                    frames / cold_projection_seconds,
                    2,
                ),
            },
            "resources": {
                "peak_python_heap_bytes": peak_python_heap_bytes,
                "archive_bytes_per_delta": round(verified.byte_size / frames, 2),
            },
            "correctness": deterministic,
            "acceptance": {
                "checks": checks,
                "passed": all(checks.values()),
                "timing_threshold_frozen": False,
            },
            "deterministic_evidence_hash": canonical_sha256(deterministic),
        }


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", type=int, default=100_000)
    parser.add_argument(
        "--max-python-heap-bytes",
        type=int,
        default=512 * 1024 * 1024,
    )
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if not 1 <= args.frames <= 1_000_000:
        parser.error("--frames must be between 1 and 1000000")
    if args.max_python_heap_bytes < 1:
        parser.error("--max-python-heap-bytes must be positive")
    return args


def main() -> int:
    args = _arguments()
    tracemalloc.start()
    report = asyncio.run(
        _benchmark(
            frames=args.frames,
            max_python_heap_bytes=args.max_python_heap_bytes,
        )
    )
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.out is not None:
        output = args.out.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["acceptance"]["passed"] else 2  # type: ignore[index]


if __name__ == "__main__":
    raise SystemExit(main())
