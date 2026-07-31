from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.catalog import ReplayCatalog, ReplaySeriesIdentity
from app.replay.dataset import BarDatasetBuilder, BarDatasetSnapshot
from app.replay.history_archive import (
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
    ReplayHistoryRepository,
)
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from app.replay.training.models import TrainingRunCreateRequest
from tests.fixtures.replay.fakes import make_bar
from tests.fixtures.replay.service_fakes import SessionIdFactory, replay_settings


INTERVAL_MS = 60_000
START_MS = 1_710_000_000_000
NOW_MS = START_MS + 30 * INTERVAL_MS
IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")


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
