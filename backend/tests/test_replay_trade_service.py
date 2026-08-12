from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeBarWindow,
)
from app.replay.bars.trade_parity import trade_bar_parity_policy
from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    SessionState,
    StartPolicy,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService, SYNTHETIC_TIME_ANCHOR_MS
from app.replay.storage import ReplaySQLiteStore
from app.replay.trade_compatibility import build_trade_bar_compatibility
from tests.fixtures.replay.fakes import FixtureIdentity
from tests.fixtures.replay.service_fakes import SessionIdFactory, replay_settings
from tests.fixtures.replay.trade_service_fakes import (
    DAY_START_MS,
    TRADE_NOW_MS,
    TRADE_REPLAY_START_MS,
    trade_replay_config,
    trade_replay_repository,
    verified_trade_archive,
)


pytestmark = pytest.mark.anyio


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="trade-browser",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


async def _service(
    database: Path,
    archive,
    *,
    prefix: str,
    repository=None,
) -> ReplayService:
    service = ReplayService(
        settings=replay_settings(database),
        store=ReplaySQLiteStore(database, now_ms=lambda: TRADE_NOW_MS),
        repository=repository or trade_replay_repository(),
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory(prefix),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


async def test_trade_service_uses_shared_actor_api_and_pin_lifecycle(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "archive")
    service = await _service(tmp_path / "replay.db", archive, prefix="trade")
    capability = service.capabilities()["sources"]["agg_trade"]
    assert capability["enabled"] is True
    assert capability["fidelity"] == "VERIFIED_AGG_TRADE_APPROXIMATE_BARS"
    assert capability["bar_parity_required"] is False

    created = await service.create_session(trade_replay_config())
    session_id = str(created["session_id"])
    assert created["data_fidelity"] == "VERIFIED_AGG_TRADE_APPROXIMATE_BARS"
    assert created["execution_fidelity"] == "AGG_TRADE_TAPE"
    assert created["snapshot"]["state"] == SessionState.PAUSED.value
    assert archive.diagnostics()["active_pins"] == 1

    acquired = await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step", CommandType.STEP, acquired["revision"], {"count": 3}),
    )
    assert stepped["cursor"]["source_sequence"] == 3
    assert stepped["cursor"]["last_agg_trade_id"] == 1_002
    assert stepped["cursor"]["last_trade_time_ms"] is not None
    assert stepped["cursor"]["last_base_bar_open_ms"] is None

    forked = await service.fork_session(session_id)
    assert forked["snapshot"]["state_hash"] == stepped["state_hash"]
    assert archive.diagnostics()["active_pins"] == 2
    await service.shutdown(step_timeout=1.0)
    assert archive.diagnostics()["active_pins"] == 0


async def test_trade_capability_stays_closed_without_a_verified_exact_partition(
    tmp_path: Path,
) -> None:
    archive = ParquetRawAggTradeArchive(tmp_path / "empty-archive")
    service = await _service(tmp_path / "empty.db", archive, prefix="empty-trade")

    capability = service.capabilities()["sources"]["agg_trade"]
    assert capability == {
        "enabled": False,
        "reason": "DATASET_INCOMPLETE",
    }
    await service.shutdown(step_timeout=1.0)


async def test_trade_catalog_filters_identities_and_intersects_official_coverage(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "catalog-archive")
    repository = trade_replay_repository()
    futures_rows = next(iter(repository.rows.values()))
    repository.add_rows(
        FixtureIdentity("binance", "spot", "BTCUSDT"),
        "1m",
        futures_rows,
    )
    service = await _service(
        tmp_path / "catalog.db",
        archive,
        prefix="trade-catalog",
        repository=repository,
    )
    try:
        bar_catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=4 * 60_000,
            quality_mode="exact",
            blind_mode=False,
        )
        assert {
            entry["identity"]["market_type"] for entry in bar_catalog["entries"]
        } == {"futures", "spot"}

        trade_catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=4 * 60_000,
            quality_mode="exact",
            blind_mode=False,
            source_kind="AGG_TRADE",
        )
        assert [entry["identity"] for entry in trade_catalog["entries"]] == [{
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
        }]
        entry = trade_catalog["entries"][0]
        assert entry["quality"] == "VERIFIED_AGG_TRADE_APPROXIMATE_BARS"
        assert entry["eligible_ranges"][0]["first_start_ms"] == (
            TRADE_REPLAY_START_MS
        )
        assert entry["eligible_ranges"][0]["last_start_ms"] == (
            TRADE_REPLAY_START_MS + 2 * 60_000
        )
        assert entry["eligible_ranges"][0]["count"] == 3
        assert entry["eligible_ranges"][0]["replay_bars"] == 4
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_trade_catalog_epoch_binds_official_availability_epoch(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "epoch-archive")
    service = await _service(
        tmp_path / "epoch.db",
        archive,
        prefix="trade-epoch",
    )
    windows = archive.list_selection_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    try:
        archive.selection_snapshot = lambda **_kwargs: (  # type: ignore[attr-defined]
            "sha256:" + "a" * 64,
            windows,
        )
        first = await service.catalog(
            warmup_bars=2,
            horizon_ms=4 * 60_000,
            quality_mode="exact",
            blind_mode=False,
            source_kind="AGG_TRADE",
        )
        archive.selection_snapshot = lambda **_kwargs: (  # type: ignore[attr-defined]
            "sha256:" + "b" * 64,
            windows,
        )
        second = await service.catalog(
            warmup_bars=2,
            horizon_ms=4 * 60_000,
            quality_mode="exact",
            blind_mode=False,
            source_kind="AGG_TRADE",
        )
        assert first["catalog_epoch"] != second["catalog_epoch"]
        assert first["entries"][0]["catalog_epoch"] == first["catalog_epoch"]
        assert second["entries"][0]["catalog_epoch"] == second["catalog_epoch"]
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_manual_trade_selection_rejects_bar_only_window_before_freeze(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "manual-archive")
    service = await _service(
        tmp_path / "manual.db",
        archive,
        prefix="trade-manual",
    )
    try:
        config = replace(
            trade_replay_config(),
            requested_start_ms=TRADE_REPLAY_START_MS - 60_000,
        )
        catalog = await service.catalog(
            warmup_bars=config.warmup_bars,
            horizon_ms=config.horizon_ms,
            quality_mode=config.quality_mode.value,
            blind_mode=False,
            source_kind="AGG_TRADE",
        )
        with pytest.raises(ReplayDomainError, match="not eligible") as exc_info:
            await service.select_training_window(
                config,
                expected_catalog_epoch=str(catalog["catalog_epoch"]),
            )
        assert exc_info.value.code is ReplayErrorCode.NO_ELIGIBLE_WINDOW
        assert archive.diagnostics()["active_pins"] == 0
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_random_trade_selection_uses_only_verified_trade_coverage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive = verified_trade_archive(tmp_path / "verified-archive")
    trade_catalog_epoch = "sha256:" + "a" * 64
    archive.selection_snapshot = lambda **kwargs: (  # type: ignore[attr-defined]
        trade_catalog_epoch,
        archive.list_selection_windows(**kwargs),
    )
    repository = trade_replay_repository()
    identity = FixtureIdentity("binance", "futures", "BTCUSDT")
    key = (identity.exchange, identity.market_type, identity.symbol, "1m")
    verified_rows = repository.rows[key]
    unverified_rows = [
        {
            **row,
            "open_time": int(row["open_time"]) - 86_400_000,
            "close_time": int(row["close_time"]) - 86_400_000,
        }
        for row in verified_rows
    ]
    repository.add_rows(identity, "1m", unverified_rows + verified_rows)
    service = ReplayService(
        settings=replay_settings(tmp_path / "random-trade.db"),
        store=ReplaySQLiteStore(
            tmp_path / "random-trade.db",
            now_ms=lambda: TRADE_NOW_MS,
        ),
        repository=repository,
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("random-trade"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        config = replace(
            trade_replay_config(),
            start_policy=StartPolicy.RANDOM_ELIGIBLE,
            requested_start_ms=None,
        )
        catalog = await service.catalog(
            warmup_bars=config.warmup_bars,
            horizon_ms=config.horizon_ms,
            quality_mode=config.quality_mode.value,
            blind_mode=False,
            source_kind="AGG_TRADE",
        )
        entry = catalog["entries"][0]
        assert entry["eligible_window_count"] == 3
        assert archive.list_verified_bar_windows(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            interval="1m",
            interval_ms=60_000,
            bar_source_revision=str(entry["source_fingerprint"]),
            parity_policy=trade_bar_parity_policy(compare_trade_count=False),
        ) == ()
        monkeypatch.setattr(
            service._catalog,
            "_stable_sample_index",
            lambda **_kwargs: 0,
        )

        selected = await service.select_training_window(
            config,
            expected_catalog_epoch=str(catalog["catalog_epoch"]),
        )

        assert selected["selected_start_ms"] >= DAY_START_MS
        assert (
            int(selected["selected_start_ms"])
            + config.horizon_ms
            - 1
            <= DAY_START_MS + 86_400_000 - 1
        )
        assert selected["selected_start_ms"] == TRADE_REPLAY_START_MS
        assert selected["agg_trade_catalog_epoch"] == trade_catalog_epoch
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_trade_bar_compatibility_builder_publishes_matching_segments(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "compatibility-archive")
    revision = "sha256:" + "a" * 64

    report = build_trade_bar_compatibility(
        archive,
        trade_replay_repository(),
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        interval="1m",
        start_time_ms=TRADE_REPLAY_START_MS,
        end_time_ms=TRADE_REPLAY_START_MS + 4 * 60_000 - 1,
        bar_source_revision=revision,
    )

    assert report["checked_bar_count"] == 4
    assert report["matching_bar_count"] == 4
    assert report["mismatch_bar_count"] == 0
    assert archive.list_verified_bar_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        interval="1m",
        interval_ms=60_000,
        bar_source_revision=revision,
        parity_policy=trade_bar_parity_policy(compare_trade_count=False),
    ) == (
        VerifiedRawAggTradeBarWindow(
            start_time_ms=TRADE_REPLAY_START_MS,
            end_time_ms=TRADE_REPLAY_START_MS + 4 * 60_000 - 1,
            bar_count=4,
        ),
    )


async def test_trade_bar_compatibility_keeps_disjoint_dataset_proofs(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "multi-compatibility-archive")
    revision = "sha256:" + "b" * 64
    policy = trade_bar_parity_policy(compare_trade_count=False)
    expected_windows: list[VerifiedRawAggTradeBarWindow] = []

    for start_offset_minutes in (0, 2):
        start_time_ms = (
            TRADE_REPLAY_START_MS + start_offset_minutes * 60_000
        )
        end_time_ms = start_time_ms + 2 * 60_000 - 1
        dataset_ref = archive.freeze_dataset(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
        )
        window = VerifiedRawAggTradeBarWindow(
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            bar_count=2,
        )
        expected_windows.append(window)
        archive.publish_bar_compatibility(
            dataset_ref=dataset_ref,
            interval="1m",
            interval_ms=60_000,
            bar_source_revision=revision,
            parity_policy=policy,
            checked_bar_count=2,
            mismatch_bar_count=0,
            compatible_windows=(window,),
        )

    assert archive.list_verified_bar_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        interval="1m",
        interval_ms=60_000,
        bar_source_revision=revision,
        parity_policy=policy,
    ) == tuple(expected_windows)


async def test_blind_trade_service_never_exposes_archive_paths_or_actual_time(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "private-archive")
    service = await _service(tmp_path / "replay.db", archive, prefix="blind-trade")
    created = await service.create_session(trade_replay_config(blind_mode=True))
    session_id = str(created["session_id"])
    serialized = json.dumps(created, sort_keys=True)
    assert str(TRADE_REPLAY_START_MS) not in serialized
    assert "date=2026-06-01" not in serialized
    assert ".parquet" not in serialized
    assert str(tmp_path) not in serialized
    assert created["snapshot"]["cursor"]["virtual_time_ms"] == (
        SYNTHETIC_TIME_ANCHOR_MS
    )

    acquired = await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step", CommandType.STEP, acquired["revision"], {"count": 1}),
    )
    serialized_step = json.dumps(stepped, sort_keys=True)
    assert str(TRADE_REPLAY_START_MS) not in serialized_step
    assert "date=2026-06-01" not in serialized_step
    assert stepped["cursor"]["last_trade_time_ms"] == SYNTHETIC_TIME_ANCHOR_MS + 1_000
    assert stepped["cursor"]["last_agg_trade_id"] == 1
    expected_hash = stepped["state_hash"]
    await service.shutdown(step_timeout=1.0)

    recovered_service = await _service(
        tmp_path / "replay.db",
        archive,
        prefix="blind-trade-recovered",
    )
    recovered = await recovered_service.get_session(session_id)
    assert recovered["snapshot"]["state_hash"] == expected_hash
    assert recovered["snapshot"]["cursor"]["last_agg_trade_id"] == 1
    await recovered_service.shutdown(step_timeout=1.0)


async def test_blind_trade_accepts_bar_mismatch_without_revealing_actual_times(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "private-archive")
    repository = trade_replay_repository()
    for rows in repository.rows.values():
        for row in rows:
            if row["open_time"] == TRADE_REPLAY_START_MS:
                for field in ("open", "high", "low", "close"):
                    row[field] = 999
                break
    service = ReplayService(
        settings=replay_settings(tmp_path / "parity.db"),
        store=ReplaySQLiteStore(tmp_path / "parity.db", now_ms=lambda: TRADE_NOW_MS),
        repository=repository,
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory("blind-parity"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()

    created = await service.create_session(trade_replay_config(blind_mode=True))
    assert created["data_fidelity"] == "VERIFIED_AGG_TRADE_APPROXIMATE_BARS"
    serialized = json.dumps(created, sort_keys=True)
    assert str(TRADE_REPLAY_START_MS) not in serialized
    await service.shutdown(step_timeout=1.0)


async def test_trade_service_recovers_checkpoint_and_revalidates_generation(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "archive")
    database = tmp_path / "replay.db"
    service = await _service(database, archive, prefix="first")
    created = await service.create_session(trade_replay_config())
    session_id = str(created["session_id"])
    acquired = await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step", CommandType.STEP, acquired["revision"], {"count": 3}),
    )
    expected_hash = stepped["state_hash"]
    await service.shutdown(step_timeout=1.0)
    assert archive.diagnostics()["active_pins"] == 0

    recovered_service = await _service(database, archive, prefix="second")
    recovered = await recovered_service.get_session(session_id)
    assert recovered["snapshot"]["state"] == SessionState.PAUSED.value
    assert recovered["snapshot"]["state_hash"] == expected_hash
    assert recovered["snapshot"]["cursor"]["last_agg_trade_id"] == 1_002
    assert archive.diagnostics()["active_pins"] == 1
    await recovered_service.shutdown(step_timeout=1.0)
    assert archive.diagnostics()["active_pins"] == 0
