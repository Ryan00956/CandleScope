"""Measure the Phase 7 segment-registry GC planning envelope."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.replay.canonical import canonical_json, canonical_sha256  # noqa: E402
from app.replay.storage.sqlite_store import ReplaySQLiteStore  # noqa: E402
from app.replay.training.schema import migrate_training_schema  # noqa: E402
from app.replay.training.account_history import (  # noqa: E402
    AccountHistoryArchiveManager,
)
from app.replay.training.historical_book import (  # noqa: E402
    HistoricalBookArchiveManager,
)
from app.replay.training.segments import (  # noqa: E402
    REHYDRATION_PROTOCOL,
    SEGMENT_PROTOCOL,
    ReplaySegmentManager,
)
from app.replay.training.storage_governance import (  # noqa: E402
    MAX_CATEGORY_ITEMS,
    ReplayStorageGovernance,
)
from tests.fixtures.replay.service_fakes import replay_settings  # noqa: E402


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * percentile) - 1)]


def _contains_forbidden_key(value: object, forbidden: set[str]) -> bool:
    if isinstance(value, dict):
        return any(
            str(key) in forbidden
            or _contains_forbidden_key(item, forbidden)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_forbidden_key(item, forbidden) for item in value)
    return False


def _seed_segments(
    connection,
    *,
    segment_count: int,
    byte_size: int,
    trusted_file: Path,
    checksum: str,
) -> None:
    rows = []
    for index in range(segment_count):
        segment_id = f"segment-benchmark-{index:05d}"
        range_start_ms = 1_700_000_000_000 + index * 60_000
        range_end_ms = range_start_ms + 59_999
        manifest = {
            "schema": REHYDRATION_PROTOCOL,
            "trusted_origin": "PHASE7_BENCHMARK",
            "trusted_file": str(trusted_file),
            "source_identity": {
                "exchange": "benchmark",
                "market_type": "spot",
                "symbol": "BENCHUSDT",
                "base_interval": "1m",
            },
            "schema_version": "benchmark.segment.v1",
            "dataset_epoch": "benchmark-epoch-v1",
            "checksum_sha256": checksum,
            "byte_size": byte_size,
            "range": {"start_ms": range_start_ms, "end_ms": range_end_ms},
        }
        rows.append(
            (
                segment_id,
                f"sha256:{index + segment_count + 1:064x}",
                SEGMENT_PROTOCOL,
                "FUTURE",
                "PHASE7_BENCHMARK",
                "benchmark",
                "spot",
                "BENCHUSDT",
                "1m",
                range_start_ms,
                range_end_ms,
                "benchmark.segment.v1",
                "benchmark-epoch-v1",
                checksum,
                f"objects/{segment_id}.blob",
                byte_size,
                canonical_json(manifest),
                range_start_ms,
                range_start_ms,
                range_start_ms,
            )
        )
    connection.executemany(
        """
        INSERT INTO replay_data_segment(
            segment_id, identity_key, protocol, source_kind, adapter_kind,
            exchange, market_type, symbol, base_interval,
            range_start_ms, range_end_ms, schema_version, dataset_epoch,
            checksum_sha256, coverage_state, continuity_state, health,
            storage_kind, local_path, byte_size, rebuildable, trusted_origin,
            rehydration_manifest_json, quarantine_reason, generation,
            reclaim_token, last_used_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT',
                  'CONTIGUOUS', 'READY', 'EXTERNAL_REPLAY_OWNED', ?, ?, 1,
                  'PHASE7_BENCHMARK', ?, NULL, 1, NULL, ?, ?, ?)
        """,
        rows,
    )


async def run_benchmark(
    *,
    segment_count: int = 10_000,
    iterations: int = 20,
    byte_size: int = 4_096,
    p95_budget_ms: float = 1_500.0,
    inventory_p95_budget_ms: float = 1_500.0,
) -> dict[str, object]:
    if not 1 <= segment_count <= 10_000:
        raise ValueError("segment_count must be between 1 and 10000")
    if iterations < 1:
        raise ValueError("iterations must be positive")
    if byte_size < 1:
        raise ValueError("byte_size must be positive")
    if p95_budget_ms <= 0:
        raise ValueError("p95_budget_ms must be positive")
    if inventory_p95_budget_ms <= 0:
        raise ValueError("inventory_p95_budget_ms must be positive")

    with tempfile.TemporaryDirectory(prefix="replay-phase7-benchmark-") as directory:
        database = Path(directory) / "segments.db"
        trusted_file = Path(directory) / "trusted-source.blob"
        trusted_file.write_bytes(bytes(byte_size))
        trusted_checksum = f"sha256:{hashlib.sha256(bytes(byte_size)).hexdigest()}"
        store = ReplaySQLiteStore(database, now_ms=lambda: 1_800_000_000_000)
        owned_root = Path(directory) / "owned"
        object_root = owned_root / "objects"
        object_root.mkdir(parents=True)
        for index in range(segment_count):
            (object_root / f"segment-benchmark-{index:05d}.blob").touch()
        manager = ReplaySegmentManager(store, root=owned_root)
        settings = replace(
            replay_settings(database),
            replay_segment_max_archive_bytes=segment_count * byte_size * 2,
        )
        books = HistoricalBookArchiveManager(
            store,
            enabled=False,
            max_archive_bytes=settings.replay_historical_book_max_archive_bytes,
            root=Path(directory) / "books",
        )
        accounts = AccountHistoryArchiveManager(
            store,
            enabled=False,
            max_archive_bytes=settings.replay_account_history_max_archive_bytes,
            root=Path(directory) / "accounts",
        )
        governance = ReplayStorageGovernance(
            store,
            settings=settings,
            segments=manager,
            historical_books=books,
            account_history=accounts,
        )
        try:
            await store.run_extension_write(
                lambda connection: migrate_training_schema(
                    connection,
                    now_ms=store._validated_now_ms(),
                )
            )
            await store.run_extension_write(
                lambda connection: _seed_segments(
                    connection,
                    segment_count=segment_count,
                    byte_size=byte_size,
                    trusted_file=trusted_file,
                    checksum=trusted_checksum,
                )
            )
            target_bytes = segment_count * byte_size
            warm = await manager.gc_plan(
                target_reclaim_bytes=target_bytes,
                max_segments=segment_count,
                audit=False,
            )
            durations_ms: list[float] = []
            plan = warm
            for _ in range(iterations):
                started = time.perf_counter()
                plan = await manager.gc_plan(
                    target_reclaim_bytes=target_bytes,
                    max_segments=segment_count,
                    audit=False,
                )
                durations_ms.append((time.perf_counter() - started) * 1_000)
            if len(plan["candidates"]) != segment_count or plan["protected"]:
                raise RuntimeError("benchmark registry did not produce the exact safe candidate set")
            p50_ms = _percentile(durations_ms, 0.50)
            p95_ms = _percentile(durations_ms, 0.95)
            await governance.inventory()
            inventory_durations_ms: list[float] = []
            inventory: dict[str, object] = {}
            for _ in range(iterations):
                started = time.perf_counter()
                inventory = await governance.inventory()
                inventory_durations_ms.append(
                    (time.perf_counter() - started) * 1_000
                )
            inventory_p50_ms = _percentile(inventory_durations_ms, 0.50)
            inventory_p95_ms = _percentile(inventory_durations_ms, 0.95)
            categories = inventory["categories"]
            if not isinstance(categories, dict):
                raise RuntimeError("storage inventory categories are malformed")
            segment_inventory = categories["segments"]
            if not isinstance(segment_inventory, dict):
                raise RuntimeError("segment storage inventory is malformed")
            summary = segment_inventory["summary"]
            items = segment_inventory["items"]
            if (
                not isinstance(summary, dict)
                or not isinstance(items, list)
                or summary.get("object_count") != segment_count
                or summary.get("truncated") is not (
                    segment_count > MAX_CATEGORY_ITEMS
                )
                or len(items) != min(segment_count, MAX_CATEGORY_ITEMS)
            ):
                raise RuntimeError("storage inventory did not remain bounded")
            forbidden = {
                "local_path",
                "trusted_source_path",
                "checksum_sha256",
                "dataset_epoch",
                "range_start_ms",
                "range_end_ms",
                "actual_time_ms",
            }
            if _contains_forbidden_key(inventory, forbidden):
                raise RuntimeError("storage inventory exposed a forbidden field")
            evidence = {
                "segment_count": segment_count,
                "candidate_count": len(plan["candidates"]),
                "protected_count": len(plan["protected"]),
                "target_reclaim_bytes": target_bytes,
                "estimated_reclaim_bytes": plan["estimated_reclaim_bytes"],
                "plan_hash": plan["plan_hash"],
            }
            inventory_evidence = {
                "object_count": summary["object_count"],
                "item_count": len(items),
                "truncated": summary["truncated"],
                "protocol": inventory["protocol"],
            }
            gc_budget_pass = p95_ms <= p95_budget_ms
            inventory_budget_pass = (
                inventory_p95_ms <= inventory_p95_budget_ms
            )
            return {
                "schema_version": "replay.phase7.segment-gc-benchmark.v1",
                "workload": "one-batched-registry-read-plus-deterministic-gc-plan",
                "iterations": iterations,
                "segment_count": segment_count,
                "p50_ms": round(p50_ms, 3),
                "p95_ms": round(p95_ms, 3),
                "max_ms": round(max(durations_ms), 3),
                "p95_budget_ms": p95_budget_ms,
                "inventory_p50_ms": round(inventory_p50_ms, 3),
                "inventory_p95_ms": round(inventory_p95_ms, 3),
                "inventory_max_ms": round(max(inventory_durations_ms), 3),
                "inventory_p95_budget_ms": inventory_p95_budget_ms,
                "gc_budget_pass": gc_budget_pass,
                "inventory_budget_pass": inventory_budget_pass,
                "budget_pass": gc_budget_pass and inventory_budget_pass,
                "evidence": evidence,
                "evidence_hash": canonical_sha256(evidence),
                "inventory_evidence": inventory_evidence,
                "inventory_evidence_hash": canonical_sha256(
                    inventory_evidence
                ),
            }
        finally:
            await manager.shutdown()
            await store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--segments", type=int, default=10_000)
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--byte-size", type=int, default=4_096)
    parser.add_argument("--p95-budget-ms", type=float, default=1_500.0)
    parser.add_argument(
        "--inventory-p95-budget-ms",
        type=float,
        default=1_500.0,
    )
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()
    report = asyncio.run(
        run_benchmark(
            segment_count=args.segments,
            iterations=args.iterations,
            byte_size=args.byte_size,
            p95_budget_ms=args.p95_budget_ms,
            inventory_p95_budget_ms=args.inventory_p95_budget_ms,
        )
    )
    rendered = json.dumps(report, indent=2)
    print(rendered)
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(f"{rendered}\n", encoding="utf-8")
    if not report["budget_pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
