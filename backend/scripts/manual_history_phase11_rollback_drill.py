"""Phase 11 rollback drill on a temporary KLINES_DB_PATH.

Create+seal a protected collection, disable the write flag, reopen DataManager,
run tiny-row-limit GC, prove verify_contiguous_range still holds, then show
collections remain readable after re-enable.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

STEP = 60_000
START = 1_700_000_040_000
BARS = 5


def _git_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "unknown"


def _row(open_time: int) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + STEP - 1,
        "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0,
        "volume": 1.0, "quote_volume": 1.0, "trades": 1,
        "taker_buy_base": 0.4, "taker_buy_quote": 0.4,
    }


async def _write_range(*, start_ms: int, end_ms: int, **kwargs) -> int:
    from app.data_engine.storage import klines_repo
    rows = []
    open_time = start_ms
    while open_time <= end_ms:
        rows.append(_row(open_time))
        open_time += STEP
    return klines_repo.upsert_klines(
        kwargs.get("symbol") or "BTCUSDT",
        kwargs.get("interval") or "1m",
        rows,
        source="binance",
        exchange="binance",
        market_type="spot",
    )


async def main() -> int:
    from app.core import config as core_config
    from app.data_engine.data_manager import DataManager
    from app.data_engine.data_manager.runtime_pressure import storage_file_snapshot
    from app.data_engine.manual_history.repository import ManualHistoryRepository
    from app.data_engine.manual_history.service import ManualHistoryService
    from app.data_engine.storage import klines_repo
    from app.data_engine.storage.klines_repo import KlinesRepoAdapter

    out_dir = REPOSITORY_ROOT / "docs" / "perf-baselines" / "manual-history"
    out_dir.mkdir(parents=True, exist_ok=True)
    date_stamp = datetime.now(timezone.utc).date().isoformat()
    commit = _git_head()

    with tempfile.TemporaryDirectory(prefix="manual-history-phase11-", ignore_cleanup_errors=True) as tmp:
        db_path = Path(tmp) / "klines.db"
        os.environ["KLINES_DB_PATH"] = str(db_path)
        os.environ["MANUAL_HISTORY_DOWNLOAD_ENABLED"] = "1"
        core_config.KLINES_DB_PATH = db_path
        klines_repo.KLINES_DB_PATH = db_path
        klines_repo.init_klines_storage()
        adapter = KlinesRepoAdapter()
        repo = ManualHistoryRepository(db_path)
        dm = DataManager()
        dm.set_storage(adapter)
        end_open = START + (BARS - 1) * STEP
        service = ManualHistoryService(
            repository=repo,
            data_manager=dm,
            storage=adapter,
            fetch_native=_write_range,
            enabled=True,
            clock_ms=lambda: START + BARS * STEP,
        )
        plan = {
            "can_start": True,
            "plan_hash": "sha256:phase11-rollback",
            "selection": {
                "exchange": "binance",
                "market_type": "spot",
                "symbols": ["BTCUSDT"],
                "intervals": ["1m"],
                "requested_start_ms": START,
                "target_count": 1,
            },
            "targets": [{
                "symbol": "BTCUSDT",
                "requested_interval": "1m",
                "canonical_interval": "1m",
                "route_kind": "NATIVE",
                "source_interval": "1m",
                "effective_start_ms": START,
                "initial_end_open_ms": end_open,
                "source_strategy": "REST",
                "estimated_target_rows": BARS,
                "estimated_source_rows": BARS,
                "existing_coverage": "NONE",
                "error": None,
                "boundary_reason": None,
            }],
            "storage": {},
        }
        created = service.create_from_plan(plan, idempotency_key="phase11-rollback")
        job = await service.run_job(created.job.job_id)
        sealed = adapter.verify_contiguous_range(
            "BTCUSDT", "1m", START, end_open, exchange="binance", market_type="spot",
        )
        if sealed.get("verified_contiguous") is not True:
            raise SystemExit(f"seal failed: {sealed}")

        # Flag off + restart DataManager (new process equivalent).
        os.environ["MANUAL_HISTORY_DOWNLOAD_ENABLED"] = "0"
        service.enabled = False
        reopened_dm = DataManager()
        reopened_dm.set_storage(KlinesRepoAdapter())
        reopened_dm.reload_durable_protections()
        floors = reopened_dm.durable_protections.clone()
        prefix = [_row(START - (20 - i) * STEP) for i in range(20)]
        for i, row in enumerate(prefix):
            row["open_time"] = 1_577_836_800_000 + i * STEP
            row["close_time"] = row["open_time"] + STEP - 1
        klines_repo.upsert_klines(
            "BTCUSDT", "1m", prefix, source="binance",
            exchange="binance", market_type="spot",
        )
        files = storage_file_snapshot(db_path)
        reopened_dm.update_retention_limits(
            db_limits={"minutes": 1, "hours": 0, "daily": 0},
            storage_row_limits_enabled=True,
        )
        gc = await reopened_dm.run_storage_gc(file_snapshot=files, batch_size=1_000)
        after = adapter.verify_contiguous_range(
            "BTCUSDT", "1m", START, end_open, exchange="binance", market_type="spot",
        )
        os.environ["MANUAL_HISTORY_DOWNLOAD_ENABLED"] = "1"
        reopened_repo = ManualHistoryRepository(db_path)
        collections = reopened_repo.list_collections()
        payload = {
            "schema": "candlescope.manual-history.phase11-rollback.v1",
            "git_commit": commit,
            "protection_aware_floor_commit": "ff0ec9fab77ed79d362a815ed3c7a1f052cb1ee6",
            "earliest_legal_backend_rollback": "ff0ec9fab77ed79d362a815ed3c7a1f052cb1ee6",
            "MANUAL_HISTORY_DOWNLOAD_ENABLED_default": 0,
            "klines_db_path": str(db_path.resolve()),
            "production_db": False,
            "job_state": job.state.value,
            "sealed_before_flag_off": sealed,
            "floors_after_restart": len(floors),
            "gc_deleted_rows": gc.get("deleted_rows"),
            "sealed_after_gc_flag_off": after,
            "collections_readable_after_reenable": [
                {"collection_id": item.collection_id, "status": item.status.value}
                for item in collections
            ],
            "flags": {
                "disable_manual_download": "stops new jobs; durable protections remain",
                "disable_history_archive": "ZIP off; REST continuity path remains",
                "schema": "forward-only; rollback must not DROP protection tables",
            },
            "enable_method": (
                "set MANUAL_HISTORY_DOWNLOAD_ENABLED=1 in the process environment "
                "and restart the LIVE backend"
            ),
        }
        path = out_dir / f"phase11-rollback-{date_stamp}.json"
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(payload, indent=2))
        if after.get("verified_contiguous") is not True:
            raise SystemExit("GC crossed protected floor after flag-off restart")
        if not collections:
            raise SystemExit("collections disappeared after flag-off restart")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
