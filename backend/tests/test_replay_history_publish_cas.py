from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.exchanges.archive import ArchiveGranularity, ArchiveObjectRef
from app.replay.catalog import ReplaySeriesIdentity
from app.replay.history_archive import (
    ReplayHistoryArchiveError,
    ReplayHistoryArchiveWriter,
    ReplayHistoryImportBatch,
)
from app.replay import remote_history
from app.replay.remote_history import (
    RemoteReplayHistoryRepository,
    publish_catalog_and_remote_index_if_current,
    publish_remote_history_index,
)
from scripts import import_binance_replay_history as importer
from tests.fixtures.replay.fakes import make_bar


IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")
START_MS = 1_710_000_000_000
INTERVAL_MS = 60_000


def _batch(
    *,
    source_key: str,
    price: str,
    offset: int = 0,
) -> ReplayHistoryImportBatch:
    return ReplayHistoryImportBatch(
        rows=(make_bar(START_MS + offset * INTERVAL_MS, price=price),),
        source_provider="binance-public-kline-v1",
        source_object_key=source_key,
        source_period=source_key,
        source_url=f"https://data.binance.vision/{source_key}.zip",
        source_content_sha256="sha256:" + "a" * 64,
        source_provider_checksum="sha256:" + "a" * 64,
        source_filter_policy="binance_checksum_utc_grid_v2",
    )


def test_publish_catalog_if_current_rejects_stale_revision(tmp_path: Path) -> None:
    writer = ReplayHistoryArchiveWriter(tmp_path)
    base = writer.import_batches(
        IDENTITY,
        "1m",
        (_batch(source_key="base", price="100"),),
    )
    first_object = writer.write_object(
        IDENTITY,
        "1m",
        _batch(source_key="first", price="200", offset=1),
    )
    stale_object = writer.write_object(
        IDENTITY,
        "1m",
        _batch(source_key="stale", price="300", offset=2),
    )

    published = writer.publish_catalog_if_current(
        base.catalog_epoch,
        IDENTITY,
        "1m",
        (first_object,),
    )
    with pytest.raises(
        ReplayHistoryArchiveError,
        match="catalog changed before publish",
    ):
        writer.publish_catalog_if_current(
            base.catalog_epoch,
            IDENTITY,
            "1m",
            (stale_object,),
        )

    current = writer.current_manifest(IDENTITY, "1m")
    assert current is not None
    assert current.catalog_epoch == published.catalog_epoch
    assert {item.source_object_key for item in current.objects} == {
        "base",
        "first",
    }


@pytest.mark.parametrize("damage", ("missing", "size", "sha256"))
def test_publish_catalog_if_current_validates_object_file(
    tmp_path: Path,
    damage: str,
) -> None:
    writer = ReplayHistoryArchiveWriter(tmp_path)
    base = writer.import_batches(
        IDENTITY,
        "1m",
        (_batch(source_key="base", price="100"),),
    )
    item = writer.write_object(
        IDENTITY,
        "1m",
        _batch(source_key="candidate", price="200"),
    )
    path = tmp_path / item.relative_path
    original = path.read_bytes()
    if damage == "missing":
        path.unlink()
    elif damage == "size":
        path.write_bytes(original + b"x")
    else:
        changed = bytearray(original)
        changed[-1] ^= 1
        path.write_bytes(changed)

    with pytest.raises(
        ReplayHistoryArchiveError,
        match="publish object is missing or changed",
    ):
        writer.publish_catalog_if_current(
            base.catalog_epoch,
            IDENTITY,
            "1m",
            (item,),
        )

    current = writer.current_manifest(IDENTITY, "1m")
    assert current is not None
    assert current.catalog_epoch == base.catalog_epoch


def test_catalog_and_remote_index_publish_as_one_visible_snapshot(
    tmp_path: Path,
) -> None:
    writer = ReplayHistoryArchiveWriter(tmp_path)
    base = writer.import_batches(
        IDENTITY,
        "1m",
        (_batch(source_key="base", price="100"),),
    )
    publish_remote_history_index(tmp_path, now_ms=START_MS)
    item = writer.write_object(
        IDENTITY,
        "1m",
        _batch(source_key="candidate", price="200", offset=1),
    )

    manifest, index = publish_catalog_and_remote_index_if_current(
        writer,
        base.catalog_epoch,
        IDENTITY,
        "1m",
        (item,),
        now_ms=START_MS + 1,
    )

    entry = next(item for item in index.catalogs if item.symbol == "BTCUSDT")
    assert entry.catalog_epoch == manifest.catalog_epoch
    remote = RemoteReplayHistoryRepository(
        tmp_path / "cache",
        tmp_path,
        refresh_seconds=0,
    )
    assert remote.get_bounds(
        "BTCUSDT",
        "1m",
        exchange="binance",
        market_type="spot",
    )["total_count"] == 2


def test_remote_index_failure_restores_previous_catalog_pointer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writer = ReplayHistoryArchiveWriter(tmp_path)
    base = writer.import_batches(
        IDENTITY,
        "1m",
        (_batch(source_key="base", price="100"),),
    )
    old_index = publish_remote_history_index(tmp_path, now_ms=START_MS)
    old_index_bytes = (tmp_path / "index.json").read_bytes()
    item = writer.write_object(
        IDENTITY,
        "1m",
        _batch(source_key="candidate", price="200", offset=1),
    )
    atomic_write = remote_history._atomic_write_json

    def fail_index_write(path: Path, payload) -> None:
        if path.name == "index.json":
            raise OSError("injected index failure")
        atomic_write(path, payload)

    monkeypatch.setattr(remote_history, "_atomic_write_json", fail_index_write)
    with pytest.raises(OSError, match="injected index failure"):
        publish_catalog_and_remote_index_if_current(
            writer,
            base.catalog_epoch,
            IDENTITY,
            "1m",
            (item,),
            now_ms=START_MS + 1,
        )

    current = writer.current_manifest(IDENTITY, "1m")
    assert current is not None
    assert current.catalog_epoch == base.catalog_epoch
    assert (tmp_path / "index.json").read_bytes() == old_index_bytes
    assert (
        remote_history.ReplayRemoteCatalogIndex.from_dict(
            remote_history._read_local_json(tmp_path / "index.json")
        ).index_epoch
        == old_index.index_epoch
    )


def test_catalog_cas_failure_does_not_change_remote_index(tmp_path: Path) -> None:
    writer = ReplayHistoryArchiveWriter(tmp_path)
    base = writer.import_batches(
        IDENTITY,
        "1m",
        (_batch(source_key="base", price="100"),),
    )
    publish_remote_history_index(tmp_path, now_ms=START_MS)
    old_index_bytes = (tmp_path / "index.json").read_bytes()
    item = writer.write_object(
        IDENTITY,
        "1m",
        _batch(source_key="candidate", price="200", offset=1),
    )

    with pytest.raises(
        ReplayHistoryArchiveError,
        match="catalog changed before publish",
    ):
        publish_catalog_and_remote_index_if_current(
            writer,
            "sha256:" + "f" * 64,
            IDENTITY,
            "1m",
            (item,),
            now_ms=START_MS + 1,
        )

    current = writer.current_manifest(IDENTITY, "1m")
    assert current is not None
    assert current.catalog_epoch == base.catalog_epoch
    assert (tmp_path / "index.json").read_bytes() == old_index_bytes


def test_binance_importer_publishes_against_its_starting_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_epoch = "sha256:" + "b" * 64
    content_digest = "c" * 64
    ref = ArchiveObjectRef(
        provider_id="binance-public-kline-v1",
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        granularity=ArchiveGranularity.MONTHLY,
        period="2024-01",
        start_ms=int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1_000),
        end_ms=int(datetime(2024, 2, 1, tzinfo=timezone.utc).timestamp() * 1_000) - 1,
        expected_filename="BTCUSDT-1m-2024-01.zip",
        packaging_timezone="UTC",
        url="https://data.binance.vision/BTCUSDT-1m-2024-01.zip",
        checksum_url="https://data.binance.vision/BTCUSDT-1m-2024-01.zip.CHECKSUM",
        allowed_hosts=("data.binance.vision",),
    )
    existing = SimpleNamespace(
        source_object_key=ref.object_key,
        source_content_sha256=f"sha256:{content_digest}",
        source_provider_checksum=f"sha256:{content_digest}",
        source_filter_policy="binance_checksum_utc_grid_v2",
        row_count=1,
    )
    base = SimpleNamespace(
        catalog_epoch=base_epoch,
        objects=(existing,),
        source_bucket_anchor_ms=0,
        alignment_policy="utc_fixed_grid",
    )
    published = SimpleNamespace(
        catalog_epoch="sha256:" + "d" * 64,
        earliest_open_ms=ref.start_ms,
        latest_open_ms=ref.end_ms,
        total_count=1,
        segments=(SimpleNamespace(),),
    )
    published_index = SimpleNamespace(index_epoch="sha256:" + "e" * 64)
    publish_call = None

    class FakeProvider:
        def plan_objects(self, **_kwargs):
            return [ref]

    class FakeCache:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        @asynccontextmanager
        async def materialize(self, *_args, **_kwargs):
            yield SimpleNamespace(
                provider_checksum=content_digest,
                content_sha256=content_digest,
            )

    class FakeWriter:
        instance: "FakeWriter | None" = None

        def __init__(self, _root: Path) -> None:
            FakeWriter.instance = self

        def current_manifest(self, _identity, _interval):
            return base

    def fake_publish(*args, **kwargs):
        nonlocal publish_call
        publish_call = (args, kwargs)
        return published, published_index

    monkeypatch.setattr(importer, "BinanceKlineArchiveProvider", FakeProvider)
    monkeypatch.setattr(importer, "HistoricalArchiveCache", FakeCache)
    monkeypatch.setattr(importer, "ReplayHistoryArchiveWriter", FakeWriter)
    monkeypatch.setattr(
        importer,
        "publish_catalog_and_remote_index_if_current",
        fake_publish,
    )
    monkeypatch.setattr(
        importer,
        "AiohttpArchiveHttpClient",
        lambda **_kwargs: SimpleNamespace(),
    )

    report = asyncio.run(
        importer.import_history(
            SimpleNamespace(
                market_type="spot",
                symbol="BTCUSDT",
                interval="1m",
                start=date(2024, 1, 1),
                end=date(2024, 1, 31),
                archive_dir=tmp_path / "archive",
                source_cache_dir=tmp_path / "cache",
                cache_max_bytes=1024,
                timeout_seconds=30.0,
                fail_on_missing=False,
                replace_current=False,
                plan_only=False,
            )
        )
    )

    writer = FakeWriter.instance
    assert writer is not None
    assert publish_call is not None
    args, kwargs = publish_call
    assert args[:5] == (writer, base_epoch, IDENTITY, "1m", [existing])
    assert kwargs["merge_current"] is True
    assert report["base_catalog_epoch"] == base_epoch
    assert report["remote_index_epoch"] == published_index.index_epoch
