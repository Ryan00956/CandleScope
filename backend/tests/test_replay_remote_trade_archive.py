from __future__ import annotations

from pathlib import Path

from app.data_engine.storage.raw_trade_archive import VerifiedRawAggTradeBarWindow
from app.replay.bars.trade_parity import trade_bar_parity_policy
from app.replay.remote_trade_archive import (
    RemoteRawAggTradeArchive,
    publish_remote_agg_trade_index,
)
from tests.fixtures.replay.trade_service_fakes import (
    INTERVAL_MS,
    TRADE_REPLAY_MINUTES,
    TRADE_REPLAY_START_MS,
    verified_trade_archive,
)


def test_remote_agg_trade_selection_uses_metadata_then_materializes_selected_day(
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
    revision = "sha256:" + "a" * 64
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
    remote_index = publish_remote_agg_trade_index(origin_root)
    cache_root = tmp_path / "cache"
    remote = RemoteRawAggTradeArchive(cache_root, origin_root)

    windows = remote.list_verified_bar_windows(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        interval="1m",
        interval_ms=INTERVAL_MS,
        bar_source_revision=revision,
        parity_policy=policy,
    )

    assert windows == (
        VerifiedRawAggTradeBarWindow(
            start_time_ms=TRADE_REPLAY_START_MS,
            end_time_ms=end_ms,
            bar_count=TRADE_REPLAY_MINUTES,
        ),
    )
    assert list(cache_root.rglob("*.parquet")) == []
    assert remote.diagnostics()["remote_index_epoch"] == remote_index.index_epoch

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
