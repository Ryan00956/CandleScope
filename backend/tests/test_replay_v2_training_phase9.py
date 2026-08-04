from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from dataclasses import replace
from hashlib import sha256
from pathlib import Path

import pytest

from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.errors import TrainingRunError
from app.replay.training.historical_book import (
    ARCHIVE_PROTOCOL,
    ARCHIVE_SCHEMA_VERSION,
    ARCHIVE_SOURCE_CONTRACT_URL,
    BOOK_EXECUTION_FIDELITY,
    verify_historical_book_archive,
)
from app.replay.training.models import BookMode, ReplayV2CommandType
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    SessionIdFactory,
    replay_settings,
)
from tests.fixtures.replay.trade_service_fakes import (
    TRADE_NOW_MS,
    TRADE_REPLAY_MINUTES,
    TRADE_REPLAY_START_MS,
)
from tests.test_replay_v2_training_phase5 import (
    _acquire,
    _command,
    _multi_trade_sources,
    _trade_request,
)
from tests.test_replay_v2_training_api import (
    _app as api_app,
    _create_initialized_run as api_create_initialized_run,
    _request as api_request,
)


pytestmark = pytest.mark.anyio


def _levels(value: list[list[str]]) -> str:
    return json.dumps(value, separators=(",", ":"))


def _book_archive(
    path: Path,
    *,
    symbol: str = "BTCUSDT",
    gap_at: int | None = None,
    minutes: int = TRADE_REPLAY_MINUTES + 1,
) -> Path:
    dataset_epoch = f"sha256:{sha256(f'book:{symbol}'.encode()).hexdigest()}"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE archive_meta (
                singleton INTEGER PRIMARY KEY,
                protocol TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                range_start_ms INTEGER NOT NULL,
                range_end_ms INTEGER NOT NULL,
                dataset_epoch TEXT NOT NULL,
                source TEXT NOT NULL,
                source_contract_url TEXT NOT NULL,
                max_depth_levels INTEGER NOT NULL
            );
            CREATE TABLE book_frame (
                ordinal INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                event_time_ms INTEGER NOT NULL,
                transaction_time_ms INTEGER NOT NULL,
                first_update_id INTEGER,
                final_update_id INTEGER NOT NULL,
                previous_final_update_id INTEGER,
                bids_json TEXT NOT NULL,
                asks_json TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO archive_meta VALUES (1, ?, ?, 'binance', 'futures', ?, ?, ?, ?,
                'BINANCE_USDM_DIFF_DEPTH_CAPTURE', ?, 1000)
            """,
            (
                ARCHIVE_PROTOCOL,
                ARCHIVE_SCHEMA_VERSION,
                symbol,
                TRADE_REPLAY_START_MS,
                TRADE_REPLAY_START_MS + minutes * INTERVAL_MS,
                dataset_epoch,
                ARCHIVE_SOURCE_CONTRACT_URL,
            ),
        )
        connection.execute(
            """
            INSERT INTO book_frame VALUES (0, 'SNAPSHOT', ?, ?, NULL, 100, NULL, ?, ?)
            """,
            (
                TRADE_REPLAY_START_MS,
                TRADE_REPLAY_START_MS,
                _levels([["99", "10"], ["98", "20"]]),
                _levels([["101", "10"], ["102", "20"]]),
            ),
        )
        previous_u = 100
        for minute in range(1, minutes + 1):
            final_u = previous_u + 1
            pu = previous_u + 7 if gap_at == minute else previous_u
            bid = 99 + minute
            ask = 101 + minute
            connection.execute(
                """
                INSERT INTO book_frame VALUES (?, 'DELTA', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    minute,
                    TRADE_REPLAY_START_MS + minute * INTERVAL_MS,
                    TRADE_REPLAY_START_MS + minute * INTERVAL_MS,
                    previous_u if minute == 1 else final_u,
                    final_u,
                    pu,
                    _levels([[str(bid - 1), "0"], [str(bid), "10"]]),
                    _levels([[str(ask - 1), "0"], [str(ask), "10"]]),
                ),
            )
            previous_u = final_u
    return path


async def _service(
    path: Path,
    *,
    archive_root: Path,
    enabled: bool = True,
    symbols: tuple[str, ...] = ("BTCUSDT", "ETHUSDT"),
) -> ReplayService:
    repository, trade_archive = _multi_trade_sources(archive_root, symbols)
    settings = replace(
        replay_settings(path),
        replay_historical_book_enabled=enabled,
        replay_historical_book_max_archive_bytes=64 * 1024 * 1024,
    )
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: TRADE_NOW_MS),
        repository=repository,
        raw_trade_archive=trade_archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("book-adapter"),
        training_run_id_factory=SessionIdFactory("book-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _book_request(service: ReplayService):
    return replace(
        await _trade_request(service),
        book_mode=BookMode.BOOK_ASSISTED_REQUIRED,
    )


async def _create_book_run(
    service: ReplayService,
) -> tuple[str, str]:
    assert service.training is not None
    created = await service.training.create_run(await _book_request(service))
    return str(created["run"]["run_id"]), str(created["run"]["adapter_session_id"])


def test_archive_verifier_accepts_snapshot_bridge_and_rejects_pu_gap(
    tmp_path: Path,
) -> None:
    valid = verify_historical_book_archive(
        _book_archive(tmp_path / "valid.sqlite3"),
        trusted_origin="TEST_CAPTURE",
    )
    assert valid.snapshot_count == 1
    assert valid.delta_count == TRADE_REPLAY_MINUTES + 1
    assert valid.checksum_sha256.startswith("sha256:")
    with pytest.raises(ValueError, match="sequence gap"):
        verify_historical_book_archive(
            _book_archive(tmp_path / "gap.sqlite3", gap_at=3),
            trusted_origin="TEST_CAPTURE",
        )


def test_archive_verifier_rejects_unbounded_resident_depth(tmp_path: Path) -> None:
    archive = _book_archive(tmp_path / "depth.sqlite3", minutes=2)
    with closing(sqlite3.connect(archive)) as connection:
        connection.execute("UPDATE archive_meta SET max_depth_levels = 2")
        connection.execute(
            "UPDATE book_frame SET bids_json = ? WHERE ordinal = 1",
            (_levels([["97", "1"]]),),
        )
        connection.commit()

    with pytest.raises(ValueError, match="resident depth"):
        verify_historical_book_archive(
            archive,
            trusted_origin="TEST_CAPTURE",
        )


async def test_default_off_rejects_book_mode_without_affecting_core(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "off.db",
        archive_root=tmp_path / "trade-off",
        enabled=False,
    )
    try:
        assert service.training is not None
        request = await _book_request(service)
        plan = await service.training.segment_plan(request)
        assert plan["historical_book"]["feature_enabled"] is False
        assert plan["historical_book"]["capability_state"] == "UNSUPPORTED_NO_HISTORY"
        with pytest.raises(TrainingRunError) as failure:
            await service.training.create_run(request)
        assert failure.value.code == "HISTORICAL_BOOK_DISABLED"
        ordinary = await service.training.create_run(
            replace(request, book_mode=BookMode.OFF)
        )
        assert ordinary["created"] is True
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_exact_archive_enables_create_pins_projection_and_report_fidelity(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "exact.db",
        archive_root=tmp_path / "trade-exact",
    )
    try:
        assert service.training is not None
        imported = await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "book.sqlite3"),
            trusted_origin="TEST_CAPTURE",
        )
        assert imported["health"] == "READY"
        request = await _book_request(service)
        plan = await service.training.segment_plan(request)
        capability = plan["historical_book"]
        assert capability["capability_state"] == "AVAILABLE_EXACT"
        assert capability["queue_exact"] is False

        run_id, _ = await _create_book_run(service)
        tracks = await service.training.store.get_market_tracks(run_id)
        book = tracks["tracks"][0]["historical_book"]
        assert tracks["tracks"][0]["capabilities"]["ORDER_BOOK"] == "AVAILABLE_EXACT"
        assert book["status"] == "READY"
        assert book["bids"][0] == ["99", "10"]
        assert book["asks"][0] == ["101", "10"]
        assert book["queue_exact"] is False
        assert tracks["portfolio"]["execution_fidelity"] == BOOK_EXECUTION_FIDELITY

        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT COUNT(*) FROM replay_historical_book_ref
                WHERE run_id = ? AND active = 1
                """,
                (run_id,),
            ).fetchone()[0] == 1
            assert connection.execute(
                """
                SELECT event_type FROM replay_historical_book_event
                WHERE run_id = ? ORDER BY event_id LIMIT 1
                """,
                (run_id,),
            ).fetchone()[0] == "BOUND"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_single_book_track_uses_ordered_playback_and_pauses_cleanly(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "single-book-play.db",
        archive_root=tmp_path / "trade-single-book-play",
    )
    try:
        assert service.training is not None
        await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "single-book-play.sqlite3")
        )
        run_id, session_id = await _create_book_run(service)
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="single-book-acquire",
        )

        selected = await service.get_session(session_id)
        playing = await service.training.command(
            run_id,
            _command(
                run_id,
                "single-book-play",
                ReplayV2CommandType.PLAY,
                selected,
                {},
            ),
        )
        assert playing["state"] == "PLAYING"
        assert playing["data"]["full_track_count"] == 1
        assert playing["data"]["global_clock"]["mode"] == "ORDERED"

        paused = await service.training.command(
            run_id,
            _command(
                run_id,
                "single-book-pause",
                ReplayV2CommandType.PAUSE,
                selected,
                {},
            ),
        )
        assert paused["state"] == "PAUSED"
        tracks = await service.training.get_market_tracks(run_id)
        assert tracks["global_clock"]["state"] == "PAUSED"
        assert tracks["tracks"][0]["historical_book"]["status"] == "READY"
        assert (
            tracks["tracks"][0]["capabilities"]["ORDER_BOOK"]
            == "AVAILABLE_EXACT"
        )
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_advance_updates_book_projection_without_queue_claim(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "advance.db",
        archive_root=tmp_path / "trade-advance",
    )
    try:
        assert service.training is not None
        await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "advance-book.sqlite3")
        )
        run_id, session_id = await _create_book_run(service)
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="book-acquire",
        )
        session = await service.get_session(session_id)
        target = TRADE_REPLAY_START_MS + 2 * INTERVAL_MS
        result = await service.training.command(
            run_id,
            _command(
                run_id,
                "book-advance",
                ReplayV2CommandType.ADVANCE_TO,
                session,
                {"virtual_time_ms": target},
            ),
        )
        assert result["cursor"]["virtual_time_ms"] == target
        tracks = await service.training.store.get_market_tracks(run_id)
        book = tracks["tracks"][0]["historical_book"]
        assert book["as_of_virtual_time_ms"] == target
        assert book["last_update_id"] == 102
        assert book["bids"][0] == ["101", "10"]
        assert book["queue_exact"] is False
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_forward_cache_is_track_scoped_and_backward_requests_rebuild(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "cache.db",
        archive_root=tmp_path / "trade-cache",
    )
    try:
        assert service.training is not None
        await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "cache-book.sqlite3")
        )
        run_id, _ = await _create_book_run(service)
        tracks = (await service.training.store.get_market_tracks(run_id))["tracks"]
        track_id = str(tracks[0]["track_id"])
        key = (run_id, track_id)

        await service.training.historical_books.prepare_run_projection(
            run_id=run_id,
            tracks=tracks,
            actual_time_ms=TRADE_REPLAY_START_MS,
            virtual_time_ms=TRADE_REPLAY_START_MS,
        )
        assert service.training.historical_books._projection_cache[
            key
        ].state.previous_ordinal == 0

        target = TRADE_REPLAY_START_MS + 3 * INTERVAL_MS
        prepared = await service.training.historical_books.prepare_run_projection(
            run_id=run_id,
            tracks=tracks,
            actual_time_ms=target,
            virtual_time_ms=target,
        )
        assert prepared[0][1].last_update_id == 103
        assert service.training.historical_books._projection_cache[
            key
        ].state.previous_ordinal == 3

        rebuilt = await service.training.historical_books.prepare_run_projection(
            run_id=run_id,
            tracks=tracks,
            actual_time_ms=TRADE_REPLAY_START_MS,
            virtual_time_ms=TRADE_REPLAY_START_MS,
        )
        assert rebuilt[0][1].last_update_id == 100
        assert service.training.historical_books._projection_cache[
            key
        ].state.previous_ordinal == 0
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_owned_archive_tamper_clears_stale_book_and_pauses_run(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "tamper.db",
        archive_root=tmp_path / "trade-tamper",
    )
    try:
        assert service.training is not None
        imported = await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "trusted-book.sqlite3")
        )
        run_id, session_id = await _create_book_run(service)
        archive_path = (
            service.training.historical_books.root
            / "objects"
            / f"{imported['archive_id']}.sqlite3"
        )
        with closing(sqlite3.connect(archive_path)) as connection:
            connection.execute(
                "UPDATE book_frame SET previous_final_update_id = 999 WHERE ordinal = 1"
            )
            connection.commit()
        await _acquire(
            service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="tamper-acquire",
        )
        session = await service.get_session(session_id)
        with pytest.raises(TrainingRunError) as failure:
            await service.training.command(
                run_id,
                _command(
                    run_id,
                    "tamper-advance",
                    ReplayV2CommandType.ADVANCE_TO,
                    session,
                    {"virtual_time_ms": TRADE_REPLAY_START_MS + INTERVAL_MS},
                ),
            )
        assert failure.value.code == "HISTORICAL_BOOK_GAP"
        tracks = await service.training.store.get_market_tracks(run_id)
        book = tracks["tracks"][0]["historical_book"]
        assert tracks["tracks"][0]["state"] == "DEGRADED"
        assert book["capability_state"] == "DEGRADED"
        assert book["status"] == "CLEARED"
        assert book["bids"] == [] and book["asks"] == []
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT event_type FROM replay_historical_book_event
                WHERE run_id = ? ORDER BY event_id DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()[0] == "GAP"
            assert connection.execute(
                "SELECT compatibility FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0] == "UNAVAILABLE"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_explicit_resync_restores_only_same_checksum_archive(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "resync.db",
        archive_root=tmp_path / "trade-resync",
    )
    try:
        assert service.training is not None
        imported = await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "resync-source.sqlite3")
        )
        run_id, _ = await _create_book_run(service)
        owned = (
            service.training.historical_books.root
            / "objects"
            / f"{imported['archive_id']}.sqlite3"
        )
        with closing(sqlite3.connect(owned)) as connection:
            connection.execute("UPDATE book_frame SET final_update_id = 999 WHERE ordinal = 1")
            connection.commit()
        tracks = (await service.training.store.get_market_tracks(run_id))["tracks"]
        with pytest.raises(TrainingRunError):
            await service.training.historical_books.prepare_run_projection(
                run_id=run_id,
                tracks=tracks,
                actual_time_ms=TRADE_REPLAY_START_MS,
                virtual_time_ms=TRADE_REPLAY_START_MS,
            )
        result = await service.training.resync_historical_book(run_id)
        assert result["resynced_track_count"] == 1
        assert result["fallback_applied"] is False
        restored = result["tracks"][0]["historical_book"]
        assert restored["status"] == "READY"
        assert restored["capability_state"] == "AVAILABLE_EXACT"
        with sqlite3.connect(service.store.path) as connection:
            assert connection.execute(
                """
                SELECT event_type FROM replay_historical_book_event
                WHERE run_id = ? ORDER BY event_id DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()[0] == "RESYNC"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_full_track_without_same_l2_coverage_fails_closed(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "multi.db",
        archive_root=tmp_path / "trade-multi",
    )
    try:
        assert service.training is not None
        await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "btc-only.sqlite3", symbol="BTCUSDT")
        )
        run_id, session_id = await _create_book_run(service)
        session = await service.get_session(session_id)
        with pytest.raises(TrainingRunError) as failure:
            await service.training.command(
                run_id,
                _command(
                    run_id,
                    "add-eth-full",
                    ReplayV2CommandType.ADD_TRACK,
                    session,
                    {
                        "exchange": "binance",
                        "market_type": "futures",
                        "symbol": "ETHUSDT",
                        "settlement_asset": "USDT",
                        "subscription_tier": "FULL",
                    },
                ),
            )
        assert failure.value.code == "HISTORICAL_BOOK_EXACT_COVERAGE_UNAVAILABLE"
        tracks = await service.training.store.get_market_tracks(run_id)
        assert not any(track["symbol"] == "ETHUSDT" for track in tracks["tracks"])
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_warm_track_needs_no_book_but_cannot_upgrade_without_exact_l2(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "warm.db",
        archive_root=tmp_path / "trade-warm",
    )
    try:
        assert service.training is not None
        await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "warm-btc.sqlite3", symbol="BTCUSDT")
        )
        run_id, session_id = await _create_book_run(service)
        session = await service.get_session(session_id)
        await service.training.command(
            run_id,
            _command(
                run_id,
                "add-eth-warm",
                ReplayV2CommandType.ADD_TRACK,
                session,
                {
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "ETHUSDT",
                    "settlement_asset": "USDT",
                    "subscription_tier": "WARM",
                },
            ),
        )
        tracks = await service.training.store.get_market_tracks(run_id)
        eth = next(track for track in tracks["tracks"] if track["symbol"] == "ETHUSDT")
        assert eth["subscription_tier"] == "WARM"
        assert eth["historical_book"]["status"] == "OFF"
        session = await service.get_session(session_id)
        with pytest.raises(TrainingRunError) as failure:
            await service.training.command(
                run_id,
                _command(
                    run_id,
                    "upgrade-eth-full",
                    ReplayV2CommandType.SET_SUBSCRIPTION_TIER,
                    session,
                    {
                        "track_id": eth["track_id"],
                        "subscription_tier": "FULL",
                    },
                ),
            )
        assert failure.value.code == "HISTORICAL_BOOK_EXACT_COVERAGE_UNAVAILABLE"
        current = await service.training.store.get_market_track(run_id, str(eth["track_id"]))
        assert current["subscription_tier"] == "WARM"
        assert current["historical_book"]["status"] == "OFF"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_historical_book_gc_protects_pins_and_rehydrates_exact_object(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "gc.db",
        archive_root=tmp_path / "trade-gc",
    )
    try:
        assert service.training is not None
        pinned = await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "pinned-btc.sqlite3", symbol="BTCUSDT")
        )
        evictable = await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "evictable-eth.sqlite3", symbol="ETHUSDT")
        )
        await _create_book_run(service)

        plan = await service.training.historical_book_gc_plan(
            target_reclaim_bytes=1,
            max_archives=10,
        )
        assert [item["archive_id"] for item in plan["candidates"]] == [
            evictable["archive_id"]
        ]
        protected = next(
            item for item in plan["protected"]
            if item["archive_id"] == pinned["archive_id"]
        )
        assert protected["protection_reasons"] == ["ACTIVE_ARCHIVE_PIN"]
        result = await service.training.historical_book_gc_run(
            plan_hash=str(plan["plan_hash"]),
            target_reclaim_bytes=1,
            max_archives=10,
        )
        assert result["exact_dry_run_set"] is True
        assert result["reclaimed"][0]["archive_id"] == evictable["archive_id"]
        evicted_path = (
            service.training.historical_books.root
            / "objects"
            / f"{evictable['archive_id']}.sqlite3"
        )
        assert not evicted_path.exists()

        restored = await service.training.rehydrate_historical_book_archive(
            str(evictable["archive_id"])
        )
        assert restored["health"] == "READY"
        assert restored["checksum_sha256"] == evictable["checksum_sha256"]
        assert evicted_path.is_file()
        with sqlite3.connect(service.store.path) as connection:
            audit = connection.execute(
                """
                SELECT action FROM replay_historical_book_gc_audit
                ORDER BY audit_id
                """
            ).fetchall()
        assert [row[0] for row in audit] == ["DRY_RUN", "RUN", "REHYDRATE"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_flag_off_restart_clears_book_and_never_falls_back_to_touch(
    tmp_path: Path,
) -> None:
    database = tmp_path / "rollback.db"
    archive_root = tmp_path / "trade-rollback"
    enabled_service = await _service(database, archive_root=archive_root)
    try:
        assert enabled_service.training is not None
        await enabled_service.training.historical_books.import_archive(
            _book_archive(tmp_path / "rollback-book.sqlite3")
        )
        run_id, session_id = await _create_book_run(enabled_service)
        await _acquire(
            enabled_service,
            run_id=run_id,
            selected_session_id=session_id,
            command_id="rollback-acquire",
        )
        session = await enabled_service.get_session(session_id)
        target = TRADE_REPLAY_START_MS + INTERVAL_MS
        await enabled_service.training.command(
            run_id,
            _command(
                run_id,
                "rollback-advance",
                ReplayV2CommandType.ADVANCE_TO,
                session,
                {"virtual_time_ms": target},
            ),
        )
    finally:
        await enabled_service.shutdown(step_timeout=1.0)

    disabled_service = await _service(
        database,
        archive_root=archive_root,
        enabled=False,
    )
    try:
        assert disabled_service.training is not None
        tracks = await disabled_service.training.store.get_market_tracks(run_id)
        book = tracks["tracks"][0]["historical_book"]
        assert tracks["tracks"][0]["state"] == "DEGRADED"
        assert book["status"] == "DISABLED"
        assert book["bids"] == [] and book["asks"] == []
        session = await disabled_service.get_session(session_id)
        assert session["snapshot"]["state"] == "PAUSED"
        with pytest.raises(TrainingRunError) as failure:
            await _acquire(
                disabled_service,
                run_id=run_id,
                selected_session_id=session_id,
                command_id="rollback-reacquire",
            )
        assert failure.value.code == "HISTORICAL_BOOK_DISABLED"
        assert failure.value.details["fallback_applied"] is False
        with sqlite3.connect(database) as connection:
            event = connection.execute(
                """
                SELECT event_type, at_virtual_time_ms
                FROM replay_historical_book_event
                WHERE run_id = ? ORDER BY event_id DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()
        assert event == ("FEATURE_DISABLED", target)
    finally:
        await disabled_service.shutdown(step_timeout=1.0)

    with sqlite3.connect(database) as connection:
        persisted_track = connection.execute(
            """
            SELECT state, degraded_reason
            FROM replay_training_market_track
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        persisted_projection = connection.execute(
            """
            SELECT status, capability_state, bids_json, asks_json
            FROM replay_historical_book_projection
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
    assert persisted_track == ("DEGRADED", "HISTORICAL_BOOK_FEATURE_DISABLED")
    assert persisted_projection == ("DISABLED", "DEGRADED", "[]", "[]")


async def test_phase9_http_plan_create_inventory_gc_and_resync_contracts(
    tmp_path: Path,
) -> None:
    service = await _service(
        tmp_path / "http.db",
        archive_root=tmp_path / "trade-http",
    )
    try:
        assert service.training is not None
        imported = await service.training.historical_books.import_archive(
            _book_archive(tmp_path / "http-book.sqlite3")
        )
        app = api_app(service)
        payload = (await _book_request(service)).to_dict()

        planned = await api_request(
            app,
            "POST",
            "/api/v1/replay/runs/data-segments/plan",
            json=payload,
        )
        assert planned.status_code == 200
        assert planned.json()["historical_book"]["capability_state"] == "AVAILABLE_EXACT"
        assert planned.json()["historical_book"]["queue_exact"] is False

        created = await api_create_initialized_run(app, service, payload)
        assert created.status_code == 201
        run_id = created.json()["run"]["run_id"]

        inventory = await api_request(
            app,
            "GET",
            "/api/v1/replay/runs/historical-books",
        )
        assert inventory.status_code == 200
        assert inventory.json()["summary"]["pinned_count"] == 1
        assert inventory.json()["items"][0]["archive_id"] == imported["archive_id"]

        gc_plan = await api_request(
            app,
            "POST",
            "/api/v1/replay/runs/historical-books/gc/dry-run",
            json={
                "protocol": "replay.historical-book.gc.v1",
                "target_reclaim_bytes": 1,
                "max_archives": 10,
            },
        )
        assert gc_plan.status_code == 200
        assert gc_plan.json()["candidates"] == []
        assert gc_plan.json()["protected"][0]["protection_reasons"] == [
            "ACTIVE_ARCHIVE_PIN"
        ]

        invalid_gc = await api_request(
            app,
            "POST",
            "/api/v1/replay/runs/historical-books/gc/dry-run",
            json={
                "protocol": "replay.historical-book.gc.v1",
                "target_reclaim_bytes": 1,
                "unexpected": True,
            },
        )
        assert invalid_gc.status_code == 422
        assert invalid_gc.json()["error"]["code"] == "TRAINING_RUN_INVALID"

        resynced = await api_request(
            app,
            "POST",
            f"/api/v1/replay/runs/{run_id}/historical-book/resync",
        )
        assert resynced.status_code == 200
        assert resynced.json()["resynced_track_count"] == 1
        assert resynced.json()["fallback_applied"] is False
    finally:
        await service.shutdown(step_timeout=1.0)
