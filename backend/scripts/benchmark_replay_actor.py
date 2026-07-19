from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from app.replay.actor import ReplaySessionActor
from app.replay.canonical import canonical_sha256
from app.replay.catalog import ReplaySeriesIdentity
from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    ExecutionModel,
    QualityMode,
    SlippageKind,
    SourceKind,
    StartPolicy,
)
from app.replay.dataset import (
    BAR_DATASET_SCHEMA_VERSION,
    BarDatasetProvenance,
    BarDatasetSnapshot,
    ReplayBar,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import (
    FeeModel,
    ReplayCommand,
    ReplaySessionConfig,
    SlippageModel,
)
from app.replay.sources.bar_source import BarReplaySource


DEFAULT_BAR_COUNT = 43_200
INTERVAL_MS = 60_000
START_OPEN_MS = 1_710_000_000_000


@dataclass(slots=True)
class BenchmarkReducer:
    count: int = 0
    last_close_time_ms: int | None = None

    def apply_source_event(self, event: object) -> Mapping[str, object]:
        if not isinstance(event, ReplayBar):
            raise TypeError("benchmark reducer requires ReplayBar events")
        self.count += 1
        self.last_close_time_ms = event.close_time_ms
        return {
            "count": self.count,
            "last_close_time_ms": self.last_close_time_ms,
        }

    def snapshot(self) -> Mapping[str, object]:
        return {
            "count": self.count,
            "last_close_time_ms": self.last_close_time_ms,
        }

    def restore(self, state: Mapping[str, object]) -> None:
        count = state.get("count")
        last_close_time_ms = state.get("last_close_time_ms")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("benchmark reducer count is invalid")
        if last_close_time_ms is not None and (
            isinstance(last_close_time_ms, bool)
            or not isinstance(last_close_time_ms, int)
            or last_close_time_ms < 0
        ):
            raise ValueError("benchmark reducer cursor is invalid")
        self.count = count
        self.last_close_time_ms = last_close_time_ms

    def reset(self) -> None:
        self.count = 0
        self.last_close_time_ms = None

    def has_trading_state(self) -> bool:
        return False


def _fixture(bar_count: int) -> BarDatasetSnapshot:
    if bar_count < 1:
        raise ValueError("bar_count must be positive")
    identity = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")
    prices = tuple(str(10_000 + offset) for offset in range(100))
    rows = tuple(
        ReplayBar(
            open_time_ms=START_OPEN_MS + index * INTERVAL_MS,
            close_time_ms=START_OPEN_MS + (index + 1) * INTERVAL_MS - 1,
            open=prices[index % len(prices)],
            high=prices[(index + 2) % len(prices)],
            low=prices[index % len(prices)],
            close=prices[(index + 1) % len(prices)],
            volume="10",
            quote_volume="100000",
            trades=100,
            taker_buy_base="5",
            taker_buy_quote="50000",
            source="phase2-benchmark",
        )
        for index in range(bar_count)
    )
    last_open_ms = rows[-1].open_time_ms
    recipe_hash = canonical_sha256(
        {
            "schema": "replay-phase2-benchmark-fixture.v1",
            "bar_count": bar_count,
            "start_open_ms": START_OPEN_MS,
            "interval_ms": INTERVAL_MS,
            "price_cycle": prices,
        }
    )
    provenance = BarDatasetProvenance(
        repository_backend="generated-fixture",
        identity=identity,
        interval="1m",
        source_fingerprint=recipe_hash,
        catalog_epoch=recipe_hash,
        source_earliest_open_ms=START_OPEN_MS,
        source_latest_open_ms=last_open_ms,
        source_latest_closed_open_ms=last_open_ms,
        row_count=bar_count,
        first_open_ms=START_OPEN_MS,
        last_open_ms=last_open_ms,
        gap_count=0,
        gap_scan_bars=bar_count,
        calendar_id="continuous-24x7",
        hash_schema="replay-phase2-benchmark-fixture.v1",
    )
    return BarDatasetSnapshot(
        schema_version=BAR_DATASET_SCHEMA_VERSION,
        data_epoch=recipe_hash,
        identity=identity,
        interval="1m",
        rows=rows,
        warmup_bars=0,
        replay_start_index=0,
        replay_start_ms=START_OPEN_MS,
        replay_end_open_ms=last_open_ms,
        provenance=provenance,
        estimated_size_bytes=bar_count * 256,
    )


def _session_config(bar_count: int) -> ReplaySessionConfig:
    return ReplaySessionConfig(
        protocol=REPLAY_PROTOCOL,
        source_kind=SourceKind.BAR,
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        base_interval="1m",
        display_interval="1m",
        start_policy=StartPolicy.MANUAL,
        requested_start_ms=START_OPEN_MS,
        warmup_bars=0,
        horizon_ms=bar_count * INTERVAL_MS,
        random_seed=20260718,
        quality_mode=QualityMode.EXACT,
        blind_mode=False,
        initial_equity="10000",
        quote_asset="USDT",
        execution_model=ExecutionModel.PAPER_LINEAR_V1,
        fee_model=FeeModel("2", "4"),
        slippage_model=SlippageModel(SlippageKind.FIXED_BPS, "1"),
        max_leverage="5",
        pause_on_controller_loss=True,
    )


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: Mapping[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="phase2-benchmark-client",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


def _windows_rss_bytes() -> int | None:
    if sys.platform != "win32":
        return None

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
    handle = get_current_process()
    if not get_process_memory_info(handle, ctypes.byref(counters), counters.cb):
        return None
    return int(counters.WorkingSetSize)


def _linux_rss_bytes() -> int | None:
    if not sys.platform.startswith("linux"):
        return None
    try:
        resident_pages = int(
            Path("/proc/self/statm").read_text(encoding="ascii").split()[1]
        )
        return resident_pages * int(os.sysconf("SC_PAGE_SIZE"))
    except (OSError, ValueError, IndexError):
        return None


def _rss_bytes() -> int | None:
    return _windows_rss_bytes() or _linux_rss_bytes()


async def _wait_ended(actor: ReplaySessionActor) -> None:
    while True:
        snapshot = await actor.snapshot()
        if snapshot.state.value == "ENDED":
            return
        await asyncio.sleep(0.001)


async def run_benchmark(
    *,
    bar_count: int = DEFAULT_BAR_COUNT,
    command_queue_size: int = 32,
    event_buffer_size: int = 512,
    checkpoint_event_interval: int = 10_000,
    checkpoint_virtual_ms: int = 300_000,
) -> dict[str, object]:
    snapshot = _fixture(bar_count)
    reducer = BenchmarkReducer()
    actor = ReplaySessionActor(
        session_id="phase2-benchmark-session",
        config=_session_config(bar_count),
        source_factory=lambda: BarReplaySource(snapshot),
        initial_virtual_time_ms=START_OPEN_MS,
        command_queue_size=command_queue_size,
        event_buffer_size=event_buffer_size,
        max_emit_fps=30,
        controller_ttl_seconds=300,
        checkpoint_event_interval=checkpoint_event_interval,
        checkpoint_virtual_ms=checkpoint_virtual_ms,
        reducer=reducer,
        max_command_records=256,
        max_recent_checkpoints=32,
    )
    await actor.start()
    await actor.submit(_command("benchmark-acquire", CommandType.ACQUIRE_CONTROLLER, 0))

    repeated_speed = _command(
        "benchmark-speed",
        CommandType.SET_SPEED,
        1,
        {"speed": "MAX"},
    )
    pressure_results = await asyncio.gather(
        *(actor.submit(repeated_speed) for _ in range(command_queue_size * 2)),
        return_exceptions=True,
    )
    overflow_count = sum(
        isinstance(result, ReplayDomainError)
        and result.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
        for result in pressure_results
    )
    successful_pressure = sum(not isinstance(result, BaseException) for result in pressure_results)
    if successful_pressure < 1:
        raise RuntimeError("command pressure probe produced no accepted command")

    baseline_rss = _rss_bytes()
    peak_rss = baseline_rss
    rss_milestones: dict[str, int | None] = {}
    stop_sampling = asyncio.Event()
    milestones = (
        (0.25, "25pct"),
        (0.50, "50pct"),
        (0.75, "75pct"),
        (1.00, "100pct"),
    )

    async def sample_memory() -> None:
        nonlocal peak_rss
        pending = list(milestones)
        while not stop_sampling.is_set():
            current = _rss_bytes()
            if current is not None:
                peak_rss = current if peak_rss is None else max(peak_rss, current)
            processed = int(actor.diagnostics()["events_processed"])
            while pending and processed >= math.ceil(bar_count * pending[0][0]):
                _, label = pending.pop(0)
                rss_milestones[label] = current
            await asyncio.sleep(0.002)
        current = _rss_bytes()
        if current is not None:
            peak_rss = current if peak_rss is None else max(peak_rss, current)
        for _, label in pending:
            rss_milestones[label] = current

    sampler = asyncio.create_task(sample_memory(), name="phase2-benchmark-rss")
    started = time.perf_counter()
    await actor.submit(_command("benchmark-play", CommandType.PLAY, 2))
    await _wait_ended(actor)
    elapsed_seconds = time.perf_counter() - started
    stop_sampling.set()
    await sampler

    final = await actor.snapshot()
    diagnostics = actor.diagnostics()
    latest_checkpoint = actor.latest_checkpoint_blob()
    checkpoint_count = int(diagnostics["checkpoints_created"])
    checkpoint_bytes = int(diagnostics["checkpoint_bytes"])
    projection = diagnostics["projection"]
    events = diagnostics["events"]
    checkpoints = diagnostics["checkpoints"]
    if (
        not isinstance(projection, Mapping)
        or not isinstance(events, Mapping)
        or not isinstance(checkpoints, Mapping)
    ):
        raise TypeError("actor diagnostics shape changed during benchmark")

    ordinary_projection_rate = (
        float(projection["ordinary_emitted"]) / elapsed_seconds
        if elapsed_seconds > 0
        else 0.0
    )
    retained_structures_bounded = (
        int(diagnostics["command_queue_high_water"]) <= command_queue_size
        and int(events["retained"]) <= event_buffer_size
        and int(diagnostics["projection_buffer_size"]) <= event_buffer_size
        and int(checkpoints["records"]) <= 33
    )
    if not retained_structures_bounded:
        raise RuntimeError("a replay actor retained structure exceeded its configured bound")
    allowed_projection_count = math.ceil(elapsed_seconds * 30) + 1
    if int(projection["ordinary_emitted"]) > allowed_projection_count:
        raise RuntimeError("ordinary projection exceeded the 30 fps budget")
    if int(diagnostics["events_processed"]) != bar_count:
        raise RuntimeError("benchmark actor did not process the complete fixture")

    midpoint_rss = rss_milestones.get("50pct")
    final_rss = rss_milestones.get("100pct")
    late_rss_growth = (
        final_rss - midpoint_rss
        if final_rss is not None and midpoint_rss is not None
        else None
    )
    linear_growth_suspected = bool(
        late_rss_growth is not None and late_rss_growth > 8 * 1024 * 1024
    )
    report: dict[str, object] = {
        "schema": "replay-actor-benchmark.v1",
        "fixture": {
            "source_kind": "BAR",
            "interval": "1m",
            "bar_count": bar_count,
            "data_epoch": snapshot.data_epoch,
        },
        "result": {
            "elapsed_seconds": round(elapsed_seconds, 6),
            "events_per_second": round(bar_count / elapsed_seconds, 2),
            "state_hash": final.state_hash,
            "virtual_time_ms": final.cursor.virtual_time_ms,
            "source_sequence": final.cursor.source_sequence,
        },
        "commands": {
            "ack_latency_ms": diagnostics["command_ack_latency_ms"],
            "pressure_attempts": len(pressure_results),
            "pressure_succeeded": successful_pressure,
            "overflow_count": overflow_count,
            "queue_capacity": command_queue_size,
            "queue_high_water": diagnostics["command_queue_high_water"],
        },
        "actor": {
            "events_processed": diagnostics["events_processed"],
            "component_snapshot_materializations": diagnostics[
                "component_snapshot_materializations"
            ],
        },
        "checkpoints": {
            "created": checkpoint_count,
            "latest_size_bytes": len(latest_checkpoint) if latest_checkpoint else 0,
            "average_size_bytes": (
                round(checkpoint_bytes / checkpoint_count, 2)
                if checkpoint_count
                else 0.0
            ),
            "latency_ms": diagnostics["checkpoint_latency_ms"],
            "retained": checkpoints["records"],
        },
        "projection": {
            "ordinary_emitted": projection["ordinary_emitted"],
            "ordinary_coalesced": projection["ordinary_coalesced"],
            "ordinary_per_second": round(ordinary_projection_rate, 3),
            "max_fps": projection["max_fps"],
        },
        "memory": {
            "baseline_rss_bytes": baseline_rss,
            "peak_rss_bytes": peak_rss,
            "peak_delta_bytes": (
                peak_rss - baseline_rss
                if peak_rss is not None and baseline_rss is not None
                else None
            ),
            "milestones_rss_bytes": rss_milestones,
            "late_half_growth_bytes": late_rss_growth,
            "linear_growth_suspected": linear_growth_suspected,
        },
        "bounds": {
            "retained_structures_bounded": retained_structures_bounded,
            "event_buffer_retained": events["retained"],
            "event_buffer_capacity": events["max_events"],
            "projection_buffer_retained": diagnostics["projection_buffer_size"],
            "checkpoint_retained": checkpoints["records"],
            "checkpoint_capacity": 33,
        },
    }
    await actor.shutdown(step_timeout=5)
    if actor.task is None or not actor.task.done():
        raise RuntimeError("benchmark actor task leaked after shutdown")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark the deterministic replay actor with a generated BAR fixture."
    )
    parser.add_argument("--bars", type=int, default=DEFAULT_BAR_COUNT)
    parser.add_argument("--command-queue-size", type=int, default=32)
    parser.add_argument("--event-buffer-size", type=int, default=512)
    parser.add_argument("--checkpoint-event-interval", type=int, default=10_000)
    parser.add_argument("--checkpoint-virtual-ms", type=int, default=300_000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = asyncio.run(
        run_benchmark(
            bar_count=args.bars,
            command_queue_size=args.command_queue_size,
            event_buffer_size=args.event_buffer_size,
            checkpoint_event_interval=args.checkpoint_event_interval,
            checkpoint_virtual_ms=args.checkpoint_virtual_ms,
        )
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    memory = report.get("memory")
    if isinstance(memory, Mapping) and memory.get("linear_growth_suspected") is True:
        raise SystemExit("late benchmark RSS growth exceeded the fail-closed threshold")


if __name__ == "__main__":
    main()
