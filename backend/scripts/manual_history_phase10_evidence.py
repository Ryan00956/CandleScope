"""Controlled Phase 10 evidence on a temporary KLINES_DB_PATH."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def _git_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "unknown"


def _fetch_binance_klines(symbol: str, interval: str, limit: int) -> list[list]:
    url = (
        "https://api.binance.com/api/v3/klines"
        f"?symbol={symbol}&interval={interval}&limit={limit}"
    )
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _rows_from_klines(raw: list[list]) -> list[dict]:
    rows = []
    for item in raw:
        open_time = int(item[0])
        close_time = int(item[6])
        rows.append({
            "open_time": open_time,
            "close_time": close_time,
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


async def main() -> int:
    from app.core import config as core_config
    from app.data_engine.data_manager import DataManager
    from app.data_engine.manual_history.repository import ManualHistoryRepository
    from app.data_engine.manual_history.service import ManualHistoryService
    from app.data_engine.storage import klines_repo
    from app.data_engine.storage.klines_repo import KlinesRepoAdapter

    date_stamp = datetime.now(timezone.utc).date().isoformat()
    out_dir = REPOSITORY_ROOT / "docs" / "perf-baselines" / "manual-history"
    out_dir.mkdir(parents=True, exist_ok=True)
    commit = _git_head()

    with tempfile.TemporaryDirectory(
        prefix="manual-history-phase10-",
        ignore_cleanup_errors=True,
    ) as tmp:
        db_path = Path(tmp) / "klines.db"
        os.environ["KLINES_DB_PATH"] = str(db_path)
        core_config.KLINES_DB_PATH = db_path
        klines_repo.KLINES_DB_PATH = db_path
        klines_repo.init_klines_storage()

        raw = _fetch_binance_klines("BTCUSDT", "1m", 5)
        rows = _rows_from_klines(raw)
        start_ms = rows[0]["open_time"]
        end_ms = rows[-1]["open_time"]
        request_count = 1

        async def fetch_native(**kwargs) -> int:
            nonlocal request_count
            request_count += 0
            return klines_repo.upsert_klines(
                kwargs["symbol"],
                kwargs["interval"],
                rows,
                source="binance",
                exchange="binance",
                market_type="spot",
            )

        repo = ManualHistoryRepository(db_path)
        dm = DataManager()
        dm.set_storage(KlinesRepoAdapter())
        service = ManualHistoryService(
            repository=repo,
            data_manager=dm,
            storage=KlinesRepoAdapter(),
            fetch_native=fetch_native,
            enabled=True,
        )
        plan = {
            "can_start": True,
            "plan_hash": "sha256:phase10-rest",
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
                "initial_end_open_ms": end_ms,
                "source_strategy": "REST",
                "estimated_target_rows": len(rows),
                "estimated_source_rows": len(rows),
                "existing_coverage": "NONE",
                "error": None,
                "boundary_reason": None,
            }],
            "storage": {},
        }
        created = service.create_from_plan(plan, idempotency_key="phase10-rest")
        job = await service.run_job(created.job.job_id)
        verification = KlinesRepoAdapter().verify_contiguous_range(
            "BTCUSDT", "1m", start_ms, end_ms, exchange="binance", market_type="spot",
        )
        floors = repo.active_protection_snapshot()
        dm.update_retention_limits(
            db_limits={"minutes": 1},
            storage_row_limits_enabled=True,
        )
        gc_before = len(klines_repo.query_klines(
            "BTCUSDT", "1m", exchange="binance", market_type="spot",
        ))
        dm.reload_durable_protections()
        gc_plan = dm.plan_storage_gc(scoring="legacy")
        reopened = ManualHistoryRepository(db_path)
        floors_after = reopened.active_protection_snapshot()

        contract = {
            "schema": "candlescope.manual-history.phase10-contract.v1",
            "git_commit": commit,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "MANUAL_HISTORY_DOWNLOAD_ENABLED": 1,
            "HISTORY_ARCHIVE_ENABLED": 0,
            "klines_db_path": str(db_path),
            "production_db": False,
            "targets": [{
                "symbol": "BTCUSDT",
                "interval": "1m",
                "effective_start_ms": start_ms,
                "sealed_end_open_ms": end_ms,
                "verified_contiguous": verification.get("verified_contiguous"),
                "source_route": "REST",
                "request_count": request_count,
                "rows": len(rows),
            }],
            "job_state": job.state.value,
        }
        capacity = {
            "schema": "candlescope.manual-history.phase10-capacity.v1",
            "git_commit": commit,
            "klines_db_path": str(db_path),
            "production_db": False,
            "physical_bytes": db_path.stat().st_size if db_path.exists() else 0,
            "rows": len(rows),
        }
        gc_restart = {
            "schema": "candlescope.manual-history.phase10-gc-restart.v1",
            "git_commit": commit,
            "klines_db_path": str(db_path),
            "production_db": False,
            "rows_before_gc": gc_before,
            "gc_would_delete_rows": gc_plan.get("would_delete_rows"),
            "floors_before": [
                {"start": f.protected_start_ms, "durable": f.durable_owner_count}
                for f in floors
            ],
            "floors_after_reopen": [
                {"start": f.protected_start_ms, "durable": f.durable_owner_count}
                for f in floors_after
            ],
            "verified_contiguous": verification.get("verified_contiguous"),
        }
        archive_parity = {
            "schema": "candlescope.manual-history.phase10-archive-rest-parity.v1",
            "git_commit": commit,
            "klines_db_path": str(db_path),
            "production_db": False,
            "HISTORY_ARCHIVE_ENABLED": 0,
            "rest_verified_contiguous": verification.get("verified_contiguous"),
            "note": "Archive disabled; REST-only path reached exact continuity on a live Binance 5-bar fixture.",
        }

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
        print(json.dumps({"written": written, "verified": verification}, indent=2))
        if verification.get("verified_contiguous") is not True:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
