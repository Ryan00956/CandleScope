from __future__ import annotations

import hashlib
import io
import zipfile
from datetime import date
from pathlib import Path

from app.data_engine.storage.raw_trade_archive import (
    RawAggTradeSelectionWindow,
    VerifiedRawAggTradeBarWindow,
    VerifiedRawAggTradeWindow,
)
from app.replay.bars.trade_parity import trade_bar_parity_policy
from app.replay.remote_trade_archive import (
    RemoteRawAggTradeArchive,
    publish_remote_agg_trade_index,
    sync_official_agg_trade_availability,
)
from app.replay.trade_import import official_agg_trade_urls
from tests.fixtures.replay.trade_service_fakes import (
    DAY_START_MS,
    INTERVAL_MS,
    TRADE_REPLAY_MINUTES,
    TRADE_REPLAY_START_MS,
    verified_trade_archive,
)


def test_remote_agg_trade_selection_uses_receipts_without_bar_parity_proofs(
    tmp_path: Path,
) -> None:
    origin_root = tmp_path / "origin"
    origin = verified_trade_archive(origin_root)
    end_ms = TRADE_REPLAY_START_MS + TRADE_REPLAY_MINUTES * INTERVAL_MS - 1
    dataset_ref = origin.freeze_dataset(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=TRADE_REPLAY_START_MS,
        end_time_ms=end_ms,
    )
    remote_index = publish_remote_agg_trade_index(origin_root)
    assert remote_index.compatibility_indexes == ()
    cache_root = tmp_path / "cache"
    remote = RemoteRawAggTradeArchive(cache_root, origin_root)

    windows = remote.list_verified_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )

    assert windows == (
        VerifiedRawAggTradeWindow(
            start_time_ms=DAY_START_MS,
            end_time_ms=DAY_START_MS + 86_400_000 - 1,
            first_agg_trade_id=1_000,
            last_agg_trade_id=1_007,
            partition_count=1,
        ),
    )
    assert remote.list_verified_identities() == [
        {
            "exchange": "binance",
            "market_type": "futures",
            "symbol": "BTCUSDT",
        }
    ]
    assert list(cache_root.rglob("*.parquet")) == []
    assert remote.diagnostics()["remote_index_epoch"] == remote_index.index_epoch
    assert remote.diagnostics()["bar_parity_required"] is False

    frozen = remote.freeze_dataset(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=TRADE_REPLAY_START_MS,
        end_time_ms=end_ms,
    )

    assert frozen.data_epoch == dataset_ref.data_epoch
    assert frozen.objects == dataset_ref.objects
    assert len(list(cache_root.rglob("*.parquet"))) == len(dataset_ref.objects)
    diagnostics = remote.diagnostics()
    assert diagnostics["materialized_partitions"] == 1
    assert diagnostics["materialized_objects"] == len(dataset_ref.objects) * 2
    assert diagnostics["materialization_failures"] == 0


def test_remote_agg_trade_compatibility_is_independent_of_partial_body_cache(
    tmp_path: Path,
) -> None:
    origin_root = tmp_path / "origin"
    origin = verified_trade_archive(origin_root)
    end_ms = TRADE_REPLAY_START_MS + TRADE_REPLAY_MINUTES * INTERVAL_MS - 1
    dataset_ref = origin.freeze_dataset(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=TRADE_REPLAY_START_MS,
        end_time_ms=end_ms,
    )
    revision = "sha256:" + "b" * 64
    policy = trade_bar_parity_policy(compare_trade_count=False)
    origin.publish_bar_compatibility(
        dataset_ref=dataset_ref,
        interval="1m",
        interval_ms=INTERVAL_MS,
        bar_source_revision=revision,
        parity_policy=policy,
        checked_bar_count=TRADE_REPLAY_MINUTES,
        mismatch_bar_count=0,
        compatible_windows=(
            VerifiedRawAggTradeBarWindow(
                start_time_ms=TRADE_REPLAY_START_MS,
                end_time_ms=end_ms,
                bar_count=TRADE_REPLAY_MINUTES,
            ),
        ),
    )
    publish_remote_agg_trade_index(origin_root)

    empty = RemoteRawAggTradeArchive(tmp_path / "empty", origin_root)
    partial_root = tmp_path / "partial"
    first = dataset_ref.objects[0]
    source = origin_root / first.object_id
    destination = partial_root / first.object_id
    destination.parent.mkdir(parents=True)
    destination.write_bytes(source.read_bytes())
    partial = RemoteRawAggTradeArchive(partial_root, origin_root)

    request = {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "interval_ms": INTERVAL_MS,
        "bar_source_revision": revision,
        "parity_policy": policy,
    }
    assert empty.list_verified_bar_windows(**request) == partial.list_verified_bar_windows(
        **request
    )


def test_official_availability_selects_full_day_then_downloads_on_demand(
    tmp_path: Path,
) -> None:
    origin_root = tmp_path / "origin"
    cache_root = tmp_path / "cache"
    day = date(2026, 6, 1)
    prefix = "data/futures/um/daily/aggTrades/BTCUSDT/"
    listing = (
        "<?xml version='1.0' encoding='UTF-8'?>"
        "<ListBucketResult xmlns='http://s3.amazonaws.com/doc/2006-03-01/'>"
        f"<Contents><Key>{prefix}BTCUSDT-aggTrades-{day}.zip</Key></Contents>"
        f"<Contents><Key>{prefix}BTCUSDT-aggTrades-{day}.zip.CHECKSUM</Key>"
        "</Contents><IsTruncated>false</IsTruncated></ListBucketResult>"
    ).encode()
    sync_official_agg_trade_availability(
        origin_root,
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        as_of_date=date(2026, 6, 2),
        now_ms=1,
        opener=lambda *_args, **_kwargs: io.BytesIO(listing),
    )
    remote_index = publish_remote_agg_trade_index(origin_root, now_ms=2)
    assert remote_index.verified_receipts == ()
    assert len(remote_index.official_availability_indexes) == 1

    filename = f"BTCUSDT-aggTrades-{day}.zip"
    csv_name = filename.removesuffix(".zip") + ".csv"
    rows = [
        (
            f"{1_000 + index},{100 + index // 2},1,{10_000 + index},"
            f"{10_000 + index},{TRADE_REPLAY_START_MS + index * 1_000},"
            f"{'true' if index % 2 == 0 else 'false'}"
        )
        for index in range(8)
    ]
    body = io.BytesIO()
    with zipfile.ZipFile(body, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            csv_name,
            "agg_trade_id,price,quantity,first_trade_id,last_trade_id,"
            "transact_time,is_buyer_maker\n" + "\n".join(rows) + "\n",
        )
    zip_payload = body.getvalue()
    digest = hashlib.sha256(zip_payload).hexdigest()
    source_url, checksum_url, _ = official_agg_trade_urls(
        market_type="futures",
        symbol="BTCUSDT",
        day=day,
    )
    downloads = {
        source_url: zip_payload,
        checksum_url: f"{digest}  {filename}\n".encode(),
    }

    def official_opener(url: str, **_kwargs: object) -> io.BytesIO:
        return io.BytesIO(downloads[url])

    remote = RemoteRawAggTradeArchive(
        cache_root,
        origin_root,
        official_opener=official_opener,
    )
    assert remote.list_verified_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    ) == ()
    assert remote.list_selection_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    ) == (
        RawAggTradeSelectionWindow(
            start_time_ms=DAY_START_MS,
            end_time_ms=DAY_START_MS + 86_400_000 - 1,
            partition_count=1,
        ),
    )
    selection_epoch, selection_windows = remote.selection_snapshot(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert selection_epoch.startswith("sha256:")
    assert selection_windows == remote.list_selection_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert list(cache_root.rglob("*.parquet")) == []

    frozen = remote.freeze_dataset(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=TRADE_REPLAY_START_MS,
        end_time_ms=TRADE_REPLAY_START_MS + 7_999,
        page_rows=2,
    )

    assert frozen.row_count == 8
    assert frozen.expected_first_agg_trade_id == 1_000
    assert frozen.expected_last_agg_trade_id == 1_007
    assert list(cache_root.rglob("*.parquet"))
    diagnostics = remote.diagnostics()
    assert diagnostics["selection_basis"] == "official_daily_availability"
    assert diagnostics["official_daily_archive_count"] == 1
    assert diagnostics["official_days_downloaded"] == 1
    assert diagnostics["official_rows_imported"] == 8

    def unexpected_download(*_args: object, **_kwargs: object) -> io.BytesIO:
        raise AssertionError("cached official day must not be downloaded again")

    restarted = RemoteRawAggTradeArchive(
        cache_root,
        origin_root,
        official_opener=unexpected_download,
    )
    cached = restarted.freeze_dataset(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=TRADE_REPLAY_START_MS,
        end_time_ms=TRADE_REPLAY_START_MS + 7_999,
        page_rows=2,
    )

    assert cached.data_epoch == frozen.data_epoch
    restarted_diagnostics = restarted.diagnostics()
    assert restarted_diagnostics["official_cache_hits"] == 1
    assert restarted_diagnostics["official_days_downloaded"] == 0
