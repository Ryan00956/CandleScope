from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.replay.canonical import canonical_sha256
from app.replay.catalog import ReplaySeriesIdentity
from app.replay.dataset import (
    BAR_DATASET_SCHEMA_VERSION,
    BarDatasetProvenance,
    BarDatasetSnapshot,
    ReplayBar,
)
from app.replay.history_archive import (
    SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
    SOURCE_BUCKET_ALIGNMENT_CANONICAL,
    SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
    ReplayHistoryRepository,
)
from app.replay.display_time import SourceBucketTimeMapper
from app.replay.training.history import build_display_projection, build_history_page
from tests.fixtures.replay.fakes import make_bar
from tests.fixtures.replay.service_fakes import replay_config


MINUTE_MS = 60_000
HOUR_MS = 60 * MINUTE_MS
DAY_MS = 24 * HOUR_MS
DISPLAY_INTERVAL = "15m"
DISPLAY_MS = 15 * MINUTE_MS
ANCHOR_MS = 1_704_067_200_000  # 2024-01-01T00:00:00Z
IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")


def _ms(value: str) -> int:
    return int(
        datetime.fromisoformat(value)
        .replace(tzinfo=timezone.utc)
        .timestamp()
        * 1_000
    )


def _batch(
    rows: list[dict[str, object]],
    *,
    source_key: str,
    digest_character: str,
    alignment_policy: str | None = None,
    source_bucket_anchor_ms: int | None = None,
) -> ReplayHistoryImportBatch:
    return ReplayHistoryImportBatch(
        rows=rows,
        source_provider="binance-public-kline-v1",
        source_object_key=source_key,
        source_period=source_key,
        source_url=f"https://data.binance.vision/{source_key}.zip",
        source_content_sha256=f"sha256:{digest_character * 64}",
        source_provider_checksum=f"sha256:{digest_character * 64}",
        alignment_policy=alignment_policy,
        source_bucket_anchor_ms=source_bucket_anchor_ms,
    )


def _snapshot(
    *,
    source_revision: str,
    replay_start_ms: int,
) -> BarDatasetSnapshot:
    rows = tuple(
        ReplayBar.from_dict(
            {
                "open_time_ms": ANCHOR_MS + offset * MINUTE_MS,
                "close_time_ms": ANCHOR_MS + (offset + 1) * MINUTE_MS - 1,
                "open": str(100 + offset),
                "high": str(101 + offset),
                "low": str(99 + offset),
                "close": str(100.5 + offset),
                "volume": "10",
                "quote_volume": "1005",
                "trades": 7,
                "taker_buy_base": "4",
                "taker_buy_quote": "402",
                "source": "binance_archive_verified",
            }
        )
        for offset in range(8, 21)
    )
    provenance = BarDatasetProvenance(
        repository_backend="replay_history_archive",
        identity=IDENTITY,
        interval="1m",
        source_fingerprint=source_revision,
        catalog_epoch=source_revision,
        source_earliest_open_ms=ANCHOR_MS,
        source_latest_open_ms=ANCHOR_MS + 20 * MINUTE_MS,
        source_latest_closed_open_ms=ANCHOR_MS + 20 * MINUTE_MS,
        row_count=20,
        first_open_ms=rows[0].open_time_ms,
        last_open_ms=rows[-1].open_time_ms,
        gap_count=1,
        gap_scan_bars=20,
        calendar_id="UTC",
        hash_schema="replay-bar-dataset-hash.v1",
        source_revision=source_revision,
    )
    unhashed = BarDatasetSnapshot(
        schema_version=BAR_DATASET_SCHEMA_VERSION,
        data_epoch="sha256:" + "0" * 64,
        identity=IDENTITY,
        interval="1m",
        rows=rows,
        warmup_bars=2,
        replay_start_index=2,
        replay_start_ms=replay_start_ms,
        replay_end_open_ms=rows[-1].open_time_ms,
        provenance=provenance,
        estimated_size_bytes=1,
    )
    return replace(unhashed, data_epoch=canonical_sha256(unhashed.hash_payload()))


def _snapshot_for_rows(
    *,
    source_revision: str,
    base_interval: str,
    base_interval_ms: int,
    replay_start_ms: int,
    row_opens: list[int],
    source_earliest_open_ms: int,
    source_latest_open_ms: int,
    gap_count: int,
) -> BarDatasetSnapshot:
    replay_start_index = row_opens.index(replay_start_ms)
    rows = tuple(
        ReplayBar.from_dict(
            {
                "open_time_ms": open_time_ms,
                "close_time_ms": open_time_ms + base_interval_ms - 1,
                "open": str(100 + index),
                "high": str(101 + index),
                "low": str(99 + index),
                "close": str(100.5 + index),
                "volume": "10",
                "quote_volume": "1005",
                "trades": 7,
                "taker_buy_base": "4",
                "taker_buy_quote": "402",
                "source": "binance_archive_verified",
            }
        )
        for index, open_time_ms in enumerate(row_opens)
    )
    provenance = BarDatasetProvenance(
        repository_backend="replay_history_archive",
        identity=IDENTITY,
        interval=base_interval,
        source_fingerprint=source_revision,
        catalog_epoch=source_revision,
        source_earliest_open_ms=source_earliest_open_ms,
        source_latest_open_ms=source_latest_open_ms,
        source_latest_closed_open_ms=source_latest_open_ms,
        row_count=len(row_opens),
        first_open_ms=rows[0].open_time_ms,
        last_open_ms=rows[-1].open_time_ms,
        gap_count=gap_count,
        gap_scan_bars=len(row_opens),
        calendar_id="UTC",
        hash_schema="replay-bar-dataset-hash.v1",
        source_revision=source_revision,
    )
    unhashed = BarDatasetSnapshot(
        schema_version=BAR_DATASET_SCHEMA_VERSION,
        data_epoch="sha256:" + "0" * 64,
        identity=IDENTITY,
        interval=base_interval,
        rows=rows,
        warmup_bars=replay_start_index,
        replay_start_index=replay_start_index,
        replay_start_ms=replay_start_ms,
        replay_end_open_ms=rows[-1].open_time_ms,
        provenance=provenance,
        estimated_size_bytes=1,
    )
    return replace(unhashed, data_epoch=canonical_sha256(unhashed.hash_payload()))


def _grid_binding(
    *,
    snapshot: BarDatasetSnapshot,
    config: object,
    display_interval: str,
    display_source_revision: str,
    source_bucket_anchor_ms: int,
    alignment_policy: str,
    durable_boundary_ms: int,
) -> dict[str, object]:
    config_payload = config.to_dict()  # type: ignore[attr-defined]
    commitment = canonical_sha256(
        {
            "schema_version": "replay.display-source-grid.v1",
            "source_revision": display_source_revision,
            "display_interval": display_interval,
            "source_bucket_anchor_ms": source_bucket_anchor_ms,
            "alignment_policy": alignment_policy,
        }
    )
    return {
        "run_id": "run-1",
        "session_id": "session-1",
        "track_id": "track-1",
        "primary_adapter_session_id": "session-1",
        "track_dataset_epoch": snapshot.data_epoch,
        "session_data_epoch": snapshot.data_epoch,
        "run_dataset_epoch": snapshot.data_epoch,
        "virtual_time_ms": durable_boundary_ms,
        "degraded_reason": None,
        "config": config_payload,
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "source_kind": "BAR",
        "base_interval": snapshot.interval,
        "display_interval": display_interval,
        "display_source_revision": display_source_revision,
        "display_source_bucket_anchor_ms": source_bucket_anchor_ms,
        "display_alignment_policy": alignment_policy,
        "display_grid_commitment": commitment,
    }


def _persisted(
    snapshot: BarDatasetSnapshot,
    *,
    actual_replay_start_ms: int,
    synthetic_origin_ms: int | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "data_epoch": snapshot.data_epoch,
        "snapshot_blob": json.dumps(snapshot.to_dict()).encode("utf-8"),
        "actual_replay_start_ms": actual_replay_start_ms,
    }
    if synthetic_origin_ms is not None:
        payload["synthetic_origin_ms"] = synthetic_origin_ms
    return payload


def test_projection_uses_pinned_native_bar_only_after_gap_bucket_is_closed(
    tmp_path: Path,
) -> None:
    root = tmp_path / "archive"
    writer = ReplayHistoryArchiveWriter(
        root,
        now_ms=lambda: ANCHOR_MS + 30 * MINUTE_MS,
    )
    # Minute 1 is deliberately absent.  It is before replay_start_ms, so the
    # execution snapshot remains contiguous, but it makes reconstruction of
    # the seam's first 15m display bucket impossible from the base revision.
    base_offsets = [0, *range(2, 21)]
    base_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [
                    make_bar(
                        ANCHOR_MS + offset * MINUTE_MS,
                        price=str(100 + offset),
                        source="binance_archive_verified",
                    )
                    for offset in base_offsets
                ],
                source_key="base-1m-with-pre-seam-gap",
                digest_character="a",
            )
        ],
    )
    native_values = {
        "open": 900.0,
        "high": 950.0,
        "low": 850.0,
        "close": 925.0,
        "volume": 1_234.0,
        "quote_volume": 1_111_111.0,
        "trades": 987_654,
        "taker_buy_base": 600.0,
        "taker_buy_quote": 555_555.0,
    }
    native_manifest = writer.import_batches(
        IDENTITY,
        DISPLAY_INTERVAL,
        [
            _batch(
                [
                    {
                        "exchange": "binance",
                        "market_type": "spot",
                        "symbol": "BTCUSDT",
                        "interval": DISPLAY_INTERVAL,
                        "open_time": ANCHOR_MS,
                        "close_time": ANCHOR_MS + DISPLAY_MS - 1,
                        **native_values,
                        "source": "binance_archive_verified",
                    }
                ],
                source_key="native-15m-complete",
                digest_character="b",
                alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
                source_bucket_anchor_ms=0,
            )
        ],
        alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
        source_bucket_anchor_ms=0,
    )
    assert native_manifest.source_bucket_anchor_ms == 0
    assert native_manifest.alignment_policy == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED

    replay_start_ms = ANCHOR_MS + 10 * MINUTE_MS
    snapshot = _snapshot(
        source_revision=base_manifest.catalog_epoch,
        replay_start_ms=replay_start_ms,
    )
    config = replace(
        replay_config(),
        display_interval=DISPLAY_INTERVAL,
        requested_start_ms=replay_start_ms,
        warmup_bars=2,
        horizon_ms=11 * MINUTE_MS,
    )
    display_grid_commitment = canonical_sha256(
        {
            "schema_version": "replay.display-source-grid.v1",
            "source_revision": native_manifest.catalog_epoch,
            "display_interval": DISPLAY_INTERVAL,
            "source_bucket_anchor_ms": 0,
            "alignment_policy": SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
        }
    )
    closed_boundary_ms = ANCHOR_MS + DISPLAY_MS - 1
    binding: dict[str, object] = {
        "run_id": "run-1",
        "session_id": "session-1",
        "track_id": "track-1",
        "primary_adapter_session_id": "session-1",
        "track_dataset_epoch": snapshot.data_epoch,
        "session_data_epoch": snapshot.data_epoch,
        "run_dataset_epoch": snapshot.data_epoch,
        "virtual_time_ms": closed_boundary_ms,
        "degraded_reason": None,
        "config": config.to_dict(),
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "source_kind": "BAR",
        "base_interval": "1m",
        "display_interval": DISPLAY_INTERVAL,
        "display_source_revision": native_manifest.catalog_epoch,
        "display_source_bucket_anchor_ms": 0,
        "display_alignment_policy": SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
        "display_grid_commitment": display_grid_commitment,
    }
    persisted: dict[str, object] = {
        "data_epoch": snapshot.data_epoch,
        "snapshot_blob": json.dumps(snapshot.to_dict()).encode("utf-8"),
        "actual_replay_start_ms": replay_start_ms,
    }
    repository = ReplayHistoryRepository(root)

    in_progress = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=replay_start_ms + MINUTE_MS - 1,
        limit=10,
        data_epoch=snapshot.data_epoch,
        display_interval=DISPLAY_INTERVAL,
        repository=repository,
    )
    # The pinned native candle contains the future high/low/close for the full
    # bucket.  It must remain unreadable while even one component is unrevealed.
    for bar in in_progress["bars"]:
        assert bar["high"] != "950"
        assert bar["low"] != "850"
        assert bar["close"] != "925"
        assert bar["volume"] != "1234"
        assert bar["trades"] != native_values["trades"]
    assert all(bar["is_closed"] is False for bar in in_progress["bars"])

    closed = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=closed_boundary_ms,
        limit=10,
        data_epoch=snapshot.data_epoch,
        display_interval=DISPLAY_INTERVAL,
        repository=repository,
    )

    assert len(closed["bars"]) == 1
    bar = closed["bars"][0]
    assert bar == {
        "open_time_ms": ANCHOR_MS,
        "close_time_ms": ANCHOR_MS + DISPLAY_MS - 1,
        "open": "900",
        "high": "950",
        "low": "850",
        "close": "925",
        "volume": "1234",
        "quote_volume": "1111111",
        "trades": 987_654,
        "taker_buy_base": "600",
        "taker_buy_quote": "555555",
        "first_base_open_ms": ANCHOR_MS,
        "last_base_open_ms": ANCHOR_MS + 14 * MINUTE_MS,
        "component_count": 15,
        "expected_components": 15,
        "is_closed": True,
        "synthetic": False,
    }


@pytest.mark.parametrize(
    (
        "display_interval",
        "base_interval",
        "base_interval_ms",
        "source_anchor_ms",
        "alignment_policy",
    ),
    [
        pytest.param(
            "1d",
            "1h",
            HOUR_MS,
            0,
            SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
            id="daily-utc",
        ),
        pytest.param(
            "3d",
            "1d",
            DAY_MS,
            DAY_MS,
            SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
            id="three-day-source-phase",
        ),
        pytest.param(
            "1w",
            "1d",
            DAY_MS,
            -3 * DAY_MS,
            SOURCE_BUCKET_ALIGNMENT_CANONICAL,
            id="weekly-monday",
        ),
    ],
)
def test_fixed_native_grids_fill_seam_and_keep_limit_has_more(
    tmp_path: Path,
    display_interval: str,
    base_interval: str,
    base_interval_ms: int,
    source_anchor_ms: int,
    alignment_policy: str,
) -> None:
    display_ms_by_interval = {
        "1d": DAY_MS,
        "3d": 3 * DAY_MS,
        "1w": 7 * DAY_MS,
    }
    display_ms = display_ms_by_interval[display_interval]
    components = display_ms // base_interval_ms
    actual_anchor_ms = (
        source_anchor_ms
        + ((ANCHOR_MS - source_anchor_ms) // display_ms) * display_ms
    )
    if display_interval == "3d":
        assert actual_anchor_ms % display_ms == DAY_MS
    if display_interval == "1w":
        assert datetime.fromtimestamp(
            actual_anchor_ms / 1_000,
            tz=timezone.utc,
        ).weekday() == 0

    root = tmp_path / "archive"
    actual_end_ms = actual_anchor_ms + 2 * display_ms
    writer = ReplayHistoryArchiveWriter(
        root,
        now_ms=lambda: actual_end_ms + base_interval_ms,
    )
    # Keep a complete preceding bucket, omit only component zero of the seam
    # bucket, then retain a complete following bucket.
    base_offsets = [*range(-components, 0), *range(1, 2 * components)]
    base_manifest = writer.import_batches(
        IDENTITY,
        base_interval,
        [
            _batch(
                [
                    {
                        **make_bar(
                            actual_anchor_ms + offset * base_interval_ms,
                            interval_ms=base_interval_ms,
                            price=str(200 + offset),
                            source="binance_archive_verified",
                        ),
                        "interval": base_interval,
                    }
                    for offset in base_offsets
                ],
                source_key=f"base-{base_interval}-gap-for-{display_interval}",
                digest_character="c",
            )
        ],
    )
    native_manifest = writer.import_batches(
        IDENTITY,
        display_interval,
        [
            _batch(
                [
                    {
                        "exchange": "binance",
                        "market_type": "spot",
                        "symbol": "BTCUSDT",
                        "interval": display_interval,
                        "open_time": actual_anchor_ms + ordinal * display_ms,
                        "close_time": (
                            actual_anchor_ms + (ordinal + 1) * display_ms - 1
                        ),
                        "open": 900.0 + ordinal,
                        "high": 950.0 + ordinal,
                        "low": 850.0 + ordinal,
                        "close": 925.0 + ordinal,
                        "volume": 1_234.0 + ordinal,
                        "quote_volume": 1_111_111.0 + ordinal,
                        "trades": 987_654 + ordinal,
                        "taker_buy_base": 600.0 + ordinal,
                        "taker_buy_quote": 555_555.0 + ordinal,
                        "source": "binance_archive_verified",
                    }
                    for ordinal in range(2)
                ],
                source_key=f"native-{display_interval}-seam",
                digest_character="d",
                alignment_policy=alignment_policy,
                source_bucket_anchor_ms=source_anchor_ms,
            )
        ],
        alignment_policy=alignment_policy,
        source_bucket_anchor_ms=source_anchor_ms,
    )
    replay_start_ms = actual_anchor_ms + 2 * base_interval_ms
    row_opens = [
        actual_anchor_ms + offset * base_interval_ms
        for offset in range(1, 2 * components)
    ]
    snapshot = _snapshot_for_rows(
        source_revision=base_manifest.catalog_epoch,
        base_interval=base_interval,
        base_interval_ms=base_interval_ms,
        replay_start_ms=replay_start_ms,
        row_opens=row_opens,
        source_earliest_open_ms=actual_anchor_ms - display_ms,
        source_latest_open_ms=row_opens[-1],
        gap_count=1,
    )
    config = replace(
        replay_config(),
        base_interval=base_interval,
        display_interval=display_interval,
        requested_start_ms=replay_start_ms,
        warmup_bars=1,
        horizon_ms=actual_end_ms - replay_start_ms,
    )
    binding = _grid_binding(
        snapshot=snapshot,
        config=config,
        display_interval=display_interval,
        display_source_revision=native_manifest.catalog_epoch,
        source_bucket_anchor_ms=source_anchor_ms,
        alignment_policy=alignment_policy,
        durable_boundary_ms=actual_end_ms - 1,
    )
    persisted = _persisted(
        snapshot,
        actual_replay_start_ms=replay_start_ms,
    )
    repository = ReplayHistoryRepository(root)
    mapper = SourceBucketTimeMapper.create(
        interval=display_interval,
        actual_replay_start_ms=replay_start_ms,
        public_replay_start_ms=snapshot.replay_start_ms,
        source_bucket_anchor_ms=source_anchor_ms,
    )

    complete = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=actual_end_ms - 1,
        limit=2,
        data_epoch=snapshot.data_epoch,
        display_interval=display_interval,
        repository=repository,
    )

    assert [bar["open_time_ms"] for bar in complete["bars"]] == [
        mapper.public_bucket_open(0),
        mapper.public_bucket_open(1),
    ]
    native = complete["bars"][0]
    assert native["trades"] == 987_654
    assert native["component_count"] == components
    assert native["expected_components"] == components
    assert native["is_closed"] is True
    assert complete["bars"][1]["trades"] == 987_655

    tail = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=actual_end_ms - 1,
        limit=1,
        data_epoch=snapshot.data_epoch,
        display_interval=display_interval,
        repository=repository,
    )

    assert [bar["open_time_ms"] for bar in tail["bars"]] == [
        mapper.public_bucket_open(1)
    ]
    assert tail["has_more"] is True


def test_calendar_month_seam_is_causal_native_exact_and_history_contiguous(
    tmp_path: Path,
) -> None:
    actual_history_start_ms = _ms("2023-12-01T00:00:00")
    actual_january_ms = _ms("2024-01-01T00:00:00")
    actual_anchor_ms = _ms("2024-02-01T00:00:00")
    actual_replay_start_ms = _ms("2024-02-20T00:00:00")
    actual_end_ms = _ms("2024-03-01T00:00:00")
    public_replay_start_ms = _ms("2001-03-20T00:00:00")
    mapper = SourceBucketTimeMapper.create(
        interval="1M",
        actual_replay_start_ms=actual_replay_start_ms,
        public_replay_start_ms=public_replay_start_ms,
        source_bucket_anchor_ms=0,
    )
    assert mapper.actual_anchor_ms == actual_anchor_ms
    assert mapper.public_anchor_ms == _ms("2001-02-01T00:00:00")
    assert mapper.actual_bucket_end(actual_anchor_ms) - actual_anchor_ms == 29 * DAY_MS
    assert (
        mapper.public_bucket_end(mapper.public_anchor_ms) - mapper.public_anchor_ms
        == 28 * DAY_MS
    )

    root = tmp_path / "archive"
    writer = ReplayHistoryArchiveWriter(
        root,
        now_ms=lambda: _ms("2024-04-01T00:00:00"),
    )
    all_daily_opens = list(
        range(actual_history_start_ms, actual_end_ms, DAY_MS)
    )
    missing_daily_open_ms = _ms("2024-02-02T00:00:00")
    base_opens = [
        open_time_ms
        for open_time_ms in all_daily_opens
        if open_time_ms != missing_daily_open_ms
    ]
    base_manifest = writer.import_batches(
        IDENTITY,
        "1d",
        [
            _batch(
                [
                    {
                        **make_bar(
                            open_time_ms,
                            interval_ms=DAY_MS,
                            price=str(200 + index),
                            source="binance_archive_verified",
                        ),
                        "interval": "1d",
                    }
                    for index, open_time_ms in enumerate(base_opens)
                ],
                source_key="base-1d-calendar-month-gap",
                digest_character="e",
            )
        ],
    )
    monthly_specs = [
        (actual_history_start_ms, actual_january_ms, 700),
        (actual_january_ms, actual_anchor_ms, 800),
        (actual_anchor_ms, actual_end_ms, 900),
    ]
    native_manifest = writer.import_batches(
        IDENTITY,
        "1M",
        [
            _batch(
                [
                    {
                        "exchange": "binance",
                        "market_type": "spot",
                        "symbol": "BTCUSDT",
                        "interval": "1M",
                        "open_time": open_time_ms,
                        "close_time": next_open_time_ms - 1,
                        "open": float(price),
                        "high": float(price + 50),
                        "low": float(price - 50),
                        "close": float(price + 25),
                        "volume": float(price + 334),
                        "quote_volume": float(price * 1_000 + 111),
                        "trades": 987_000 + price,
                        "taker_buy_base": float(price - 300),
                        "taker_buy_quote": float(price * 500 + 555),
                        "source": "binance_archive_verified",
                    }
                    for open_time_ms, next_open_time_ms, price in monthly_specs
                ],
                source_key="native-1M-history-and-seam",
                digest_character="f",
                alignment_policy=SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
                source_bucket_anchor_ms=0,
            )
        ],
        alignment_policy=SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
        source_bucket_anchor_ms=0,
    )

    snapshot_opens = list(
        range(_ms("2024-02-18T00:00:00"), actual_end_ms, DAY_MS)
    )
    snapshot = _snapshot_for_rows(
        source_revision=base_manifest.catalog_epoch,
        base_interval="1d",
        base_interval_ms=DAY_MS,
        replay_start_ms=actual_replay_start_ms,
        row_opens=snapshot_opens,
        source_earliest_open_ms=actual_history_start_ms,
        source_latest_open_ms=snapshot_opens[-1],
        gap_count=1,
    )
    config = replace(
        replay_config(blind_mode=True),
        base_interval="1d",
        display_interval="1M",
        requested_start_ms=actual_replay_start_ms,
        warmup_bars=2,
        horizon_ms=actual_end_ms - actual_replay_start_ms,
    )
    closed_boundary_ms = (
        public_replay_start_ms + actual_end_ms - actual_replay_start_ms - 1
    )
    binding = _grid_binding(
        snapshot=snapshot,
        config=config,
        display_interval="1M",
        display_source_revision=native_manifest.catalog_epoch,
        source_bucket_anchor_ms=0,
        alignment_policy=SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH,
        durable_boundary_ms=closed_boundary_ms,
    )
    binding["history_policy"] = {
        "schema_version": "replay.data-policy.v1",
        "indicator_warmup_bars": 2,
        "visible_history_lookback": {
            "mode": "ALL_AVAILABLE",
            "duration_ms": None,
        },
        "visible_history_rows": len(base_opens),
        "actual_visible_history_start_ms": actual_history_start_ms,
        "actual_replay_start_ms": actual_replay_start_ms,
        "effective_warmup_bars": 2,
        "forward_cache_ms": actual_end_ms - actual_replay_start_ms,
        "interval_ms": DAY_MS,
        "policy_hash": "sha256:" + "9" * 64,
    }
    persisted = _persisted(
        snapshot,
        actual_replay_start_ms=actual_replay_start_ms,
        synthetic_origin_ms=public_replay_start_ms,
    )
    repository = ReplayHistoryRepository(root)

    in_progress_boundary_ms = public_replay_start_ms + DAY_MS - 1
    in_progress = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=in_progress_boundary_ms,
        limit=10,
        data_epoch=snapshot.data_epoch,
        display_interval="1M",
        repository=repository,
    )
    for bar in in_progress["bars"]:
        assert bar["high"] != "950"
        assert bar["low"] != "850"
        assert bar["close"] != "925"
        assert bar["trades"] != 987_900
        assert bar["is_closed"] is False

    projection = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=closed_boundary_ms,
        limit=10,
        data_epoch=snapshot.data_epoch,
        display_interval="1M",
        repository=repository,
    )

    assert len(projection["bars"]) == 1
    projected = projection["bars"][0]
    assert projected == {
        "open_time_ms": mapper.public_anchor_ms,
        "close_time_ms": mapper.public_bucket_end(mapper.public_anchor_ms) - 1,
        "open": "900",
        "high": "950",
        "low": "850",
        "close": "925",
        "volume": "1234",
        "quote_volume": "900111",
        "trades": 987_900,
        "taker_buy_base": "600",
        "taker_buy_quote": "450555",
        "first_base_open_ms": mapper.public_anchor_ms,
        "last_base_open_ms": mapper.public_bucket_end(mapper.public_anchor_ms)
        - DAY_MS,
        "component_count": 28,
        "expected_components": 28,
        "is_closed": True,
        "synthetic": False,
    }

    history = build_history_page(
        binding=binding,
        persisted=persisted,
        before_ms=projected["open_time_ms"],
        revealed_boundary_ms=closed_boundary_ms,
        limit=10,
        data_epoch=snapshot.data_epoch,
        expected_history_epoch=None,
        display_interval="1M",
        repository=repository,
    )

    assert history["excluded_ranges"] == []
    assert [bar["open"] for bar in history["bars"]] == ["700", "800"]
    assert history["bars"][-1]["close_time_ms"] + 1 == projected["open_time_ms"]


def test_closed_projection_prefers_native_rounding_over_complete_base_aggregate(
    tmp_path: Path,
) -> None:
    anchor_ms = _ms("2024-01-01T00:00:00")
    replay_start_ms = anchor_ms + 10 * MINUTE_MS
    actual_end_ms = anchor_ms + DISPLAY_MS
    root = tmp_path / "archive"
    writer = ReplayHistoryArchiveWriter(
        root,
        now_ms=lambda: actual_end_ms + MINUTE_MS,
    )
    base_manifest = writer.import_batches(
        IDENTITY,
        "1m",
        [
            _batch(
                [
                    make_bar(
                        anchor_ms + offset * MINUTE_MS,
                        price=str(100 + offset),
                        source="binance_archive_verified",
                    )
                    for offset in range(15)
                ],
                source_key="complete-base-1m-for-native-rounding",
                digest_character="1",
            )
        ],
    )
    native_manifest = writer.import_batches(
        IDENTITY,
        DISPLAY_INTERVAL,
        [
            _batch(
                [
                    {
                        "exchange": "binance",
                        "market_type": "spot",
                        "symbol": "BTCUSDT",
                        "interval": DISPLAY_INTERVAL,
                        "open_time": anchor_ms,
                        "close_time": actual_end_ms - 1,
                        "open": "100",
                        "high": "115.00000001",
                        "low": "98.99999999",
                        "close": "114.50000001",
                        "volume": "150.00000001",
                        "quote_volume": "15075.00000001",
                        "trades": 105,
                        "taker_buy_base": "60.00000001",
                        "taker_buy_quote": "6030.00000001",
                        "source": "binance_archive_verified",
                    }
                ],
                source_key="native-15m-rounded-final",
                digest_character="2",
                alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
                source_bucket_anchor_ms=0,
            )
        ],
        alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
        source_bucket_anchor_ms=0,
    )
    row_opens = [
        anchor_ms + offset * MINUTE_MS
        for offset in range(8, 15)
    ]
    snapshot = _snapshot_for_rows(
        source_revision=base_manifest.catalog_epoch,
        base_interval="1m",
        base_interval_ms=MINUTE_MS,
        replay_start_ms=replay_start_ms,
        row_opens=row_opens,
        source_earliest_open_ms=anchor_ms,
        source_latest_open_ms=row_opens[-1],
        gap_count=0,
    )
    config = replace(
        replay_config(),
        display_interval=DISPLAY_INTERVAL,
        requested_start_ms=replay_start_ms,
        warmup_bars=2,
        horizon_ms=actual_end_ms - replay_start_ms,
    )
    binding = _grid_binding(
        snapshot=snapshot,
        config=config,
        display_interval=DISPLAY_INTERVAL,
        display_source_revision=native_manifest.catalog_epoch,
        source_bucket_anchor_ms=0,
        alignment_policy=SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED,
        durable_boundary_ms=actual_end_ms - 1,
    )
    persisted = _persisted(
        snapshot,
        actual_replay_start_ms=replay_start_ms,
    )
    repository = ReplayHistoryRepository(root)

    forming = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=replay_start_ms + MINUTE_MS - 1,
        limit=10,
        data_epoch=snapshot.data_epoch,
        display_interval=DISPLAY_INTERVAL,
        repository=repository,
    )

    assert forming["bars"] == [
        {
            "open_time_ms": anchor_ms,
            "close_time_ms": actual_end_ms - 1,
            "open": "100",
            "high": "111",
            "low": "99",
            "close": "110.5",
            "volume": "110",
            "quote_volume": "11055",
            "trades": 77,
            "taker_buy_base": "44",
            "taker_buy_quote": "4422",
            "first_base_open_ms": anchor_ms,
            "last_base_open_ms": anchor_ms + 10 * MINUTE_MS,
            "component_count": 11,
            "expected_components": 15,
            "is_closed": False,
            "synthetic": False,
        }
    ]

    closed = build_display_projection(
        binding=binding,
        persisted=persisted,
        revealed_boundary_ms=actual_end_ms - 1,
        limit=10,
        data_epoch=snapshot.data_epoch,
        display_interval=DISPLAY_INTERVAL,
        repository=repository,
    )

    assert closed["bars"] == [
        {
            "open_time_ms": anchor_ms,
            "close_time_ms": actual_end_ms - 1,
            "open": "100",
            "high": "115.00000001",
            "low": "98.99999999",
            "close": "114.50000001",
            "volume": "150.00000001",
            "quote_volume": "15075.00000001",
            "trades": 105,
            "taker_buy_base": "60.00000001",
            "taker_buy_quote": "6030.00000001",
            "first_base_open_ms": anchor_ms,
            "last_base_open_ms": anchor_ms + 14 * MINUTE_MS,
            "component_count": 15,
            "expected_components": 15,
            "is_closed": True,
            "synthetic": False,
        }
    ]
