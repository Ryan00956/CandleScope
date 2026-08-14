"""One-million aggTrade M6 benchmark through BacktestService and SQLite."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sqlite3
import subprocess
import threading
import time
from pathlib import Path
from tempfile import TemporaryDirectory

import psutil

from app.backtest.reports import verify_report_hash
from app.backtest.service import BacktestService
from app.backtest.strategy.protocol import (
    ProviderCapabilities,
    StrategyOutput,
    canonical_hash,
)
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.simulation.execution_realism import EXECUTION_REALISM_V2


class _ScheduledOrders:
    def __init__(self, event_count: int) -> None:
        self._schedule = {
            sequence: ("BUY" if ordinal % 2 == 0 else "SELL")
            for ordinal, sequence in enumerate(range(1, event_count, 100_000))
        }

    def describe(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            input_modes=("TRADE",), output_modes=("ORDER_INTENT",)
        )

    def prepare(self, _context: dict) -> None:
        return None

    def warmup(self, _frame: object) -> None:
        return None

    def step(self, frame: object) -> StrategyOutput | None:
        sequence = int(getattr(frame, "sequence"))
        side = self._schedule.get(sequence)
        if side is None:
            return None
        payload = {"side": side, "type": "MARKET", "qty": "100", "tif": "GTC"}
        return StrategyOutput(
            sequence=sequence,
            kind="ORDER_INTENT",
            payload=payload,
            state_hash=canonical_hash({"sequence": sequence}),
            output_hash=canonical_hash(payload),
        )

    def on_execution_report(self, _report: dict) -> None:
        return None

    def snapshot(self) -> dict:
        return {}

    def restore(self, _payload: dict) -> None:
        return None

    def close(self) -> str:
        return canonical_hash({"closed": True})


def _events(count: int) -> tuple[MarketEvent, ...]:
    return tuple(
        MarketEvent(
            sequence=sequence,
            event_time_ms=sequence,
            role="TRADES",
            payload={
                "source_event_kind": "AGG_TRADE",
                "source_sequence": sequence,
                "tie_break": f"AGG_TRADE:{sequence}",
                "price": str(100 + sequence % 17),
                "qty": "10",
            },
        )
        for sequence in range(1, count + 1)
    )


def _git(command: str) -> str:
    return subprocess.check_output(
        ["git", *command.split()], text=True, encoding="utf-8"
    ).strip()


def _write(path: Path, payload: dict) -> None:
    unsigned = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    payload["sha256"] = hashlib.sha256(unsigned.encode("utf-8")).hexdigest()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", type=int, default=1_000_000)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    if args.events != 1_000_000:
        parser.error("formal M6 evidence requires exactly 1000000 events")
    git_sha = _git("rev-parse HEAD")
    git_dirty = bool(_git("status --porcelain"))
    process = psutil.Process(os.getpid())
    peak_rss = process.memory_info().rss
    monitoring = True

    def monitor() -> None:
        nonlocal peak_rss
        while monitoring:
            peak_rss = max(peak_rss, process.memory_info().rss)
            time.sleep(0.02)

    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    with TemporaryDirectory(prefix="candlescope-backtest-m6-") as temp:
        temp_path = Path(temp)
        settings = load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_TRADE_TAPE_ENABLED": "1",
                "BACKTEST_CHECKPOINT_EVENT_INTERVAL": "10000",
            },
            data_dir=temp_path,
            klines_db_path=temp_path / "candlescope.db",
            replay_db_path=temp_path / "replay.db",
        )
        service = BacktestService.start(settings, now_ms=1)
        try:
            events = _events(args.events)
            created = service.create_run(
                {
                    "strategy_revision_id": "benchmark-scheduled-orders-v1",
                    "dataset_id": "synthetic-m6-product-path-v1",
                    "data_epoch": "sha256:" + "ab" * 32,
                    "snapshot_hash": "sha256:" + "cd" * 32,
                    "fidelity_mode": "AGG_TRADE_TAPE",
                    "source_event_kind": "AGG_TRADE",
                    "start_time_ms": 1,
                    "end_time_ms": args.events + 1,
                    "output_mode": "ORDER_INTENT",
                    "initial_balance": "1000000",
                    "slippage_bps": "1",
                    "taker_fee_bps": "1",
                    "maker_fee_bps": "1",
                    "execution_model_revision": EXECUTION_REALISM_V2,
                    "participation_rate": "0.05",
                    "latency_ms": 2,
                    "latency_events": 2,
                    "order_end_policy": "CANCEL_AT_END",
                },
                idempotency_key="m6-million-product-path",
                now_ms=2,
            )
            started = time.perf_counter()
            completed = service.execute_trade_run(
                str(created["run_id"]),
                events=events,
                provider=_ScheduledOrders(args.events),
                now_ms=3,
            )
            duration = time.perf_counter() - started
            report = service.get_report(str(created["run_id"]))
            connection = sqlite3.connect(settings.db_path)
            try:
                report_rows = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM backtest_reports"
                    ).fetchone()[0]
                )
                audit_rows = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM backtest_audit"
                    ).fetchone()[0]
                )
            finally:
                connection.close()
        finally:
            service.shutdown()
    monitoring = False
    thread.join(timeout=1)
    matrix = report.get("cost_sensitivity") or {}
    fills = report.get("fills") or []
    measured = {
        "duration_seconds": round(duration, 6),
        "events_per_second": round(args.events / duration, 3),
        "peak_rss_bytes": peak_rss,
        "fill_count": len(fills),
        "order_event_count": len(report.get("order_events") or []),
        "decision_count": int((report.get("ledger") or {}).get("decision_count") or 0),
        "equity_curve_points": len(report.get("equity_curve") or []),
        "report_bytes": len(json.dumps(report, separators=(",", ":")).encode("utf-8")),
        "report_rows": report_rows,
        "audit_rows": audit_rows,
        "sensitivity_scenarios": len(matrix.get("scenarios") or []),
    }
    checks = {
        "completed": completed.get("state") == "COMPLETED",
        "exact_event_count": measured["decision_count"] == args.events,
        "real_orders": measured["order_event_count"] > 0,
        "partial_fills": measured["fill_count"] > 10,
        "decimal_ledger": bool((report.get("ledger") or {}).get("account_hash")),
        "authoritative_fill_trace": (report.get("fill_trace") or {}).get("complete")
        is True,
        "sqlite_report_write": report_rows == 1 and audit_rows > 0,
        "report_hash_valid": verify_report_hash(report),
        "report_within_ceiling": measured["report_bytes"] <= 16_777_216,
        "five_sensitivity_scenarios": measured["sensitivity_scenarios"] == 5,
        "primary_hash_excludes_matrix": matrix.get("included_in_primary_config_hash")
        is False,
    }
    thresholds = None
    if args.baseline is not None:
        thresholds = json.loads(args.baseline.read_text(encoding="utf-8"))[
            "acceptance_thresholds"
        ]
        checks.update(
            {
                "throughput_threshold": measured["events_per_second"]
                >= float(thresholds["min_events_per_second"]),
                "duration_threshold": measured["duration_seconds"]
                <= float(thresholds["max_duration_seconds"]),
                "rss_threshold": measured["peak_rss_bytes"]
                <= int(thresholds["max_peak_rss_bytes"]),
            }
        )
    payload = {
        "schemaVersion": "candlescope.backtest-m6-product-benchmark/1",
        "kind": "ONE_MILLION_AGG_TRADE_PRODUCT_PATH",
        "gitSha": git_sha,
        "gitDirty": git_dirty,
        "branch": _git("branch --show-current"),
        "runtimeProfile": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "cpu_count": os.cpu_count(),
        },
        "effectiveFlags": {
            "BACKTEST_ENABLED": 1,
            "BACKTEST_TRADE_TAPE_ENABLED": 1,
            "all_other_backtest_production_flags": 0,
        },
        "datasetSnapshotHashes": {
            "source": "SYNTHETIC_DETERMINISTIC_M6_PERFORMANCE_FIXTURE",
            "generator": "sha256:"
            + hashlib.sha256(b"m6-product-events-v1").hexdigest(),
        },
        "strategyRevision": "benchmark-scheduled-orders-v1",
        "accountModel": "LINEAR_PERP_ONE_WAY_V1",
        "fillModel": "AGG_TRADE_LATENCY_PARTICIPATION_V2",
        "reportSchema": report.get("schemaVersion"),
        "eventCount": args.events,
        "measurements": measured,
        "thresholds": thresholds,
        "hashes": {
            "decision": (report.get("hashes") or {}).get("decision"),
            "fill": (report.get("hashes") or {}).get("fill"),
            "ledger": (report.get("hashes") or {}).get("ledger"),
            "report": (report.get("hashes") or {}).get("report"),
            "matrix": matrix.get("matrix_hash"),
        },
        "checks": checks,
        "ok": all(checks.values()),
        "scope": "M6_PRODUCT_PATH_PERFORMANCE_NOT_RELEASE_OR_REAL_MARKET_EVIDENCE",
    }
    _write(args.output.resolve(), payload)
    print(json.dumps(payload, indent=2))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
