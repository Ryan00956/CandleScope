from __future__ import annotations

import json
import shutil
import sqlite3
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider
from app.replay.archive_pins import persisted_bar_archive_reference
from app.replay.catalog import ReplayCatalog, ReplaySeriesIdentity
from app.replay.constants import REPLAY_PROTOCOL, CommandType
from app.replay.dataset import BarDatasetBuilder, BarDatasetSnapshot
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.history_archive import (
    ReplayHistoryArchiveError,
    ReplayHistoryArchiveRuntimeLease,
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
    ReplayHistoryRepository,
)
from app.replay.remote_history import (
    RemoteReplayHistoryRepository,
    publish_remote_history_index,
)
from app.replay.service import ReplayService
from app.replay.models import ReplayCommand
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.models import TrainingRunCreateRequest
from app.replay.training.errors import TrainingRunError
from app.replay.training.schema import migrate_training_schema
from scripts.import_binance_replay_history import (
    _daily_fallbacks_by_month,
    _select_source_objects,
)
from tests.fixtures.replay.fakes import make_bar
from tests.fixtures.replay.service_fakes import SessionIdFactory, replay_settings
from tests.fixtures.replay.trade_fakes import make_trade_dataset


INTERVAL_MS = 60_000
START_MS = 1_710_000_000_000
NOW_MS = START_MS + 30 * INTERVAL_MS
IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")


def test_binance_monthly_history_plan_retains_checksum_daily_fallbacks() -> None:
    provider = BinanceKlineArchiveProvider()
    refs = provider.plan_objects(
        market_type="futures",
        symbol="BTCUSDT",
        interval="1m",
        start_ms=int(
            datetime(2019, 9, 1, tzinfo=timezone.utc).timestamp() * 1_000
        ),
        end_ms=(
            int(
                datetime(2019, 9, 4, tzinfo=timezone.utc).timestamp()
                * 1_000
            )
            - 1
        ),
        now_ms=int(
            datetime(2026, 7, 31, tzinfo=timezone.utc).timestamp() * 1_000
        ),
    )

    assert [item.period for item in _select_source_objects(refs)] == [
        "2019-09"
    ]
    assert [
        item.period
        for item in _daily_fallbacks_by_month(refs)["2019-09"]
    ] == ["2019-09-01", "2019-09-02", "2019-09-03"]


def _batch(
    offsets: list[int],
    *,
    price_base: int,
    source_key: str,
    digest_character: str,
) -> ReplayHistoryImportBatch:
    return ReplayHistoryImportBatch(
        rows=[
            make_bar(
                START_MS + offset * INTERVAL_MS,
                price=str(price_base + offset),
                source="binance_archive_verified",
            )
            for offset in offsets
        ],
        source_provider="binance-public-kline-v1",
        source_object_key=source_key,
        source_period=source_key,
        source_url=f"https://data.binance.vision/{source_key}.zip",
        source_content_sha256=f"sha256:{digest_character * 64}",
        source_provider_checksum=f"sha256:{digest_character * 64}",
    )


def _catalog(repository: ReplayHistoryRepository) -> ReplayCatalog:
    return ReplayCatalog(
        repository,
        native_intervals=lambda _identity: ("1m",),
        now_ms=lambda: NOW_MS,
        max_scan_rows=2,
    )


def test_manifest_gap_index_drives_weighted_random_without_reading_parquet(
    tmp_path: Path,
) -> None:
    writer = ReplayHistoryArchiveWriter(
        tmp_path / "replay-history",
        now_ms=lambda: NOW_MS,
    )
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [0, 1, 2, 5, 6, 7, 8],
                price_base=100,
                source_key="fixture-2024-03",
                digest_character="a",
            )
        ],
    )
    assert [(item.start_ms, item.end_ms) for item in manifest.segments] == [
        (START_MS, START_MS + 2 * INTERVAL_MS),
        (START_MS + 5 * INTERVAL_MS, START_MS + 8 * INTERVAL_MS),
    ]

    repository = ReplayHistoryRepository(tmp_path / "replay-history")
    catalog = _catalog(repository)
    snapshot = catalog.build(warmup_bars=1, horizon_ms=2 * INTERVAL_MS)
    entry = snapshot.require_entry(IDENTITY)

    assert entry.source_revision == manifest.catalog_epoch
    assert entry.eligible_window_count == 3
    assert [
        (item.first_start_ms, item.last_start_ms, item.count)
        for item in entry.eligible_ranges
    ] == [
        (
            START_MS + INTERVAL_MS,
            START_MS + INTERVAL_MS,
            1,
        ),
        (
            START_MS + 6 * INTERVAL_MS,
            START_MS + 7 * INTERVAL_MS,
            2,
        ),
    ]
    assert repository.diagnostics()["parquet_objects_read"] == 0
    description = repository.describe_catalog(
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    )
    assert description["continuous_segment_count"] == 2
    assert description["missing_grid_rows"] == 2
    assert description["source_rejected_rows"] == 0
    assert repository.verify_catalog_objects(
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    )["verified"] is True

    selected = {
        catalog.select_random(entry, seed=seed).replay_start_ms
        for seed in range(64)
    }
    assert selected == {
        START_MS + INTERVAL_MS,
        START_MS + 6 * INTERVAL_MS,
        START_MS + 7 * INTERVAL_MS,
    }

    gaps = repository.scan_gaps_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "1m",
        start_ms=START_MS,
        end_ms=START_MS + 8 * INTERVAL_MS,
        exchange="binance",
        market_type="spot",
        limit=1,
    )
    assert gaps["truncated"] is False
    assert gaps["gap_count"] == 1
    assert gaps["gaps"] == [
        {
            "start_ms": START_MS + 3 * INTERVAL_MS,
            "end_ms": START_MS + 4 * INTERVAL_MS,
            "missing_bars": 2,
            "reason": "replay_archive_gap",
            "status": "detected",
        }
    ]


def test_float64_archive_tiny_volume_is_canonicalized_for_replay(
    tmp_path: Path,
) -> None:
    batch = _batch(
        list(range(4)),
        price_base=100,
        source_key="fixture-tiny-volume",
        digest_character="9",
    )
    rows = [dict(row) for row in batch.rows]
    rows[0]["volume"] = "0.000013"
    writer = ReplayHistoryArchiveWriter(
        tmp_path / "replay-history",
        now_ms=lambda: NOW_MS,
    )
    writer.import_batches(
        IDENTITY,
        "1m",
        [replace(batch, rows=rows)],
    )
    repository = ReplayHistoryRepository(tmp_path / "replay-history")
    catalog = _catalog(repository)
    entry = catalog.build(
        warmup_bars=1,
        horizon_ms=2 * INTERVAL_MS,
    ).require_entry(IDENTITY)
    window = catalog.select_manual(
        entry,
        start_ms=START_MS + INTERVAL_MS,
    )

    snapshot = BarDatasetBuilder(repository, now_ms=lambda: NOW_MS).create(
        entry,
        window,
    )

    assert snapshot.rows[0].volume == "0.000013"


def test_remote_catalog_random_selection_is_independent_of_local_object_cache(
    tmp_path: Path,
) -> None:
    origin = tmp_path / "origin"
    writer = ReplayHistoryArchiveWriter(origin, now_ms=lambda: NOW_MS)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(5)),
                price_base=100,
                source_key="fixture-remote-a",
                digest_character="1",
            ),
            _batch(
                list(range(5, 10)),
                price_base=100,
                source_key="fixture-remote-b",
                digest_character="2",
            ),
        ],
    )
    remote_index = publish_remote_history_index(origin, now_ms=NOW_MS)
    assert remote_index.catalogs[0].catalog_epoch == manifest.catalog_epoch

    empty_cache = tmp_path / "cache-empty"
    partial_cache = tmp_path / "cache-partial"
    full_cache = tmp_path / "cache-full"
    first = manifest.objects[0]
    partial_object = partial_cache / first.relative_path
    partial_object.parent.mkdir(parents=True)
    shutil.copyfile(origin / first.relative_path, partial_object)
    shutil.copytree(origin / "objects", full_cache / "objects")

    selections: list[int] = []
    for cache in (empty_cache, partial_cache, full_cache):
        repository = RemoteReplayHistoryRepository(
            cache,
            origin,
            refresh_seconds=0,
        )
        catalog = _catalog(repository)
        snapshot = catalog.build(warmup_bars=1, horizon_ms=2 * INTERVAL_MS)
        entry = snapshot.require_entry(IDENTITY)
        selections.append(catalog.select_random(entry, seed=734_221).replay_start_ms)
        diagnostics = repository.diagnostics()
        assert diagnostics["parquet_objects_read"] == 0
        assert diagnostics["object_downloads"] == 0
        assert diagnostics["remote_index_epoch"] == remote_index.index_epoch

    assert selections[0] == selections[1] == selections[2]


def test_remote_repository_materializes_only_objects_overlapping_selected_range(
    tmp_path: Path,
) -> None:
    origin = tmp_path / "origin"
    writer = ReplayHistoryArchiveWriter(origin, now_ms=lambda: NOW_MS)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(5)),
                price_base=100,
                source_key="fixture-materialize-a",
                digest_character="3",
            ),
            _batch(
                list(range(5, 10)),
                price_base=100,
                source_key="fixture-materialize-b",
                digest_character="4",
            ),
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    cache = tmp_path / "cache"
    repository = RemoteReplayHistoryRepository(cache, origin)

    rows = repository.query_bars_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "1m",
        start_ms=START_MS + 6 * INTERVAL_MS,
        end_ms=START_MS + 8 * INTERVAL_MS,
        exchange="binance",
        market_type="spot",
    )

    assert [row["open_time"] for row in rows] == [
        START_MS + 6 * INTERVAL_MS,
        START_MS + 7 * INTERVAL_MS,
        START_MS + 8 * INTERVAL_MS,
    ]
    assert not (cache / manifest.objects[0].relative_path).exists()
    assert (cache / manifest.objects[1].relative_path).is_file()
    diagnostics = repository.diagnostics()
    assert diagnostics["object_downloads"] == 1
    assert diagnostics["object_download_failures"] == 0


def test_remote_object_checksum_failure_does_not_change_selection_domain(
    tmp_path: Path,
) -> None:
    origin = tmp_path / "origin"
    writer = ReplayHistoryArchiveWriter(origin, now_ms=lambda: NOW_MS)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="fixture-corrupt-object",
                digest_character="5",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    repository = RemoteReplayHistoryRepository(tmp_path / "cache", origin)
    entry = _catalog(repository).build(
        warmup_bars=1,
        horizon_ms=2 * INTERVAL_MS,
    ).require_entry(IDENTITY)
    selected_before = _catalog(repository).select_random(entry, seed=77).replay_start_ms

    object_path = origin / manifest.objects[0].relative_path
    object_path.write_bytes(object_path.read_bytes() + b"corrupt")

    selected_after = _catalog(repository).select_random(entry, seed=77).replay_start_ms
    assert selected_after == selected_before
    with pytest.raises(ReplayHistoryArchiveError, match="size/checksum"):
        repository.query_bars_at_revision(
            manifest.catalog_epoch,
            "BTCUSDT",
            "1m",
            start_ms=START_MS,
            end_ms=START_MS + INTERVAL_MS,
            exchange="binance",
            market_type="spot",
        )
    assert repository.diagnostics()["object_download_failures"] == 1


@pytest.mark.anyio
async def test_failed_random_preparation_retries_immutable_remote_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    origin = tmp_path / "origin"
    writer = ReplayHistoryArchiveWriter(origin, now_ms=lambda: NOW_MS)
    first_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(20)),
                price_base=100,
                source_key="fixture-immutable-old",
                digest_character="7",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    database = tmp_path / "replay.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            product_v2_enabled=True,
            replay_bar_source="archive",
            replay_history_archive_dir=tmp_path / "cache",
            replay_history_origin_uri=str(origin),
            replay_history_catalog_refresh_seconds=0,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("remote-session"),
        training_run_id_factory=SessionIdFactory("remote-run"),
        training_random_seed_factory=lambda: 991_337,
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    training = service.training
    assert training is not None
    original_create = service._dataset_builder.create
    attempts = 0

    def fail_first_materialization(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "injected origin outage",
            )
        return original_create(*args, **kwargs)

    monkeypatch.setattr(
        service._dataset_builder,
        "create",
        fail_first_materialization,
    )
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v2",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Immutable retry",
                "source_kind": "BAR",
                "start_mode": "RANDOM",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "requested_start_ms": None,
                "indicator_warmup_bars": 2,
                "forward_cache_ms": 5 * INTERVAL_MS,
                "random_seed": None,
                "initial_equity": "10000",
                "max_leverage": "3",
                "maker_fee_bps": "2",
                "taker_fee_bps": "5",
                "market_slippage_bps": "1",
                "integrity_mode": "CHALLENGE",
                "time_disclosure_policy": "NONE",
                "book_mode": "OFF",
                "margin_mode": "CROSS",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        with pytest.raises(TrainingRunError):
            await training.create_run(request)

        second_manifest = writer.import_batches(
            IDENTITY,
            "1m",
            [
                _batch(
                    list(range(20)),
                    price_base=900,
                    source_key="fixture-immutable-new",
                    digest_character="8",
                )
            ],
        )
        assert second_manifest.catalog_epoch != first_manifest.catalog_epoch
        publish_remote_history_index(origin, now_ms=NOW_MS + 1)

        created = await training.retry_selection_preparation("remote-run-1")
        session_id = str(created["run"]["adapter_session_id"])
        persisted = await service.store.load_dataset(session_id)
        assert persisted is not None
        payload = json.loads(bytes(persisted["snapshot_blob"]).decode("utf-8"))
        snapshot_payload = payload.get("bar_dataset", payload)
        assert isinstance(snapshot_payload, dict)
        snapshot = BarDatasetSnapshot.from_dict(snapshot_payload)
        assert snapshot.provenance.source_revision == first_manifest.catalog_epoch
        assert max(float(row.open) for row in snapshot.rows) < 200
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.anyio
async def test_forward_cache_boundary_pages_same_revision_without_ending_run(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(12)),
                price_base=100,
                source_key="fixture-paged-forward-cache",
                digest_character="9",
            )
        ],
    )
    database = tmp_path / "paged-forward-cache.db"

    async def start_service() -> ReplayService:
        instance = ReplayService(
            settings=replace(
                replay_settings(database),
                product_v2_enabled=True,
            ),
            store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
            repository=ReplayHistoryRepository(root),
            now_ms=lambda: NOW_MS,
            session_id_factory=SessionIdFactory("paged-session"),
            training_run_id_factory=SessionIdFactory("paged-run"),
            native_intervals=lambda _identity: ("1m",),
        )
        await instance.start()
        return instance

    service = await start_service()
    try:
        catalog = await service.catalog(
            warmup_bars=1,
            horizon_ms=3 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=True,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v2",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Paged forward cache",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "requested_start_ms": START_MS + INTERVAL_MS,
                "indicator_warmup_bars": 1,
                "forward_cache_ms": 3 * INTERVAL_MS,
                "random_seed": None,
                "initial_equity": "10000",
                "max_leverage": "3",
                "maker_fee_bps": "2",
                "taker_fee_bps": "5",
                "market_slippage_bps": "1",
                "integrity_mode": "CHALLENGE",
                "time_disclosure_policy": "HIDE_ALL",
                "book_mode": "OFF",
                "margin_mode": "CROSS",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        session_id = str(created["run"]["adapter_session_id"])

        def command(
            command_id: str,
            command_type: CommandType,
            revision: int,
            payload: dict[str, object] | None = None,
        ) -> ReplayCommand:
            return ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id=command_id,
                client_instance_id="paged-browser",
                expected_revision=revision,
                type=command_type,
                payload=payload or {},
            )

        await service.command(
            session_id,
            command("acquire-paged", CommandType.ACQUIRE_CONTROLLER, 0),
        )
        cache_boundary = await service.command(
            session_id,
            command(
                "step-cache-boundary",
                CommandType.STEP,
                1,
                {"count": 3},
            ),
        )
        assert cache_boundary["state"] == "PAUSED"
        assert cache_boundary["cursor"]["source_sequence"] == 3
        assert cache_boundary["cursor"]["at_end"] is False
        assert cache_boundary["cursor"]["virtual_time_ms"] < START_MS
        assert str(START_MS + 11 * INTERVAL_MS) not in json.dumps(
            cache_boundary,
            sort_keys=True,
        )

        paged = await service.command(
            session_id,
            command("step-paged", CommandType.STEP, 2, {"count": 1}),
        )
        assert paged["state"] == "PAUSED"
        assert paged["cursor"]["source_sequence"] == 4
        persisted = await service.store.load_dataset(session_id)
        assert persisted is not None
        bundle = json.loads(bytes(persisted["snapshot_blob"]).decode("utf-8"))
        assert bundle["schema_version"] == "replay-paged-bar-session-dataset.v1"
        assert bundle["paging_manifest"]["source_revision"] == manifest.catalog_epoch
    finally:
        await service.shutdown(step_timeout=1.0)

    recovered = await start_service()
    try:
        snapshot = (await recovered.get_session(session_id))["snapshot"]
        assert snapshot["state"] == "PAUSED"
        assert snapshot["cursor"]["source_sequence"] == 4
        assert snapshot["cursor"]["at_end"] is False
    finally:
        await recovered.shutdown(step_timeout=1.0)


def test_corrupt_live_remote_index_fails_closed_instead_of_using_stale_cache(
    tmp_path: Path,
) -> None:
    origin = tmp_path / "origin"
    writer = ReplayHistoryArchiveWriter(origin, now_ms=lambda: NOW_MS)
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="fixture-corrupt-index",
                digest_character="6",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    repository = RemoteReplayHistoryRepository(
        tmp_path / "cache",
        origin,
        refresh_seconds=0,
    )
    assert repository.list_all_series()
    (origin / "index.json").write_text("{}", encoding="utf-8")

    with pytest.raises(ReplayHistoryArchiveError, match="index fields"):
        repository.list_all_series()


def test_closed_archive_catalog_epoch_does_not_churn_with_wall_clock(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="fixture-2024-03",
                digest_character="f",
            )
        ],
    )
    current_now_ms = [NOW_MS]
    catalog = ReplayCatalog(
        ReplayHistoryRepository(root),
        native_intervals=lambda _identity: ("1m",),
        now_ms=lambda: current_now_ms[0],
        max_scan_rows=2,
        cache_ttl_seconds=60.0,
    )
    first = catalog.build(warmup_bars=1, horizon_ms=2 * INTERVAL_MS)

    current_now_ms[0] += INTERVAL_MS
    second = catalog.build(warmup_bars=1, horizon_ms=2 * INTERVAL_MS)

    assert second is first
    assert second.catalog_epoch == first.catalog_epoch
    assert catalog.diagnostics()["cache_hits"] == 1


def test_one_corrupt_series_is_quarantined_without_hiding_healthy_series(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    broken = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="broken-series",
                digest_character="1",
            )
        ],
    )
    healthy_identity = ReplaySeriesIdentity("binance", "spot", "ETHUSDT")
    writer.import_batches(
        healthy_identity,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=1_000,
                source_key="healthy-series",
                digest_character="2",
            )
        ],
    )
    broken_object = root / broken.objects[0].relative_path
    broken_object.unlink()

    repository = ReplayHistoryRepository(root)
    series = repository.list_all_series()
    assert {(item["symbol"], item["interval"]) for item in series} == {
        ("ETHUSDT", "1m")
    }
    diagnostics = repository.diagnostics()
    assert diagnostics["series_count"] == 1
    assert len(diagnostics["series_errors"]) == 1


def test_archive_gc_keeps_current_and_explicitly_pinned_revisions(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    first = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="fixture-replaced",
                digest_character="3",
            )
        ],
    )
    second = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=900,
                source_key="fixture-replaced",
                digest_character="4",
            )
        ],
    )

    pinned = writer.collect_garbage(
        pinned_revisions=[first.catalog_epoch],
        dry_run=True,
    )
    assert pinned["stale_manifest_count"] == 0
    assert pinned["stale_object_count"] == 0

    unpinned = writer.collect_garbage(pinned_revisions=(), dry_run=True)
    assert unpinned["stale_manifest_count"] == 1
    assert unpinned["stale_object_count"] == 1
    applied = writer.collect_garbage(pinned_revisions=(), dry_run=False)
    assert applied["stale_manifest_count"] == 1
    assert applied["stale_object_count"] == 1

    repository = ReplayHistoryRepository(root)
    current = repository.query_bars_at_revision(
        second.catalog_epoch,
        "BTCUSDT",
        "1m",
        start_ms=START_MS,
        end_ms=START_MS,
        exchange="binance",
        market_type="spot",
    )
    assert current[0]["open"] == 900.0
    with pytest.raises(ReplayHistoryArchiveError):
        repository.query_bars_at_revision(
            first.catalog_epoch,
            "BTCUSDT",
            "1m",
            start_ms=START_MS,
            end_ms=START_MS,
            exchange="binance",
            market_type="spot",
        )


def test_archive_runtime_lease_blocks_destructive_maintenance(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    runtime = ReplayHistoryArchiveRuntimeLease(root)
    maintenance = ReplayHistoryArchiveRuntimeLease(root)
    runtime.acquire()
    try:
        with pytest.raises(
            ReplayHistoryArchiveError,
            match="active runtime",
        ):
            maintenance.acquire()
    finally:
        runtime.release()

    maintenance.acquire()
    maintenance.release()


def test_archive_fixed_interval_aggregation_is_revision_bound_and_cached(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(180)),
                price_base=100,
                source_key="fixture-three-hours",
                digest_character="5",
            )
        ],
    )
    repository = ReplayHistoryRepository(root)
    kwargs = {
        "source_revision": manifest.catalog_epoch,
        "symbol": "BTCUSDT",
        "base_interval": "1m",
        "display_interval": "1h",
        "actual_start_ms": START_MS,
        "actual_end_ms": START_MS + 180 * INTERVAL_MS,
        "timeline_delta_ms": 0,
        "limit": 10,
        "exchange": "binance",
        "market_type": "spot",
    }

    first = repository.query_aggregated_bars_at_revision(**kwargs)
    second = repository.query_aggregated_bars_at_revision(**kwargs)
    shifted = repository.query_aggregated_bars_at_revision(
        **{**kwargs, "timeline_delta_ms": 3_600_000}
    )

    assert second == first
    assert shifted["bars"][0]["open_time_ms"] == (
        first["bars"][0]["open_time_ms"] + 3_600_000
    )
    assert first["has_more"] is False
    assert [item["open_time_ms"] for item in first["bars"]] == [
        START_MS,
        START_MS + 60 * INTERVAL_MS,
        START_MS + 120 * INTERVAL_MS,
    ]
    assert first["bars"][0]["open"] == "100"
    assert first["bars"][0]["close"] == "159.5"
    assert first["bars"][0]["component_count"] == 60
    diagnostics = repository.diagnostics()
    assert diagnostics["aggregate_cache_hits"] == 1
    assert diagnostics["aggregate_cache_writes"] == 2

    restarted = ReplayHistoryRepository(root)
    assert restarted.query_aggregated_bars_at_revision(**kwargs) == first
    restarted_diagnostics = restarted.diagnostics()
    assert restarted_diagnostics["aggregate_cache_hits"] == 1
    assert restarted_diagnostics["checksum_verifications"] == 0


def test_dataset_and_history_reads_stay_pinned_to_the_selected_catalog_revision(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    first_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="fixture-2024-03",
                digest_character="b",
            )
        ],
    )
    repository = ReplayHistoryRepository(root)
    first_catalog = _catalog(repository)
    first_snapshot = first_catalog.build(
        warmup_bars=2,
        horizon_ms=3 * INTERVAL_MS,
    )
    first_entry = first_snapshot.require_entry(IDENTITY)
    first_window = first_catalog.select_manual(
        first_entry,
        start_ms=START_MS + 4 * INTERVAL_MS,
    )

    second_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=900,
                source_key="fixture-2024-03",
                digest_character="c",
            )
        ],
    )
    assert second_manifest.catalog_epoch != first_manifest.catalog_epoch

    pinned = BarDatasetBuilder(repository, now_ms=lambda: NOW_MS).create(
        first_entry,
        first_window,
    )
    assert pinned.provenance.source_revision == first_manifest.catalog_epoch
    assert pinned.replay_rows[0].open == "104"
    assert "source_revision" not in pinned.snapshot_ref().to_dict()
    persisted_bar_ref, _ = ReplayService._persisted_dataset(pinned, None)
    assert persisted_bar_ref["source_revision"] == first_manifest.catalog_epoch
    persisted_trade_ref, _ = ReplayService._persisted_dataset(
        pinned,
        make_trade_dataset(1),
    )
    assert persisted_trade_ref["bar_snapshot_ref"] == persisted_bar_ref
    legacy_reference = persisted_bar_archive_reference(
        pinned.snapshot_ref().to_dict(),
        json.dumps(pinned.to_dict()).encode("utf-8"),
        strict=True,
    )
    assert legacy_reference is not None
    assert legacy_reference["source_revision"] == first_manifest.catalog_epoch
    assert (
        BarDatasetSnapshot.from_dict(pinned.to_dict()).data_epoch
        == pinned.data_epoch
    )

    second_catalog = _catalog(repository)
    second_snapshot = second_catalog.build(
        warmup_bars=2,
        horizon_ms=3 * INTERVAL_MS,
    )
    second_entry = second_snapshot.require_entry(IDENTITY)
    second_window = second_catalog.select_manual(
        second_entry,
        start_ms=START_MS + 4 * INTERVAL_MS,
    )
    current = BarDatasetBuilder(repository, now_ms=lambda: NOW_MS).create(
        second_entry,
        second_window,
    )
    assert current.provenance.source_revision == second_manifest.catalog_epoch
    assert current.replay_rows[0].open == "904"

    descending = repository.query_bars_at_revision(
        first_manifest.catalog_epoch,
        "BTCUSDT",
        "1m",
        start_ms=START_MS,
        end_ms=START_MS + 9 * INTERVAL_MS,
        limit=2,
        order="DESC",
        exchange="binance",
        market_type="spot",
    )
    assert [item["open_time"] for item in descending] == [
        START_MS + 9 * INTERVAL_MS,
        START_MS + 8 * INTERVAL_MS,
    ]
    assert descending[0]["open"] == 109.0


@pytest.mark.anyio
async def test_all_available_history_uses_the_run_bound_archive_revision(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(20)),
                price_base=100,
                source_key="fixture-2024-03",
                digest_character="d",
            )
        ],
    )
    database = tmp_path / "replay.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            product_v2_enabled=True,
            replay_bar_source="archive",
            replay_history_archive_dir=root,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("archive-session"),
        training_run_id_factory=SessionIdFactory("archive-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    assert isinstance(service.history_repository, ReplayHistoryRepository)
    assert service.capabilities()["sources"]["bar"] == {
        "enabled": True,
        "fidelity": "EXACT_BAR_COVERAGE",
    }
    await service.start()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        assert "source_revision" not in catalog["entries"][0]
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v2",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Archive revision history",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "requested_start_ms": START_MS + 12 * INTERVAL_MS,
                "indicator_warmup_bars": 2,
                "visible_history_lookback": {
                    "mode": "ALL_AVAILABLE",
                    "duration_ms": None,
                },
                "forward_cache_ms": 5 * INTERVAL_MS,
                "random_seed": 42,
                "initial_equity": "10000",
                "max_leverage": "3",
                "maker_fee_bps": "2",
                "taker_fee_bps": "5",
                "market_slippage_bps": "1",
                "integrity_mode": "CHALLENGE",
                "time_disclosure_policy": "NONE",
                "book_mode": "OFF",
                "margin_mode": "CROSS",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        training = service.training
        assert training is not None
        await training.create_run(request)
        with sqlite3.connect(database) as connection:
            pin = connection.execute(
                """
                SELECT run_id, track_id, source_revision, symbol, base_interval
                FROM replay_archive_pin
                """
            ).fetchone()
        assert pin == (
            "archive-run-1",
            "track-1",
            writer.current_manifest(IDENTITY, "1m").catalog_epoch,
            "BTCUSDT",
            "1m",
        )
        persisted = await service.store.load_dataset("archive-session-1")
        assert persisted is not None
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            legacy_ref = dict(persisted["snapshot_ref"])
            nested_bar_ref = legacy_ref.get("bar_snapshot_ref")
            if isinstance(nested_bar_ref, dict):
                nested_bar_ref = dict(nested_bar_ref)
                nested_bar_ref.pop("source_revision")
                legacy_ref["bar_snapshot_ref"] = nested_bar_ref
            else:
                legacy_ref.pop("source_revision")
            connection.execute(
                """
                UPDATE replay_dataset_ref
                SET snapshot_ref_json = ?, snapshot_blob = ?,
                    snapshot_object_id = NULL, snapshot_size_bytes = NULL
                WHERE session_id = 'archive-session-1'
                """,
                (
                    json.dumps(legacy_ref),
                    persisted["snapshot_blob"],
                ),
            )
            connection.execute("DELETE FROM replay_archive_pin")
            migrate_training_schema(connection, now_ms=NOW_MS)
            legacy_pin = connection.execute(
                "SELECT source_revision FROM replay_archive_pin"
            ).fetchone()
        assert legacy_pin is not None
        assert legacy_pin["source_revision"] == (
            writer.current_manifest(IDENTITY, "1m").catalog_epoch
        )
        session = await service.get_session("archive-session-1")
        snapshot = session["snapshot"]

        writer.import_batches(
            IDENTITY,
            "1m",
            [
                _batch(
                    list(range(20)),
                    price_base=900,
                    source_key="fixture-2024-03",
                    digest_character="e",
                )
            ],
        )

        boundary = int(snapshot["cursor"]["virtual_time_ms"])
        page = await training.history_page(
            "archive-session-1",
            track_id="track-1",
            before_ms=boundary + 1,
            revealed_boundary_ms=boundary,
            limit=20,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=None,
        )
        bars = page["bars"]
        assert bars
        assert max(float(item["open"]) for item in bars) < 200
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.anyio
async def test_all_available_history_crosses_a_revision_declared_archive_gap(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history-gap"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [offset for offset in range(30) if offset not in range(5, 10)],
                price_base=100,
                source_key="fixture-maintenance-gap",
                digest_character="9",
            )
        ],
    )
    database = tmp_path / "replay-gap.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            product_v2_enabled=True,
            replay_bar_source="archive",
            replay_history_archive_dir=root,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("gap-session"),
        training_run_id_factory=SessionIdFactory("gap-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v2",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Archive maintenance gap history",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "5m",
                "requested_start_ms": START_MS + 20 * INTERVAL_MS,
                "indicator_warmup_bars": 2,
                "visible_history_lookback": {
                    "mode": "ALL_AVAILABLE",
                    "duration_ms": None,
                },
                "forward_cache_ms": 5 * INTERVAL_MS,
                "random_seed": 42,
                "initial_equity": "10000",
                "max_leverage": "3",
                "maker_fee_bps": "2",
                "taker_fee_bps": "5",
                "market_slippage_bps": "1",
                "integrity_mode": "CHALLENGE",
                "time_disclosure_policy": "NONE",
                "book_mode": "OFF",
                "margin_mode": "CROSS",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        training = service.training
        assert training is not None
        await training.create_run(request)
        session = await service.get_session("gap-session-1")
        snapshot = session["snapshot"]
        page = await training.history_page(
            "gap-session-1",
            track_id="track-1",
            before_ms=START_MS + 10 * INTERVAL_MS,
            revealed_boundary_ms=int(snapshot["cursor"]["virtual_time_ms"]),
            limit=2,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=None,
            display_interval="5m",
        )

        assert page["schema_version"] == "replay.history.v3"
        assert page["history_boundary_ms"] == START_MS
        assert [bar["open_time_ms"] for bar in page["bars"]] == [START_MS]
        assert page["excluded_ranges"] == [
            {
                "start_ms": START_MS + 5 * INTERVAL_MS,
                "end_ms": START_MS + 10 * INTERVAL_MS - 1,
                "reason": "source_gap_affected_display_bucket",
                "source_reason": "replay_archive_gap",
            }
        ]
        assert page["has_more"] is False

        snapshot_after = (await service.get_session("gap-session-1"))["snapshot"]
        assert snapshot_after["cursor"] == snapshot["cursor"]
        assert snapshot_after["data_epoch"] == snapshot["data_epoch"]
    finally:
        await service.shutdown(step_timeout=1.0)
