from __future__ import annotations

import asyncio
import hashlib
import io
import zipfile
from datetime import datetime, timedelta, timezone

import pytest

from app.data_engine.backfill.archive_cache import HistoricalArchiveCache
from app.exchanges.archive import ArchiveDataError, ArchiveHttpResponse
from app.exchanges.plugins.binance.archive import BinanceKlineArchiveProvider


UTC = timezone.utc


def _zip_bytes(filename: str, row: str) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(filename, row)
    return output.getvalue()


def _refs():
    provider = BinanceKlineArchiveProvider()
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = datetime(2024, 3, 1, tzinfo=UTC)
    refs = provider.plan_objects(
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        start_ms=int(start.timestamp() * 1_000),
        end_ms=int(end.timestamp() * 1_000) - 1,
        now_ms=int((end + timedelta(days=40)).timestamp() * 1_000),
    )
    monthly = [item for item in refs if item.granularity.value == "monthly"]
    return provider, monthly[:2]


class _FakeHttp:
    def __init__(self, payloads: dict[str, bytes]) -> None:
        self.payloads = payloads
        self.downloads = 0
        self.checksums = 0
        self.status = 200

    async def get_bytes(self, url, *, allowed_hosts, max_bytes):
        del allowed_hosts, max_bytes
        self.checksums += 1
        archive_url = url.removesuffix(".CHECKSUM")
        payload = self.payloads[archive_url]
        digest = hashlib.sha256(payload).hexdigest()
        filename = archive_url.rsplit("/", 1)[-1]
        return ArchiveHttpResponse(200, {}, f"{digest}  {filename}\n".encode())

    async def download(self, url, destination, *, allowed_hosts, max_bytes):
        del allowed_hosts, max_bytes
        self.downloads += 1
        if self.status != 200:
            return ArchiveHttpResponse(self.status, {})
        destination.write_bytes(self.payloads[url])
        return ArchiveHttpResponse(200, {"etag": f'"{self.downloads}"'})

    async def head(self, url, *, allowed_hosts):
        del url, allowed_hosts
        return ArchiveHttpResponse(200, {})


def _payload_for(ref, marker: str) -> bytes:
    open_ms = ref.start_ms
    row = (
        f"{open_ms},100,110,90,105,1.5,{open_ms + 59_999},"
        f"157.5,10,0.75,78.75,{marker}\n"
    )
    return _zip_bytes(ref.expected_filename[:-4] + ".csv", row)


def test_archive_cache_cold_download_then_persistent_hit(tmp_path) -> None:
    async def _run() -> None:
        provider, refs = _refs()
        ref = refs[0]
        http = _FakeHttp({ref.url: _payload_for(ref, "0")})
        cache = HistoricalArchiveCache(
            tmp_path,
            max_bytes=10_000_000,
            revalidate_seconds=86_400,
        )

        async with cache.materialize(ref, provider, http) as first:
            assert first.cache_hit is False
            assert first.path.is_file()
        async with cache.materialize(ref, provider, http) as second:
            assert second.cache_hit is True
            assert second.content_sha256 == first.content_sha256

        assert http.downloads == 1
        assert cache.snapshot()["object_count"] == 1

    asyncio.run(_run())


def test_archive_cache_rejects_checksum_mismatch_and_http_404(tmp_path) -> None:
    async def _run() -> None:
        provider, refs = _refs()
        ref = refs[0]
        payload = _payload_for(ref, "0")

        class _BadChecksumHttp(_FakeHttp):
            async def get_bytes(self, url, *, allowed_hosts, max_bytes):
                del url, allowed_hosts, max_bytes
                return ArchiveHttpResponse(
                    200,
                    {},
                    f"{'0' * 64}  {ref.expected_filename}\n".encode(),
                )

        cache = HistoricalArchiveCache(tmp_path / "bad", max_bytes=10_000_000)
        with pytest.raises(ArchiveDataError, match="SHA-256"):
            async with cache.materialize(
                ref,
                provider,
                _BadChecksumHttp({ref.url: payload}),
            ):
                pass
        assert cache.snapshot()["object_count"] == 0

        missing = _FakeHttp({ref.url: payload})
        missing.status = 404
        with pytest.raises(ArchiveDataError, match="HTTP 404"):
            async with cache.materialize(ref, provider, missing):
                pass
        assert cache.snapshot()["object_count"] == 0

    asyncio.run(_run())


def test_archive_cache_detects_revision_and_removes_old_blob(tmp_path) -> None:
    async def _run() -> None:
        provider, refs = _refs()
        ref = refs[0]
        first_payload = _payload_for(ref, "0")
        http = _FakeHttp({ref.url: first_payload})
        cache = HistoricalArchiveCache(
            tmp_path,
            max_bytes=10_000_000,
            revalidate_seconds=0,
        )
        async with cache.materialize(ref, provider, http) as first:
            first_path = first.path
        await asyncio.sleep(0.01)
        http.payloads[ref.url] = _payload_for(ref, "1")
        async with cache.materialize(ref, provider, http) as revised:
            assert revised.revision_changed is True
            assert revised.content_sha256 != first.content_sha256
        assert not first_path.exists()
        assert revised.path.exists()

    asyncio.run(_run())


def test_archive_cache_lru_never_evicts_active_object(tmp_path) -> None:
    async def _run() -> None:
        provider, refs = _refs()
        first_ref, second_ref = refs
        first_payload = _payload_for(first_ref, "0")
        second_payload = _payload_for(second_ref, "1")
        http = _FakeHttp({
            first_ref.url: first_payload,
            second_ref.url: second_payload,
        })
        cache = HistoricalArchiveCache(
            tmp_path,
            max_bytes=max(len(first_payload), len(second_payload)) + 1,
        )

        async with cache.materialize(first_ref, provider, http) as first:
            async with cache.materialize(second_ref, provider, http):
                assert first.path.exists()
            # The inner release may evict the second object, never this lease.
            assert first.path.exists()
        snapshot = cache.snapshot()
        assert snapshot["bytes"] <= cache.max_bytes
        assert snapshot["object_count"] == 1

    asyncio.run(_run())
