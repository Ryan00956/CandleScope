"""Measure the deterministic replay.v2 multi-track coordination kernel."""

from __future__ import annotations

import argparse
import ctypes
import json
import sys
import time
import tracemalloc
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.canonical import canonical_json, canonical_sha256  # noqa: E402
from app.replay.training.multitrack import (  # noqa: E402
    GLOBAL_ORDERING_VERSION,
    MARKET_EVENT_PHASE,
    StableMarketEvent,
    TrainingRunActor,
    global_ordering_hash,
    stable_market_event_order,
)


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


def _track(track_index: int) -> dict[str, object]:
    track_id = f"track-{track_index:02d}"
    return {
        "run_id": "benchmark-run",
        "track_id": track_id,
        "stable_ordinal": track_index,
        "adapter_session_id": f"adapter-{track_index:02d}",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": f"SYMBOL{track_index:02d}USDT",
        "settlement_asset": "USDT",
        "state": "READY",
        "source_kind": "BAR",
        "subscription_tier": "FULL",
        "cursor": {
            "virtual_time_ms": 1_710_000_000_000,
            "source_sequence": 0,
            "revision": 1,
        },
        "forced_full_reasons": (["VIEWED"] if track_index == 1 else []),
        "capabilities": {"OHLCV": "AVAILABLE_EXACT"},
        "public_price": "100",
        "position": {"quantity": "0"},
        "open_order_count": 0,
        "degraded_reason": None,
        "account": {
            "equity": "10000",
            "cash_balance": "10000",
            "available_equity": "10000",
            "reserved_margin": "0",
            "margin_used": "0",
            "realized_pnl": "0",
            "unrealized_pnl": "0",
            "fees_paid": "0",
        },
    }


def _checkpoint_size(tracks: tuple[dict[str, object], ...]) -> int:
    portfolio = {
        "schema_version": "replay.training.portfolio.v1",
        "initial_equity": "10000",
        "equity": "10000",
        "available_equity": "10000",
        "positions": [],
    }
    payload = {
        "schema_version": "replay.training.global-checkpoint.v1",
        "ordering_version": GLOBAL_ORDERING_VERSION,
        "global_event_sequence": 0,
        "global_virtual_time_ms": 1_710_000_000_000,
        "tracks": tracks,
        "portfolio": portfolio,
    }
    return len(canonical_json(payload).encode("utf-8"))


def _run_case(track_count: int, iterations: int) -> dict[str, object]:
    tracks = tuple(_track(index) for index in range(1, track_count + 1))
    ordered_tracks = TrainingRunActor.ordered_full_tracks(reversed(tracks))
    expected_ids = [f"track-{index:02d}" for index in range(1, track_count + 1)]
    if [track["track_id"] for track in ordered_tracks] != expected_ids:
        raise RuntimeError("TrainingRunActor track order drifted")

    rss_before = _rss_bytes()
    rss_peak = rss_before
    tracemalloc.start()
    wall_started = time.perf_counter()
    cpu_started = time.process_time()
    projections = 0
    tail_hash = ""
    for iteration in range(iterations):
        timestamp = 1_710_000_000_000 + iteration * 60_000
        unordered = [
            StableMarketEvent(
                actual_event_time_ms=timestamp,
                event_phase=MARKET_EVENT_PHASE,
                market_track_stable_id=track_id,
                source_sequence=iteration + 1,
            )
            for track_id in reversed(expected_ids)
        ]
        ordered = stable_market_event_order(unordered)
        if [event.market_track_stable_id for event in ordered] != expected_ids:
            raise RuntimeError("global event order drifted")
        tail_hash = global_ordering_hash(ordered)
        projections += len(ordered)
        if iteration % 100 == 0:
            sample = _rss_bytes()
            if sample is not None:
                rss_peak = sample if rss_peak is None else max(rss_peak, sample)
    cpu_seconds = time.process_time() - cpu_started
    wall_seconds = time.perf_counter() - wall_started
    _current_bytes, python_peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    rss_after = _rss_bytes()
    if rss_after is not None:
        rss_peak = rss_after if rss_peak is None else max(rss_peak, rss_after)
    return {
        "track_count": track_count,
        "iterations": iterations,
        "projections": projections,
        "wall_ms": round(wall_seconds * 1_000, 3),
        "cpu_ms": round(cpu_seconds * 1_000, 3),
        "projection_rate_per_second": round(projections / wall_seconds, 3),
        "ordered_queue_high_water": track_count,
        "checkpoint_bytes": _checkpoint_size(tracks),
        "python_peak_bytes": python_peak_bytes,
        "rss_before_bytes": rss_before,
        "rss_peak_bytes": rss_peak,
        "rss_delta_bytes": (
            None
            if rss_before is None or rss_peak is None
            else max(0, rss_peak - rss_before)
        ),
        "tail_ordering_hash": tail_hash,
    }


def run_benchmark(*, iterations: int) -> dict[str, object]:
    if iterations < 1:
        raise ValueError("iterations must be positive")
    cases = [_run_case(track_count, iterations) for track_count in (1, 2, 4, 8)]
    contract_evidence = [
        {
            "track_count": case["track_count"],
            "iterations": case["iterations"],
            "projections": case["projections"],
            "ordered_queue_high_water": case["ordered_queue_high_water"],
            "checkpoint_bytes": case["checkpoint_bytes"],
            "tail_ordering_hash": case["tail_ordering_hash"],
        }
        for case in cases
    ]
    return {
        "schema_version": "replay.phase5.multitrack-benchmark.v1",
        "ordering_version": GLOBAL_ORDERING_VERSION,
        "workload": "stable-order-plus-checkpoint-envelope",
        "cases": cases,
        "evidence_hash": canonical_sha256(contract_evidence),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=10_000)
    args = parser.parse_args()
    print(json.dumps(run_benchmark(iterations=args.iterations), indent=2))


if __name__ == "__main__":
    main()
