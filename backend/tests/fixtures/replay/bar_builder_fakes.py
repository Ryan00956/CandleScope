from __future__ import annotations

from decimal import Decimal

from app.replay.canonical import canonical_sha256
from app.replay.catalog import ReplaySeriesIdentity
from app.replay.dataset import (
    BAR_DATASET_SCHEMA_VERSION,
    BarDatasetProvenance,
    BarDatasetSnapshot,
    ReplayBar,
)


INTERVAL_MS = 60_000
REPLAY_START_MS = 1_710_000_000_000
IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")


def make_replay_bar(
    open_time_ms: int,
    value: int | str,
    *,
    interval_ms: int = INTERVAL_MS,
    volume: int | str | None = None,
    quote_volume: int | str | None = None,
    trades: int | None = None,
    source: str = "phase3-fixture",
) -> ReplayBar:
    price = Decimal(str(value))
    volume_value = Decimal(str(value if volume is None else volume))
    quote_value = (
        volume_value * price if quote_volume is None else Decimal(str(quote_volume))
    )
    return ReplayBar(
        open_time_ms=open_time_ms,
        close_time_ms=open_time_ms + interval_ms - 1,
        open=format(price, "f"),
        high=format(price + Decimal("2"), "f"),
        low=format(price - Decimal("1"), "f"),
        close=format(price + Decimal("1"), "f"),
        volume=format(volume_value, "f"),
        quote_volume=format(quote_value, "f"),
        trades=int(volume_value) if trades is None else trades,
        taker_buy_base=format(volume_value / Decimal("2"), "f"),
        taker_buy_quote=format(quote_value / Decimal("2"), "f"),
        source=source,
    )


def make_bar_snapshot(
    *,
    warmup_count: int = 0,
    replay_count: int = 10,
    replay_start_ms: int = REPLAY_START_MS,
    interval: str = "1m",
    interval_ms: int = INTERVAL_MS,
) -> BarDatasetSnapshot:
    if warmup_count < 0 or replay_count < 1:
        raise ValueError("fixture counts are invalid")
    first_open_ms = replay_start_ms - warmup_count * interval_ms
    rows = tuple(
        make_replay_bar(
            first_open_ms + index * interval_ms,
            100 + index,
            interval_ms=interval_ms,
        )
        for index in range(warmup_count + replay_count)
    )
    data_epoch = canonical_sha256(
        {
            "schema": "replay-phase3-bar-fixture.v1",
            "interval": interval,
            "warmup_count": warmup_count,
            "replay_start_ms": replay_start_ms,
            "rows": [row.to_dict() for row in rows],
        }
    )
    provenance = BarDatasetProvenance(
        repository_backend="phase3-fixture",
        identity=IDENTITY,
        interval=interval,
        source_fingerprint=data_epoch,
        catalog_epoch=data_epoch,
        source_earliest_open_ms=rows[0].open_time_ms,
        source_latest_open_ms=rows[-1].open_time_ms,
        source_latest_closed_open_ms=rows[-1].open_time_ms,
        row_count=len(rows),
        first_open_ms=rows[0].open_time_ms,
        last_open_ms=rows[-1].open_time_ms,
        gap_count=0,
        gap_scan_bars=len(rows),
        calendar_id="continuous-24x7",
        hash_schema="replay-phase3-bar-fixture.v1",
    )
    return BarDatasetSnapshot(
        schema_version=BAR_DATASET_SCHEMA_VERSION,
        data_epoch=data_epoch,
        identity=IDENTITY,
        interval=interval,
        rows=rows,
        warmup_bars=warmup_count,
        replay_start_index=warmup_count,
        replay_start_ms=replay_start_ms,
        replay_end_open_ms=rows[-1].open_time_ms,
        provenance=provenance,
        estimated_size_bytes=len(rows) * 256,
    )
