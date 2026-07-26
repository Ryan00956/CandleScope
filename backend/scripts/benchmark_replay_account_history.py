"""Benchmark positioned replay.v2 FULL tracks with exact account-history inputs."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import math
import platform
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

from app.replay.canonical import canonical_sha256  # noqa: E402
from app.replay.service import ReplayService  # noqa: E402
from app.replay.storage import ReplaySQLiteStore  # noqa: E402
from app.replay.training.models import (  # noqa: E402
    ReplayV2CommandType,
    TrainingRunCreateRequest,
)
from tests.fixtures.replay.account_history import (  # noqa: E402
    build_account_history_archive,
)
from tests.fixtures.replay.fakes import (  # noqa: E402
    FakeKlinesRepo,
    FixtureIdentity,
    make_bar,
)
from tests.fixtures.replay.service_fakes import (  # noqa: E402
    INTERVAL_MS,
    START_MS,
    SessionIdFactory,
    replay_settings,
)
from tests.test_replay_v2_training_phase5 import (  # noqa: E402
    _acquire,
    _command,
)


SCHEMA_VERSION = "replay.phase16.account-history-capacity.v1"
REPLAY_START_MS = START_MS + 4 * INTERVAL_MS
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
# Frozen after the first uninstrumented positioned-track pilot (8-track p95
# 315.332 ms and RSS delta 4.92 MiB). The ceilings retain Windows scheduling
# headroom without treating multi-second steps or unbounded memory as healthy.
MAX_STEP_P95_MS = 500.0
MAX_RSS_DELTA_BYTES = 64 * 1024**2


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
            get_current_process(),
            ctypes.byref(counters),
            counters.cb,
        ):
            return int(counters.WorkingSetSize)
        return None
    if sys.platform.startswith("linux"):
        try:
            resident_pages = int(
                Path("/proc/self/statm").read_text(encoding="ascii").split()[1]
            )
            return resident_pages * 4096
        except (OSError, ValueError, IndexError):
            return None
    return None


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * percentile) - 1)
    return ordered[index]


def _repository(symbols: tuple[str, ...], *, row_count: int) -> FakeKlinesRepo:
    repository = FakeKlinesRepo()
    for symbol_index, symbol in enumerate(symbols):
        price_base = 100 * (symbol_index + 1)
        repository.add_rows(
            FixtureIdentity("binance", "futures", symbol),
            "1m",
            [
                make_bar(
                    START_MS + row_index * INTERVAL_MS,
                    price=str(price_base + row_index),
                )
                for row_index in range(row_count)
            ],
        )
    return repository


def _request(
    *,
    catalog_epoch: str,
    forward_cache_ms: int,
    account_history_ref: object,
) -> TrainingRunCreateRequest:
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog_epoch,
            "name": "Phase 16 positioned capacity",
            "source_kind": "BAR",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "futures",
            "symbol": SYMBOLS[0],
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": REPLAY_START_MS,
            "warmup_bars": 2,
            "forward_cache_ms": forward_cache_ms,
            "random_seed": 16,
            "initial_equity": "1000000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "0",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "NONE",
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "funding_mode": "HISTORICAL_EXACT",
            "account_data_mode": "HISTORICAL_EXACT",
            "account_history_ref": account_history_ref,
            "allow_rule_changes": False,
        }
    )


async def _send(
    service: ReplayService,
    *,
    run_id: str,
    session_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    payload: dict[str, object],
) -> dict[str, object]:
    assert service.training is not None
    session = await service.get_session(session_id)
    return await service.training.command(
        run_id,
        _command(run_id, command_id, command_type, session, payload),
    )


async def _run_case(root: Path, *, track_count: int, iterations: int) -> dict[str, object]:
    symbols = SYMBOLS[:track_count]
    forward_minutes = max(20, iterations + 4)
    forward_cache_ms = forward_minutes * INTERVAL_MS
    range_end_ms = REPLAY_START_MS + (forward_minutes + 2) * INTERVAL_MS
    now_ms = START_MS + (forward_minutes + 20) * INTERVAL_MS
    database = root / f"positioned-{track_count}.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            product_v2_enabled=True,
            replay_account_history_enabled=True,
            replay_account_history_max_archive_bytes=512 * 1024**2,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: now_ms),
        repository=_repository(
            symbols,
            row_count=forward_minutes + 24,
        ),
        now_ms=lambda: now_ms,
        session_id_factory=SessionIdFactory(
            f"phase16-capacity-{track_count}-adapter"
        ),
        training_run_id_factory=SessionIdFactory(
            f"phase16-capacity-{track_count}-run"
        ),
        native_intervals=lambda _identity: ("1m",),
    )
    rss_before = _rss_bytes()
    rss_peak = rss_before
    await service.start()
    assert service.training is not None
    run_id = ""
    session_id = ""
    step_durations_ms: list[float] = []
    try:
        for symbol_index, symbol in enumerate(symbols):
            price_base = 100 * (symbol_index + 1)
            archive = root / f"account-{track_count}-{symbol}.sqlite3"
            build_account_history_archive(
                archive,
                archive_id=f"capacity-{track_count}-{symbol.lower()}",
                symbol=symbol,
                range_start_ms=REPLAY_START_MS,
                range_end_ms=range_end_ms,
                funding_anchor_ms=REPLAY_START_MS + 2 * INTERVAL_MS - 1,
                price_at=lambda timestamp, base=price_base: str(
                    base
                    + 4
                    + (timestamp - REPLAY_START_MS) // INTERVAL_MS
                ),
            )
            await service.training.account_history.import_archive(archive)
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=forward_cache_ms,
            quality_mode="exact",
            blind_mode=False,
        )
        planning_request = _request(
            catalog_epoch=str(catalog["catalog_epoch"]),
            forward_cache_ms=forward_cache_ms,
            account_history_ref=None,
        )
        plan = await service.training.segment_plan(planning_request)
        account_plan = plan["account_history"]
        if not isinstance(account_plan, dict):
            raise RuntimeError("account-history capacity plan is invalid")
        request = _request(
            catalog_epoch=str(catalog["catalog_epoch"]),
            forward_cache_ms=forward_cache_ms,
            account_history_ref=account_plan["account_history_ref"],
        )
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        for index, symbol in enumerate(symbols[1:], 2):
            selected = await service.get_session(session_id)
            await service.training.command(
                run_id,
                _command(
                    run_id,
                    f"capacity-add-{index}",
                    ReplayV2CommandType.ADD_TRACK,
                    selected,
                    {
                        "exchange": "binance",
                        "market_type": "futures",
                        "symbol": symbol,
                        "settlement_asset": "USDT",
                        "subscription_tier": "FULL",
                    },
                ),
            )
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="capacity-acquire",
        )
        order_payload = {
            "side": "BUY",
            "order_type": "MARKET",
            "quantity": "1",
            "reduce_only": False,
            "limit_price": None,
            "stop_price": None,
        }
        for index in range(1, track_count + 1):
            if index > 1:
                viewer = await service.training.get_viewer_state(run_id)
                selected = await _send(
                    service,
                    run_id=run_id,
                    session_id=session_id,
                    command_id=f"capacity-select-{index}",
                    command_type=ReplayV2CommandType.SELECT_TRACK,
                    payload={
                        "track_id": f"track-{index}",
                        "expected_viewer_revision": viewer[
                            "semantic_view_revision"
                        ],
                    },
                )
                session_id = str(selected["session_id"])
            await _send(
                service,
                run_id=run_id,
                session_id=session_id,
                command_id=f"capacity-open-{index}",
                command_type=ReplayV2CommandType.PLACE_ORDER,
                payload={
                    "client_order_id": f"capacity-open-{index}",
                    **order_payload,
                },
            )
        positioned = await service.training.get_market_tracks(run_id)
        if len(positioned["portfolio"]["positions"]) != track_count:
            raise RuntimeError("capacity workload did not open every position")
        for iteration in range(iterations):
            session = await service.get_session(session_id)
            command = _command(
                run_id,
                f"capacity-step-{iteration}",
                ReplayV2CommandType.STEP_BASE,
                session,
                {"count": 1},
            )
            started = time.perf_counter()
            await service.training.command(run_id, command)
            step_durations_ms.append((time.perf_counter() - started) * 1_000)
            sample = _rss_bytes()
            if sample is not None:
                rss_peak = sample if rss_peak is None else max(rss_peak, sample)
        projection = await service.training.get_market_tracks(run_id)
        audit = await service.training.audit_account(run_id)
        global_events = await service.training.store.global_events(run_id)
        cursors = {
            int(track["cursor"]["virtual_time_ms"])
            for track in projection["tracks"]
        }
        full_tracks = [
            track
            for track in projection["tracks"]
            if track["subscription_tier"] == "FULL"
        ]
        checks = {
            "all_tracks_positioned": (
                len(projection["portfolio"]["positions"]) == track_count
            ),
            "all_tracks_full": len(full_tracks) == track_count,
            "single_virtual_clock": len(cursors) == 1,
            "exact_account_active": (
                projection["portfolio"]["account_history"]["status"] == "ACTIVE"
            ),
            "exact_binding_per_track": (
                len(projection["portfolio"]["account_history"]["bindings"])
                == track_count
            ),
            "auditor_pass": audit["status"] == "PASS",
            "ledger_reconciles": (
                projection["portfolio"]["ledger"]["reconciliation_delta"] == "0"
            ),
            "funding_exercised": any(
                entry["kind"] == "FUNDING_SETTLEMENT"
                for entry in projection["portfolio"]["ledger"]["entries"]
            ),
            "global_events_recorded": bool(global_events),
        }
        with sqlite3.connect(database) as connection:
            quick_check = connection.execute("PRAGMA quick_check").fetchone()
            foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
            database_page_bytes = (
                int(connection.execute("PRAGMA page_count").fetchone()[0])
                * int(connection.execute("PRAGMA page_size").fetchone()[0])
            )
        connection.close()
        checks.update(
            {
                "sqlite_quick_check": quick_check == ("ok",),
                "sqlite_foreign_keys": foreign_keys == [],
            }
        )
        rss_after = _rss_bytes()
        if rss_after is not None:
            rss_peak = rss_after if rss_peak is None else max(rss_peak, rss_after)
        return {
            "track_count": track_count,
            "iterations": iterations,
            "position_count": len(projection["portfolio"]["positions"]),
            "global_event_count": len(global_events),
            "step_ms": {
                "samples": [round(value, 3) for value in step_durations_ms],
                "min": round(min(step_durations_ms), 3),
                "p50": round(statistics.median(step_durations_ms), 3),
                "p95": round(_percentile(step_durations_ms, 0.95), 3),
                "max": round(max(step_durations_ms), 3),
            },
            "rss_before_bytes": rss_before,
            "rss_peak_bytes": rss_peak,
            "rss_delta_bytes": (
                None
                if rss_before is None or rss_peak is None
                else max(0, rss_peak - rss_before)
            ),
            "database_page_bytes": database_page_bytes,
            "account_archive_bytes": sum(
                path.stat().st_size
                for path in (
                    service.training.account_history.root / "objects"
                ).glob("*.sqlite3")
            ),
            "account_audit_proof_hash": audit["proof_hash"],
            "account_archive_proof_hash": (
                projection["portfolio"]["account_history"]["archive_proof_hash"]
            ),
            "checks": checks,
        }
    finally:
        await service.shutdown(step_timeout=5.0)


async def run_benchmark(*, iterations: int) -> dict[str, object]:
    if iterations < 3:
        raise ValueError("iterations must be at least 3")
    temporary_storage_root = Path(tempfile.gettempdir()).resolve()
    with tempfile.TemporaryDirectory(
        prefix="replay-phase16-account-capacity-"
    ) as raw_root:
        root = Path(raw_root)
        cases = [
            await _run_case(root, track_count=track_count, iterations=iterations)
            for track_count in (1, 2, 4, 8)
        ]
    semantic_evidence = [
        {
            "track_count": case["track_count"],
            "position_count": case["position_count"],
            "global_event_count": case["global_event_count"],
            "account_audit_proof_hash": case["account_audit_proof_hash"],
            "account_archive_proof_hash": case["account_archive_proof_hash"],
            "checks": case["checks"],
        }
        for case in cases
    ]
    checks = {
        "all_semantic_checks_pass": all(
            all(bool(value) for value in case["checks"].values())
            for case in cases
        ),
        "all_p95_within_frozen_ceiling": all(
            float(case["step_ms"]["p95"]) <= MAX_STEP_P95_MS
            for case in cases
        ),
        "all_rss_within_frozen_ceiling": all(
            case["rss_delta_bytes"] is None
            or int(case["rss_delta_bytes"]) <= MAX_RSS_DELTA_BYTES
            for case in cases
        ),
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "sqlite": sqlite3.sqlite_version,
            "temporary_storage_drive": temporary_storage_root.drive,
        },
        "workload": {
            "source_kind": "BAR",
            "account_data_mode": "HISTORICAL_EXACT",
            "account_archive": "OPERATOR_CAPTURED_DETERMINISTIC_FIXTURE",
            "margin_mode": "CROSS",
            "funding_mode": "HISTORICAL_EXACT",
            "execution_model": "TOUCH_OR_TAPE_V2",
            "track_counts": [1, 2, 4, 8],
            "positions_per_track": 1,
            "iterations": iterations,
        },
        "frozen_limits": {
            "max_step_p95_ms": MAX_STEP_P95_MS,
            "max_rss_delta_bytes": MAX_RSS_DELTA_BYTES,
        },
        "cases": cases,
        "checks": checks,
        "evidence_hash": canonical_sha256(semantic_evidence),
        "acceptance": {
            "passed": all(checks.values()),
            "decision": "PASS" if all(checks.values()) else "FAIL",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=8)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = asyncio.run(run_benchmark(iterations=args.iterations))
    payload = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0 if result["acceptance"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
