"""Measure real SQLite K-line growth for manual history space estimates.

Phase 0 capacity evidence only.  The script refuses to open the live
``data/candlescope.db`` and always uses a temporary KLINES_DB_PATH.

It does not treat memory-GC ``BAR_ESTIMATED_BYTES=96`` as SQLite bytes/row.
Measured db/WAL/index physical growth is the estimate source.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import platform
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
FORBIDDEN_KLINES_DBS = (
    (BACKEND_ROOT / "data" / "candlescope.db").resolve(),
    (REPOSITORY_ROOT / "data" / "candlescope.db").resolve(),
)
SYMBOL = "BTCUSDT"
INTERVAL = "1m"
TARGET_INTERVAL = "89m"
EXCHANGE = "binance"
MARKET_TYPE = "spot"
SOURCE_MS = 60_000
TARGET_MS = 89 * SOURCE_MS
# Aligned to both 1m and 89m so derived buckets start on a closed boundary.
START_MS = 318_353 * TARGET_MS
NATIVE_SCALES = (10_000, 100_000, 1_000_000)
UPSERT_BATCH = 25_000
MATERIALIZE_BUCKETS_PER_CHUNK = 64
BOUNDED_DELETE_BATCHES = 10
BOUNDED_DELETE_KEEP_OFFSET = 10_000


class BenchmarkError(RuntimeError):
    """The benchmark would touch production storage or cannot proceed."""


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _git_head() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    head = completed.stdout.strip()
    if completed.returncode != 0 or not head:
        return "unknown"
    return head


def _filesystem_type(path: Path) -> str:
    if sys.platform != "win32":
        try:
            import os as _os

            st = _os.statvfs(str(path if path.exists() else path.parent))
            return f"posix-fs-namemax-{int(st.f_namemax)}"
        except OSError:
            return "unknown"
    try:
        import ctypes

        fs_name = ctypes.create_unicode_buffer(64)
        root = str(path.resolve().drive) + "\\"
        ok = ctypes.windll.kernel32.GetVolumeInformationW(
            root, None, 0, None, None, None, fs_name, 64
        )
        return fs_name.value if ok else "unknown"
    except OSError:
        return "unknown"


def _refuse_production_db(db_path: Path) -> None:
    resolved = db_path.resolve()
    for forbidden in FORBIDDEN_KLINES_DBS:
        if resolved == forbidden:
            raise BenchmarkError(
                f"refusing to benchmark against production KLINES_DB_PATH={resolved}"
            )
    if resolved.name == "candlescope.db" and "data" in resolved.parts:
        raise BenchmarkError(
            f"refusing to benchmark a candlescope.db under a data/ directory: {resolved}"
        )


def _configure_temp_klines_db(db_path: Path) -> None:
    _refuse_production_db(db_path)
    os.environ["KLINES_DB_PATH"] = str(db_path)
    os.environ["CANDLE_DATA_DIR"] = str(db_path.parent / "candle-data")


def _hardware_payload(db_path: Path) -> dict[str, Any]:
    memory_total: int | None
    try:
        import psutil

        memory_total = int(psutil.virtual_memory().total)
        cpu_freq = getattr(psutil.cpu_freq(), "current", None)
    except Exception:
        memory_total = None
        cpu_freq = None
    return {
        "hostname": platform.node(),
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cpu_count": os.cpu_count(),
        "cpu_freq_mhz": cpu_freq,
        "memory_total_bytes": memory_total,
        "python": sys.version,
        "python_executable": sys.executable,
        "sqlite": sqlite3.sqlite_version,
        "filesystem": _filesystem_type(db_path),
        "git_commit": _git_head(),
        "recorded_at": _utc_now(),
    }


def _build_native_rows(start_index: int, count: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index in range(start_index, start_index + count):
        open_time = START_MS + index * SOURCE_MS
        price = 50_000.0 + (index % 1_000) * 0.25
        volume = 1.0 + (index % 17) * 0.05
        rows.append(
            {
                "open_time": open_time,
                "close_time": open_time + SOURCE_MS - 1,
                "open": price,
                "high": price + 1.5,
                "low": price - 1.25,
                "close": price + 0.5,
                "volume": volume,
                "quote_volume": volume * price,
                "trades": 10 + (index % 9),
                "taker_buy_base": volume * 0.4,
                "taker_buy_quote": volume * 0.4 * price,
            }
        )
    return rows


def _upsert_native(
    klines_repo: Any,
    *,
    start_index: int,
    count: int,
    symbol: str = SYMBOL,
) -> dict[str, Any]:
    started = time.perf_counter()
    written = 0
    remaining = count
    cursor = start_index
    while remaining > 0:
        batch = min(UPSERT_BATCH, remaining)
        rows = _build_native_rows(cursor, batch)
        written += int(
            klines_repo.upsert_klines(
                symbol,
                INTERVAL,
                rows,
                source=EXCHANGE,
                exchange=EXCHANGE,
                market_type=MARKET_TYPE,
            )
        )
        cursor += batch
        remaining -= batch
        if count >= 100_000 and (cursor - start_index) % 100_000 == 0:
            print(
                f"native upsert {cursor - start_index}/{count}",
                file=sys.stderr,
                flush=True,
            )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return {
        "requested_rows": count,
        "upsert_reported_changes": written,
        "elapsed_ms": round(elapsed_ms, 3),
        "rows_per_second": round(count / (elapsed_ms / 1000.0), 3) if elapsed_ms else None,
    }


def _compact_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "db_size_bytes",
        "wal_size_bytes",
        "shm_size_bytes",
        "physical_size_bytes",
        "total_size_bytes",
        "page_size_bytes",
        "page_count",
        "freelist_count",
        "klines_managed_bytes",
        "file_set_stable",
    )
    compact = {key: snapshot.get(key) for key in keys}
    compact["bytes_per_row_note"] = (
        "physical_size_bytes / row_count; do not use BAR_ESTIMATED_BYTES=96"
    )
    return compact


def _bytes_per_row(physical_size_bytes: Any, row_count: int) -> float | None:
    if not isinstance(physical_size_bytes, (int, float)) or row_count <= 0:
        return None
    return round(float(physical_size_bytes) / float(row_count), 3)


def _count_rows(klines_repo: Any, interval: str, symbol: str = SYMBOL) -> int:
    with klines_repo._connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM klines "
            "WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?",
            (EXCHANGE, MARKET_TYPE, symbol, interval),
        ).fetchone()
    return int(row["cnt"] if row is not None else 0)


def _materialize_89m(klines_repo: Any, aggregate_kline_rows: Any) -> dict[str, Any]:
    source_count = _count_rows(klines_repo, INTERVAL)
    complete_buckets = source_count // 89
    now_ms = START_MS + source_count * SOURCE_MS + TARGET_MS
    started = time.perf_counter()
    peak_physical = 0
    written = 0
    rebuilt_total = 0
    from app.data_engine.data_manager.runtime_pressure import (
        process_memory_snapshot,
        storage_file_snapshot,
    )

    peak_rss = process_memory_snapshot()
    chunk_source_rows = MATERIALIZE_BUCKETS_PER_CHUNK * 89
    offset = 0
    while offset < complete_buckets * 89:
        start_ms = START_MS + offset * SOURCE_MS
        end_ms = START_MS + min(offset + chunk_source_rows, complete_buckets * 89) * SOURCE_MS - SOURCE_MS
        components = klines_repo.query_klines(
            SYMBOL,
            INTERVAL,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=EXCHANGE,
            market_type=MARKET_TYPE,
        )
        rebuilt = aggregate_kline_rows(
            components,
            target_interval=TARGET_INTERVAL,
            source_interval=INTERVAL,
            now_ms=now_ms,
        )
        rebuilt_total += len(rebuilt)
        if rebuilt:
            written += int(
                klines_repo.upsert_klines(
                    SYMBOL,
                    TARGET_INTERVAL,
                    rebuilt,
                    source=EXCHANGE,
                    exchange=EXCHANGE,
                    market_type=MARKET_TYPE,
                )
            )
        files = storage_file_snapshot(klines_repo.KLINES_DB_PATH)
        physical = int(files.get("physical_size_bytes") or 0)
        peak_physical = max(peak_physical, physical)
        rss = process_memory_snapshot()
        current_rss = int(rss.get("rss_bytes") or rss.get("working_set_bytes") or 0)
        peak_rss_bytes = int(
            peak_rss.get("rss_bytes") or peak_rss.get("working_set_bytes") or 0
        )
        if current_rss > peak_rss_bytes:
            peak_rss = rss
        offset += chunk_source_rows

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    target_count = _count_rows(klines_repo, TARGET_INTERVAL)
    return {
        "source_rows": source_count,
        "complete_source_buckets": complete_buckets,
        "rebuilt_rows": rebuilt_total,
        "upsert_reported_changes": written,
        "stored_target_rows": target_count,
        "elapsed_ms": round(elapsed_ms, 3),
        "peak_physical_size_bytes": peak_physical,
        "peak_process_memory": peak_rss,
        "aggregator": "app.data_engine.interval_policy.aggregate_kline_rows",
    }


def _bounded_delete_and_checkpoint(
    klines_repo: Any,
    *,
    symbol: str,
    keep: int,
    batches: int,
) -> dict[str, Any]:
    from app.data_engine.data_manager.runtime_pressure import storage_file_snapshot

    before = storage_file_snapshot(klines_repo.KLINES_DB_PATH)
    native_before = _count_rows(klines_repo, INTERVAL, symbol=symbol)
    deleted = 0
    interrupted: str | None = None
    started = time.perf_counter()
    try:
        for _ in range(batches):
            deleted += int(
                klines_repo.delete_oldest_klines_batch(
                    symbol,
                    INTERVAL,
                    keep=keep,
                    batch_size=1_000,
                    exchange=EXCHANGE,
                    market_type=MARKET_TYPE,
                )
            )
    except sqlite3.OperationalError as exc:
        interrupted = str(exc)
    after_delete = storage_file_snapshot(klines_repo.KLINES_DB_PATH)
    checkpoint = klines_repo.wal_checkpoint_truncate()
    after_checkpoint = storage_file_snapshot(klines_repo.KLINES_DB_PATH)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return {
        "symbol": symbol,
        "native_rows_before": native_before,
        "native_rows_after": _count_rows(klines_repo, INTERVAL, symbol=symbol),
        "deleted_rows": deleted,
        "keep": keep,
        "batches": batches,
        "interrupted": interrupted,
        "elapsed_ms": round(elapsed_ms, 3),
        "files_before": _compact_snapshot(before),
        "files_after_delete": _compact_snapshot(after_delete),
        "checkpoint": checkpoint,
        "files_after_checkpoint": _compact_snapshot(after_checkpoint),
    }


def run_benchmark(db_path: Path) -> dict[str, Any]:
    _configure_temp_klines_db(db_path)
    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))

    from app.core import config as core_config
    from app.data_engine.interval_policy import aggregate_kline_rows
    from app.data_engine.storage import klines_repo
    from app.data_engine.data_manager.runtime_pressure import storage_file_snapshot

    core_config.KLINES_DB_PATH = db_path
    klines_repo.KLINES_DB_PATH = db_path
    _refuse_production_db(Path(klines_repo.KLINES_DB_PATH))
    _refuse_production_db(Path(core_config.KLINES_DB_PATH))

    klines_repo.init_klines_storage()
    empty = storage_file_snapshot(db_path)

    growth: dict[str, Any] = {}
    inserted = 0
    for scale in NATIVE_SCALES:
        additional = scale - inserted
        upsert = _upsert_native(klines_repo, start_index=inserted, count=additional)
        inserted = scale
        files = storage_file_snapshot(db_path)
        physical = files.get("physical_size_bytes")
        growth[str(scale)] = {
            "row_count": _count_rows(klines_repo, INTERVAL),
            "upsert": upsert,
            "files": _compact_snapshot(files),
            "measured_physical_bytes_per_row": _bytes_per_row(physical, scale),
            "bar_estimated_bytes_96_used": False,
        }

    replay_before = storage_file_snapshot(db_path)
    replay = _upsert_native(klines_repo, start_index=0, count=100_000)
    replay_after = storage_file_snapshot(db_path)

    materialization = _materialize_89m(klines_repo, aggregate_kline_rows)
    after_materialization = storage_file_snapshot(db_path)
    large_bounded = _bounded_delete_and_checkpoint(
        klines_repo,
        symbol=SYMBOL,
        keep=max(0, _count_rows(klines_repo, INTERVAL) - BOUNDED_DELETE_KEEP_OFFSET),
        batches=BOUNDED_DELETE_BATCHES,
    )
    small_symbol = "BENCHUSDT"
    _upsert_native(klines_repo, start_index=0, count=20_000, symbol=small_symbol)
    small_bounded = _bounded_delete_and_checkpoint(
        klines_repo,
        symbol=small_symbol,
        keep=10_000,
        batches=BOUNDED_DELETE_BATCHES,
    )

    return {
        "schema": "candlescope.manual-history.phase0-storage.v1",
        "klines_db_path": str(Path(klines_repo.KLINES_DB_PATH).resolve()),
        "production_klines_db_opened": False,
        "hardware": _hardware_payload(db_path),
        "empty_schema": _compact_snapshot(empty),
        "native_growth": growth,
        "upsert_replay": {
            "replayed_rows": 100_000,
            "upsert": replay,
            "files_before": _compact_snapshot(replay_before),
            "files_after": _compact_snapshot(replay_after),
            "physical_delta_bytes": int(replay_after.get("physical_size_bytes") or 0)
            - int(replay_before.get("physical_size_bytes") or 0),
        },
        "materialization_1m_to_89m": {
            **materialization,
            "files_after": _compact_snapshot(after_materialization),
        },
        "bounded_delete_checkpoint": {
            "large_1m_series": large_bounded,
            "small_20k_series": small_bounded,
        },
        "notes": [
            "Do not use memory-GC BAR_ESTIMATED_BYTES=96 as SQLite bytes/row.",
            "Space estimates must use measured physical_size_bytes / row_count.",
            "This run used a temporary KLINES_DB_PATH and did not open data/candlescope.db.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Baseline JSON path. Defaults to docs/perf-baselines/manual-history/phase0-storage-<date>.json",
    )
    args = parser.parse_args(argv)
    date_stamp = datetime.now(timezone.utc).date().isoformat()
    output = args.output or (
        REPOSITORY_ROOT
        / "docs"
        / "perf-baselines"
        / "manual-history"
        / f"phase0-storage-{date_stamp}.json"
    )
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix="manual-history-phase0-",
        ignore_cleanup_errors=True,
    ) as tmp:
        db_path = Path(tmp) / "klines.db"
        report = run_benchmark(db_path)
        if Path(report["klines_db_path"]).resolve() in FORBIDDEN_KLINES_DBS:
            raise BenchmarkError("report path resolved to production candlescope.db")
        output.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(json.dumps({"output": str(output), "klines_db_path": report["klines_db_path"]}, indent=2))
        gc.collect()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkError as exc:
        print(f"benchmark aborted: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
