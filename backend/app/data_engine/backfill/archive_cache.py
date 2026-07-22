"""Persistent content-addressed cache for official K-line ZIP objects."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import aiohttp

from app.data_engine.ingestion.metrics import LayerMetrics
from app.exchanges.archive import (
    ArchiveDataError,
    ArchiveHttpResponse,
    ArchiveObjectRef,
    HistoricalArchiveProvider,
)


logger = logging.getLogger("backfill.ArchiveCache")


@dataclass(frozen=True, slots=True)
class CachedArchiveObject:
    ref: ArchiveObjectRef
    path: Path
    content_sha256: str
    provider_checksum: str | None
    size_bytes: int
    cache_hit: bool
    revision_changed: bool
    etag: str | None = None
    last_modified: str | None = None
    download_elapsed_ms: int = 0
    verify_elapsed_ms: int = 0


class AiohttpArchiveHttpClient:
    """Small fail-closed binary client with proxy parity and host allowlists."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 60.0,
        proxy_resolver: Callable[[], str | None] | None = None,
    ) -> None:
        self._timeout_seconds = max(1.0, float(timeout_seconds))
        self._proxy_resolver = proxy_resolver

    async def get_bytes(
        self,
        url: str,
        *,
        allowed_hosts: tuple[str, ...],
        max_bytes: int,
    ) -> ArchiveHttpResponse:
        _validate_url(url, allowed_hosts)
        timeout = aiohttp.ClientTimeout(total=self._timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                url,
                proxy=self._proxy(),
                allow_redirects=False,
            ) as response:
                body = await _read_bounded(response, max_bytes=max_bytes)
                return _response(response, body)

    async def download(
        self,
        url: str,
        destination: Path,
        *,
        allowed_hosts: tuple[str, ...],
        max_bytes: int,
    ) -> ArchiveHttpResponse:
        _validate_url(url, allowed_hosts)
        timeout = aiohttp.ClientTimeout(total=self._timeout_seconds)
        total = 0
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                url,
                proxy=self._proxy(),
                allow_redirects=False,
            ) as response:
                if 300 <= response.status < 400:
                    location = response.headers.get("Location")
                    if location:
                        _validate_url(urljoin(url, location), allowed_hosts)
                    return _response(response)
                if response.status != 200:
                    body = await _read_bounded(response, max_bytes=64 * 1024)
                    return _response(response, body)
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > max_bytes:
                    raise ArchiveDataError("archive download exceeds configured size limit")
                with destination.open("wb") as output:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ArchiveDataError(
                                "archive download exceeds configured size limit"
                            )
                        output.write(chunk)
                return _response(response)

    async def head(
        self,
        url: str,
        *,
        allowed_hosts: tuple[str, ...],
    ) -> ArchiveHttpResponse:
        _validate_url(url, allowed_hosts)
        timeout = aiohttp.ClientTimeout(total=self._timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.head(
                url,
                proxy=self._proxy(),
                allow_redirects=False,
            ) as response:
                return _response(response)

    async def post_json(
        self,
        url: str,
        payload: dict[str, Any],
        *,
        allowed_hosts: tuple[str, ...],
        max_bytes: int,
    ) -> tuple[ArchiveHttpResponse, Any]:
        _validate_url(url, allowed_hosts)
        timeout = aiohttp.ClientTimeout(total=self._timeout_seconds)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url,
                json=payload,
                proxy=self._proxy(),
                allow_redirects=False,
            ) as response:
                body = await _read_bounded(response, max_bytes=max_bytes)
                parsed: Any = None
                if body:
                    try:
                        parsed = json.loads(body.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        parsed = None
                return _response(response, body), parsed

    def _proxy(self) -> str | None:
        if self._proxy_resolver is None:
            return None
        return self._proxy_resolver()


class HistoricalArchiveCache:
    """Bounded persistent ZIP cache independent from the K-line database."""

    def __init__(
        self,
        root: Path | str,
        *,
        max_bytes: int,
        revalidate_seconds: int = 86_400,
        max_download_bytes: int = 256 * 1024**2,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.objects_dir = self.root / "objects"
        self.tmp_dir = self.root / "tmp"
        self.index_path = self.root / "history_archive_cache.sqlite"
        self.max_bytes = max(1, int(max_bytes))
        self.revalidate_ms = max(0, int(revalidate_seconds)) * 1_000
        self.max_download_bytes = max(1, int(max_download_bytes))
        self._lock = threading.RLock()
        self._active: set[str] = set()
        self.metrics = LayerMetrics("HistoricalArchiveCache")
        self.objects_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self._init_index()

    @asynccontextmanager
    async def materialize(
        self,
        ref: ArchiveObjectRef,
        provider: HistoricalArchiveProvider,
        http,
    ):
        with self._lock:
            self._active.add(ref.object_key)
        try:
            value = await self._materialize(ref, provider, http)
            yield value
        finally:
            with self._lock:
                self._active.discard(ref.object_key)
            # A download may temporarily exceed the budget while every
            # candidate is leased.  Re-run eviction after releasing a lease
            # so the persistent cache converges to its configured bound.
            await asyncio.to_thread(self._evict)

    async def _materialize(
        self,
        ref: ArchiveObjectRef,
        provider: HistoricalArchiveProvider,
        http,
    ) -> CachedArchiveObject:
        if not ref.url:
            raise ArchiveDataError("archive object has no resolved download URL")
        now_ms = _now_ms()
        validation_started = time.monotonic()
        existing = await asyncio.to_thread(self._lookup, ref.object_key)
        if existing is not None and not Path(existing["path"]).is_file():
            await asyncio.to_thread(self._remove_record, ref.object_key)
            existing = None

        if existing is not None and now_ms - int(existing["validated_at_ms"]) <= self.revalidate_ms:
            await asyncio.to_thread(self._touch, ref.object_key, now_ms, now_ms)
            self.metrics.inc("archive_cache_hits")
            self.metrics.mark("last_cache_hit_at")
            logger.info("archive_cache_hit object=%s", ref.object_key)
            return _cached_object(
                ref,
                existing,
                cache_hit=True,
                revision_changed=False,
            )

        provider_checksum: str | None = None
        checksum_response: ArchiveHttpResponse | None = None
        if ref.checksum_url:
            checksum_response = await http.get_bytes(
                ref.checksum_url,
                allowed_hosts=ref.allowed_hosts,
                max_bytes=16 * 1024,
            )
            if checksum_response.status != 200:
                raise ArchiveDataError(
                    f"archive checksum request returned HTTP {checksum_response.status}"
                )
            provider_checksum = provider.parse_checksum(checksum_response.body, ref)
            if (
                existing is not None
                and provider_checksum == existing["provider_checksum"]
            ):
                await asyncio.to_thread(self._touch, ref.object_key, now_ms, now_ms)
                self.metrics.inc("archive_cache_revalidated_hits")
                logger.info("archive_cache_hit object=%s revalidated=checksum", ref.object_key)
                verify_elapsed_ms = int(
                    (time.monotonic() - validation_started) * 1_000
                )
                self.metrics.set("last_verify_elapsed_ms", verify_elapsed_ms)
                return _cached_object(
                    ref,
                    existing,
                    cache_hit=True,
                    revision_changed=False,
                    verify_elapsed_ms=verify_elapsed_ms,
                )
        elif existing is not None:
            head = await http.head(ref.url, allowed_hosts=ref.allowed_hosts)
            if head.status == 200 and _metadata_matches(existing, head.headers):
                await asyncio.to_thread(self._touch, ref.object_key, now_ms, now_ms)
                self.metrics.inc("archive_cache_revalidated_hits")
                logger.info("archive_cache_hit object=%s revalidated=metadata", ref.object_key)
                verify_elapsed_ms = int(
                    (time.monotonic() - validation_started) * 1_000
                )
                self.metrics.set("last_verify_elapsed_ms", verify_elapsed_ms)
                return _cached_object(
                    ref,
                    existing,
                    cache_hit=True,
                    revision_changed=False,
                    verify_elapsed_ms=verify_elapsed_ms,
                )

        temporary = self.tmp_dir / f".{uuid4().hex}.zip.tmp"
        try:
            preflight_elapsed_ms = int(
                (time.monotonic() - validation_started) * 1_000
            )
            download_started = time.monotonic()
            response = await http.download(
                ref.url,
                temporary,
                allowed_hosts=ref.allowed_hosts,
                max_bytes=self.max_download_bytes,
            )
            if response.status != 200:
                raise ArchiveDataError(
                    f"archive download returned HTTP {response.status}"
                )
            if not temporary.is_file() or temporary.stat().st_size <= 0:
                raise ArchiveDataError("archive download is empty")
            download_elapsed_ms = int(
                (time.monotonic() - download_started) * 1_000
            )
            digest_started = time.monotonic()
            content_sha256 = await asyncio.to_thread(_file_sha256, temporary)
            if provider_checksum is not None and content_sha256 != provider_checksum:
                raise ArchiveDataError("archive SHA-256 does not match provider checksum")
            verify_elapsed_ms = preflight_elapsed_ms + int(
                (time.monotonic() - digest_started) * 1_000
            )
            destination = self._content_path(content_sha256)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                temporary.unlink(missing_ok=True)
            else:
                os.replace(temporary, destination)
            size_bytes = destination.stat().st_size
            revision_changed = bool(
                existing is not None
                and existing["content_sha256"] != content_sha256
            )
            record = {
                "object_key": ref.object_key,
                "provider_id": ref.provider_id,
                "exchange": ref.exchange,
                "market_type": ref.market_type,
                "symbol": ref.symbol,
                "interval": ref.interval,
                "granularity": ref.granularity.value,
                "period": ref.period,
                "start_ms": ref.start_ms,
                "end_ms": ref.end_ms,
                "source_url": ref.url,
                "checksum_url": ref.checksum_url,
                "provider_checksum": provider_checksum,
                "content_sha256": content_sha256,
                "size_bytes": size_bytes,
                "etag": response.headers.get("etag"),
                "last_modified": response.headers.get("last-modified"),
                "path": str(destination),
                "validated_at_ms": now_ms,
                "last_access_ms": now_ms,
                "state": "ready",
            }
            await asyncio.to_thread(self._upsert, record)
            if (
                existing is not None
                and existing.get("content_sha256") != content_sha256
            ):
                await asyncio.to_thread(self._discard_superseded_blob, existing)
            await asyncio.to_thread(self._evict)
            self.metrics.inc("archive_cold_downloads")
            self.metrics.inc("archive_download_bytes", size_bytes)
            self.metrics.set("last_download_elapsed_ms", download_elapsed_ms)
            self.metrics.set("last_verify_elapsed_ms", verify_elapsed_ms)
            self.metrics.mark("last_download_at")
            logger.info(
                "archive_cold_download object=%s bytes=%d revision_changed=%s",
                ref.object_key,
                size_bytes,
                revision_changed,
            )
            return CachedArchiveObject(
                ref=ref,
                path=destination,
                content_sha256=content_sha256,
                provider_checksum=provider_checksum,
                size_bytes=size_bytes,
                cache_hit=False,
                revision_changed=revision_changed,
                etag=record["etag"],
                last_modified=record["last_modified"],
                download_elapsed_ms=download_elapsed_ms,
                verify_elapsed_ms=verify_elapsed_ms,
            )
        except BaseException:
            self.metrics.inc("archive_download_errors")
            self.metrics.mark("last_error_at")
            raise
        finally:
            temporary.unlink(missing_ok=True)

    async def invalidate(self, object_key: str) -> None:
        await asyncio.to_thread(self._invalidate_sync, object_key)
        self.metrics.inc("archive_invalidations")

    async def has_fresh(self, ref: ArchiveObjectRef) -> bool:
        """Return whether *ref* can be opened without any network validation.

        The router uses this inexpensive index check to keep a genuinely cold
        archive download behind the foreground REST request while still
        allowing an empty K-line database to rebuild directly from a warm ZIP.
        A stale or missing file deliberately returns ``False``; the normal
        materialization path remains responsible for revalidation and repair.
        """
        existing = await asyncio.to_thread(self._lookup, ref.object_key)
        if existing is None:
            return False
        if not Path(existing["path"]).is_file():
            await asyncio.to_thread(self._remove_record, ref.object_key)
            return False
        return (
            _now_ms() - int(existing["validated_at_ms"])
            <= self.revalidate_ms
        )

    def snapshot(self) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS object_count, COALESCE(SUM(size_bytes), 0) AS bytes "
                "FROM archive_objects WHERE state = 'ready'"
            ).fetchone()
        with self._lock:
            active = len(self._active)
        return {
            "root": str(self.root),
            "max_bytes": self.max_bytes,
            "object_count": int(row["object_count"] if row else 0),
            "bytes": int(row["bytes"] if row else 0),
            "active_leases": active,
            "revalidate_ms": self.revalidate_ms,
            "metrics": self.metrics.snapshot(),
        }

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.index_path), timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_index(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS archive_objects (
                    object_key TEXT PRIMARY KEY,
                    provider_id TEXT NOT NULL,
                    exchange TEXT NOT NULL,
                    market_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    granularity TEXT NOT NULL,
                    period TEXT NOT NULL,
                    start_ms INTEGER NOT NULL,
                    end_ms INTEGER NOT NULL,
                    source_url TEXT NOT NULL,
                    checksum_url TEXT,
                    provider_checksum TEXT,
                    content_sha256 TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    etag TEXT,
                    last_modified TEXT,
                    path TEXT NOT NULL,
                    validated_at_ms INTEGER NOT NULL,
                    last_access_ms INTEGER NOT NULL,
                    state TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_archive_objects_lru
                ON archive_objects(state, last_access_ms);
                """
            )

    def _lookup(self, object_key: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM archive_objects WHERE object_key = ? AND state = 'ready'",
                (object_key,),
            ).fetchone()
        return dict(row) if row is not None else None

    def _upsert(self, record: dict[str, Any]) -> None:
        columns = tuple(record)
        values = tuple(record[column] for column in columns)
        assignments = ", ".join(
            f"{column}=excluded.{column}" for column in columns if column != "object_key"
        )
        placeholders = ",".join("?" for _ in columns)
        with self._lock, self._connect() as connection:
            connection.execute(
                f"INSERT INTO archive_objects ({','.join(columns)}) VALUES ({placeholders}) "
                f"ON CONFLICT(object_key) DO UPDATE SET {assignments}",
                values,
            )
            connection.commit()

    def _touch(self, object_key: str, validated_at_ms: int, access_ms: int) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE archive_objects SET validated_at_ms = ?, last_access_ms = ? "
                "WHERE object_key = ?",
                (validated_at_ms, access_ms, object_key),
            )
            connection.commit()

    def _remove_record(self, object_key: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("DELETE FROM archive_objects WHERE object_key = ?", (object_key,))
            connection.commit()

    def _invalidate_sync(self, object_key: str) -> None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT path, content_sha256 FROM archive_objects WHERE object_key = ?",
                (object_key,),
            ).fetchone()
            connection.execute("DELETE FROM archive_objects WHERE object_key = ?", (object_key,))
            connection.commit()
            if row is not None:
                self._delete_unreferenced_path(connection, row["path"], row["content_sha256"])

    def _discard_superseded_blob(self, previous: dict[str, Any]) -> None:
        with self._lock, self._connect() as connection:
            self._delete_unreferenced_path(
                connection,
                str(previous["path"]),
                str(previous["content_sha256"]),
            )

    def _evict(self) -> None:
        with self._lock, self._connect() as connection:
            total_row = connection.execute(
                "SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM archive_objects "
                "WHERE state = 'ready'"
            ).fetchone()
            total = int(total_row["bytes"] if total_row else 0)
            if total <= self.max_bytes:
                return
            rows = connection.execute(
                "SELECT object_key, path, content_sha256, size_bytes FROM archive_objects "
                "WHERE state = 'ready' ORDER BY last_access_ms ASC"
            ).fetchall()
            for row in rows:
                if total <= self.max_bytes:
                    break
                if row["object_key"] in self._active:
                    continue
                connection.execute(
                    "DELETE FROM archive_objects WHERE object_key = ?",
                    (row["object_key"],),
                )
                total -= int(row["size_bytes"])
                self._delete_unreferenced_path(
                    connection,
                    row["path"],
                    row["content_sha256"],
                )
                self.metrics.inc("archive_evictions")
            connection.commit()

    def _delete_unreferenced_path(
        self,
        connection: sqlite3.Connection,
        raw_path: str,
        content_sha256: str,
    ) -> None:
        remaining = connection.execute(
            "SELECT 1 FROM archive_objects WHERE content_sha256 = ? LIMIT 1",
            (content_sha256,),
        ).fetchone()
        if remaining is not None:
            return
        candidate = Path(raw_path).resolve()
        root = self.objects_dir.resolve()
        if candidate != root and root in candidate.parents:
            candidate.unlink(missing_ok=True)

    def _content_path(self, digest: str) -> Path:
        return self.objects_dir / digest[:2] / f"{digest}.zip"


async def _read_bounded(response: aiohttp.ClientResponse, *, max_bytes: int) -> bytes:
    content_length = response.headers.get("Content-Length")
    if content_length and int(content_length) > max_bytes:
        raise ArchiveDataError("archive HTTP response exceeds configured size limit")
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.content.iter_chunked(64 * 1024):
        total += len(chunk)
        if total > max_bytes:
            raise ArchiveDataError("archive HTTP response exceeds configured size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _response(response: aiohttp.ClientResponse, body: bytes = b"") -> ArchiveHttpResponse:
    return ArchiveHttpResponse(
        status=int(response.status),
        headers={str(key).lower(): str(value) for key, value in response.headers.items()},
        body=body,
    )


def _validate_url(url: str, allowed_hosts: tuple[str, ...]) -> None:
    parsed = urlparse(str(url or ""))
    hosts = {str(host).strip().lower() for host in allowed_hosts}
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in hosts:
        raise ArchiveDataError("archive URL is outside the provider allowlist")
    if parsed.username or parsed.password:
        raise ArchiveDataError("archive URL must not contain credentials")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _metadata_matches(existing: dict[str, Any], headers: dict[str, str]) -> bool:
    etag = headers.get("etag")
    modified = headers.get("last-modified")
    length = headers.get("content-length")
    if etag and existing.get("etag"):
        return etag == existing["etag"]
    if modified and existing.get("last_modified"):
        return modified == existing["last_modified"]
    if length and str(existing.get("size_bytes")) == str(length):
        return True
    return False


def _cached_object(
    ref: ArchiveObjectRef,
    record: dict[str, Any],
    *,
    cache_hit: bool,
    revision_changed: bool,
    verify_elapsed_ms: int = 0,
) -> CachedArchiveObject:
    return CachedArchiveObject(
        ref=ref,
        path=Path(record["path"]),
        content_sha256=str(record["content_sha256"]),
        provider_checksum=record.get("provider_checksum"),
        size_bytes=int(record["size_bytes"]),
        cache_hit=cache_hit,
        revision_changed=revision_changed,
        etag=record.get("etag"),
        last_modified=record.get("last_modified"),
        verify_elapsed_ms=verify_elapsed_ms,
    )


def _now_ms() -> int:
    return int(time.time() * 1_000)


__all__ = [
    "AiohttpArchiveHttpClient",
    "CachedArchiveObject",
    "HistoricalArchiveCache",
]
