"""Benchmark real multi-track HEDGE normal and liquidation waves."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import math
import sqlite3
import statistics
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.service import ReplayService  # noqa: E402
from app.replay.training.models import ReplayV2CommandType  # noqa: E402
from tests.fixtures.replay.hedge_input_fakes import (  # noqa: E402
    import_hedge_track_public_inputs,
    prepare_hedge_request,
)
from tests.fixtures.replay.service_fakes import INTERVAL_MS  # noqa: E402
from tests.test_replay_v2_training_phase5 import (  # noqa: E402
    _acquire,
    _command,
    _request,
)
from tests.test_replay_v2_training_phase6 import (  # noqa: E402
    _risk_service,
    _sandbox_request,
    _send,
)


SCHEMA_VERSION = "replay.hedge-exchange-parity.performance.v1"
SYMBOLS = (
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "BNBUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
)
MAX_NORMAL_P95_MS = 500.0
MAX_LIQUIDATION_P95_MS = 2_000.0
MAX_LIQUIDATION_MAX_MS = 5_000.0
MAX_RSS_DELTA_BYTES = 96 * 1024**2


def _rss_bytes() -> int | None:
    if sys.platform == "win32":
        class ProcessMemoryCountersEx(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCountersEx()
        counters.cb = ctypes.sizeof(counters)
        get_current_process = ctypes.windll.kernel32.GetCurrentProcess
        get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
        get_process_memory_info.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
        ]
        get_process_memory_info.restype = ctypes.c_int
        if get_process_memory_info(
            get_current_process(), ctypes.byref(counters), counters.cb
        ):
            return int(counters.WorkingSetSize)
        return None
    if sys.platform.startswith("linux"):
        try:
            pages = int(Path("/proc/self/statm").read_text(encoding="ascii").split()[1])
            return pages * 4096
        except (OSError, ValueError, IndexError):
            return None
    return None


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * percentile) - 1)]


def _distribution(values: list[float]) -> dict[str, object]:
    return {
        "samples": [round(value, 3) for value in values],
        "p50": round(statistics.median(values), 3),
        "p95": round(_percentile(values, 0.95), 3),
        "max": round(max(values), 3),
    }


async def _prepare_run(
    root: Path,
    *,
    track_count: int,
    prefix: str,
    liquidation: bool,
) -> tuple[ReplayService, str, str, Path]:
    root.mkdir(parents=True, exist_ok=True)
    symbols = SYMBOLS[:track_count]
    database = root / f"{prefix}.db"
    service = await _risk_service(database, symbols=symbols)
    initial_equity = str((100 if liquidation else 1_000_000) * track_count)
    base = replace(
        _sandbox_request(await _request(service), initial_equity=initial_equity),
        market_type="futures",
    )
    mark_count = base.forward_cache_ms // INTERVAL_MS + 1
    primary_marks = (
        ["104", "50", *(["50"] * (mark_count - 2))]
        if liquidation
        else [str(100 + index) for index in range(mark_count)]
    )
    request = await prepare_hedge_request(
        service,
        base,
        root=root,
        prefix=prefix,
        mark_prices=primary_marks,
        required_symbols=list(symbols),
        insurance_opening_balance="1000000000",
    )
    for symbol_index, symbol in enumerate(symbols[1:], start=2):
        marks = (
            ["104", "50", *(["50"] * (mark_count - 2))]
            if liquidation
            else [
                str(symbol_index * 100 + index)
                for index in range(mark_count)
            ]
        )
        await import_hedge_track_public_inputs(
            service,
            request,
            root=root,
            prefix=prefix,
            symbol=symbol,
            mark_prices=marks,
        )
    assert service.training is not None
    created = await service.training.create_run(request)
    run_id = str(created["run"]["run_id"])
    selected_session_id = str(created["run"]["adapter_session_id"])
    for index, symbol in enumerate(symbols[1:], start=2):
        await _send(
            service,
            run_id=run_id,
            session_id=selected_session_id,
            command_id=f"{prefix}-add-{index}",
            command_type=ReplayV2CommandType.ADD_TRACK,
            payload={
                "exchange": "binance",
                "market_type": "futures",
                "symbol": symbol,
                "settlement_asset": "USDT",
                "subscription_tier": "FULL",
            },
        )
    await _acquire(
        service,
        run_id=run_id,
        selected_session_id=selected_session_id,
        command_id=f"{prefix}-acquire",
    )
    quantity = "2.4" if liquidation else "1"
    short_quantity = "0.4" if liquidation else "1"
    for index, _symbol in enumerate(symbols, start=1):
        if index > 1:
            viewer = await service.training.get_viewer_state(run_id)
            selected = await _send(
                service,
                run_id=run_id,
                session_id=selected_session_id,
                command_id=f"{prefix}-select-{index}",
                command_type=ReplayV2CommandType.SELECT_TRACK,
                payload={
                    "track_id": f"track-{index}",
                    "expected_viewer_revision": viewer["semantic_view_revision"],
                },
            )
            selected_session_id = str(selected["session_id"])
        for side, position_side, leg_quantity in (
            ("BUY", "LONG", quantity),
            ("SELL", "SHORT", short_quantity),
        ):
            await _send(
                service,
                run_id=run_id,
                session_id=selected_session_id,
                command_id=f"{prefix}-open-{index}-{position_side.lower()}",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": (
                        f"{prefix}-open-{index}-{position_side.lower()}"
                    ),
                    "side": side,
                    "position_side": position_side,
                    "order_type": "MARKET",
                    "quantity": leg_quantity,
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                },
            )
    projection = await service.training.get_market_tracks(run_id)
    if len(projection["portfolio"]["positions"]) != track_count * 2:
        raise RuntimeError("HEDGE capacity workload did not open both legs per track")
    if sum(
        track["subscription_tier"] == "FULL" for track in projection["tracks"]
    ) != track_count:
        raise RuntimeError("a positioned HEDGE track was not retained at FULL")
    return service, run_id, selected_session_id, database


def _storage_evidence(database: Path) -> dict[str, object]:
    with sqlite3.connect(database) as connection:
        quick_check = connection.execute("PRAGMA quick_check").fetchone()
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        page_bytes = (
            int(connection.execute("PRAGMA page_count").fetchone()[0])
            * int(connection.execute("PRAGMA page_size").fetchone()[0])
        )
        wal_rows = connection.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
    wal = Path(f"{database}-wal")
    return {
        "quick_check": quick_check == ("ok",),
        "foreign_key_check": foreign_keys == [],
        "database_page_bytes": page_bytes,
        "wal_bytes": wal.stat().st_size if wal.exists() else 0,
        "wal_checkpoint": list(wal_rows) if wal_rows is not None else None,
    }


async def _normal_case(
    root: Path,
    *,
    track_count: int,
    iterations: int,
) -> dict[str, object]:
    service, run_id, session_id, database = await _prepare_run(
        root,
        track_count=track_count,
        prefix=f"normal-{track_count}",
        liquidation=False,
    )
    rss_before = _rss_bytes()
    rss_peak = rss_before
    durations: list[float] = []
    try:
        assert service.training is not None
        for iteration in range(iterations):
            session = await service.get_session(session_id)
            started = time.perf_counter()
            await service.training.command(
                run_id,
                _command(
                    run_id,
                    f"normal-{track_count}-step-{iteration}",
                    ReplayV2CommandType.STEP_BASE,
                    session,
                    {"count": 1},
                ),
            )
            durations.append((time.perf_counter() - started) * 1_000)
            sample = _rss_bytes()
            if sample is not None:
                rss_peak = sample if rss_peak is None else max(rss_peak, sample)
        projection = await service.training.get_market_tracks(run_id)
        account_audit = await service.training.audit_account(run_id)
        input_audit = await service.training.hedge_inputs.audit_run(run_id)
        distribution = _distribution(durations)
        checks = {
            "both_legs_per_track": len(projection["portfolio"]["positions"])
            == track_count * 2,
            "all_positioned_tracks_full": sum(
                track["subscription_tier"] == "FULL"
                for track in projection["tracks"]
            )
            == track_count,
            "track_public_binding_per_track": len(
                projection["portfolio"]["hedge_inputs"]["track_public"]
            )
            == track_count,
            "account_audit": account_audit["status"] == "PASS",
            "input_audit": input_audit["status"] == "PASS",
            "p95_within_frozen_limit": distribution["p95"]
            <= MAX_NORMAL_P95_MS,
        }
        return {
            "track_count": track_count,
            "iterations": iterations,
            "normal_wave_ms": distribution,
            "rss_before_bytes": rss_before,
            "rss_peak_bytes": rss_peak,
            "rss_delta_bytes": (
                None
                if rss_before is None or rss_peak is None
                else max(0, rss_peak - rss_before)
            ),
            "storage": _storage_evidence(database),
            "account_audit_differences": account_audit.get("differences", []),
            "checks": checks,
            "passed": all(checks.values()),
        }
    finally:
        await service.shutdown(step_timeout=2.0)


async def _liquidation_sample(
    root: Path,
    *,
    track_count: int,
    sample: int,
) -> tuple[float, dict[str, object]]:
    prefix = f"liquidation-{track_count}-{sample}"
    service, run_id, session_id, database = await _prepare_run(
        root,
        track_count=track_count,
        prefix=prefix,
        liquidation=True,
    )
    try:
        assert service.training is not None
        started = time.perf_counter()
        await _send(
            service,
            run_id=run_id,
            session_id=session_id,
            command_id=f"{prefix}-crash",
            command_type=ReplayV2CommandType.STEP_BASE,
            payload={"count": 2},
        )
        duration = (time.perf_counter() - started) * 1_000
        projection = await service.training.get_market_tracks(run_id)
        account_audit = await service.training.audit_account(run_id)
        input_audit = await service.training.hedge_inputs.audit_run(run_id)
        liquidations = projection["portfolio"]["liquidations"]
        evidence = {
            "positions_closed": projection["portfolio"]["positions"] == [],
            "one_account_case": len(liquidations) == 1,
            "case_completed": bool(liquidations)
            and liquidations[0]["state"] == "COMPLETED",
            "account_audit": account_audit["status"] == "PASS",
            "account_audit_differences": account_audit.get("differences", []),
            "input_audit": input_audit["status"] == "PASS",
            "storage": _storage_evidence(database),
        }
        if not all(
            value
            for key, value in evidence.items()
            if key not in {"storage", "account_audit_differences"}
        ):
            raise RuntimeError(f"liquidation sample failed: {evidence}")
        storage = evidence["storage"]
        if not isinstance(storage, dict) or not all(
            storage[key] for key in ("quick_check", "foreign_key_check")
        ):
            raise RuntimeError(f"liquidation SQLite evidence failed: {storage}")
        return duration, evidence
    finally:
        await service.shutdown(step_timeout=2.0)


async def run_benchmark(
    *,
    temp_root: Path | None = None,
    track_counts: tuple[int, ...] = (1, 2, 4, 8),
    normal_iterations: int = 8,
    liquidation_samples: int = 5,
) -> dict[str, object]:
    if not track_counts or any(count not in {1, 2, 4, 8} for count in track_counts):
        raise ValueError("track_counts must be a non-empty subset of 1/2/4/8")
    if normal_iterations < 1 or normal_iterations > 10:
        raise ValueError("normal_iterations must be between 1 and 10")
    if liquidation_samples < 1:
        raise ValueError("liquidation_samples must be positive")
    owned_temp = None
    if temp_root is None:
        owned_temp = tempfile.TemporaryDirectory(
            prefix="replay-hedge-phase9-",
            ignore_cleanup_errors=True,
        )
        root = Path(owned_temp.name)
    else:
        root = temp_root.resolve()
        root.mkdir(parents=True, exist_ok=True)
    try:
        normal_cases = [
            await _normal_case(
                root / f"normal-case-{count}",
                track_count=count,
                iterations=normal_iterations,
            )
            for count in track_counts
        ]
        liquidation_cases: list[dict[str, object]] = []
        for count in track_counts:
            sample_values: list[float] = []
            evidence: list[dict[str, object]] = []
            for sample in range(liquidation_samples):
                sample_root = root / f"liquidation-case-{count}-{sample}"
                sample_root.mkdir(parents=True, exist_ok=True)
                duration, sample_evidence = await _liquidation_sample(
                    sample_root,
                    track_count=count,
                    sample=sample,
                )
                sample_values.append(duration)
                evidence.append(sample_evidence)
            distribution = _distribution(sample_values)
            checks = {
                "p95_within_frozen_limit": distribution["p95"]
                <= MAX_LIQUIDATION_P95_MS,
                "max_within_frozen_limit": distribution["max"]
                <= MAX_LIQUIDATION_MAX_MS,
                "all_samples_passed": len(evidence) == liquidation_samples,
            }
            liquidation_cases.append(
                {
                    "track_count": count,
                    "samples": liquidation_samples,
                    "liquidation_wave_ms": distribution,
                    "checks": checks,
                    "passed": all(checks.values()),
                }
            )
        rss_ok = all(
            case["rss_delta_bytes"] is None
            or case["rss_delta_bytes"] <= MAX_RSS_DELTA_BYTES
            for case in normal_cases
        )
        acceptance = {
            "matrix": list(track_counts) == [1, 2, 4, 8],
            "normal": all(case["passed"] for case in normal_cases),
            "liquidation": all(case["passed"] for case in liquidation_cases),
            "rss_within_limit": rss_ok,
        }
        return {
            "schema_version": SCHEMA_VERSION,
            "profile": "real-replay-service-sqlite-decimal-archive-hedge",
            "thresholds": {
                "normal_p95_ms": MAX_NORMAL_P95_MS,
                "liquidation_p95_ms": MAX_LIQUIDATION_P95_MS,
                "liquidation_max_ms": MAX_LIQUIDATION_MAX_MS,
                "rss_delta_bytes": MAX_RSS_DELTA_BYTES,
            },
            "normal_cases": normal_cases,
            "liquidation_cases": liquidation_cases,
            "acceptance": {**acceptance, "passed": all(acceptance.values())},
        }
    finally:
        if owned_temp is not None:
            owned_temp.cleanup()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--normal-iterations", type=int, default=8)
    parser.add_argument("--liquidation-samples", type=int, default=5)
    parser.add_argument("--temp-root", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = asyncio.run(
        run_benchmark(
            temp_root=args.temp_root,
            normal_iterations=args.normal_iterations,
            liquidation_samples=args.liquidation_samples,
        )
    )
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if report["acceptance"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
