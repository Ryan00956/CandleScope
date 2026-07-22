"""Phase 8 exact-reducer fast-forward equivalence and resource benchmark."""

from __future__ import annotations

import argparse
import asyncio
import gc
import json
import math
import sys
import time
from pathlib import Path
from typing import Mapping

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.actor import ReplaySessionActor  # noqa: E402
from app.replay.canonical import canonical_sha256  # noqa: E402
from app.replay.constants import REPLAY_PROTOCOL, CommandType  # noqa: E402
from app.replay.internal_commands import InternalCommandType  # noqa: E402
from app.replay.models import ReplayCommand  # noqa: E402
from app.replay.sources.trade_reader import PagedReplayTradeReader  # noqa: E402
from app.replay.sources.trade_source import TradeReplaySource  # noqa: E402
from scripts.benchmark_replay_trade import (  # noqa: E402
    GeneratedPagedArchive,
    START_TIME_MS,
    _broker,
    _dataset,
    _rss_bytes,
    _session_config,
)


SCHEMA_VERSION = "replay-fast-forward-benchmark.v1"


def _command(
    *,
    command_id: str,
    revision: int,
    command_type: CommandType | InternalCommandType,
    payload: Mapping[str, object],
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="phase8-benchmark",
        expected_revision=revision,
        type=command_type,
        payload=payload,
    )


async def _run_mode(
    *,
    optimized: bool,
    trade_count: int,
    page_rows: int,
    chunk_events: int,
    tail_events: int,
    event_spacing_ms: int,
) -> dict[str, object]:
    mode = "AGGREGATE_SCAN" if optimized else "FULL_EVENT_SCAN"
    dataset = _dataset(trade_count, event_spacing_ms=event_spacing_ms)
    archive = GeneratedPagedArchive(
        dataset,
        event_spacing_ms=event_spacing_ms,
    )
    broker = _broker(replay_end_time_ms=dataset.end_time_ms, max_closed_bars=128)

    def source_factory() -> TradeReplaySource:
        return TradeReplaySource(
            PagedReplayTradeReader(archive, dataset, page_rows=page_rows)
        )

    actor = ReplaySessionActor(
        session_id=f"phase8-{mode.lower()}",
        config=_session_config(
            trade_count,
            event_spacing_ms=event_spacing_ms,
        ),
        source_factory=source_factory,
        initial_virtual_time_ms=START_TIME_MS,
        command_queue_size=32,
        event_buffer_size=chunk_events,
        max_emit_fps=30,
        controller_ttl_seconds=3_600,
        checkpoint_event_interval=max(trade_count + 1, 10_000),
        checkpoint_virtual_ms=max(dataset.end_time_ms - START_TIME_MS + 1, 300_000),
        reducer=broker,
        max_command_records=max(512, math.ceil(trade_count / chunk_events) + 2),
    )
    await actor.start()
    baseline_rss = _rss_bytes()
    peak_rss = baseline_rss
    milestones: dict[str, int | None] = {}
    boundaries = (
        (math.ceil(trade_count * 0.25), "25pct"),
        (math.ceil(trade_count * 0.50), "50pct"),
        (math.ceil(trade_count * 0.75), "75pct"),
        (trade_count, "100pct"),
    )
    pending = list(boundaries)
    consumed = 0
    coalesced = 0
    chunks = 0
    try:
        acquired = await actor.submit(
            _command(
                command_id=f"{mode.lower()}-acquire",
                revision=0,
                command_type=CommandType.ACQUIRE_CONTROLLER,
                payload={},
            )
        )
        revision = acquired.revision
        started = time.perf_counter()
        while consumed < trade_count:
            count = min(chunk_events, trade_count - consumed)
            command_type: CommandType | InternalCommandType
            payload: dict[str, object]
            if optimized:
                command_type = InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT
                payload = {
                    "count": count,
                    "tail_events": min(tail_events, count),
                }
            else:
                command_type = CommandType.STEP
                payload = {"count": count}
            result = await actor.submit(
                _command(
                    command_id=f"{mode.lower()}-{chunks + 1}",
                    revision=revision,
                    command_type=command_type,
                    payload=payload,
                )
            )
            revision = result.revision
            consumed += int(result.data.get("consumed", 0))
            coalesced += int(result.data.get("coalesced_projection_events", 0))
            chunks += 1
            while pending and consumed >= pending[0][0]:
                _, label = pending.pop(0)
                gc.collect()
                current = _rss_bytes()
                milestones[label] = current
                if current is not None:
                    peak_rss = current if peak_rss is None else max(peak_rss, current)
        elapsed = time.perf_counter() - started
        snapshot = await actor.snapshot()
        diagnostics = actor.diagnostics()
        projection = diagnostics["projection"]
        if not isinstance(projection, Mapping):
            raise TypeError("projection diagnostics are invalid")
        midpoint = milestones.get("50pct")
        end = milestones.get("100pct")
        report = broker.build_report()
        return {
            "mode": mode,
            "result": {
                "elapsed_seconds": round(elapsed, 6),
                "events_per_second": round(trade_count / elapsed, 2),
                "source_sequence": snapshot.cursor.source_sequence,
                "cursor": snapshot.to_dict()["cursor"],
                "state_hash": snapshot.state_hash,
                "component_state_hash": broker.state_hash,
                "report_hash": report.report_hash,
                "public_event_sequence": snapshot.sequence,
            },
            "streaming": {
                "chunks": chunks,
                "chunk_event_limit": chunk_events,
                "tail_event_count": tail_events if optimized else 0,
                "coalesced_projection_events": coalesced,
                "archive_page_calls": archive.page_calls,
                "archive_max_page_rows": archive.max_page_rows_seen,
                "page_rows_limit": page_rows,
                "full_history_materialized": False,
                "queue_high_water": diagnostics["command_queue_high_water"],
                "queue_capacity": 32,
                "projection_domain_events": projection["domain_events"],
                "projection_capacity_forced_flushes": projection[
                    "capacity_forced_flushes"
                ],
            },
            "memory": {
                "baseline_rss_bytes": baseline_rss,
                "peak_rss_bytes": peak_rss,
                "milestones_rss_bytes": milestones,
                "late_half_growth_bytes": (
                    None if midpoint is None or end is None else end - midpoint
                ),
            },
        }
    finally:
        await actor.shutdown(step_timeout=5)


async def run_benchmark(args: argparse.Namespace) -> dict[str, object]:
    spacing = max(
        1,
        (args.span_days * 86_400_000) // max(1, args.trades - 1),
    )
    optimized = await _run_mode(
        optimized=True,
        trade_count=args.trades,
        page_rows=args.page_rows,
        chunk_events=args.chunk_events,
        tail_events=args.tail_events,
        event_spacing_ms=spacing,
    )
    reference = (
        None
        if args.skip_reference
        else await _run_mode(
            optimized=False,
            trade_count=args.trades,
            page_rows=args.page_rows,
            chunk_events=args.chunk_events,
            tail_events=args.tail_events,
            event_spacing_ms=spacing,
        )
    )
    optimized_result = optimized["result"]
    optimized_streaming = optimized["streaming"]
    optimized_memory = optimized["memory"]
    assert isinstance(optimized_result, Mapping)
    assert isinstance(optimized_streaming, Mapping)
    assert isinstance(optimized_memory, Mapping)
    runtime_checks = {
        "all_events_processed": optimized_result["source_sequence"] == args.trades,
        "bounded_pages": (
            int(optimized_streaming["archive_max_page_rows"]) <= args.page_rows
        ),
        "bounded_queue": int(optimized_streaming["queue_high_water"]) <= 32,
        "no_capacity_forced_flush": (
            optimized_streaming["projection_capacity_forced_flushes"] == 0
        ),
        "full_history_not_materialized": (
            optimized_streaming["full_history_materialized"] is False
        ),
        "bounded_late_half_memory": (
            optimized_memory["late_half_growth_bytes"] is None
            or int(optimized_memory["late_half_growth_bytes"]) <= 64 * 1024 * 1024
        ),
    }
    equivalence_checks: dict[str, bool] = {}
    if reference is not None:
        reference_result = reference["result"]
        reference_streaming = reference["streaming"]
        reference_memory = reference["memory"]
        assert isinstance(reference_result, Mapping)
        assert isinstance(reference_streaming, Mapping)
        assert isinstance(reference_memory, Mapping)
        equivalence_checks = {
            "cursor_equal": (
                optimized_result["cursor"] == reference_result["cursor"]
            ),
            "state_hash_equal": (
                optimized_result["state_hash"] == reference_result["state_hash"]
            ),
            "component_state_hash_equal": (
                optimized_result["component_state_hash"]
                == reference_result["component_state_hash"]
            ),
            "report_hash_equal": (
                optimized_result["report_hash"] == reference_result["report_hash"]
            ),
            "reference_all_events_processed": (
                reference_result["source_sequence"] == args.trades
            ),
            "reference_bounded_pages": (
                int(reference_streaming["archive_max_page_rows"]) <= args.page_rows
            ),
            "reference_bounded_queue": (
                int(reference_streaming["queue_high_water"]) <= 32
            ),
            "reference_no_capacity_forced_flush": (
                reference_streaming["projection_capacity_forced_flushes"] == 0
            ),
            "reference_full_history_not_materialized": (
                reference_streaming["full_history_materialized"] is False
            ),
            "projection_delivery_reduced": (
                int(optimized_streaming["projection_domain_events"])
                < int(reference_streaming["projection_domain_events"])
            ),
            "reference_bounded_late_half_memory": (
                reference_memory["late_half_growth_bytes"] is None
                or int(reference_memory["late_half_growth_bytes"])
                <= 64 * 1024 * 1024
            ),
        }
    checks = {**runtime_checks, **equivalence_checks}
    deterministic_evidence = {
        "schema_version": SCHEMA_VERSION,
        "trade_count": args.trades,
        "span_days": args.span_days,
        "event_spacing_ms": spacing,
        "page_rows": args.page_rows,
        "chunk_events": args.chunk_events,
        "tail_events": args.tail_events,
        "checks": checks,
        "state_hash": optimized_result["state_hash"],
        "component_state_hash": optimized_result["component_state_hash"],
        "report_hash": optimized_result["report_hash"],
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "fixture": {
            "source_kind": "AGG_TRADE",
            "trade_count": args.trades,
            "requested_span_days": args.span_days,
            "event_spacing_ms": spacing,
            "actual_span_ms": spacing * max(0, args.trades - 1),
            "generated": True,
        },
        "optimized": optimized,
        "reference": reference,
        "equivalence": {
            "status": (
                "VERIFIED_AGAINST_FULL_EVENT_SCAN"
                if reference is not None
                else "PERFORMANCE_ONLY_REFERENCE_NOT_RUN"
            ),
            "checks": equivalence_checks,
            "passed": (
                all(equivalence_checks.values()) if reference is not None else None
            ),
            "proof": "CURSOR_SOURCE_EVENT_CHAIN_COMPONENT_STATE_REPORT_HASH",
            "deterministic_evidence_hash": canonical_sha256(deterministic_evidence),
        },
        "acceptance": {
            "checks": runtime_checks,
            "passed": all(runtime_checks.values()),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trades", type=int, default=1_000_000)
    parser.add_argument("--span-days", type=int, choices=(1, 7), default=7)
    parser.add_argument("--page-rows", type=int, default=50_000)
    parser.add_argument("--chunk-events", type=int, default=4_096)
    parser.add_argument("--tail-events", type=int, default=32)
    parser.add_argument("--skip-reference", action="store_true")
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args()
    for field in ("trades", "page_rows", "chunk_events", "tail_events"):
        if getattr(args, field) < 1:
            parser.error(f"--{field.replace('_', '-')} must be positive")
    if args.tail_events > args.chunk_events:
        parser.error("--tail-events cannot exceed --chunk-events")
    return args


def main() -> int:
    args = parse_args()
    report = asyncio.run(run_benchmark(args))
    encoded = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0 if report["acceptance"]["passed"] else 2  # type: ignore[index]


if __name__ == "__main__":
    raise SystemExit(main())
