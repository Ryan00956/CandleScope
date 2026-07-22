from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import threading
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path

import pytest

import app.replay.training.segments as segments_module
from app.replay.training.errors import TrainingRunError
from app.replay.training.segments import ReplaySegmentManager, SegmentPrepareSpec
from tests.test_replay_v2_training_api import (
    _app as api_app,
    _payload as api_payload,
    _request as api_request,
    _service as api_service,
)
from tests.test_replay_v2_training_phase5 import (
    _request,
    _service,
    _trade_request,
    _trade_service,
)


pytestmark = pytest.mark.anyio


def _checksum(payload: bytes) -> str:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _spec(
    *,
    name: str,
    payload: bytes,
    trusted_file: Path,
    source_kind: str = "FUTURE",
) -> SegmentPrepareSpec:
    return SegmentPrepareSpec(
        source_kind=source_kind,
        adapter_kind="TEST_FUTURE_SOURCE",
        exchange="binance",
        market_type="spot",
        symbol=f"{name.upper()}USDT",
        base_interval="1m",
        range_start_ms=1_700_000_000_000,
        range_end_ms=1_700_000_060_000,
        schema_version="test-segment.v1",
        dataset_epoch=_checksum(f"epoch:{name}".encode()),
        checksum_sha256=_checksum(payload),
        byte_size=len(payload),
        trusted_origin="TEST_TRUSTED_FILE",
        rehydration_manifest={
            "schema": "replay.data.rehydration.v1",
            "trusted_origin": "TEST_TRUSTED_FILE",
            "trusted_file": str(trusted_file),
            "checksum_sha256": _checksum(payload),
            "schema_version": "test-segment.v1",
            "dataset_epoch": _checksum(f"epoch:{name}".encode()),
            "byte_size": len(payload),
            "source_identity": {
                "exchange": "binance",
                "market_type": "spot",
                "symbol": f"{name.upper()}USDT",
                "base_interval": "1m",
            },
            "range": {
                "start_ms": 1_700_000_000_000,
                "end_ms": 1_700_000_060_000,
            },
        },
    )


async def _prepare_payload(
    manager: ReplaySegmentManager,
    spec: SegmentPrepareSpec,
    payload: bytes,
) -> dict[str, object]:
    async def produce(path: Path) -> None:
        path.write_bytes(payload)

    return await manager.prepare_external(spec, produce)


async def test_create_registers_one_checksum_bound_segment_and_completed_prepare_job(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "registry.db")
    try:
        assert service.training is not None
        request = await _request(service)
        plan = await service.training.segment_plan(request)
        assert plan["selection_loads_history"] is False
        assert plan["create_loads_only_selected_range"] is True
        assert plan["prepare_action"] == "SNAPSHOT_LOCAL_BAR_RANGE"
        assert plan["download_worker_enabled"] is False
        assert plan["auto_gc_enabled"] is False

        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
        listed = await service.training.list_data_segments(run_id=run_id)
        assert listed["summary"] == {
            "segment_count": 1,
            "ready_count": 1,
            "quarantined_count": 0,
            "local_bytes": listed["items"][0]["byte_size"],
        }
        segment = listed["items"][0]
        assert segment["adapter_kind"] == "V1_BAR_SNAPSHOT"
        assert segment["storage_kind"] == "EMBEDDED_ARCHIVE"
        assert segment["rebuildable"] is False
        assert segment["ref_count"] == 2
        assert segment["coverage_state"] == "EXACT"
        assert segment["continuity_state"] == "CONTIGUOUS"
        assert segment["checksum_sha256"].startswith("sha256:")

        with sqlite3.connect(service.store.path) as connection:
            connection.row_factory = sqlite3.Row
            job = connection.execute(
                "SELECT * FROM replay_data_prepare_job WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            assert job is not None
            assert job["state"] == "READY"
            assert (job["progress_numerator"], job["progress_denominator"]) == (1, 1)
            dangling = connection.execute(
                """
                SELECT COUNT(*) FROM replay_data_segment_ref AS r
                LEFT JOIN replay_data_segment AS s USING(segment_id)
                LEFT JOIN replay_training_run AS t USING(run_id)
                WHERE s.segment_id IS NULL OR t.run_id IS NULL
                """
            ).fetchone()[0]
            assert dangling == 0
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_identical_run_dataset_deduplicates_segment_but_keeps_independent_refs(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "dedupe.db")
    try:
        assert service.training is not None
        request = await _request(service)
        first = await service.training.create_run(request)
        second = await service.training.create_run(request)
        assert first["run"]["run_id"] != second["run"]["run_id"]
        all_segments = await service.training.list_data_segments()
        assert all_segments["summary"]["segment_count"] == 1
        assert all_segments["items"][0]["ref_count"] == 4
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_actor_checkpoint_and_review_owners_follow_archive_lifecycle(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "owners.db")
    try:
        assert service.training is not None
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT active FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'ACTOR'
                """,
                (run_id,),
            ).fetchone() == (1,)

        returned = await service.training.return_to_hub_by_session(session_id)
        assert returned["checkpointed"] is True
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT active FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'ACTOR'
                """,
                (run_id,),
            ).fetchone() == (0,)
            assert connection.execute(
                """
                SELECT COUNT(*) FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'CHECKPOINT'
                """,
                (run_id,),
            ).fetchone()[0] >= 1
            assert connection.execute(
                """
                SELECT DISTINCT active, released_at_ms IS NOT NULL
                FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'CHECKPOINT'
                """,
                (run_id,),
            ).fetchall() == [(0, 1)]

        await service.training.store.checkpoint_market_tracks(run_id)
        await service.training.store.checkpoint_market_tracks(run_id)
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT COUNT(*) FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'CHECKPOINT'
                """,
                (run_id,),
            ).fetchone() == (1,)

        await service.training.store.start()
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT active FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'ACTOR'
                """,
                (run_id,),
            ).fetchone() == (0,)

        review = await service.training.start_review(run_id, event_id=None)
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT active FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'REVIEW' AND owner_id = ?
                """,
                (run_id, review["review_id"]),
            ).fetchone() == (1,)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_external_prepare_is_single_flight_and_idempotent(tmp_path: Path) -> None:
    service = await _service(tmp_path / "singleflight.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"deterministic segment payload"
        trusted = tmp_path / "trusted-singleflight.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="single", payload=payload, trusted_file=trusted)
        entered = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def produce(path: Path) -> None:
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            path.write_bytes(payload)

        first = asyncio.create_task(manager.prepare_external(spec, produce))
        await entered.wait()
        second = asyncio.create_task(manager.prepare_external(spec, produce))
        release.set()
        first_result, second_result = await asyncio.gather(first, second)
        assert calls == 1
        assert first_result["segment_id"] == second_result["segment_id"]
        assert first_result["health"] == "READY"

        repeated = await manager.prepare_external(spec, produce)
        assert repeated["segment_id"] == first_result["segment_id"]
        assert calls == 1
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_data_segment WHERE identity_key = ?",
                (spec.identity()[1],),
            ).fetchone() == (1,)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_checksum_mismatch_quarantines_and_never_publishes(tmp_path: Path) -> None:
    service = await _service(tmp_path / "quarantine.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        expected = b"expected bytes"
        trusted = tmp_path / "trusted-quarantine.bin"
        trusted.write_bytes(expected)
        spec = _spec(name="quarantine", payload=expected, trusted_file=trusted)

        async def corrupt(path: Path) -> None:
            path.write_bytes(b"corrupt bytes!")

        with pytest.raises(TrainingRunError) as exc_info:
            await manager.prepare_external(spec, corrupt)
        assert exc_info.value.code == "SEGMENT_CHECKSUM_MISMATCH"
        listed = await manager.list_segments()
        quarantined = next(
            item for item in listed["items"] if item["segment_id"] == spec.identity()[0]
        )
        assert quarantined["health"] == "QUARANTINED"
        assert quarantined["local_object_present"] is False
        assert quarantined["ref_count"] == 0
        assert not any((manager.root / "objects").iterdir())
        assert not any((manager.root / ".tmp").iterdir())
        assert len(tuple((manager.root / ".quarantine").iterdir())) == 1
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_manifest_mismatches_quarantine_before_io_and_retry_succeeds(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "manifest-quarantine.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        cases = (
            ("schema", "schema", "wrong.schema", "MANIFEST_SCHEMA_MISMATCH"),
            (
                "version",
                "schema_version",
                "wrong-version",
                "MANIFEST_SCHEMA_VERSION_MISMATCH",
            ),
            ("range", "range", {"start_ms": 0, "end_ms": 1}, "MANIFEST_RANGE_MISMATCH"),
            (
                "identity",
                "source_identity",
                {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "WRONGUSDT",
                    "base_interval": "1m",
                },
                "MANIFEST_IDENTITY_MISMATCH",
            ),
            (
                "locator",
                "trusted_file",
                None,
                "MANIFEST_REHYDRATOR_MISSING",
            ),
        )
        for name, field, invalid_value, expected_reason in cases:
            payload = f"manifest-{name}".encode()
            trusted = tmp_path / f"trusted-manifest-{name}.bin"
            trusted.write_bytes(payload)
            good_spec = _spec(name=name, payload=payload, trusted_file=trusted)
            bad_manifest = {**good_spec.rehydration_manifest, field: invalid_value}
            bad_spec = replace(good_spec, rehydration_manifest=bad_manifest)
            producer_called = False

            async def must_not_run(path: Path) -> None:
                nonlocal producer_called
                producer_called = True
                path.write_bytes(payload)

            with pytest.raises(TrainingRunError) as exc_info:
                await manager.prepare_external(bad_spec, must_not_run)
            assert exc_info.value.code == "SEGMENT_MANIFEST_MISMATCH"
            assert exc_info.value.details == {"reason": expected_reason}
            assert producer_called is False

            restored = await _prepare_payload(manager, good_spec, payload)
            assert restored["health"] == "READY"
            with sqlite3.connect(service.store.path) as connection:
                assert connection.execute(
                    """
                    SELECT state, failure_reason FROM replay_data_prepare_job
                    WHERE segment_id = ?
                    ORDER BY CASE state WHEN 'QUARANTINED' THEN 0 ELSE 1 END
                    """,
                    (good_spec.identity()[0],),
                ).fetchall() == [("QUARANTINED", expected_reason), ("READY", None)]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_cancel_requested_prepare_never_publishes_partial_data(tmp_path: Path) -> None:
    service = await _service(tmp_path / "cancel.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"cancelable payload"
        trusted = tmp_path / "trusted-cancel.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="cancel", payload=payload, trusted_file=trusted)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def produce(path: Path) -> None:
            entered.set()
            await release.wait()
            path.write_bytes(payload)

        task = asyncio.create_task(manager.prepare_external(spec, produce))
        await entered.wait()
        job_id: str | None = None
        for _ in range(50):
            with sqlite3.connect(service.store.path) as connection:
                row = connection.execute(
                    """
                    SELECT job_id FROM replay_data_prepare_job
                    WHERE segment_id = ? AND state = 'LOADING'
                    """,
                    (spec.identity()[0],),
                ).fetchone()
            if row is not None:
                job_id = str(row[0])
                break
            await asyncio.sleep(0)
        assert job_id is not None
        canceled = await manager.cancel_prepare(job_id)
        assert canceled["cancel_requested"] is True
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                "SELECT state FROM replay_data_prepare_job WHERE job_id = ?",
                (job_id,),
            ).fetchone() == ("CANCELED",)
            assert connection.execute(
                "SELECT health FROM replay_data_segment WHERE segment_id = ?",
                (spec.identity()[0],),
            ).fetchone() == ("CANCELED",)
        assert not any((manager.root / ".tmp").iterdir())
        assert not any((manager.root / "objects").iterdir())
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_agg_trade_partition_set_uses_unified_checksum_bound_adapter(
    tmp_path: Path,
) -> None:
    service = await _trade_service(
        tmp_path / "trade-registry.db",
        archive_root=tmp_path / "raw-trades",
        symbols=("BTCUSDT",),
    )
    try:
        assert service.training is not None
        created = await service.training.create_run(await _trade_request(service))
        run_id = str(created["run"]["run_id"])
        listed = await service.training.segments.list_segments(run_id=run_id)
        assert listed["summary"]["segment_count"] == 1
        segment = listed["items"][0]
        assert segment["source_kind"] == "AGG_TRADE"
        assert segment["adapter_kind"] == "RAW_AGG_TRADE_PARTITION_SET"
        assert segment["coverage_state"] == "EXACT"
        assert segment["rehydration_manifest"]["source"]["source_quality"] == (
            "binance_public_checksum"
        )
        object_manifests = segment["rehydration_manifest"]["source"][
            "object_manifests"
        ]
        assert object_manifests
        assert all(item["source_checksum_sha256"] for item in object_manifests)
        assert segment["storage_kind"] == "EMBEDDED_ARCHIVE"
        assert segment["rebuildable"] is False
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_interrupted_prepare_cleans_temp_and_records_error(tmp_path: Path) -> None:
    service = await _service(tmp_path / "interrupted.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"interrupted payload"
        trusted = tmp_path / "trusted-interrupted.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="interrupted", payload=payload, trusted_file=trusted)

        async def interrupted(path: Path) -> None:
            path.write_bytes(payload[:4])
            raise OSError("simulated interrupted download")

        with pytest.raises(OSError, match="simulated interrupted"):
            await manager.prepare_external(spec, interrupted)
        assert not any((manager.root / ".tmp").iterdir())
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                "SELECT health FROM replay_data_segment WHERE segment_id = ?",
                (spec.identity()[0],),
            ).fetchone() == ("ERROR",)
            assert connection.execute(
                """
                SELECT state, failure_reason FROM replay_data_prepare_job
                WHERE segment_id = ? ORDER BY created_at_ms DESC LIMIT 1
                """,
                (spec.identity()[0],),
            ).fetchone() == ("ERROR", "OSError")
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_gc_dry_run_matches_execution_and_rehydrates_identical_hash(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "gc.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"rebuildable cold replay source"
        trusted = tmp_path / "trusted-gc.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="cold", payload=payload, trusted_file=trusted)
        prepared = await _prepare_payload(manager, spec, payload)
        segment_id = str(prepared["segment_id"])

        dry_run = await manager.gc_plan(
            target_reclaim_bytes=len(payload),
            max_segments=10,
        )
        assert [item["segment_id"] for item in dry_run["candidates"]] == [segment_id]
        assert dry_run["estimated_reclaim_bytes"] == len(payload)
        assert (manager.root / "objects" / f"{segment_id}.blob").is_file()

        with pytest.raises(TrainingRunError) as exc_info:
            await manager.gc_run(
                plan_hash=_checksum(b"stale-plan"),
                target_reclaim_bytes=len(payload),
                max_segments=10,
            )
        assert exc_info.value.code == "SEGMENT_GC_PLAN_CHANGED"

        executed = await manager.gc_run(
            plan_hash=str(dry_run["plan_hash"]),
            target_reclaim_bytes=len(payload),
            max_segments=10,
        )
        assert executed["exact_dry_run_set"] is True
        assert [item["segment_id"] for item in executed["reclaimed"]] == [segment_id]
        assert executed["reclaimed_bytes"] == len(payload)
        assert not (manager.root / "objects" / f"{segment_id}.blob").exists()
        with sqlite3.connect(service.store.path) as connection:
            row = connection.execute(
                """
                SELECT health, local_path, byte_size, checksum_sha256,
                       rehydration_manifest_json
                FROM replay_data_segment WHERE segment_id = ?
                """,
                (segment_id,),
            ).fetchone()
            assert row[:4] == ("EVICTED", None, 0, _checksum(payload))
            assert json.loads(row[4])["trusted_file"] == str(trusted)

        restored = await manager.rehydrate(segment_id)
        assert restored["health"] == "READY"
        restored_path = manager.root / "objects" / f"{segment_id}.blob"
        assert _checksum(restored_path.read_bytes()) == _checksum(payload)
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                "SELECT checksum_sha256 FROM replay_data_segment WHERE segment_id = ?",
                (segment_id,),
            ).fetchone() == (_checksum(payload),)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_non_rebuildable_actor_review_and_recovery_are_never_gc_candidates(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "protected.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        archive = await service.training.create_run(await _request(service))
        run_id = str(archive["run"]["run_id"])
        payload = b"protected payload"
        trusted = tmp_path / "trusted-protected.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="protected", payload=payload, trusted_file=trusted)
        prepared = await _prepare_payload(manager, spec, payload)
        segment_id = str(prepared["segment_id"])
        now = service.store._validated_now_ms()

        def protect(connection: sqlite3.Connection) -> None:
            subnormal_quantity = f"0.{('0' * 400)}1"
            connection.execute(
                "UPDATE replay_data_segment SET rebuildable = 0 WHERE segment_id = ?",
                (segment_id,),
            )
            connection.execute(
                """
                INSERT INTO replay_data_segment_ref(
                    segment_id, run_id, track_id, owner_kind, owner_id,
                    active, created_at_ms, released_at_ms
                ) VALUES (?, ?, 'track-1', 'ACTOR', 'protected-actor', 1, ?, NULL)
                """,
                (segment_id, run_id, now),
            )
            connection.executemany(
                """
                INSERT INTO replay_data_segment_ref(
                    segment_id, run_id, track_id, owner_kind, owner_id,
                    active, created_at_ms, released_at_ms
                ) VALUES (?, ?, 'track-1', ?, ?, 1, ?, NULL)
                """,
                (
                    (segment_id, run_id, "REVIEW", "protected-review", now),
                    (segment_id, run_id, "RECOVERY", "protected-recovery", now),
                ),
            )
            connection.execute(
                """
                UPDATE replay_training_market_track
                SET position_json = json_object('quantity', ?)
                WHERE run_id = ? AND stable_ordinal = 1
                """,
                (subnormal_quantity, run_id),
            )

        await service.store.run_extension_write(protect)
        plan = await manager.gc_plan(target_reclaim_bytes=len(payload), max_segments=10)
        assert segment_id not in {item["segment_id"] for item in plan["candidates"]}
        protected = next(item for item in plan["protected"] if item["segment_id"] == segment_id)
        assert "NON_REBUILDABLE" in protected["protection_reasons"]
        assert "ACTIVE_ACTOR" in protected["protection_reasons"]
        assert "ACTIVE_REVIEW" in protected["protection_reasons"]
        assert "ACTIVE_RECOVERY" in protected["protection_reasons"]
        assert "OPEN_POSITION" in protected["protection_reasons"]
        assert (manager.root / "objects" / f"{segment_id}.blob").is_file()
        assert plan["non_rebuildable_auto_reclaimed"] is False
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_gc_windows_lock_failure_restores_ready_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "locked.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"locked payload"
        trusted = tmp_path / "trusted-locked.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="locked", payload=payload, trusted_file=trusted)
        prepared = await _prepare_payload(manager, spec, payload)
        segment_id = str(prepared["segment_id"])
        plan = await manager.gc_plan(target_reclaim_bytes=len(payload), max_segments=1)
        real_replace = os.replace

        def locked_replace(source: str | Path, target: str | Path) -> None:
            if "objects" in Path(source).parts and ".trash" in Path(target).parts:
                raise PermissionError(13, "simulated Windows sharing violation", str(source), 32)
            real_replace(source, target)

        monkeypatch.setattr(segments_module.os, "replace", locked_replace)
        result = await manager.gc_run(
            plan_hash=str(plan["plan_hash"]),
            target_reclaim_bytes=len(payload),
            max_segments=1,
        )
        assert result["reclaimed"] == []
        assert result["skipped"][0]["reason"] == "PermissionError"
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                "SELECT health, reclaim_token FROM replay_data_segment WHERE segment_id = ?",
                (segment_id,),
            ).fetchone() == ("READY", None)
        assert (manager.root / "objects" / f"{segment_id}.blob").is_file()
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_gc_rejects_noncanonical_owned_path_without_touching_siblings(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "owned-path.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        first_payload = b"first owned payload"
        second_payload = b"second owned payload"
        first_trusted = tmp_path / "trusted-owned-first.bin"
        second_trusted = tmp_path / "trusted-owned-second.bin"
        first_trusted.write_bytes(first_payload)
        second_trusted.write_bytes(second_payload)
        first_spec = _spec(
            name="ownedfirst",
            payload=first_payload,
            trusted_file=first_trusted,
        )
        second_spec = _spec(
            name="ownedsecond",
            payload=second_payload,
            trusted_file=second_trusted,
        )
        first = await _prepare_payload(manager, first_spec, first_payload)
        second = await _prepare_payload(manager, second_spec, second_payload)
        first_id = str(first["segment_id"])
        second_id = str(second["segment_id"])
        await service.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_data_segment
                SET local_path = 'objects', last_used_at_ms = 0
                WHERE segment_id = ?
                """,
                (first_id,),
            )
        )

        plan = await manager.gc_plan(
            target_reclaim_bytes=len(first_payload),
            max_segments=1,
        )
        assert [item["segment_id"] for item in plan["candidates"]] == [second_id]
        assert all(item["segment_id"] != first_id for item in plan["candidates"])
        protected = next(
            item for item in plan["protected"] if item["segment_id"] == first_id
        )
        assert "OWNED_PATH_INVALID" in protected["protection_reasons"]
        assert (manager.root / "objects" / f"{first_id}.blob").read_bytes() == first_payload
        assert (manager.root / "objects" / f"{second_id}.blob").read_bytes() == second_payload
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_gc_never_recursively_deletes_object_replaced_by_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "owned-directory.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"directory swap payload"
        trusted = tmp_path / "trusted-directory-swap.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="directoryswap", payload=payload, trusted_file=trusted)
        prepared = await _prepare_payload(manager, spec, payload)
        segment_id = str(prepared["segment_id"])
        plan = await manager.gc_plan(
            target_reclaim_bytes=len(payload),
            max_segments=1,
        )
        object_path = manager.root / "objects" / f"{segment_id}.blob"
        sentinel = object_path / "never-delete.txt"
        real_reclaim = manager._reclaim_candidate

        async def swap_then_reclaim(candidate: Mapping[str, object]) -> dict[str, object]:
            object_path.unlink()
            object_path.mkdir()
            sentinel.write_text("owned by the safety test", encoding="utf-8")
            return await real_reclaim(candidate)

        monkeypatch.setattr(manager, "_reclaim_candidate", swap_then_reclaim)

        result = await manager.gc_run(
            plan_hash=str(plan["plan_hash"]),
            target_reclaim_bytes=len(payload),
            max_segments=1,
        )

        assert result["reclaimed"] == []
        assert result["skipped"][0]["reason"] == "LOCAL_OBJECT_NOT_REGULAR"
        assert sentinel.read_text(encoding="utf-8") == "owned by the safety test"
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                "SELECT health, local_path FROM replay_data_segment WHERE segment_id = ?",
                (segment_id,),
            ).fetchone() == ("QUARANTINED", None)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_gc_claim_blocks_new_actor_pin_until_rehydration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "pin-race.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await service.training.return_to_hub_by_session(session_id)

        payload = b"pin race payload"
        trusted = tmp_path / "trusted-pin-race.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="pinrace", payload=payload, trusted_file=trusted)
        prepared = await _prepare_payload(manager, spec, payload)
        segment_id = str(prepared["segment_id"])
        now = service.store._validated_now_ms()

        def attach_cold_run(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                INSERT INTO replay_data_segment_ref(
                    segment_id, run_id, track_id, owner_kind, owner_id,
                    active, created_at_ms, released_at_ms
                ) VALUES (?, ?, 'track-1', 'RUN_ARCHIVE', 'cold-source', 1, ?, NULL)
                """,
                (segment_id, run_id, now),
            )
            connection.execute(
                """
                INSERT INTO replay_data_segment_ref(
                    segment_id, run_id, track_id, owner_kind, owner_id,
                    active, created_at_ms, released_at_ms
                ) VALUES (?, ?, 'track-1', 'ACTOR', 'cold-source-actor', 0, ?, ?)
                """,
                (segment_id, run_id, now, now),
            )

        await service.store.run_extension_write(attach_cold_run)
        plan = await manager.gc_plan(target_reclaim_bytes=len(payload), max_segments=1)
        assert [item["segment_id"] for item in plan["candidates"]] == [segment_id]
        entered = threading.Event()
        release = threading.Event()
        real_replace = os.replace

        def blocked_replace(source: str | Path, target: str | Path) -> None:
            if "objects" in Path(source).parts and ".trash" in Path(target).parts:
                entered.set()
                assert release.wait(timeout=5)
            real_replace(source, target)

        monkeypatch.setattr(segments_module.os, "replace", blocked_replace)
        gc_task = asyncio.create_task(
            manager.gc_run(
                plan_hash=str(plan["plan_hash"]),
                target_reclaim_bytes=len(payload),
                max_segments=1,
            )
        )
        assert await asyncio.to_thread(entered.wait, 5)
        with pytest.raises(TrainingRunError) as exc_info:
            await service.training.store.set_actor_segment_refs(run_id, active=True)
        assert exc_info.value.code == "SEGMENT_NOT_READY"
        release.set()
        result = await gc_task
        assert result["reclaimed"][0]["segment_id"] == segment_id
        restored = await manager.rehydrate(segment_id)
        assert restored["health"] == "READY"
        await service.training.store.set_actor_segment_refs(run_id, active=True)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_reclaim_crash_recovery_restores_trash_and_stale_temp_cleanup(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "recovery.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"crash recovery payload"
        trusted = tmp_path / "trusted-recovery.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="recovery", payload=payload, trusted_file=trusted)
        prepared = await _prepare_payload(manager, spec, payload)
        segment_id = str(prepared["segment_id"])
        original = manager.root / "objects" / f"{segment_id}.blob"
        token = "crash-token"
        trash = manager.root / ".trash" / f"{segment_id}-{token}.trash"
        os.replace(original, trash)
        stale = manager.root / ".tmp" / "stale.part"
        stale.write_bytes(b"stale")

        await service.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_data_segment
                SET health = 'RECLAIMING', reclaim_token = ?, generation = generation + 1
                WHERE segment_id = ?
                """,
                (token, segment_id),
            )
        )
        restarted = ReplaySegmentManager(service.store, root=manager.root)
        await restarted.start()
        assert original.read_bytes() == payload
        assert not trash.exists()
        assert not stale.exists()
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                "SELECT health, reclaim_token FROM replay_data_segment WHERE segment_id = ?",
                (segment_id,),
            ).fetchone() == ("READY", None)
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_data_gc_audit WHERE action = 'RECOVERY'"
            ).fetchone()[0] == 1
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_restart_marks_interrupted_prepare_retryable_and_cleans_artifacts(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "prepare-restart.db")
    try:
        assert service.training is not None
        manager = service.training.segments
        payload = b"restart interrupted prepare"
        trusted = tmp_path / "trusted-prepare-restart.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="preparerestart", payload=payload, trusted_file=trusted)
        segment_id, identity_key = spec.identity()
        now = service.store._validated_now_ms()
        temp_relative = ".tmp/interrupted.part"

        def insert_interrupted(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                INSERT INTO replay_data_segment(
                    segment_id, identity_key, protocol, source_kind, adapter_kind,
                    exchange, market_type, symbol, base_interval,
                    range_start_ms, range_end_ms, schema_version, dataset_epoch,
                    checksum_sha256, coverage_state, continuity_state, health,
                    storage_kind, local_path, byte_size, rebuildable, trusted_origin,
                    rehydration_manifest_json, quarantine_reason, generation,
                    reclaim_token, last_used_at_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, 'replay.data.segment.v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          'EXACT', 'CONTIGUOUS', 'LOADING', 'EXTERNAL_REPLAY_OWNED',
                          NULL, ?, 1, ?, ?, NULL, 1, NULL, ?, ?, ?)
                """,
                (
                    segment_id,
                    identity_key,
                    spec.source_kind,
                    spec.adapter_kind,
                    spec.exchange,
                    spec.market_type,
                    spec.symbol,
                    spec.base_interval,
                    spec.range_start_ms,
                    spec.range_end_ms,
                    spec.schema_version,
                    spec.dataset_epoch,
                    spec.checksum_sha256,
                    spec.byte_size,
                    spec.trusted_origin,
                    json.dumps(spec.rehydration_manifest),
                    now,
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_data_prepare_job(
                    job_id, identity_key, request_hash, state,
                    progress_numerator, progress_denominator, segment_id,
                    run_id, track_id, failure_reason, cancel_requested,
                    temp_path, created_at_ms, updated_at_ms
                ) VALUES ('prepare-interrupted', ?, 'sha256:interrupted', 'LOADING',
                          1, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)
                """,
                (identity_key, len(payload), segment_id, temp_relative, now, now),
            )

        await service.store.run_extension_write(insert_interrupted)
        manager._ensure_dirs()
        (manager.root / temp_relative).write_bytes(payload[:5])
        (manager.root / ".trash" / "orphan-after-finalize.trash").write_bytes(payload)

        restarted = ReplaySegmentManager(service.store, root=manager.root)
        await restarted.start()
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT health, quarantine_reason FROM replay_data_segment
                WHERE segment_id = ?
                """,
                (segment_id,),
            ).fetchone() == ("ERROR", "PROCESS_RESTART_INTERRUPTED")
            assert connection.execute(
                """
                SELECT state, failure_reason, temp_path FROM replay_data_prepare_job
                WHERE job_id = 'prepare-interrupted'
                """
            ).fetchone() == ("ERROR", "PROCESS_RESTART_INTERRUPTED", None)
        assert not any((manager.root / ".tmp").iterdir())
        assert not any((manager.root / ".trash").iterdir())

        restored = await _prepare_payload(restarted, spec, payload)
        assert restored["health"] == "READY"
        assert (manager.root / "objects" / f"{segment_id}.blob").read_bytes() == payload
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_phase7_http_plan_does_not_build_dataset_and_hidden_run_redacts_range(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await api_service(tmp_path / "phase7-api.db")
    app = api_app(service)
    try:
        payload = await api_payload(service)
        calls = 0
        real_create = service._dataset_builder.create

        def tracked_create(*args, **kwargs):
            nonlocal calls
            calls += 1
            return real_create(*args, **kwargs)

        monkeypatch.setattr(service._dataset_builder, "create", tracked_create)
        planned = await api_request(
            app,
            "POST",
            "/api/v1/replay/runs/data-segments/plan",
            json=payload,
        )
        assert planned.status_code == 200
        assert planned.json()["selection_loads_history"] is False
        assert calls == 0

        created = await api_request(app, "POST", "/api/v1/replay/runs", json=payload)
        assert created.status_code == 201
        assert calls == 1
        run_id = created.json()["run"]["run_id"]
        segments = await api_request(
            app,
            "GET",
            f"/api/v1/replay/runs/{run_id}/data-segments",
        )
        assert segments.status_code == 200
        assert segments.json()["items"][0]["range"] == {"redacted": True}
        assert segments.json()["items"][0]["rehydration_manifest"]["range"] == {
            "redacted": True
        }

        global_segments = await api_request(
            app,
            "GET",
            "/api/v1/replay/runs/data-segments",
        )
        assert global_segments.status_code == 200
        assert global_segments.json()["items"][0]["range"] == {"redacted": True}
        assert global_segments.json()["items"][0]["rehydration_manifest"]["range"] == {
            "redacted": True
        }
        assert global_segments.json()["items"][0]["rehydration_manifest"]["source"] == {
            "redacted": True
        }
        assert "trusted_url" not in global_segments.json()["items"][0][
            "rehydration_manifest"
        ]

        gc_plan = await api_request(
            app,
            "POST",
            "/api/v1/replay/runs/data-segments/gc/dry-run",
            json={
                "protocol": "replay.data.gc.v1",
                "target_reclaim_bytes": 1024,
                "max_segments": 10,
            },
        )
        assert gc_plan.status_code == 200
        assert gc_plan.json()["candidates"] == []
        assert "NON_REBUILDABLE" in gc_plan.json()["protected"][0]["protection_reasons"]
    finally:
        await service.shutdown(step_timeout=1.0)
