from __future__ import annotations

import io
import zipfile
from datetime import datetime, timezone

import pytest

from app.exchanges.archive import ArchiveDataError
from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider
from app.replay.catalog import ReplaySeriesIdentity
from app.replay.display_time import SourceBucketTimeMapper
from app.replay.history_archive import (
    REPLAY_HISTORY_CATALOG_SCHEMA_VERSION,
    REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2,
    SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
    SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
    ReplayHistoryArchiveError,
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
    ReplayHistoryRepository,
)
from app.replay.remote_history import (
    ReplayRemoteCatalogIndex,
    publish_remote_history_index,
)


IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")
DAY_MS = 86_400_000
THREE_DAY_MS = 3 * DAY_MS


def _ms(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1_000)


def _row(open_ms: int, close_ms: int, price: float) -> dict[str, object]:
    return {
        "open_time": open_ms,
        "close_time": close_ms,
        "open": price,
        "high": price + 2,
        "low": price - 1,
        "close": price + 1,
        "volume": price * 10,
        "quote_volume": price * 100,
        "trades": int(price),
        "taker_buy_base": price * 4,
        "taker_buy_quote": price * 40,
        "source": "binance_archive_verified",
    }


def _batch(
    rows: list[dict[str, object]],
    *,
    source_key: str,
    alignment_policy: str | None = None,
    source_bucket_anchor_ms: int | None = None,
) -> ReplayHistoryImportBatch:
    return ReplayHistoryImportBatch(
        rows=rows,
        source_provider="binance-public-kline-v1",
        source_object_key=source_key,
        source_period=source_key,
        source_url=f"https://data.binance.vision/{source_key}.zip",
        source_content_sha256="sha256:" + "a" * 64,
        source_provider_checksum="sha256:" + "b" * 64,
        alignment_policy=alignment_policy,
        source_bucket_anchor_ms=source_bucket_anchor_ms,
    )


def test_v1_catalog_round_trip_keeps_legacy_hash_shape(tmp_path) -> None:
    minute_ms = 60_000
    start_ms = _ms("2024-01-01T00:00:00")
    writer = ReplayHistoryArchiveWriter(tmp_path, now_ms=lambda: start_ms + minute_ms)
    manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [
                    _row(start_ms, start_ms + minute_ms - 1, 100),
                    _row(start_ms + minute_ms, start_ms + 2 * minute_ms - 1, 101),
                ],
                source_key="legacy-v1",
            )
        ],
    )

    payload = manifest.to_dict()
    assert manifest.schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION
    assert "source_bucket_anchor_ms" not in payload
    assert "alignment_policy" not in payload
    assert writer.current_manifest(IDENTITY, "1m") == manifest


def test_catalog_anchored_three_day_grid_is_hash_bound_and_gap_aware(
    tmp_path,
) -> None:
    source_open_ms = _ms("2017-08-17T00:00:00")
    source_phase_ms = source_open_ms % THREE_DAY_MS
    opens = [
        source_open_ms,
        source_open_ms + THREE_DAY_MS,
        source_open_ms + 3 * THREE_DAY_MS,
    ]
    writer = ReplayHistoryArchiveWriter(
        tmp_path,
        now_ms=lambda: source_open_ms + 10 * THREE_DAY_MS,
    )
    manifest = writer.import_batches(
        IDENTITY,
        "3d",
        [
            _batch(
                [
                    _row(open_ms, open_ms + THREE_DAY_MS - 1, 100 + index)
                    for index, open_ms in enumerate(opens)
                ],
                source_key="native-3d",
                alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
                source_bucket_anchor_ms=source_phase_ms,
            )
        ],
    )

    assert manifest.schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
    assert manifest.source_bucket_anchor_ms == DAY_MS
    assert manifest.alignment_policy == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED
    assert manifest.to_dict()["source_bucket_anchor_ms"] == DAY_MS
    repository = ReplayHistoryRepository(tmp_path)
    bounds = repository.get_bounds_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "3d",
        exchange="binance",
        market_type="spot",
    )
    assert bounds["source_bucket_anchor_ms"] == DAY_MS
    gaps = repository.scan_gaps_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "3d",
        start_ms=source_open_ms,
        end_ms=source_open_ms + 3 * THREE_DAY_MS,
        exchange="binance",
        market_type="spot",
    )
    assert gaps["gaps"] == [
        {
            "start_ms": source_open_ms + 2 * THREE_DAY_MS,
            "end_ms": source_open_ms + 2 * THREE_DAY_MS,
            "missing_bars": 1,
            "reason": "replay_archive_gap",
            "status": "detected",
        }
    ]
    drift_open_ms = source_open_ms + 13 * DAY_MS
    with pytest.raises(ReplayHistoryArchiveError, match="misaligned"):
        writer.import_batches(
            IDENTITY,
            "3d",
            [
                _batch(
                    [
                        _row(
                            drift_open_ms,
                            drift_open_ms + THREE_DAY_MS - 1,
                            200,
                        )
                    ],
                    source_key="native-3d-phase-drift",
                    alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
                    source_bucket_anchor_ms=drift_open_ms % THREE_DAY_MS,
                )
            ],
        )
    assert writer.current_manifest(IDENTITY, "3d") == manifest


def test_source_bucket_aggregation_and_cache_are_bound_to_three_day_phase(
    tmp_path,
) -> None:
    source_open_ms = _ms("2017-08-17T00:00:00")
    public_replay_start_ms = _ms("2024-01-10T00:00:00")
    writer = ReplayHistoryArchiveWriter(
        tmp_path,
        now_ms=lambda: source_open_ms + 20 * DAY_MS,
    )
    base_manifest = writer.import_batches(
        IDENTITY,
        "1d",
        [
            _batch(
                [
                    _row(open_ms, open_ms + DAY_MS - 1, 100 + index)
                    for index, open_ms in enumerate(
                        source_open_ms + index * DAY_MS for index in range(6)
                    )
                ],
                source_key="base-1d",
            )
        ],
    )
    repository = ReplayHistoryRepository(tmp_path)
    common = {
        "source_revision": base_manifest.catalog_epoch,
        "symbol": "BTCUSDT",
        "base_interval": "1d",
        "display_interval": "3d",
        "actual_start_ms": source_open_ms,
        "actual_end_ms": source_open_ms + 6 * DAY_MS,
        "actual_replay_start_ms": source_open_ms + 4 * DAY_MS,
        "public_replay_start_ms": public_replay_start_ms,
        "limit": 10,
        "exchange": "binance",
        "market_type": "spot",
    }
    anchored = repository.query_source_bucket_bars_at_revision(
        **common,
        source_bucket_anchor_ms=DAY_MS,
    )
    canonical = repository.query_source_bucket_bars_at_revision(
        **common,
        source_bucket_anchor_ms=0,
    )

    assert len(anchored["bars"]) == 2
    assert len(canonical["bars"]) == 1
    mapper = SourceBucketTimeMapper.create(
        interval="3d",
        actual_replay_start_ms=common["actual_replay_start_ms"],
        public_replay_start_ms=public_replay_start_ms,
        source_bucket_anchor_ms=DAY_MS,
    )
    assert [bar["open_time_ms"] for bar in anchored["bars"]] == [
        mapper.public_from_actual(source_open_ms),
        mapper.public_from_actual(source_open_ms + THREE_DAY_MS),
    ]
    cache_files = list((tmp_path / "derived-cache" / "source-bucket-v2").rglob("*.json.zlib"))
    assert len(cache_files) == 2


def test_calendar_month_manifest_uses_calendar_successors_for_segments_and_gaps(
    tmp_path,
) -> None:
    january = _ms("2024-01-01T00:00:00")
    february = _ms("2024-02-01T00:00:00")
    march = _ms("2024-03-01T00:00:00")
    april = _ms("2024-04-01T00:00:00")
    may = _ms("2024-05-01T00:00:00")
    writer = ReplayHistoryArchiveWriter(tmp_path, now_ms=lambda: may)
    manifest = writer.import_batches(
        IDENTITY,
        "1M",
        [
            _batch(
                [
                    _row(january, february - 1, 100),
                    _row(february, march - 1, 101),
                    _row(april, may - 1, 103),
                ],
                source_key="native-1M",
                alignment_policy=SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
                source_bucket_anchor_ms=0,
            )
        ],
    )

    assert manifest.schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
    assert [(item.start_ms, item.end_ms, item.row_count) for item in manifest.segments] == [
        (january, february, 2),
        (april, april, 1),
    ]
    repository = ReplayHistoryRepository(tmp_path)
    gaps = repository.scan_gaps_at_revision(
        manifest.catalog_epoch,
        "BTCUSDT",
        "1M",
        start_ms=january,
        end_ms=april,
        exchange="binance",
        market_type="spot",
    )
    assert gaps["gaps"] == [
        {
            "start_ms": march,
            "end_ms": march,
            "missing_bars": 1,
            "reason": "replay_archive_gap",
            "status": "detected",
        }
    ]
    summary = repository.describe_catalog(
        "BTCUSDT",
        "1M",
        exchange="binance",
        market_type="spot",
        source_revision=manifest.catalog_epoch,
    )
    assert summary["expected_grid_rows"] == 4
    assert summary["missing_grid_rows"] == 1


def test_minute_and_calendar_month_catalog_paths_are_casefold_safe_end_to_end(
    tmp_path,
) -> None:
    minute_ms = 60_000
    january = _ms("2024-01-01T00:00:00")
    february = _ms("2024-02-01T00:00:00")
    writer = ReplayHistoryArchiveWriter(tmp_path, now_ms=lambda: february)
    minute = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [_row(january, january + minute_ms - 1, 100)],
                source_key="native-1m",
            )
        ],
    )
    month = writer.import_batches(
        IDENTITY,
        "1M",
        [
            _batch(
                [_row(january, february - 1, 200)],
                source_key="native-1M",
                alignment_policy=SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
                source_bucket_anchor_ms=0,
            )
        ],
    )

    series_root = tmp_path / "catalogs" / "binance" / "spot" / "BTCUSDT"
    minute_dir = series_root / "1m"
    month_dir = series_root / "1mo"
    assert minute_dir.name.casefold() != month_dir.name.casefold()
    assert (minute_dir / "current.json").is_file()
    assert (month_dir / "current.json").is_file()
    assert writer.current_manifest(IDENTITY, "1m") == minute
    assert writer.current_manifest(IDENTITY, "1M") == month

    repository = ReplayHistoryRepository(tmp_path)
    assert {
        (item["interval"], item["source_revision"])
        for item in repository.list_all_series()
    } == {
        ("1m", minute.catalog_epoch),
        ("1M", month.catalog_epoch),
    }
    assert repository.get_bounds_at_revision(
        minute.catalog_epoch,
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    )["source_revision"] == minute.catalog_epoch
    assert repository.get_bounds_at_revision(
        month.catalog_epoch,
        "BTCUSDT",
        "1M",
        exchange="binance",
        market_type="spot",
    )["source_revision"] == month.catalog_epoch

    remote_index = publish_remote_history_index(tmp_path, now_ms=february)
    assert ReplayRemoteCatalogIndex.from_dict(remote_index.to_dict()) == remote_index
    assert {
        (item.interval, item.manifest_path)
        for item in remote_index.catalogs
    } == {
        (
            "1m",
            "catalogs/binance/spot/BTCUSDT/1m/"
            f"{minute.catalog_epoch.removeprefix('sha256:')}.json",
        ),
        (
            "1M",
            "catalogs/binance/spot/BTCUSDT/1mo/"
            f"{month.catalog_epoch.removeprefix('sha256:')}.json",
        ),
    }
    gc_report = writer.collect_garbage(
        pinned_revisions=(minute.catalog_epoch, month.catalog_epoch),
        dry_run=True,
    )
    assert gc_report["kept_object_count"] == 2


def test_binance_replay_parser_accepts_off_epoch_native_three_day_rows(
    tmp_path,
) -> None:
    provider = BinanceKlineArchiveProvider()
    month_start = _ms("2017-08-01T00:00:00")
    month_end = _ms("2017-09-01T00:00:00")
    refs = provider.plan_objects(
        market_type="spot",
        symbol="BTCUSDT",
        interval="3d",
        start_ms=month_start,
        end_ms=month_end - 1,
        now_ms=_ms("2017-11-01T00:00:00"),
    )
    ref = next(item for item in refs if item.period == "2017-08")
    source_open_ms = _ms("2017-08-17T00:00:00")
    csv_row = (
        f"{source_open_ms},100,110,90,105,1.5,"
        f"{source_open_ms + THREE_DAY_MS - 1},157.5,10,0.75,78.75,0\n"
    )
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(ref.expected_filename[:-4] + ".csv", csv_row)
    archive_path = tmp_path / ref.expected_filename
    archive_path.write_bytes(payload.getvalue())

    parsed = provider.parse_bars_for_replay(archive_path, ref)
    assert [bar.open_time for bar in parsed.bars] == [source_open_ms]
    assert parsed.rejected_row_count == 0
    assert parsed.rejection_reasons == ()

    drift_open_ms = source_open_ms + 4 * DAY_MS
    mixed_rows = csv_row + (
        f"{drift_open_ms},105,115,95,110,2.5,"
        f"{drift_open_ms + THREE_DAY_MS - 1},260,12,1.25,130,0\n"
    )
    mixed_payload = io.BytesIO()
    with zipfile.ZipFile(mixed_payload, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(ref.expected_filename[:-4] + ".csv", mixed_rows)
    archive_path.write_bytes(mixed_payload.getvalue())
    with pytest.raises(ArchiveDataError, match="mixes source bucket phases"):
        provider.parse_bars_for_replay(archive_path, ref)
