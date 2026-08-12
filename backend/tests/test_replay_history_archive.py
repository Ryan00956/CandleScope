from __future__ import annotations

import json
import shutil
import sqlite3
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.data_engine.interval_policy import compute_bucket_start_ms
from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider
from app.replay.archive_pins import persisted_bar_archive_reference
from app.replay.catalog import ReplayCatalog, ReplaySeriesIdentity
from app.replay.constants import REPLAY_PROTOCOL, CommandType
from app.replay.dataset import BarDatasetBuilder, BarDatasetSnapshot
from app.replay.display_time import SourceBucketTimeMapper
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.history_archive import (
    SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
    ReplayHistoryArchiveError,
    ReplayHistoryArchiveRuntimeLease,
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
    ReplayHistoryRepository,
)
from app.replay.remote_history import (
    RemoteReplayHistoryRepository,
    ReplayHistoryOriginUnavailable,
    publish_remote_history_index,
)
from app.replay.service import ReplayService
from app.replay.models import ReplayCommand
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.commands import ReplayV2Command
from app.replay.training.models import (
    ReplayV2CommandType,
    TrainingCursor,
    TrainingRunCreateRequest,
)
from app.replay.training.errors import TrainingRunError
from app.replay.training.schema import migrate_training_schema
from scripts.import_binance_replay_history import (
    _daily_fallbacks_by_month,
    _select_source_objects,
    _source_filter_policy,
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
        start_ms=int(datetime(2019, 9, 1, tzinfo=timezone.utc).timestamp() * 1_000),
        end_ms=(int(datetime(2019, 9, 4, tzinfo=timezone.utc).timestamp() * 1_000) - 1),
        now_ms=int(datetime(2026, 7, 31, tzinfo=timezone.utc).timestamp() * 1_000),
    )

    assert [item.period for item in _select_source_objects(refs)] == ["2019-09"]
    assert [item.period for item in _daily_fallbacks_by_month(refs)["2019-09"]] == [
        "2019-09-01",
        "2019-09-02",
        "2019-09-03",
    ]


def test_binance_history_parser_policy_requires_v2_rebuild() -> None:
    assert _source_filter_policy(None) == "binance_checksum_utc_grid_v2"
    assert (
        _source_filter_policy(SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED)
        == "binance_checksum_catalog_fixed_grid_v2"
    )


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


def _native_interval_batch(
    offsets: list[int],
    *,
    interval: str,
    interval_ms: int,
    price_base: int,
    source_key: str,
    digest_character: str,
) -> ReplayHistoryImportBatch:
    return ReplayHistoryImportBatch(
        rows=[
            {
                **make_bar(
                    START_MS + offset * INTERVAL_MS,
                    interval_ms=interval_ms,
                    price=str(price_base + offset),
                    source="binance_archive_verified",
                ),
                "interval": interval,
            }
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
    assert (
        repository.verify_catalog_objects(
            "BTCUSDT",
            "1m",
            exchange="binance",
            market_type="spot",
        )["verified"]
        is True
    )

    selected = {
        catalog.select_random(entry, seed=seed).replay_start_ms for seed in range(64)
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


def test_remote_unchanged_index_refresh_does_not_reload_manifests(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
                source_key="fixture-unchanged-index",
                digest_character="a",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    repository = RemoteReplayHistoryRepository(
        tmp_path / "cache",
        origin,
        refresh_seconds=0,
    )
    calls: list[str] = []
    original_read_json = repository.origin.read_json

    def read_json(relative_path: str, *, max_bytes: int):
        calls.append(relative_path)
        return original_read_json(relative_path, max_bytes=max_bytes)

    monkeypatch.setattr(repository.origin, "read_json", read_json)

    assert repository.list_all_series()
    assert repository.list_all_series()

    assert calls == ["index.json", "index.json"]
    diagnostics = repository.diagnostics()
    # ``diagnostics()`` asks the base repository for a current snapshot and
    # therefore performs one additional zero-interval index-only refresh.
    assert diagnostics["remote_index_unchanged_refreshes"] == 3
    assert diagnostics["remote_manifests_loaded"] == 1
    assert diagnostics["remote_manifests_reused"] == 0


def test_remote_changed_index_loads_only_changed_manifests(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    origin = tmp_path / "origin"
    writer = ReplayHistoryArchiveWriter(origin, now_ms=lambda: NOW_MS)
    eth_identity = ReplaySeriesIdentity("binance", "spot", "ETHUSDT")
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="fixture-incremental-btc-a",
                digest_character="b",
            )
        ],
    )
    writer.import_batches(
        eth_identity,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=200,
                source_key="fixture-incremental-eth",
                digest_character="c",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    repository = RemoteReplayHistoryRepository(
        tmp_path / "cache",
        origin,
        refresh_seconds=0,
    )
    calls: list[str] = []
    original_read_json = repository.origin.read_json

    def read_json(relative_path: str, *, max_bytes: int):
        calls.append(relative_path)
        return original_read_json(relative_path, max_bytes=max_bytes)

    monkeypatch.setattr(repository.origin, "read_json", read_json)
    changed = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10, 20)),
                price_base=100,
                source_key="fixture-incremental-btc-b",
                digest_character="d",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS + 1)

    series = repository.list_all_series()

    manifest_calls = [item for item in calls if item != "index.json"]
    assert len(manifest_calls) == 1
    assert manifest_calls[0].endswith(f"{changed.catalog_epoch[7:]}.json")
    assert all("ETHUSDT" not in item for item in manifest_calls)
    assert {(item["symbol"], item["total_count"]) for item in series} == {
        ("BTCUSDT", 20),
        ("ETHUSDT", 10),
    }
    diagnostics = repository.diagnostics()
    assert diagnostics["remote_manifests_loaded"] == 3
    assert diagnostics["remote_manifests_reused"] == 1


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
    entry = (
        _catalog(repository)
        .build(
            warmup_bars=1,
            horizon_ms=2 * INTERVAL_MS,
        )
        .require_entry(IDENTITY)
    )
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
                "protocol": "replay.v3",
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
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
                "protocol": "replay.v3",
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
                "visible_history_lookback": {
                    "mode": "ALL_AVAILABLE",
                    "duration_ms": None,
                },
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        run_id = str(created["run"]["run_id"])
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
            command("step-paged", CommandType.STEP, 2, {"count": 3}),
        )
        assert paged["state"] == "PAUSED"
        assert paged["cursor"]["source_sequence"] == 6
        paged_snapshot = (await service.get_session(session_id))["snapshot"]
        builder = paged_snapshot["components"]["bar_builder"]
        replay_start_ms = int(builder["replay_start_ms"])
        revealed_boundary_ms = int(paged_snapshot["cursor"]["virtual_time_ms"])
        persisted = await service.store.load_dataset(session_id)
        assert persisted is not None
        initial_forward_upper = (
            int(persisted["synthetic_origin_ms"])
            + int(persisted["actual_replay_end_ms"])
            - int(persisted["actual_replay_start_ms"])
            + INTERVAL_MS
            - 1
        )
        assert revealed_boundary_ms > initial_forward_upper
        public_times = await service.training.public_times(
            run_id,
            timeline_ms=(revealed_boundary_ms,),
        )
        assert [item["input_timeline_ms"] for item in public_times["items"]] == [
            revealed_boundary_ms
        ]
        with pytest.raises(TrainingRunError, match="outside the pinned"):
            await service.training.public_times(
                run_id,
                timeline_ms=(revealed_boundary_ms + 1,),
            )
        report = await service.training.report(run_id)
        assert report["run_id"] == run_id
        revealed_page = await service.training.history_page(
            session_id,
            track_id="track-1",
            before_ms=replay_start_ms + 5 * INTERVAL_MS,
            revealed_boundary_ms=revealed_boundary_ms,
            limit=20,
            data_epoch=str(paged_snapshot["data_epoch"]),
            history_epoch=None,
            display_interval="5m",
        )
        # The requested source start sits inside its native 5m candle.  Blind
        # projection maps that whole exchange bucket to the preceding public
        # slot instead of re-flooring the shifted 1m timestamps at replay start.
        assert [bar["open_time_ms"] for bar in revealed_page["bars"]] == [
            replay_start_ms - 5 * INTERVAL_MS
        ]
        revealed_bar = revealed_page["bars"][0]
        assert revealed_bar["open"] == "100"
        assert revealed_bar["close"] == "104.5"
        assert revealed_bar["component_count"] == 5
        assert revealed_bar["is_closed"] is True
        assert revealed_bar["close_time_ms"] <= revealed_boundary_ms
        bundle = json.loads(bytes(persisted["snapshot_blob"]).decode("utf-8"))
        assert bundle["schema_version"] == "replay-paged-bar-session-dataset.v1"
        assert bundle["paging_manifest"]["source_revision"] == manifest.catalog_epoch
        assert bundle["paging_manifest"]["schema_version"] == (
            "replay-paged-bar-manifest.v3"
        )
        assert bundle["paging_manifest"]["terminal_kind"] == (
            "SOURCE_LATEST_CLOSED"
        )
        assert bundle["paging_manifest"]["verified_market_halts"] == []
        retired_manifest = dict(bundle["paging_manifest"])
        retired_manifest["schema_version"] = "replay-paged-bar-manifest.v2"
        with pytest.raises(
            ReplayDomainError,
            match="paged BAR manifest schema is unsupported",
        ) as retired_error:
            service._validated_bar_paging_manifest(
                retired_manifest,
                BarDatasetSnapshot.from_dict(bundle["bar_dataset"]),
            )
        assert retired_error.value.code is ReplayErrorCode.DATASET_MISMATCH
    finally:
        await service.shutdown(step_timeout=1.0)

    recovered = await start_service()
    try:
        snapshot = (await recovered.get_session(session_id))["snapshot"]
        assert snapshot["state"] == "PAUSED"
        assert snapshot["cursor"]["source_sequence"] == 6
        assert snapshot["cursor"]["at_end"] is False
        assert recovered.training is not None
        public_times = await recovered.training.public_times(
            run_id,
            timeline_ms=(int(snapshot["cursor"]["virtual_time_ms"]),),
        )
        assert [item["input_timeline_ms"] for item in public_times["items"]] == [
            int(snapshot["cursor"]["virtual_time_ms"])
        ]
    finally:
        await recovered.shutdown(step_timeout=1.0)


@pytest.mark.anyio
async def test_verified_binance_halt_advances_clock_and_pages_to_first_resume_bar(
    tmp_path: Path,
) -> None:
    halt_start_ms = 1_557_889_200_000
    resume_ms = 1_557_925_200_000
    source_start_ms = halt_start_ms - 10 * INTERVAL_MS
    rows = [
        make_bar(
            source_start_ms + offset * INTERVAL_MS,
            price=str(100 + offset),
            source="binance_archive_verified",
        )
        for offset in range(10)
    ] + [
        make_bar(
            resume_ms + offset * INTERVAL_MS,
            price=str(200 + offset),
            source="binance_archive_verified",
        )
        for offset in range(11)
    ]
    root = tmp_path / "verified-halt-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            ReplayHistoryImportBatch(
                rows=rows,
                source_provider="binance-public-kline-v1",
                source_object_key="BTCUSDT-1m-2019-05-reviewed",
                source_period="2019-05-15",
                source_url="https://data.binance.vision/reviewed.zip",
                source_content_sha256="sha256:" + "7" * 64,
                source_provider_checksum="sha256:" + "7" * 64,
            )
        ],
    )
    database = tmp_path / "verified-halt.db"

    async def start_service() -> ReplayService:
        instance = ReplayService(
            settings=replace(
                replay_settings(database),
            ),
            store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
            repository=ReplayHistoryRepository(root),
            now_ms=lambda: NOW_MS,
            session_id_factory=SessionIdFactory("halt-session"),
            training_run_id_factory=SessionIdFactory("halt-run"),
            native_intervals=lambda _identity: ("1m",),
        )
        await instance.start()
        return instance

    service = await start_service()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=3 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v3",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Verified Binance halt",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "5m",
                "requested_start_ms": halt_start_ms - 5 * INTERVAL_MS,
                "indicator_warmup_bars": 2,
                "visible_history_lookback": {
                    "mode": "ALL_AVAILABLE",
                    "duration_ms": None,
                },
                "forward_cache_ms": 3 * INTERVAL_MS,
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        session_id = str(created["run"]["adapter_session_id"])

        persisted = await service.store.load_dataset(session_id)
        assert persisted is not None
        bundle = json.loads(bytes(persisted["snapshot_blob"]).decode("utf-8"))
        manifest = bundle["paging_manifest"]
        assert manifest["schema_version"] == "replay-paged-bar-manifest.v3"
        assert manifest["terminal_kind"] == "SOURCE_LATEST_CLOSED"
        assert manifest["verified_market_halts"] == [
            {
                "schema_version": "replay-bar-halt.v2",
                "halt_id": "binance-system-upgrade-2019-05-15",
                "start_open_ms": halt_start_ms,
                "end_open_ms": resume_ms - INTERVAL_MS,
                "resume_ms": resume_ms,
                "reason": "exchange_scheduled_system_upgrade",
                "boundary_source": "binance_spot_klines_bracketed_gap.v1",
                "evidence": [
                    {
                        "role": "maintenance_notice",
                        "url": (
                            "https://www.binance.com/en/support/articles/"
                            "360028054052"
                        ),
                    },
                    {
                        "role": "official_klines_boundary",
                        "url": (
                            "https://api.binance.com/api/v3/klines?"
                            "symbol=BTCUSDT&interval=1m&"
                            "startTime=1557889140000&endTime=1557925200000&"
                            "limit=1000"
                        ),
                    },
                ],
            }
        ]

        def command(
            command_id: str,
            command_type: CommandType,
            revision: int,
            payload: dict[str, object] | None = None,
        ) -> ReplayCommand:
            return ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id=command_id,
                client_instance_id="halt-browser",
                expected_revision=revision,
                type=command_type,
                payload=payload or {},
            )

        await service.command(
            session_id,
            command("acquire-halt", CommandType.ACQUIRE_CONTROLLER, 0),
        )
        before_halt = await service.command(
            session_id,
            command("step-to-halt", CommandType.STEP, 1, {"count": 5}),
        )
        assert before_halt["state"] == "PAUSED"
        assert before_halt["cursor"]["source_sequence"] == 5
        assert before_halt["cursor"]["at_end"] is False
        assert before_halt["cursor"]["last_base_bar_open_ms"] == (
            halt_start_ms - INTERVAL_MS
        )

        inside_halt = await service.command(
            session_id,
            command(
                "advance-inside-halt",
                CommandType.ADVANCE_BY,
                2,
                {"ms": 4 * 60 * INTERVAL_MS},
            ),
        )
        assert inside_halt["state"] == "PAUSED"
        assert inside_halt["data"]["consumed"] == 0
        assert inside_halt["cursor"]["source_sequence"] == 5
        assert inside_halt["cursor"]["virtual_time_ms"] == (
            halt_start_ms - 1 + 4 * 60 * INTERVAL_MS
        )

        resumed = await service.command(
            session_id,
            command("step-first-resume", CommandType.STEP, 3, {"count": 1}),
        )
        assert resumed["state"] == "PAUSED"
        assert resumed["cursor"]["source_sequence"] == 6
        assert resumed["cursor"]["last_base_bar_open_ms"] == resume_ms
        snapshot = (await service.get_session(session_id))["snapshot"]
        builder = snapshot["components"]["bar_builder"]
        assert builder["gap_policy"] == "verified_market_halts_v2"
        assert builder["replay_events_applied"] == 6
        assert [bar["open_time_ms"] for bar in builder["closed_bars"][-2:]] == [
            halt_start_ms - INTERVAL_MS,
            resume_ms,
        ]
    finally:
        await service.shutdown(step_timeout=1.0)

    recovered = await start_service()
    try:
        snapshot = (await recovered.get_session(session_id))["snapshot"]
        assert snapshot["state"] == "PAUSED"
        assert snapshot["cursor"]["source_sequence"] == 6
        assert snapshot["cursor"]["last_base_bar_open_ms"] == resume_ms
    finally:
        await recovered.shutdown(step_timeout=1.0)


@pytest.mark.anyio
async def test_bar_selection_starts_after_unverified_gap_and_ends_at_real_tail(
    tmp_path: Path,
) -> None:
    root = tmp_path / "unverified-gap-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [*range(0, 10), *range(11, 21)],
                price_base=100,
                source_key="fixture-unverified-future-gap",
                digest_character="8",
            )
        ],
    )
    database = tmp_path / "unverified-gap.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        repository=ReplayHistoryRepository(root),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("unverified-gap-session"),
        training_run_id_factory=SessionIdFactory("unverified-gap-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=3 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        early_request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v3",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Unverified future gap",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "requested_start_ms": START_MS + 5 * INTERVAL_MS,
                "indicator_warmup_bars": 2,
                "visible_history_lookback": {
                    "mode": "ALL_AVAILABLE",
                    "duration_ms": None,
                },
                "forward_cache_ms": 3 * INTERVAL_MS,
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        assert service.training is not None
        with pytest.raises(TrainingRunError) as early_rejected:
            await service.training.create_run(early_request)
        assert early_rejected.value.code == "MARKET_UNSUPPORTED_AT_COMMITTED_START"
        assert early_rejected.value.details["reason"] == "NO_ELIGIBLE_WINDOW"

        reachable_floor_ms = START_MS + 13 * INTERVAL_MS
        random_payload = early_request.to_dict()
        random_payload.update(
            {
                "start_mode": "RANDOM",
                "requested_start_ms": None,
            }
        )
        for seed in range(32):
            random_request = TrainingRunCreateRequest.from_dict(
                {**random_payload, "random_seed": seed}
            )
            random_config = service.training._adapter_config(random_request)
            selection = await service.select_training_window(
                random_config,
                expected_catalog_epoch=catalog["catalog_epoch"],
            )
            assert int(selection["selected_start_ms"]) >= reachable_floor_ms
            assert selection["bar_terminal_kind"] == "SOURCE_LATEST_CLOSED"
            assert selection["continuous_future_end_ms"] == (
                START_MS + 20 * INTERVAL_MS
            )

        valid_request = TrainingRunCreateRequest.from_dict(
            {
                **early_request.to_dict(),
                "name": "Reachable post-gap tail",
                "requested_start_ms": reachable_floor_ms,
            }
        )
        created = await service.training.create_run(valid_request)
        session_id = str(created["run"]["adapter_session_id"])

        persisted = await service.store.load_dataset(session_id)
        assert persisted is not None
        bundle = json.loads(bytes(persisted["snapshot_blob"]).decode("utf-8"))
        paging_manifest = bundle["paging_manifest"]
        assert paging_manifest["source_revision"] == manifest.catalog_epoch
        assert paging_manifest["terminal_open_ms"] == START_MS + 20 * INTERVAL_MS
        assert paging_manifest["terminal_kind"] == "SOURCE_LATEST_CLOSED"
        assert paging_manifest["schema_version"] == "replay-paged-bar-manifest.v3"
        assert paging_manifest["verified_market_halts"] == []

        await service.command(
            session_id,
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="acquire-reachable-tail",
                client_instance_id="unverified-gap-browser",
                expected_revision=0,
                type=CommandType.ACQUIRE_CONTROLLER,
                payload={},
            ),
        )
        before_latest = await service.command(
            session_id,
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="step-before-real-tail",
                client_instance_id="unverified-gap-browser",
                expected_revision=1,
                type=CommandType.STEP,
                payload={"count": 7},
            ),
        )
        assert before_latest["state"] == "PAUSED"
        assert before_latest["cursor"]["at_end"] is False
        assert before_latest["cursor"]["last_base_bar_open_ms"] == (
            START_MS + 19 * INTERVAL_MS
        )

        ended = await service.command(
            session_id,
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id="step-real-tail",
                client_instance_id="unverified-gap-browser",
                expected_revision=2,
                type=CommandType.STEP,
                payload={"count": 1},
            ),
        )
        assert ended["state"] == "ENDED"
        assert ended["cursor"]["at_end"] is True
        assert ended["cursor"]["last_base_bar_open_ms"] == (
            START_MS + 20 * INTERVAL_MS
        )
    finally:
        await service.shutdown(step_timeout=1.0)


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


def test_unavailable_remote_index_rejects_new_catalog_but_keeps_pinned_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
                source_key="fixture-unavailable-index",
                digest_character="9",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    cache = tmp_path / "cache"
    repository = RemoteReplayHistoryRepository(
        cache,
        origin,
        refresh_seconds=0,
    )
    assert repository.list_all_series()
    expected = repository.query_bars_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "1m",
        start_ms=START_MS,
        end_ms=START_MS + INTERVAL_MS,
        exchange="binance",
        market_type="spot",
    )

    def unavailable(*_args, **_kwargs):
        raise ReplayHistoryOriginUnavailable(
            "remote replay-history origin is unavailable"
        )

    monkeypatch.setattr(repository.origin, "read_json", unavailable)
    monkeypatch.setattr(repository.origin, "fetch_object", unavailable)
    with pytest.raises(ReplayHistoryOriginUnavailable, match="unavailable"):
        repository.list_all_series()

    # Existing Runs address an immutable revision, not the mutable current
    # index.  Once its manifest/object are cached it remains reproducible while
    # freshness-sensitive catalog discovery is rejected.
    assert repository.query_bars_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "1m",
        start_ms=START_MS,
        end_ms=START_MS + INTERVAL_MS,
        exchange="binance",
        market_type="spot",
    ) == expected

    cold = RemoteReplayHistoryRepository(cache, origin, refresh_seconds=0)
    monkeypatch.setattr(cold.origin, "read_json", unavailable)
    monkeypatch.setattr(cold.origin, "fetch_object", unavailable)
    with pytest.raises(ReplayHistoryOriginUnavailable, match="unavailable"):
        cold.list_all_series()
    assert cold.query_bars_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "1m",
        start_ms=START_MS,
        end_ms=START_MS + INTERVAL_MS,
        exchange="binance",
        market_type="spot",
    ) == expected


@pytest.mark.anyio
async def test_service_maps_unavailable_remote_catalog_to_503_domain_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    origin = tmp_path / "service-origin"
    writer = ReplayHistoryArchiveWriter(origin, now_ms=lambda: NOW_MS)
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(10)),
                price_base=100,
                source_key="fixture-service-unavailable-index",
                digest_character="a",
            )
        ],
    )
    publish_remote_history_index(origin, now_ms=NOW_MS)
    repository = RemoteReplayHistoryRepository(
        tmp_path / "service-cache",
        origin,
        refresh_seconds=0,
    )
    database = tmp_path / "service-unavailable-index.db"
    service = ReplayService(
        settings=replay_settings(database),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        repository=repository,
        now_ms=lambda: NOW_MS,
    )
    await service.start()
    try:
        assert (
            await service.catalog(
                warmup_bars=1,
                horizon_ms=2 * INTERVAL_MS,
                quality_mode="exact",
                blind_mode=False,
            )
        )["entries"]

        def unavailable(*_args, **_kwargs):
            raise ReplayHistoryOriginUnavailable(
                "remote replay-history origin is unavailable"
            )

        monkeypatch.setattr(repository.origin, "read_json", unavailable)
        monkeypatch.setattr(repository.origin, "fetch_object", unavailable)

        with pytest.raises(ReplayDomainError) as visible_error:
            await service.catalog(
                warmup_bars=1,
                horizon_ms=2 * INTERVAL_MS,
                quality_mode="exact",
                blind_mode=False,
            )
        assert visible_error.value.code is ReplayErrorCode.ARCHIVE_DEGRADED
        assert visible_error.value.message == "replay history catalog is unavailable"

        with pytest.raises(ReplayDomainError) as blind_error:
            await service.catalog(
                warmup_bars=1,
                horizon_ms=2 * INTERVAL_MS,
                quality_mode="exact",
                blind_mode=True,
            )
        assert blind_error.value.code is ReplayErrorCode.ARCHIVE_DEGRADED
        assert blind_error.value.details == {"blind_redacted": True}
    finally:
        await service.shutdown(step_timeout=1.0)


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


def test_archive_blind_weekly_projection_keeps_native_monday_buckets(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-history-native-week"
    monday_ms = int(datetime(2024, 3, 4, tzinfo=timezone.utc).timestamp() * 1_000)
    rows = [
        make_bar(
            monday_ms + offset * INTERVAL_MS,
            price=str(100 + offset),
            source="binance_archive_verified",
        )
        for offset in range(2 * 7 * 24 * 60)
    ]
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            ReplayHistoryImportBatch(
                rows=rows,
                source_provider="binance-public-kline-v1",
                source_object_key="fixture-two-native-weeks",
                source_period="2024-03",
                source_url="https://data.binance.vision/native-week.zip",
                source_content_sha256=f"sha256:{'6' * 64}",
                source_provider_checksum=f"sha256:{'6' * 64}",
            )
        ],
    )
    repository = ReplayHistoryRepository(root)
    actual_replay_start_ms = monday_ms + (2 * 24 * 60 + 11 * 60 + 50) * INTERVAL_MS
    public_replay_start_ms = int(
        datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp() * 1_000
    )

    projected = repository.query_source_bucket_bars_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "1m",
        "1w",
        actual_start_ms=monday_ms,
        actual_end_ms=monday_ms + 2 * 7 * 24 * 60 * INTERVAL_MS,
        actual_replay_start_ms=actual_replay_start_ms,
        public_replay_start_ms=public_replay_start_ms,
        limit=10,
        exchange="binance",
        market_type="spot",
    )

    bars = projected["bars"]
    assert len(bars) == 2
    assert bars[0]["open"] == "100"
    assert bars[0]["close"] == "10179.5"
    assert bars[0]["component_count"] == 10_080
    assert bars[1]["open"] == "10180"
    assert bars[1]["close"] == "20259.5"
    assert bars[1]["open_time_ms"] - bars[0]["open_time_ms"] == 7 * 86_400_000
    assert str(monday_ms) not in json.dumps(projected, sort_keys=True)


@pytest.mark.anyio
async def test_aligned_initial_display_projection_survives_service_recovery(
    tmp_path: Path,
) -> None:
    root = tmp_path / "aligned-initial-display-history"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(20)),
                price_base=100,
                source_key="fixture-aligned-initial-display",
                digest_character="2",
            )
        ],
    )
    database = tmp_path / "aligned-initial-display.db"

    async def start_service() -> ReplayService:
        instance = ReplayService(
            settings=replace(
                replay_settings(database),
                replay_history_archive_dir=root,
            ),
            store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
            now_ms=lambda: NOW_MS,
            session_id_factory=SessionIdFactory("aligned-display-session"),
            training_run_id_factory=SessionIdFactory("aligned-display-run"),
            # Keep 5m off the native catalog so this exercises the same
            # revision-bound 1m fallback as futures archives without 5m data.
            native_intervals=lambda _identity: ("1m",),
        )
        await instance.start()
        return instance

    service = await start_service()
    try:
        catalog = await service.catalog(
            warmup_bars=5,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=False,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v3",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Aligned initial display projection",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1m",
                "requested_start_ms": START_MS + 10 * INTERVAL_MS,
                "indicator_warmup_bars": 5,
                "visible_history_lookback": {
                    "mode": "ALL_AVAILABLE",
                    "duration_ms": None,
                },
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        assert service.training is not None
        created = await service.training.create_run(request)
        session_id = str(created["run"]["adapter_session_id"])
        snapshot = (await service.get_session(session_id))["snapshot"]
        replay_start_ms = int(
            snapshot["components"]["bar_builder"]["replay_start_ms"]
        )
        assert replay_start_ms % (5 * INTERVAL_MS) == 0

        async def initial_projection(instance: ReplayService) -> dict[str, object]:
            assert instance.training is not None
            current = (await instance.get_session(session_id))["snapshot"]
            return await instance.training.display_projection(
                session_id,
                track_id="track-1",
                revealed_boundary_ms=int(current["cursor"]["virtual_time_ms"]),
                limit=500,
                data_epoch=str(current["data_epoch"]),
                display_interval="5m",
            )

        first = await initial_projection(service)
        assert first["has_more"] is False
        assert [bar["open_time_ms"] for bar in first["bars"]] == [
            replay_start_ms - 5 * INTERVAL_MS
        ]
        assert first["bars"][0]["last_base_open_ms"] == (
            replay_start_ms - INTERVAL_MS
        )
        assert first["bars"][0]["component_count"] == 5
        assert first["bars"][0]["is_closed"] is True
    finally:
        await service.shutdown(step_timeout=1.0)

    recovered = await start_service()
    try:
        recovered_projection = await initial_projection(recovered)
        assert recovered_projection["bars"] == first["bars"]
    finally:
        await recovered.shutdown(step_timeout=1.0)


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
    persisted_bar_ref, _ = ReplayService._persisted_extension_dataset(pinned, None)
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
        BarDatasetSnapshot.from_dict(pinned.to_dict()).data_epoch == pinned.data_epoch
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
                "protocol": "replay.v3",
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
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
            connection.execute("SAVEPOINT retired_schema_probe")
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
            assert legacy_pin is None

            connection.execute(
                """
                UPDATE replay_training_schema_version
                SET version = 9
                WHERE singleton = 1
                """
            )
            with pytest.raises(
                RuntimeError,
                match="schema 9 is obsolete.*clear replay training data",
            ):
                migrate_training_schema(connection, now_ms=NOW_MS)

            connection.execute("ROLLBACK TO retired_schema_probe")
            connection.execute("RELEASE retired_schema_probe")
            restored_pin = connection.execute(
                "SELECT source_revision FROM replay_archive_pin"
            ).fetchone()
        assert restored_pin is not None
        assert restored_pin["source_revision"] == (
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
                "protocol": "replay.v3",
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
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


@pytest.mark.anyio
async def test_all_available_history_pins_native_display_revision_before_seam(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-native-display"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    base_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [offset for offset in range(30) if offset not in range(5, 10)],
                price_base=100,
                source_key="fixture-base-gap",
                digest_character="a",
            )
        ],
    )
    native_manifest = writer.import_batches(
        IDENTITY,
        "5m",
        [
            _native_interval_batch(
                [0, 5, 10, 15],
                interval="5m",
                interval_ms=5 * INTERVAL_MS,
                price_base=1_000,
                source_key="fixture-native-5m-v1",
                digest_character="b",
            )
        ],
    )
    database = tmp_path / "replay-native-display.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            replay_history_archive_dir=root,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("native-session"),
        training_run_id_factory=SessionIdFactory("native-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=True,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v3",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Pinned native display history",
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
                "time_disclosure_policy": "HIDE_ALL",
                "book_mode": "OFF",
                "margin_mode": "CROSS",
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        training = service.training
        assert training is not None
        await training.create_run(request)
        repository = service.history_repository
        original_scan_gaps = repository.scan_gaps_at_revision
        continuity_scans = 0

        def counted_scan_gaps(*args: object, **kwargs: object) -> dict[str, object]:
            nonlocal continuity_scans
            continuity_scans += 1
            return original_scan_gaps(*args, **kwargs)

        repository.scan_gaps_at_revision = counted_scan_gaps  # type: ignore[method-assign]
        session = await service.get_session("native-session-1")
        snapshot = session["snapshot"]
        public_replay_start_ms = int(
            snapshot["components"]["bar_builder"]["replay_start_ms"]
        )
        page = await training.history_page(
            "native-session-1",
            track_id="track-1",
            before_ms=public_replay_start_ms,
            revealed_boundary_ms=int(snapshot["cursor"]["virtual_time_ms"]),
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=None,
            display_interval="5m",
        )

        assert [bar["open_time_ms"] for bar in page["bars"]] == [
            public_replay_start_ms - offset * INTERVAL_MS for offset in (20, 15, 10, 5)
        ]
        assert [bar["open"] for bar in page["bars"]] == [
            "1000",
            "1005",
            "1010",
            "1015",
        ]
        assert page["excluded_ranges"] == []
        proof_scan_count = continuity_scans
        assert proof_scan_count >= 1

        replacement_manifest = writer.import_batches(
            IDENTITY,
            "5m",
            [
                _native_interval_batch(
                    [0, 5, 10, 15],
                    interval="5m",
                    interval_ms=5 * INTERVAL_MS,
                    price_base=2_000,
                    source_key="fixture-native-5m-v2",
                    digest_character="c",
                )
            ],
            merge_current=False,
        )
        assert replacement_manifest.catalog_epoch != native_manifest.catalog_epoch

        repeated = await training.history_page(
            "native-session-1",
            track_id="track-1",
            before_ms=public_replay_start_ms,
            revealed_boundary_ms=int(snapshot["cursor"]["virtual_time_ms"]),
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=str(page["history_epoch"]),
            display_interval="5m",
        )
        assert repeated["history_epoch"] == page["history_epoch"]
        assert repeated["bars"] == page["bars"]
        assert continuity_scans == proof_scan_count

        connection = sqlite3.connect(database)
        try:
            pins = connection.execute(
                """
                SELECT base_interval, source_revision
                FROM replay_archive_pin
                ORDER BY base_interval
                """
            ).fetchall()
        finally:
            connection.close()
        assert pins == [
            ("1m", base_manifest.catalog_epoch),
            ("5m", native_manifest.catalog_epoch),
        ]
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.anyio
async def test_weekly_native_gap_fails_before_pin_then_accepts_continuous_revision(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-native-weekly-gap"
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: NOW_MS)
    base_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(30)),
                price_base=100,
                source_key="fixture-base-1m",
                digest_character="d",
            )
        ],
    )
    week_ms = 7 * 24 * 60 * INTERVAL_MS
    replay_start_ms = START_MS + 20 * INTERVAL_MS
    current_week_open_ms = compute_bucket_start_ms(
        replay_start_ms,
        week_ms,
        interval="1w",
    )
    last_complete_week_open_ms = current_week_open_ms - week_ms
    weekly_open_times = [
        last_complete_week_open_ms - offset * week_ms for offset in range(4, -1, -1)
    ]
    weekly_offsets = [
        (open_time_ms - START_MS) // INTERVAL_MS for open_time_ms in weekly_open_times
    ]
    gappy_manifest = writer.import_batches(
        IDENTITY,
        "1w",
        [
            _native_interval_batch(
                [offset for index, offset in enumerate(weekly_offsets) if index != 2],
                interval="1w",
                interval_ms=week_ms,
                price_base=100_000,
                source_key="fixture-native-1w-gappy",
                digest_character="e",
            )
        ],
    )
    database = tmp_path / "replay-native-weekly-gap.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            replay_history_archive_dir=root,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: NOW_MS),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("weekly-gap-session"),
        training_run_id_factory=SessionIdFactory("weekly-gap-run"),
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
                "protocol": "replay.v3",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Fail closed gappy weekly history",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1w",
                "requested_start_ms": replay_start_ms,
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
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        training = service.training
        assert training is not None
        await training.create_run(request)
        session = await service.get_session("weekly-gap-session-1")
        snapshot = session["snapshot"]
        revealed_boundary_ms = int(snapshot["cursor"]["virtual_time_ms"])

        with pytest.raises(TrainingRunError) as failed:
            await training.history_page(
                "weekly-gap-session-1",
                track_id="track-1",
                before_ms=replay_start_ms,
                revealed_boundary_ms=revealed_boundary_ms,
                limit=10,
                data_epoch=str(snapshot["data_epoch"]),
                history_epoch=None,
                display_interval="1w",
            )
        assert failed.value.code == "HISTORY_SOURCE_INCOMPLETE"
        assert failed.value.status_code == 503

        with sqlite3.connect(database) as connection:
            pins_after_failure = connection.execute(
                """
                SELECT base_interval, source_revision
                FROM replay_archive_pin
                ORDER BY base_interval
                """
            ).fetchall()
        assert pins_after_failure == [("1m", base_manifest.catalog_epoch)]

        continuous_manifest = writer.import_batches(
            IDENTITY,
            "1w",
            [
                _native_interval_batch(
                    weekly_offsets,
                    interval="1w",
                    interval_ms=week_ms,
                    price_base=200_000,
                    source_key="fixture-native-1w-continuous",
                    digest_character="f",
                )
            ],
            merge_current=False,
        )
        assert continuous_manifest.catalog_epoch != gappy_manifest.catalog_epoch

        page = await training.history_page(
            "weekly-gap-session-1",
            track_id="track-1",
            before_ms=replay_start_ms,
            revealed_boundary_ms=revealed_boundary_ms,
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=None,
            display_interval="1w",
        )
        assert [bar["open_time_ms"] for bar in page["bars"]] == weekly_open_times
        assert page["excluded_ranges"] == []

        with sqlite3.connect(database) as connection:
            pins_after_recovery = connection.execute(
                """
                SELECT base_interval, source_revision
                FROM replay_archive_pin
                ORDER BY base_interval
                """
            ).fetchall()
        assert pins_after_recovery == [
            ("1m", base_manifest.catalog_epoch),
            ("1w", continuous_manifest.catalog_epoch),
        ]
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.anyio
async def test_blind_native_daily_history_uses_source_bucket_ordinal_mapping(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-native-daily-phase"
    day_ms = 24 * 60 * INTERVAL_MS
    replay_start_ms = START_MS + 2 * day_ms + 20 * INTERVAL_MS
    fixture_now_ms = replay_start_ms + 30 * INTERVAL_MS
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: fixture_now_ms)
    base_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(2 * 24 * 60 + 31)),
                price_base=100,
                source_key="fixture-daily-phase-base-1m",
                digest_character="1",
            )
        ],
    )
    actual_daily_anchor_ms = compute_bucket_start_ms(
        replay_start_ms,
        day_ms,
        interval="1d",
    )
    native_daily_open_times = [
        actual_daily_anchor_ms - 2 * day_ms,
        actual_daily_anchor_ms - day_ms,
    ]
    native_daily_offsets = [
        (open_time_ms - START_MS) // INTERVAL_MS
        for open_time_ms in native_daily_open_times
    ]
    native_manifest = writer.import_batches(
        IDENTITY,
        "1d",
        [
            _native_interval_batch(
                native_daily_offsets,
                interval="1d",
                interval_ms=day_ms,
                price_base=100_000,
                source_key="fixture-native-1d-phase",
                digest_character="2",
            )
        ],
    )
    database = tmp_path / "replay-native-daily-phase.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            replay_history_archive_dir=root,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: fixture_now_ms),
        now_ms=lambda: fixture_now_ms,
        session_id_factory=SessionIdFactory("daily-phase-session"),
        training_run_id_factory=SessionIdFactory("daily-phase-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=True,
        )
        request = TrainingRunCreateRequest.from_dict(
            {
                "protocol": "replay.v3",
                "catalog_epoch": catalog["catalog_epoch"],
                "name": "Blind native daily phase mapping",
                "source_kind": "BAR",
                "start_mode": "MANUAL",
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "settlement_asset": "USDT",
                "base_interval": "1m",
                "display_interval": "1d",
                "requested_start_ms": replay_start_ms,
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
                "time_disclosure_policy": "HIDE_ALL",
                "book_mode": "OFF",
                "margin_mode": "CROSS",
                "position_mode": "ONE_WAY",
                "account_data_mode": "APPROX_PROXY",
                "funding_mode": "OFF",
                "allow_rule_changes": False,
            }
        )
        training = service.training
        assert training is not None
        await training.create_run(request)
        session = await service.get_session("daily-phase-session-1")
        snapshot = session["snapshot"]
        public_replay_start_ms = int(
            snapshot["components"]["bar_builder"]["replay_start_ms"]
        )
        mapper = SourceBucketTimeMapper.create(
            interval="1d",
            actual_replay_start_ms=replay_start_ms,
            public_replay_start_ms=public_replay_start_ms,
        )
        public_calendar_anchor_ms = compute_bucket_start_ms(
            public_replay_start_ms,
            day_ms,
            interval="1d",
        )
        assert (
            replay_start_ms - mapper.actual_anchor_ms
            != public_replay_start_ms - public_calendar_anchor_ms
        )
        assert mapper.public_anchor_ms != public_calendar_anchor_ms
        expected_public_open_times = [
            mapper.public_from_actual(open_time_ms)
            for open_time_ms in native_daily_open_times
        ]

        page = await training.history_page(
            "daily-phase-session-1",
            track_id="track-1",
            before_ms=public_replay_start_ms,
            revealed_boundary_ms=int(snapshot["cursor"]["virtual_time_ms"]),
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=None,
            display_interval="1d",
        )

        assert [bar["open_time_ms"] for bar in page["bars"]] == (
            expected_public_open_times
        )
        assert [bar["open"] for bar in page["bars"]] == [
            str(100_000 + offset) for offset in native_daily_offsets
        ]
        assert page["excluded_ranges"] == []
        with sqlite3.connect(database) as connection:
            pins = connection.execute(
                """
                SELECT base_interval, source_revision
                FROM replay_archive_pin
                ORDER BY base_interval
                """
            ).fetchall()
        assert pins == [
            ("1d", native_manifest.catalog_epoch),
            ("1m", base_manifest.catalog_epoch),
        ]
    finally:
        await service.shutdown(step_timeout=1.0)


@pytest.mark.anyio
async def test_duration_projection_uses_pinned_three_day_source_phase(
    tmp_path: Path,
) -> None:
    root = tmp_path / "replay-native-three-day-phase"
    day_ms = 24 * 60 * INTERVAL_MS
    three_day_ms = 3 * day_ms
    replay_start_ms = START_MS + 20 * INTERVAL_MS
    fixture_now_ms = replay_start_ms + 30 * INTERVAL_MS
    source_anchor_ms = day_ms
    mapper_for_source = SourceBucketTimeMapper.create(
        interval="3d",
        actual_replay_start_ms=replay_start_ms,
        public_replay_start_ms=946_684_800_000,
        source_bucket_anchor_ms=source_anchor_ms,
    )
    writer = ReplayHistoryArchiveWriter(root, now_ms=lambda: fixture_now_ms)
    base_start_offset = (mapper_for_source.actual_anchor_ms - START_MS) // INTERVAL_MS
    base_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                list(range(base_start_offset, 31)),
                price_base=100_000,
                source_key="fixture-three-day-phase-base-1m",
                digest_character="3",
            )
        ],
    )
    last_complete_open_ms = mapper_for_source.actual_bucket_open(-1)
    native_offset = (last_complete_open_ms - START_MS) // INTERVAL_MS
    native_manifest = writer.import_batches(
        IDENTITY,
        "3d",
        [
            replace(
                _native_interval_batch(
                    [native_offset],
                    interval="3d",
                    interval_ms=three_day_ms,
                    price_base=300_000,
                    source_key="fixture-native-3d-phase",
                    digest_character="4",
                ),
                alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
                source_bucket_anchor_ms=source_anchor_ms,
            )
        ],
        alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
        source_bucket_anchor_ms=source_anchor_ms,
    )
    database = tmp_path / "replay-native-three-day-phase.db"
    service = ReplayService(
        settings=replace(
            replay_settings(database),
            replay_history_archive_dir=root,
        ),
        store=ReplaySQLiteStore(database, now_ms=lambda: fixture_now_ms),
        now_ms=lambda: fixture_now_ms,
        session_id_factory=SessionIdFactory("three-day-phase-session"),
        training_run_id_factory=SessionIdFactory("three-day-phase-run"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=True,
        )
        request_payload = {
            "protocol": "replay.v3",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": "Duration three-day phase projection",
            "source_kind": "BAR",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "3d",
            "requested_start_ms": replay_start_ms,
            "warmup_bars": 2,
            "forward_cache_ms": 5 * INTERVAL_MS,
            "random_seed": 42,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "HIDE_ALL",
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "position_mode": "ONE_WAY",
            "account_data_mode": "APPROX_PROXY",
            "funding_mode": "OFF",
            "allow_rule_changes": False,
        }
        request = TrainingRunCreateRequest.from_dict(request_payload)
        training = service.training
        assert training is not None
        created = await training.create_run(request)
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])

        def command(
            command_id: str,
            command_type: ReplayV2CommandType,
            session: dict[str, object],
            payload: dict[str, object],
        ) -> ReplayV2Command:
            snapshot = session["snapshot"]
            assert isinstance(snapshot, dict)
            cursor = snapshot["cursor"]
            assert isinstance(cursor, dict)
            revision = int(snapshot["revision"])
            return ReplayV2Command(
                protocol="replay.v3",
                run_id=run_id,
                command_id=command_id,
                client_instance_id="three-day-phase-browser",
                expected_revision=revision,
                expected_cursor=TrainingCursor(
                    virtual_time_ms=int(cursor["virtual_time_ms"]),
                    source_sequence=int(cursor["source_sequence"]),
                    revision=revision,
                ),
                type=command_type,
                payload=payload,
            )

        session = await service.get_session(session_id)
        await training.command(
            run_id,
            command(
                "acquire-three-day-phase",
                ReplayV2CommandType.ACQUIRE_CONTROLLER,
                session,
                {"takeover": False},
            ),
        )
        session = await service.get_session(session_id)
        await training.command(
            run_id,
            command(
                "step-three-day-phase",
                ReplayV2CommandType.STEP_BASE,
                session,
                {"count": 2},
            ),
        )
        session = await service.get_session(session_id)
        snapshot = session["snapshot"]
        assert isinstance(snapshot, dict)
        public_replay_start_ms = int(
            snapshot["components"]["bar_builder"]["replay_start_ms"]
        )
        expected_mapper = SourceBucketTimeMapper.create(
            interval="3d",
            actual_replay_start_ms=replay_start_ms,
            public_replay_start_ms=public_replay_start_ms,
            source_bucket_anchor_ms=source_anchor_ms,
        )
        canonical_mapper = SourceBucketTimeMapper.create(
            interval="3d",
            actual_replay_start_ms=replay_start_ms,
            public_replay_start_ms=public_replay_start_ms,
        )
        assert expected_mapper.public_anchor_ms != canonical_mapper.public_anchor_ms

        projection = await training.display_projection(
            session_id,
            track_id="track-1",
            revealed_boundary_ms=int(snapshot["cursor"]["virtual_time_ms"]),
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            display_interval="3d",
        )

        assert projection["bars"], {
            "cursor": snapshot["cursor"],
            "public_replay_start_ms": public_replay_start_ms,
            "projection": projection,
        }
        assert [bar["open_time_ms"] for bar in projection["bars"]] == [
            expected_mapper.public_anchor_ms
        ]
        assert projection["bars"][0]["is_closed"] is False
        assert "source_bucket_anchor_ms" not in json.dumps(projection)
        with sqlite3.connect(database) as connection:
            pins = connection.execute(
                """
                SELECT base_interval, source_revision
                FROM replay_archive_pin
                ORDER BY base_interval
                """
            ).fetchall()
        assert pins == [
            ("1m", base_manifest.catalog_epoch),
            ("3d", native_manifest.catalog_epoch),
        ]

        all_available_payload = {
            **request_payload,
            "name": "All-available three-day seam",
            "indicator_warmup_bars": 2,
            "visible_history_lookback": {
                "mode": "ALL_AVAILABLE",
                "duration_ms": None,
            },
        }
        all_available_payload.pop("warmup_bars")
        created = await training.create_run(
            TrainingRunCreateRequest.from_dict(all_available_payload)
        )
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        session = await service.get_session(session_id)
        await training.command(
            run_id,
            command(
                "acquire-three-day-seam",
                ReplayV2CommandType.ACQUIRE_CONTROLLER,
                session,
                {"takeover": False},
            ),
        )
        session = await service.get_session(session_id)
        await training.command(
            run_id,
            command(
                "step-three-day-seam",
                ReplayV2CommandType.STEP_BASE,
                session,
                {"count": 2},
            ),
        )
        session = await service.get_session(session_id)
        snapshot = session["snapshot"]
        assert isinstance(snapshot, dict)
        public_replay_start_ms = int(
            snapshot["components"]["bar_builder"]["replay_start_ms"]
        )
        seam_mapper = SourceBucketTimeMapper.create(
            interval="3d",
            actual_replay_start_ms=replay_start_ms,
            public_replay_start_ms=public_replay_start_ms,
            source_bucket_anchor_ms=source_anchor_ms,
        )
        projection = await training.display_projection(
            session_id,
            track_id="track-1",
            revealed_boundary_ms=int(snapshot["cursor"]["virtual_time_ms"]),
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            display_interval="3d",
        )
        history = await training.history_page(
            session_id,
            track_id="track-1",
            before_ms=seam_mapper.public_anchor_ms,
            revealed_boundary_ms=int(snapshot["cursor"]["virtual_time_ms"]),
            limit=10,
            data_epoch=str(snapshot["data_epoch"]),
            history_epoch=None,
            display_interval="3d",
        )

        assert history["excluded_ranges"] == []
        assert [bar["open_time_ms"] for bar in history["bars"]] == [
            seam_mapper.public_bucket_open(-1)
        ]
        assert [bar["open_time_ms"] for bar in projection["bars"]] == [
            seam_mapper.public_anchor_ms
        ]
        assert (
            history["bars"][-1]["close_time_ms"] + 1
            == projection["bars"][0]["open_time_ms"]
        )
    finally:
        await service.shutdown(step_timeout=1.0)
