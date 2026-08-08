from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.core.config import load_replay_settings
from app.replay.training.anchor_codec import (
    ANCHOR_PAYLOAD_ENCODING_RAW,
    ANCHOR_PAYLOAD_ENCODING_ZLIB_V1,
    decode_anchor_payload,
    encode_anchor_payload,
)
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import ReplayV2CommandType
from app.replay.training.schema import TRAINING_SCHEMA_VERSION
from app.replay.training.segments import ReplaySegmentManager
from app.replay.training.storage_governance import ReplayStorageGovernance
from scripts.validate_replay_v2_real_sources import validate_kline_source
from tests.fixtures.replay.account_history import build_account_history_archive
from tests.fixtures.replay.service_fakes import replay_settings
from tests.test_replay_v2_training_phase7 import (
    _prepare_payload,
    _spec,
)
from tests.test_replay_v2_training_phase5 import (
    _acquire as _review_acquire,
    _command as _review_command,
    _request as _review_request,
    _service as _review_service,
)
from tests.test_replay_v2_training_phase16 import (
    ARCHIVE_END,
    REPLAY_START,
    _base_request,
    _import_and_plan,
    _service,
)
from tests.test_replay_v2_training_api import (
    _app as api_app,
    _request as api_request,
)


pytestmark = pytest.mark.anyio


def test_agg_trade_readiness_requires_a_matching_bar_identity(
    tmp_path: Path,
) -> None:
    class BarRepository:
        def __init__(self, market_type: str) -> None:
            self.market_type = market_type

        def list_all_series(self, *, custom_only: bool) -> list[dict[str, str]]:
            assert custom_only is False
            return [
                {
                    "exchange": "binance",
                    "market_type": self.market_type,
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                }
            ]

    class TradeArchive:
        @staticmethod
        def list_verified_identities() -> list[dict[str, str]]:
            return [
                {
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "BTCUSDT",
                }
            ]

    settings = replace(
        replay_settings(tmp_path / "governance.db"),
        replay_agg_trade_enabled=True,
    )
    categories = {
        "segments": {"items": []},
        "historical_books": {"items": []},
        "account_history": {"items": []},
    }
    governance = ReplayStorageGovernance(
        store=None,  # type: ignore[arg-type]
        settings=settings,
        segments=None,  # type: ignore[arg-type]
        historical_books=None,  # type: ignore[arg-type]
        account_history=None,  # type: ignore[arg-type]
        bar_repository=BarRepository("spot"),
        raw_trade_archive=TradeArchive(),
    )
    mismatched = next(
        item
        for item in governance._support_matrix(categories)
        if item["mode"] == "AGG_TRADE"
    )
    assert mismatched["production_readiness"] == "HOLD"
    assert mismatched["reason_codes"] == ["MATCHING_BAR_SOURCE_UNAVAILABLE"]

    governance.bar_repository = BarRepository("futures")
    matched = next(
        item
        for item in governance._support_matrix(categories)
        if item["mode"] == "AGG_TRADE"
    )
    assert matched["production_readiness"] == "ENABLE"
    assert matched["reason_codes"] == []
    assert matched["observed_identities"] == TradeArchive.list_verified_identities()


def test_review_anchor_codec_is_bounded_and_integrity_checked() -> None:
    raw = b'{"schema_version":"test","payload":"' + (b"a" * 500_000) + b'"}'
    encoded = encode_anchor_payload(raw)
    assert encoded.encoding == ANCHOR_PAYLOAD_ENCODING_ZLIB_V1
    assert encoded.stored_bytes < encoded.raw_bytes // 100
    assert (
        decode_anchor_payload(
            encoded.payload,
            encoding=encoded.encoding,
            raw_bytes=encoded.raw_bytes,
            stored_bytes=encoded.stored_bytes,
            raw_sha256=encoded.raw_sha256,
        )
        == raw
    )

    corrupted = bytearray(encoded.payload)
    corrupted[len(corrupted) // 2] ^= 0x01
    with pytest.raises(ValueError):
        decode_anchor_payload(
            bytes(corrupted),
            encoding=encoded.encoding,
            raw_bytes=encoded.raw_bytes,
            stored_bytes=encoded.stored_bytes,
            raw_sha256=encoded.raw_sha256,
        )
    with pytest.raises(ValueError):
        decode_anchor_payload(
            encoded.payload,
            encoding=encoded.encoding,
            raw_bytes=encoded.raw_bytes - 1,
            stored_bytes=encoded.stored_bytes,
            raw_sha256=encoded.raw_sha256,
        )
    with pytest.raises(ValueError):
        decode_anchor_payload(
            encoded.payload + b"trailing",
            encoding=encoded.encoding,
            raw_bytes=encoded.raw_bytes,
            stored_bytes=encoded.stored_bytes + len(b"trailing"),
            raw_sha256=encoded.raw_sha256,
        )

    tiny = encode_anchor_payload(b"x")
    assert tiny.encoding == ANCHOR_PAYLOAD_ENCODING_RAW
    assert tiny.payload == b"x"


async def test_review_anchor_compression_preserves_exact_fork(
    tmp_path: Path,
) -> None:
    database = tmp_path / "review-anchor-codec.db"
    service = await _review_service(database)
    try:
        assert service.training is not None
        created = await service.training.create_run(await _review_request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await _review_acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="phase18-codec-acquire",
        )
        for index in range(40):
            session = await service.get_session(session_id)
            await service.training.command(
                run_id,
                _review_command(
                    run_id,
                    f"phase18-codec-speed-{index}",
                    ReplayV2CommandType.SET_SPEED,
                    session,
                    {"speed": 5 if index % 2 == 0 else 1},
                ),
            )
        review = await service.training.start_review(run_id, event_id=None)
        event_id = str(review["selected_event_id"])
        state_hash = str(review["selected_state_hash"])
        with sqlite3.connect(database) as connection:
            row = connection.execute(
                """
                SELECT COUNT(*), SUM(payload_bytes), SUM(stored_bytes),
                       SUM(payload_encoding = 'ZLIB_V1')
                FROM replay_review_actor_anchor WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            assert row is not None
            anchor_count, raw_bytes, stored_bytes, compressed_count = map(int, row)
            assert anchor_count >= 40
            assert compressed_count == anchor_count
            assert stored_bytes * 2 < raw_bytes

        forked = await service.training.fork_run(run_id, event_id=event_id)
        assert forked["run"]["state_hash"] == state_hash
    finally:
        await service.shutdown(step_timeout=1.0)


def _assert_inventory_is_redacted(value: object, field: str = "inventory") -> None:
    blocked = {
        "range",
        "range_start_ms",
        "range_end_ms",
        "actual_time_ms",
        "actual_start_ms",
        "actual_end_ms",
        "checksum_sha256",
        "dataset_epoch",
        "trusted_source_path",
        "local_path",
        "trusted_file",
        "trusted_url",
    }
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_inventory_is_redacted(item, f"{field}[{index}]")
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        assert key not in blocked, f"{field}.{key} crossed the public boundary"
        assert not key.startswith("_"), f"{field}.{key} is private"
        _assert_inventory_is_redacted(item, f"{field}.{key}")


async def test_segment_total_budget_fails_without_ready_or_temp_half_write(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "segment-budget.db")
    try:
        assert service.training is not None
        manager = ReplaySegmentManager(
            service.store,
            root=tmp_path / "bounded-segments",
            max_archive_bytes=8,
        )
        await manager.start()
        payload = b"nine-byte"
        trusted = tmp_path / "trusted.bin"
        trusted.write_bytes(payload)
        spec = _spec(name="budget", payload=payload, trusted_file=trusted)
        with pytest.raises(TrainingRunError) as failure:
            await _prepare_payload(manager, spec, payload)
        assert failure.value.code == "SEGMENT_STORAGE_BUDGET_EXCEEDED"
        segment_id, _identity = spec.identity()
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT health, local_path, quarantine_reason
                FROM replay_data_segment WHERE segment_id = ?
                """,
                (segment_id,),
            ).fetchone() == (
                "ERROR",
                None,
                "SEGMENT_STORAGE_BUDGET_EXCEEDED",
            )
        jobs = await service.store.run_extension_read(
            lambda connection: tuple(
                connection.execute(
                    """
                    SELECT state, failure_reason, temp_path
                    FROM replay_data_prepare_job WHERE segment_id = ?
                    """,
                    (segment_id,),
                ).fetchall()
            )
        )
        assert len(jobs) == 1
        assert jobs[0]["state"] == "ERROR"
        assert jobs[0]["failure_reason"] == "SEGMENT_STORAGE_BUDGET_EXCEEDED"
        assert not any((manager.root / ".tmp").iterdir())
        assert not any((manager.root / "objects").iterdir())
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_account_gc_plan_hash_eviction_rehydrate_and_audit(
    tmp_path: Path,
) -> None:
    database = tmp_path / "account-gc.db"
    source = tmp_path / "operator-source.sqlite3"
    build_account_history_archive(
        source,
        archive_id="phase18-account",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _service(database)
    try:
        assert service.training is not None
        manager = service.training.account_history
        imported = await manager.import_archive(source)
        archive_id = str(imported["archive_id"])
        proof_hash = str(imported["proof_hash"])
        owned = manager.root / "objects" / f"{archive_id}.sqlite3"
        assert owned.is_file()

        plan = await manager.gc_plan(
            target_reclaim_bytes=1,
            max_archives=10,
        )
        assert plan["protocol"] == "replay.account-history.gc.v1"
        assert [item["archive_id"] for item in plan["candidates"]] == [archive_id]
        with pytest.raises(TrainingRunError) as stale:
            await manager.gc_run(
                plan_hash="sha256:" + "0" * 64,
                target_reclaim_bytes=1,
                max_archives=10,
            )
        assert stale.value.code == "ACCOUNT_HISTORY_GC_PLAN_CHANGED"
        assert owned.is_file()

        result = await manager.gc_run(
            plan_hash=str(plan["plan_hash"]),
            target_reclaim_bytes=1,
            max_archives=10,
        )
        assert result["exact_dry_run_set"] is True
        assert result["reclaimed_bytes"] == source.stat().st_size
        assert result["reclaimed"][0]["archive_id"] == archive_id
        assert not owned.exists()
        assert source.is_file()
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                """
                SELECT health, local_path FROM replay_account_history_archive
                WHERE archive_id = ?
                """,
                (archive_id,),
            ).fetchone() == ("EVICTED", None)

        restored = await manager.rehydrate_archive(archive_id)
        assert restored["health"] == "READY"
        assert restored["proof_hash"] == proof_hash
        assert owned.is_file()
        with sqlite3.connect(database) as connection:
            assert [
                row[0]
                for row in connection.execute(
                """
                SELECT action
                FROM replay_account_history_gc_audit
                ORDER BY audit_id
                """
                ).fetchall()
            ] == ["DRY_RUN", "RUN", "REHYDRATE"]
            assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_account_gc_rechecks_pin_and_inventory_is_bounded_redacted(
    tmp_path: Path,
) -> None:
    database = tmp_path / "storage-inventory.db"
    source = tmp_path / "pinned-source.sqlite3"
    build_account_history_archive(
        source,
        archive_id="phase18-pinned",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _service(database)
    try:
        assert service.training is not None
        base = await _base_request(service)
        exact, imported = await _import_and_plan(service, source, base)
        unpinned_plan = await service.training.account_history.gc_plan(
            target_reclaim_bytes=1,
            max_archives=10,
        )
        created = await service.training.create_run(exact)
        assert created["run"]["run_id"]

        with pytest.raises(TrainingRunError) as stale:
            await service.training.account_history.gc_run(
                plan_hash=str(unpinned_plan["plan_hash"]),
                target_reclaim_bytes=1,
                max_archives=10,
            )
        assert stale.value.code == "ACCOUNT_HISTORY_GC_PLAN_CHANGED"
        protected = await service.training.account_history.gc_plan(
            target_reclaim_bytes=1,
            max_archives=10,
        )
        assert protected["candidates"] == []
        assert protected["protected"][0]["protection_reasons"] == [
            "ACTIVE_ARCHIVE_PIN"
        ]

        inventory = await service.training.storage_inventory()
        assert inventory["protocol"] == "replay.storage.inventory.v1"
        assert inventory["decision"]["state"] == "ENABLE"
        assert inventory["decision"]["default_flags_enabled"] is True
        assert set(inventory["feature_flags"]) == {
            "replay_enabled",
            "agg_trade_enabled",
            "segment_download_worker_enabled",
            "segment_auto_gc_enabled",
            "fast_forward_optimization_enabled",
            "historical_book_enabled",
            "account_history_enabled",
        }
        assert inventory["bounds"] == {
            "max_items_per_category": 200,
            "max_observed_identities": 100,
            "actual_time_exposed": False,
            "local_paths_exposed": False,
        }
        account = inventory["categories"]["account_history"]
        item = next(
            value
            for value in account["items"]
            if value["object_id"] == imported["archive_id"]
        )
        assert item["protection_reasons"] == ["ACTIVE_ARCHIVE_PIN"]
        assert account["gc_protocol"] == "replay.account-history.gc.v1"
        assert inventory["categories"]["review_evidence"]["gc_protocol"] is None
        _assert_inventory_is_redacted(inventory)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_account_gc_source_drift_fails_closed_and_schema_is_additive(
    tmp_path: Path,
) -> None:
    database = tmp_path / "source-drift.db"
    source = tmp_path / "source.sqlite3"
    build_account_history_archive(
        source,
        archive_id="phase18-source-drift",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _service(database)
    try:
        assert service.training is not None
        imported = await service.training.account_history.import_archive(source)
        plan = await service.training.account_history.gc_plan(
            target_reclaim_bytes=1,
            max_archives=10,
        )
        with source.open("ab") as handle:
            handle.write(b"drift")
        with pytest.raises(TrainingRunError) as changed:
            await service.training.account_history.gc_run(
                plan_hash=str(plan["plan_hash"]),
                target_reclaim_bytes=1,
                max_archives=10,
            )
        assert changed.value.code == "ACCOUNT_HISTORY_GC_PLAN_CHANGED"
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                """
                SELECT health, local_path IS NOT NULL
                FROM replay_account_history_archive WHERE archive_id = ?
                """,
                (imported["archive_id"],),
            ).fetchone() == ("READY", 1)
            assert connection.execute(
                """
                SELECT version FROM replay_training_schema_version
                WHERE singleton = 1
                """
            ).fetchone() == (TRAINING_SCHEMA_VERSION,)
            assert connection.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name = 'replay_account_history_gc_audit'
                """
            ).fetchone() == ("replay_account_history_gc_audit",)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_account_gc_interrupted_claim_recovers_owned_object_on_start(
    tmp_path: Path,
) -> None:
    database = tmp_path / "account-gc-recovery.db"
    source = tmp_path / "account-gc-recovery-source.sqlite3"
    build_account_history_archive(
        source,
        archive_id="phase18-account-recovery",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _service(database)
    assert service.training is not None
    imported = await service.training.account_history.import_archive(source)
    manager = service.training.account_history
    token = "phase18recoverytoken"
    claim_reason = f"GC_RECLAIMING:{token}"
    owned = manager.root / "objects" / f"{imported['archive_id']}.sqlite3"
    trash = manager.root / ".trash" / f"{imported['archive_id']}-{token}.trash"
    await service.store.run_extension_write(
        lambda connection: connection.execute(
            """
            UPDATE replay_account_history_archive
            SET health = 'QUARANTINED', quarantine_reason = ?,
                generation = generation + 1
            WHERE archive_id = ?
            """,
            (claim_reason, imported["archive_id"]),
        )
    )
    owned.replace(trash)
    await service.shutdown(step_timeout=1.0)

    restarted = await _service(database)
    try:
        assert restarted.training is not None
        archives = await restarted.training.account_history.list_archives()
        item = next(
            row
            for row in archives["items"]
            if row["archive_id"] == imported["archive_id"]
        )
        assert item["health"] == "READY"
        assert item["generation"] >= imported["generation"] + 2
        assert owned.is_file()
        assert not trash.exists()
    finally:
        await restarted.shutdown(step_timeout=1.0)


async def test_phase18_storage_and_account_gc_http_contract(
    tmp_path: Path,
) -> None:
    database = tmp_path / "phase18-api.db"
    source = tmp_path / "phase18-api-source.sqlite3"
    build_account_history_archive(
        source,
        archive_id="phase18-api-account",
        range_start_ms=REPLAY_START,
        range_end_ms=ARCHIVE_END,
    )
    service = await _service(database)
    app = api_app(service)
    try:
        assert service.training is not None
        imported = await service.training.account_history.import_archive(source)
        inventory = await api_request(
            app,
            "GET",
            "/api/v1/replay/runs/storage",
        )
        assert inventory.status_code == 200
        _assert_inventory_is_redacted(inventory.json())

        payload = {
            "protocol": "replay.account-history.gc.v1",
            "target_reclaim_bytes": 1,
            "max_archives": 10,
        }
        plan = await api_request(
            app,
            "POST",
            "/api/v1/replay/runs/account-history/gc/dry-run",
            json=payload,
        )
        assert plan.status_code == 200
        plan_body = plan.json()
        assert plan_body["candidates"][0]["archive_id"] == imported["archive_id"]
        run = await api_request(
            app,
            "POST",
            "/api/v1/replay/runs/account-history/gc/run",
            json={
                **payload,
                "plan_hash": plan_body["plan_hash"],
                "confirm": True,
            },
        )
        assert run.status_code == 200
        assert run.json()["reclaimed_bytes"] == source.stat().st_size
        restored = await api_request(
            app,
            "POST",
            (
                "/api/v1/replay/runs/account-history/"
                f"{imported['archive_id']}/rehydrate"
            ),
            json={},
        )
        assert restored.status_code == 200
        assert restored.json()["health"] == "READY"
    finally:
        await service.shutdown(step_timeout=1.0)


def test_phase18_segment_budget_configuration_is_strict(tmp_path: Path) -> None:
    base = {
        "REPLAY_DB_PATH": str(tmp_path / "replay.db"),
        "REPLAY_SEGMENT_MAX_ARCHIVE_BYTES": "4096",
    }
    settings = load_replay_settings(
        base,
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candles.db",
    )
    assert settings.replay_segment_max_archive_bytes == 4096
    with pytest.raises(ValueError, match="REPLAY_SEGMENT_MAX_ARCHIVE_BYTES"):
        load_replay_settings(
            {**base, "REPLAY_SEGMENT_MAX_ARCHIVE_BYTES": "0"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candles.db",
        )
    tightened = replace(
        replay_settings(tmp_path / "manual.db"),
        replay_segment_max_archive_bytes=1,
    )
    assert tightened.replay_segment_max_archive_bytes == 1


def test_phase18_real_kline_validator_is_read_only_contiguous_and_bound(
    tmp_path: Path,
) -> None:
    source = tmp_path / "real-source.db"
    with sqlite3.connect(source) as connection:
        connection.execute(
            """
            CREATE TABLE klines (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time INTEGER NOT NULL,
                close_time INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                quote_volume REAL NOT NULL,
                trades INTEGER NOT NULL,
                taker_buy_base REAL NOT NULL,
                taker_buy_quote REAL NOT NULL,
                source TEXT NOT NULL
            )
            """
        )
        for symbol, origin in (("BTCUSDT", 30_000), ("ETHUSDT", 2_000)):
            connection.executemany(
                """
                INSERT INTO klines VALUES (
                    'binance', 'spot', ?, '1m', ?, ?, ?, ?, ?, ?, 10, 100,
                    20, 5, 50, 'operator_capture'
                )
                """,
                [
                    (
                        symbol,
                        1_700_000_040_000 + index * 60_000,
                        1_700_000_040_000 + (index + 1) * 60_000 - 1,
                        origin + index,
                        origin + index + 2,
                        origin + index - 2,
                        origin + index + 1,
                    )
                    for index in range(8)
                ],
            )
        connection.commit()
    before = source.read_bytes()
    result = validate_kline_source(source, required_rows=6)
    assert result["passed"] is True
    assert result["read_only"] is True
    assert len(result["identities"]) == 2
    assert all(
        item["validated_rows"] == 6 and item["contiguous"] is True
        for item in result["identities"]
    )
    assert source.read_bytes() == before
