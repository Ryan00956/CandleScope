"""Immutable, manifest-indexed Parquet history for BAR replay.

The live K-line database is deliberately not part of this storage contract.
Writers publish content-addressed Parquet objects first, then atomically move a
small ``current.json`` pointer to an immutable catalog manifest.  Readers can
continue to address an older catalog epoch after a newer one is published.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
import time
import uuid
import zlib
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from app.data_engine.interval_policy import (
    IntervalAlignment,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
    parse_interval_spec,
)

from .canonical import canonical_json_bytes, canonical_sha256
from .catalog import ReplaySeriesIdentity
from .display_time import SourceBucketTimeMapper
from .models import (
    normalize_decimal_string,
    validate_identifier,
    validate_timestamp_ms,
)


REPLAY_HISTORY_CATALOG_SCHEMA_VERSION = "replay-history-catalog.v1"
REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2 = "replay-history-catalog.v2"
REPLAY_HISTORY_POINTER_SCHEMA_VERSION = "replay-history-pointer.v1"
REPLAY_HISTORY_PARQUET_SCHEMA_VERSION = "replay-history-bars.v1"
REPLAY_HISTORY_CALENDAR_ID = "crypto.24x7.utc"

SOURCE_BUCKET_ALIGNMENT_CANONICAL = "CANONICAL_INTERVAL_V1"
SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED = "CATALOG_ANCHORED_FIXED_V1"
SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH = "CANONICAL_CALENDAR_MONTH_V1"

_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9._-]+$")
_PARQUET_COLUMNS = (
    "open_time",
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
    "source",
)


class ReplayHistoryArchiveError(RuntimeError):
    """The replay-history archive is missing, corrupt, or incompatible."""


def _canonical_source_bucket_anchor_ms(interval: str) -> int:
    spec = parse_interval_spec(interval)
    if spec is None:
        raise ReplayHistoryArchiveError(
            f"unsupported replay-history interval: {interval}"
        )
    return spec.floor_ms(0)


def _default_source_bucket_alignment(interval: str) -> str:
    spec = parse_interval_spec(interval)
    if spec is None:
        raise ReplayHistoryArchiveError(
            f"unsupported replay-history interval: {interval}"
        )
    return (
        SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH
        if spec.alignment is IntervalAlignment.CALENDAR_MONTH
        else SOURCE_BUCKET_ALIGNMENT_CANONICAL
    )


def _validate_source_bucket_alignment(
    *,
    interval: str,
    interval_ms: int,
    alignment_policy: str,
    source_bucket_anchor_ms: int,
) -> None:
    spec = parse_interval_spec(interval)
    if spec is None or spec.nominal_ms != interval_ms:
        raise ReplayHistoryArchiveError(
            "replay-history source bucket interval is incompatible"
        )
    if isinstance(source_bucket_anchor_ms, bool) or not isinstance(
        source_bucket_anchor_ms, int
    ):
        raise ReplayHistoryArchiveError(
            "replay-history source bucket anchor is invalid"
        )
    if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CANONICAL:
        if (
            spec.alignment is IntervalAlignment.CALENDAR_MONTH
            or source_bucket_anchor_ms != spec.floor_ms(0)
        ):
            raise ReplayHistoryArchiveError(
                "replay-history canonical source bucket anchor is invalid"
            )
        return
    if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED:
        if (
            spec.alignment is not IntervalAlignment.FIXED_EPOCH
            or source_bucket_anchor_ms < 0
            or source_bucket_anchor_ms >= interval_ms
        ):
            raise ReplayHistoryArchiveError(
                "replay-history catalog source bucket anchor is invalid"
            )
        return
    if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH:
        if (
            spec.alignment is not IntervalAlignment.CALENDAR_MONTH
            or source_bucket_anchor_ms != spec.floor_ms(0)
        ):
            raise ReplayHistoryArchiveError(
                "replay-history calendar source bucket anchor is invalid"
            )
        return
    raise ReplayHistoryArchiveError(
        "replay-history source bucket alignment policy is unsupported"
    )


def _source_bucket_is_aligned(
    open_ms: int,
    *,
    interval: str,
    interval_ms: int,
    alignment_policy: str,
    source_bucket_anchor_ms: int,
) -> bool:
    if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED:
        return (open_ms - source_bucket_anchor_ms) % interval_ms == 0
    spec = parse_interval_spec(interval)
    return spec is not None and spec.floor_ms(open_ms) == open_ms


def _source_bucket_next_ms(
    open_ms: int,
    *,
    interval: str,
    interval_ms: int,
    alignment_policy: str,
) -> int:
    if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH:
        spec = parse_interval_spec(interval)
        if spec is None:
            raise ReplayHistoryArchiveError(
                "replay-history calendar interval is invalid"
            )
        return spec.next_ms(open_ms)
    return open_ms + interval_ms


def _source_bucket_previous_ms(
    open_ms: int,
    *,
    interval: str,
    interval_ms: int,
    alignment_policy: str,
) -> int:
    if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH:
        spec = parse_interval_spec(interval)
        if spec is None:
            raise ReplayHistoryArchiveError(
                "replay-history calendar interval is invalid"
            )
        return spec.previous_ms(open_ms)
    return open_ms - interval_ms


def _source_bucket_count(
    start_ms: int,
    end_ms: int,
    *,
    interval: str,
    interval_ms: int,
    alignment_policy: str,
) -> int:
    if start_ms > end_ms:
        return 0
    if alignment_policy != SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH:
        distance_ms = end_ms - start_ms
        if distance_ms % interval_ms:
            raise ReplayHistoryArchiveError(
                "replay-history source bucket range is misaligned"
            )
        return distance_ms // interval_ms + 1
    count = 1
    cursor = start_ms
    while cursor < end_ms:
        next_ms = _source_bucket_next_ms(
            cursor,
            interval=interval,
            interval_ms=interval_ms,
            alignment_policy=alignment_policy,
        )
        if next_ms <= cursor or next_ms > end_ms:
            raise ReplayHistoryArchiveError(
                "replay-history calendar source bucket range is misaligned"
            )
        cursor = next_ms
        count += 1
    return count


class ReplayHistoryArchiveRuntimeLease:
    """Prevent destructive archive maintenance while replay is serving Runs."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self._handle: Any | None = None

    def acquire(self) -> None:
        if self._handle is not None:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.root / ".runtime.lock"
        handle: Any | None = None
        try:
            handle = path.open("a+b")
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(
                    handle.fileno(),
                    fcntl.LOCK_EX | fcntl.LOCK_NB,
                )
        except OSError as exc:
            if handle is not None:
                handle.close()
            raise ReplayHistoryArchiveError(
                "replay-history archive is already owned by an active runtime"
            ) from exc
        assert handle is not None
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            handle.close()

    def __enter__(self) -> "ReplayHistoryArchiveRuntimeLease":
        self.acquire()
        return self

    def __exit__(self, *_args: object) -> None:
        self.release()


@contextmanager
def _archive_mutation_lock(
    path: Path,
    *,
    timeout_seconds: float = 60.0,
) -> Iterator[None]:
    """Serialize archive publish and sweep operations across processes."""

    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handle = path.open("a+b")
    except OSError as exc:
        raise ReplayHistoryArchiveError(
            "replay-history mutation lock could not be opened"
        ) from exc
    acquired = False
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(
                        handle.fileno(),
                        fcntl.LOCK_EX | fcntl.LOCK_NB,
                    )
                acquired = True
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise ReplayHistoryArchiveError(
                        "timed out waiting for replay-history mutation lock"
                    ) from exc
                time.sleep(0.05)
        yield
    finally:
        if acquired:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        handle.close()


def _digest(value: object, field_name: str) -> str:
    if not isinstance(value, str) or _DIGEST_PATTERN.fullmatch(value) is None:
        raise ReplayHistoryArchiveError(
            f"{field_name} must be sha256:<64 lowercase hex>"
        )
    return value


def _optional_digest(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _digest(value, field_name)


def _nonempty(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReplayHistoryArchiveError(f"{field_name} must be a non-empty string")
    return value.strip()


def _counter(value: object, field_name: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ReplayHistoryArchiveError(
            f"{field_name} must be a non-negative integer"
        )
    if positive and value < 1:
        raise ReplayHistoryArchiveError(f"{field_name} must be positive")
    return value


def _safe_component(value: str, field_name: str) -> str:
    normalized = validate_identifier(value, field_name=field_name)
    if _SAFE_COMPONENT.fullmatch(normalized) is None or normalized in {".", ".."}:
        raise ReplayHistoryArchiveError(
            f"{field_name} cannot be used as an archive path component"
        )
    return normalized


def _digest_token(value: str) -> str:
    return _digest(value, "digest").removeprefix("sha256:")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _load_pyarrow() -> tuple[Any, Any]:
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover - exercised in minimal installs
        raise ReplayHistoryArchiveError(
            "replay-history Parquet support requires backend/requirements-parquet.txt"
        ) from exc
    return pa, pq


@dataclass(frozen=True, slots=True)
class ReplayHistorySegment:
    start_ms: int
    end_ms: int
    row_count: int

    def to_dict(self) -> dict[str, int]:
        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "row_count": self.row_count,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayHistorySegment":
        if set(payload) != {"start_ms", "end_ms", "row_count"}:
            raise ReplayHistoryArchiveError(
                "replay-history segment fields are incompatible"
            )
        start_ms = validate_timestamp_ms(payload["start_ms"], field_name="start_ms")
        end_ms = validate_timestamp_ms(payload["end_ms"], field_name="end_ms")
        row_count = _counter(payload["row_count"], "row_count", positive=True)
        if start_ms > end_ms:
            raise ReplayHistoryArchiveError("replay-history segment is reversed")
        return cls(start_ms=start_ms, end_ms=end_ms, row_count=row_count)


@dataclass(frozen=True, slots=True)
class ReplayHistoryObject:
    object_sha256: str
    relative_path: str
    size_bytes: int
    row_count: int
    first_open_ms: int
    last_open_ms: int
    segments: tuple[ReplayHistorySegment, ...]
    source_provider: str
    source_object_key: str
    source_period: str
    source_url: str
    source_content_sha256: str | None
    source_provider_checksum: str | None
    source_row_count: int
    source_rejected_rows: int
    source_normalized_rows: int
    source_filter_policy: str
    source_rejection_reasons: tuple[tuple[str, int], ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "object_sha256": self.object_sha256,
            "relative_path": self.relative_path,
            "size_bytes": self.size_bytes,
            "row_count": self.row_count,
            "first_open_ms": self.first_open_ms,
            "last_open_ms": self.last_open_ms,
            "segments": [item.to_dict() for item in self.segments],
            "source_provider": self.source_provider,
            "source_object_key": self.source_object_key,
            "source_period": self.source_period,
            "source_url": self.source_url,
            "source_content_sha256": self.source_content_sha256,
            "source_provider_checksum": self.source_provider_checksum,
            "source_row_count": self.source_row_count,
            "source_rejected_rows": self.source_rejected_rows,
            "source_normalized_rows": self.source_normalized_rows,
            "source_filter_policy": self.source_filter_policy,
            "source_rejection_reasons": [
                [reason, count]
                for reason, count in self.source_rejection_reasons
            ],
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayHistoryObject":
        expected = {
            "object_sha256",
            "relative_path",
            "size_bytes",
            "row_count",
            "first_open_ms",
            "last_open_ms",
            "segments",
            "source_provider",
            "source_object_key",
            "source_period",
            "source_url",
            "source_content_sha256",
            "source_provider_checksum",
            "source_row_count",
            "source_rejected_rows",
            "source_normalized_rows",
            "source_filter_policy",
            "source_rejection_reasons",
        }
        if set(payload) != expected:
            raise ReplayHistoryArchiveError(
                "replay-history object fields are incompatible"
            )
        raw_segments = payload["segments"]
        if not isinstance(raw_segments, list) or not raw_segments:
            raise ReplayHistoryArchiveError(
                "replay-history object segments must be a non-empty array"
            )
        segments = tuple(
            ReplayHistorySegment.from_dict(item)
            if isinstance(item, Mapping)
            else _raise_archive("replay-history object segment must be an object")
            for item in raw_segments
        )
        raw_reasons = payload["source_rejection_reasons"]
        if not isinstance(raw_reasons, list):
            raise ReplayHistoryArchiveError(
                "source_rejection_reasons must be an array"
            )
        reasons: list[tuple[str, int]] = []
        for item in raw_reasons:
            if not isinstance(item, list) or len(item) != 2:
                raise ReplayHistoryArchiveError(
                    "source rejection reason entry is invalid"
                )
            reasons.append(
                (
                    _nonempty(item[0], "source_rejection_reason"),
                    _counter(item[1], "source_rejection_count", positive=True),
                )
            )
        value = cls(
            object_sha256=_digest(payload["object_sha256"], "object_sha256"),
            relative_path=_nonempty(payload["relative_path"], "relative_path"),
            size_bytes=_counter(payload["size_bytes"], "size_bytes", positive=True),
            row_count=_counter(payload["row_count"], "row_count", positive=True),
            first_open_ms=validate_timestamp_ms(
                payload["first_open_ms"], field_name="first_open_ms"
            ),
            last_open_ms=validate_timestamp_ms(
                payload["last_open_ms"], field_name="last_open_ms"
            ),
            segments=segments,
            source_provider=_nonempty(payload["source_provider"], "source_provider"),
            source_object_key=_nonempty(
                payload["source_object_key"], "source_object_key"
            ),
            source_period=_nonempty(payload["source_period"], "source_period"),
            source_url=str(payload["source_url"]),
            source_content_sha256=_optional_digest(
                payload["source_content_sha256"], "source_content_sha256"
            ),
            source_provider_checksum=_optional_digest(
                payload["source_provider_checksum"], "source_provider_checksum"
            ),
            source_row_count=_counter(
                payload["source_row_count"], "source_row_count", positive=True
            ),
            source_rejected_rows=_counter(
                payload["source_rejected_rows"], "source_rejected_rows"
            ),
            source_normalized_rows=_counter(
                payload["source_normalized_rows"], "source_normalized_rows"
            ),
            source_filter_policy=_nonempty(
                payload["source_filter_policy"], "source_filter_policy"
            ),
            source_rejection_reasons=tuple(sorted(reasons)),
        )
        if (
            value.first_open_ms > value.last_open_ms
            or value.segments[0].start_ms != value.first_open_ms
            or value.segments[-1].end_ms != value.last_open_ms
            or sum(item.row_count for item in value.segments) != value.row_count
            or value.source_row_count
            != value.row_count + value.source_rejected_rows
            or value.source_normalized_rows > value.row_count
            or sum(count for _, count in value.source_rejection_reasons)
            != value.source_rejected_rows
        ):
            raise ReplayHistoryArchiveError(
                "replay-history object bounds do not match its segments"
            )
        return value


@dataclass(frozen=True, slots=True)
class ReplayHistoryCatalogManifest:
    catalog_epoch: str
    generated_at_ms: int
    schema_version: str
    identity: ReplaySeriesIdentity
    interval: str
    interval_ms: int
    source_bucket_anchor_ms: int
    alignment_policy: str
    calendar_id: str
    listing_boundary_ms: int
    listing_boundary_source: str
    earliest_open_ms: int
    latest_open_ms: int
    total_count: int
    objects: tuple[ReplayHistoryObject, ...]
    segments: tuple[ReplayHistorySegment, ...]

    def hash_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": self.schema_version,
            "identity": self.identity.to_dict(),
            "interval": self.interval,
            "interval_ms": self.interval_ms,
            "calendar_id": self.calendar_id,
            "listing_boundary_ms": self.listing_boundary_ms,
            "listing_boundary_source": self.listing_boundary_source,
            "earliest_open_ms": self.earliest_open_ms,
            "latest_open_ms": self.latest_open_ms,
            "total_count": self.total_count,
            "objects": [item.to_dict() for item in self.objects],
            "segments": [item.to_dict() for item in self.segments],
        }
        if self.schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2:
            payload.update(
                {
                    "source_bucket_anchor_ms": self.source_bucket_anchor_ms,
                    "alignment_policy": self.alignment_policy,
                }
            )
        return payload

    def to_dict(self) -> dict[str, object]:
        return {
            **self.hash_payload(),
            "catalog_epoch": self.catalog_epoch,
            "generated_at_ms": self.generated_at_ms,
        }

    @classmethod
    def from_dict(
        cls, payload: Mapping[str, object]
    ) -> "ReplayHistoryCatalogManifest":
        schema_version = payload.get("schema_version")
        expected = {
            "schema_version",
            "catalog_epoch",
            "generated_at_ms",
            "identity",
            "interval",
            "interval_ms",
            "calendar_id",
            "listing_boundary_ms",
            "listing_boundary_source",
            "earliest_open_ms",
            "latest_open_ms",
            "total_count",
            "objects",
            "segments",
        }
        if schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2:
            expected.update({"source_bucket_anchor_ms", "alignment_policy"})
        if set(payload) != expected:
            raise ReplayHistoryArchiveError(
                "replay-history catalog fields are incompatible"
            )
        if schema_version not in {
            REPLAY_HISTORY_CATALOG_SCHEMA_VERSION,
            REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2,
        }:
            raise ReplayHistoryArchiveError(
                "replay-history catalog schema is incompatible"
            )
        if not isinstance(payload["identity"], Mapping):
            raise ReplayHistoryArchiveError(
                "replay-history catalog identity must be an object"
            )
        raw_objects = payload["objects"]
        raw_segments = payload["segments"]
        if not isinstance(raw_objects, list) or not raw_objects:
            raise ReplayHistoryArchiveError(
                "replay-history catalog objects must be a non-empty array"
            )
        if not isinstance(raw_segments, list) or not raw_segments:
            raise ReplayHistoryArchiveError(
                "replay-history catalog segments must be a non-empty array"
            )
        objects = tuple(
            ReplayHistoryObject.from_dict(item)
            if isinstance(item, Mapping)
            else _raise_archive("replay-history catalog object must be an object")
            for item in raw_objects
        )
        segments = tuple(
            ReplayHistorySegment.from_dict(item)
            if isinstance(item, Mapping)
            else _raise_archive("replay-history catalog segment must be an object")
            for item in raw_segments
        )
        interval = validate_identifier(payload["interval"], field_name="interval")
        interval_ms = _counter(payload["interval_ms"], "interval_ms", positive=True)
        if parse_interval_ms(interval) != interval_ms:
            raise ReplayHistoryArchiveError(
                "replay-history catalog interval policy is incompatible"
            )
        manifest = cls(
            catalog_epoch=_digest(payload["catalog_epoch"], "catalog_epoch"),
            generated_at_ms=validate_timestamp_ms(
                payload["generated_at_ms"], field_name="generated_at_ms"
            ),
            schema_version=str(schema_version),
            identity=ReplaySeriesIdentity.from_dict(payload["identity"]),
            interval=interval,
            interval_ms=interval_ms,
            source_bucket_anchor_ms=(
                validate_timestamp_ms(
                    payload["source_bucket_anchor_ms"],
                    field_name="source_bucket_anchor_ms",
                )
                if schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
                else _canonical_source_bucket_anchor_ms(interval)
            ),
            alignment_policy=(
                _nonempty(payload["alignment_policy"], "alignment_policy")
                if schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
                else SOURCE_BUCKET_ALIGNMENT_CANONICAL
            ),
            calendar_id=_nonempty(payload["calendar_id"], "calendar_id"),
            listing_boundary_ms=validate_timestamp_ms(
                payload["listing_boundary_ms"], field_name="listing_boundary_ms"
            ),
            listing_boundary_source=_nonempty(
                payload["listing_boundary_source"], "listing_boundary_source"
            ),
            earliest_open_ms=validate_timestamp_ms(
                payload["earliest_open_ms"], field_name="earliest_open_ms"
            ),
            latest_open_ms=validate_timestamp_ms(
                payload["latest_open_ms"], field_name="latest_open_ms"
            ),
            total_count=_counter(
                payload["total_count"], "total_count", positive=True
            ),
            objects=objects,
            segments=segments,
        )
        manifest._validate()
        if canonical_sha256(manifest.hash_payload()) != manifest.catalog_epoch:
            raise ReplayHistoryArchiveError(
                "replay-history catalog content does not match catalog_epoch"
            )
        return manifest

    def _validate(self) -> None:
        if (
            self.calendar_id != REPLAY_HISTORY_CALENDAR_ID
            or self.listing_boundary_ms != self.earliest_open_ms
            or self.earliest_open_ms > self.latest_open_ms
            or self.objects[0].first_open_ms != self.earliest_open_ms
            or self.objects[-1].last_open_ms != self.latest_open_ms
            or self.segments[0].start_ms != self.earliest_open_ms
            or self.segments[-1].end_ms != self.latest_open_ms
            or sum(item.row_count for item in self.objects) != self.total_count
            or sum(item.row_count for item in self.segments) != self.total_count
        ):
            raise ReplayHistoryArchiveError(
                "replay-history catalog bounds/counts are inconsistent"
            )
        is_v2 = self.schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
        if is_v2:
            _validate_source_bucket_alignment(
                interval=self.interval,
                interval_ms=self.interval_ms,
                alignment_policy=self.alignment_policy,
                source_bucket_anchor_ms=self.source_bucket_anchor_ms,
            )
        previous_object_end: int | None = None
        for item in self.objects:
            first_aligned = (
                _source_bucket_is_aligned(
                    item.first_open_ms,
                    interval=self.interval,
                    interval_ms=self.interval_ms,
                    alignment_policy=self.alignment_policy,
                    source_bucket_anchor_ms=self.source_bucket_anchor_ms,
                )
                if is_v2
                else compute_bucket_start_ms(
                    item.first_open_ms,
                    self.interval_ms,
                    interval=self.interval,
                )
                == item.first_open_ms
            )
            last_aligned = (
                _source_bucket_is_aligned(
                    item.last_open_ms,
                    interval=self.interval,
                    interval_ms=self.interval_ms,
                    alignment_policy=self.alignment_policy,
                    source_bucket_anchor_ms=self.source_bucket_anchor_ms,
                )
                if is_v2
                else compute_bucket_start_ms(
                    item.last_open_ms,
                    self.interval_ms,
                    interval=self.interval,
                )
                == item.last_open_ms
            )
            if (
                not first_aligned
                or not last_aligned
                or (
                    previous_object_end is not None
                    and item.first_open_ms <= previous_object_end
                )
            ):
                raise ReplayHistoryArchiveError(
                    "replay-history catalog objects overlap or are misaligned"
                )
            _validate_segments(
                item.segments,
                interval_ms=self.interval_ms,
                **(
                    {
                        "interval": self.interval,
                        "alignment_policy": self.alignment_policy,
                        "source_bucket_anchor_ms": self.source_bucket_anchor_ms,
                    }
                    if is_v2
                    else {}
                ),
            )
            previous_object_end = item.last_open_ms
        _validate_segments(
            self.segments,
            interval_ms=self.interval_ms,
            **(
                {
                    "interval": self.interval,
                    "alignment_policy": self.alignment_policy,
                    "source_bucket_anchor_ms": self.source_bucket_anchor_ms,
                }
                if is_v2
                else {}
            ),
        )


@dataclass(frozen=True, slots=True)
class ReplayHistoryImportBatch:
    rows: Sequence[object]
    source_provider: str
    source_object_key: str
    source_period: str
    source_url: str = ""
    source_content_sha256: str | None = None
    source_provider_checksum: str | None = None
    source_row_count: int | None = None
    source_rejected_rows: int = 0
    source_normalized_rows: int = 0
    source_filter_policy: str = "strict_utc_grid_v1"
    source_rejection_reasons: tuple[tuple[str, int], ...] = ()
    source_bucket_anchor_ms: int | None = None
    alignment_policy: str | None = None


def _raise_archive(message: str):
    raise ReplayHistoryArchiveError(message)


def _validate_segments(
    segments: Sequence[ReplayHistorySegment],
    *,
    interval_ms: int,
    interval: str | None = None,
    alignment_policy: str | None = None,
    source_bucket_anchor_ms: int | None = None,
) -> None:
    if interval is None or alignment_policy is None or source_bucket_anchor_ms is None:
        previous_end: int | None = None
        for segment in segments:
            expected_count = ((segment.end_ms - segment.start_ms) // interval_ms) + 1
            if (
                (segment.end_ms - segment.start_ms) % interval_ms
                or segment.row_count != expected_count
                or (
                    previous_end is not None
                    and segment.start_ms <= previous_end + interval_ms
                )
            ):
                raise ReplayHistoryArchiveError(
                    "replay-history continuity segments are invalid"
                )
            previous_end = segment.end_ms
        return
    previous_end: int | None = None
    for segment in segments:
        expected_count = _source_bucket_count(
            segment.start_ms,
            segment.end_ms,
            interval=interval,
            interval_ms=interval_ms,
            alignment_policy=alignment_policy,
        )
        if (
            not _source_bucket_is_aligned(
                segment.start_ms,
                interval=interval,
                interval_ms=interval_ms,
                alignment_policy=alignment_policy,
                source_bucket_anchor_ms=source_bucket_anchor_ms,
            )
            or not _source_bucket_is_aligned(
                segment.end_ms,
                interval=interval,
                interval_ms=interval_ms,
                alignment_policy=alignment_policy,
                source_bucket_anchor_ms=source_bucket_anchor_ms,
            )
            or segment.row_count != expected_count
            or (
                previous_end is not None
                and segment.start_ms
                <= _source_bucket_next_ms(
                    previous_end,
                    interval=interval,
                    interval_ms=interval_ms,
                    alignment_policy=alignment_policy,
                )
            )
        ):
            raise ReplayHistoryArchiveError(
                "replay-history continuity segments are invalid"
            )
        previous_end = segment.end_ms


def _segments_from_opens(
    opens: Sequence[int],
    *,
    interval_ms: int,
    interval: str | None = None,
    alignment_policy: str | None = None,
) -> tuple[ReplayHistorySegment, ...]:
    if not opens:
        raise ReplayHistoryArchiveError("cannot build segments from empty rows")
    segments: list[ReplayHistorySegment] = []
    segment_start = opens[0]
    previous = opens[0]
    count = 1
    for current in opens[1:]:
        expected_next = (
            previous + interval_ms
            if interval is None or alignment_policy is None
            else _source_bucket_next_ms(
                previous,
                interval=interval,
                interval_ms=interval_ms,
                alignment_policy=alignment_policy,
            )
        )
        if current == expected_next:
            count += 1
        else:
            segments.append(
                ReplayHistorySegment(segment_start, previous, count)
            )
            segment_start = current
            count = 1
        previous = current
    segments.append(ReplayHistorySegment(segment_start, previous, count))
    return tuple(segments)


def _merge_segments(
    objects: Sequence[ReplayHistoryObject],
    *,
    interval_ms: int,
    interval: str | None = None,
    alignment_policy: str | None = None,
) -> tuple[ReplayHistorySegment, ...]:
    merged: list[ReplayHistorySegment] = []
    for item in objects:
        for segment in item.segments:
            expected_next = (
                merged[-1].end_ms + interval_ms
                if merged and (interval is None or alignment_policy is None)
                else (
                    _source_bucket_next_ms(
                        merged[-1].end_ms,
                        interval=interval,
                        interval_ms=interval_ms,
                        alignment_policy=alignment_policy,
                    )
                    if merged
                    else None
                )
            )
            if merged and segment.start_ms == expected_next:
                previous = merged[-1]
                merged[-1] = ReplayHistorySegment(
                    start_ms=previous.start_ms,
                    end_ms=segment.end_ms,
                    row_count=previous.row_count + segment.row_count,
                )
            else:
                merged.append(segment)
    return tuple(merged)


def _atomic_write_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(canonical_json_bytes(payload))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path) -> Mapping[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReplayHistoryArchiveError(
            f"replay-history JSON could not be read: {path}"
        ) from exc
    if not isinstance(payload, Mapping):
        raise ReplayHistoryArchiveError("replay-history JSON root must be an object")
    return payload


def _catalog_directory(
    root: Path,
    identity: ReplaySeriesIdentity,
    interval: str,
) -> Path:
    return (
        root
        / "catalogs"
        / _safe_component(identity.exchange, "exchange")
        / _safe_component(identity.market_type, "market_type")
        / _safe_component(identity.symbol, "symbol")
        / _interval_path_component(interval)
    )


def _interval_path_component(interval: str) -> str:
    """Return a stable catalog path token without case-fold collisions.

    Catalog identity remains the exchange interval spelling (``1m`` versus
    ``1M``).  The filesystem token is deliberately different for calendar
    months because Windows treats those two spellings as the same directory.
    Existing interval paths remain unchanged; only ``1M`` uses the reserved
    ``1mo`` token.
    """

    value = _safe_component(interval, "interval")
    if parse_interval_spec(value) is None:
        raise ReplayHistoryArchiveError(
            f"unsupported replay-history interval: {value}"
        )
    return "1mo" if value == "1M" else value


def _manifest_from_pointer(pointer_path: Path) -> ReplayHistoryCatalogManifest:
    pointer = _read_json(pointer_path)
    if set(pointer) != {"schema_version", "catalog_epoch", "manifest"}:
        raise ReplayHistoryArchiveError(
            "replay-history current pointer fields are incompatible"
        )
    if pointer["schema_version"] != REPLAY_HISTORY_POINTER_SCHEMA_VERSION:
        raise ReplayHistoryArchiveError(
            "replay-history current pointer schema is incompatible"
        )
    epoch = _digest(pointer["catalog_epoch"], "catalog_epoch")
    filename = _nonempty(pointer["manifest"], "manifest")
    if (
        Path(filename).name != filename
        or filename != f"{_digest_token(epoch)}.json"
    ):
        raise ReplayHistoryArchiveError(
            "replay-history current pointer manifest path is invalid"
        )
    manifest = ReplayHistoryCatalogManifest.from_dict(
        _read_json(pointer_path.parent / filename)
    )
    if manifest.catalog_epoch != epoch:
        raise ReplayHistoryArchiveError(
            "replay-history current pointer epoch does not match manifest"
        )
    expected_directory = _catalog_directory(
        pointer_path.parents[5],
        manifest.identity,
        manifest.interval,
    ).resolve()
    if pointer_path.parent.resolve() != expected_directory:
        raise ReplayHistoryArchiveError(
            "replay-history current pointer identity does not match its path"
        )
    return manifest


class ReplayHistoryArchiveWriter:
    """Publish immutable BAR objects and an atomic catalog pointer."""

    def __init__(
        self,
        root: str | Path,
        *,
        now_ms=lambda: int(time.time() * 1_000),
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.objects_dir = self.root / "objects" / "sha256"
        self.catalogs_dir = self.root / "catalogs"
        self.tmp_dir = self.root / "tmp"
        self._now_ms = now_ms
        self.objects_dir.mkdir(parents=True, exist_ok=True)
        self.catalogs_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)

    def current_manifest(
        self,
        identity: ReplaySeriesIdentity,
        interval: str,
    ) -> ReplayHistoryCatalogManifest | None:
        pointer = _catalog_directory(self.root, identity, interval) / "current.json"
        return _manifest_from_pointer(pointer) if pointer.is_file() else None

    def write_object(
        self,
        identity: ReplaySeriesIdentity,
        interval: str,
        batch: ReplayHistoryImportBatch,
    ) -> ReplayHistoryObject:
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            raise ReplayHistoryArchiveError(
                f"unsupported replay-history interval: {interval}"
            )
        alignment_policy = (
            _default_source_bucket_alignment(interval)
            if batch.alignment_policy is None
            else _nonempty(batch.alignment_policy, "alignment_policy")
        )
        source_bucket_anchor_ms = batch.source_bucket_anchor_ms
        if source_bucket_anchor_ms is None:
            source_bucket_anchor_ms = (
                validate_timestamp_ms(
                    _raw_value(batch.rows[0], "open_time"),
                    field_name="source_bucket_anchor_ms",
                )
                if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED
                and batch.rows
                else _canonical_source_bucket_anchor_ms(interval)
            )
            if alignment_policy == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED:
                source_bucket_anchor_ms %= interval_ms
        _validate_source_bucket_alignment(
            interval=interval,
            interval_ms=interval_ms,
            alignment_policy=alignment_policy,
            source_bucket_anchor_ms=source_bucket_anchor_ms,
        )
        rows = [
            _normalize_import_row(
                raw,
                identity=identity,
                interval=interval,
                interval_ms=interval_ms,
                alignment_policy=alignment_policy,
                source_bucket_anchor_ms=source_bucket_anchor_ms,
            )
            for raw in batch.rows
        ]
        if not rows:
            raise ReplayHistoryArchiveError(
                "replay-history import batch contains no rows"
            )
        opens = [int(row["open_time"]) for row in rows]
        if any(current <= previous for previous, current in zip(opens, opens[1:])):
            raise ReplayHistoryArchiveError(
                "replay-history import rows must be strictly increasing"
            )
        segments = _segments_from_opens(
            opens,
            interval_ms=interval_ms,
            interval=interval,
            alignment_policy=alignment_policy,
        )
        source_content_sha256 = _optional_digest(
            batch.source_content_sha256, "source_content_sha256"
        )
        source_provider_checksum = _optional_digest(
            batch.source_provider_checksum, "source_provider_checksum"
        )
        source_provider = _nonempty(batch.source_provider, "source_provider")
        source_object_key = _nonempty(
            batch.source_object_key, "source_object_key"
        )
        source_period = _nonempty(batch.source_period, "source_period")
        source_rejected_rows = _counter(
            batch.source_rejected_rows, "source_rejected_rows"
        )
        inferred_normalized_rows = sum(
            1 for row in rows if str(row["source"]).endswith("_normalized")
        )
        source_normalized_rows = max(
            _counter(batch.source_normalized_rows, "source_normalized_rows"),
            inferred_normalized_rows,
        )
        source_row_count = (
            len(rows) + source_rejected_rows
            if batch.source_row_count is None
            else _counter(batch.source_row_count, "source_row_count", positive=True)
        )
        if (
            source_row_count != len(rows) + source_rejected_rows
            or source_normalized_rows > len(rows)
        ):
            raise ReplayHistoryArchiveError(
                "replay-history source audit counts are inconsistent"
            )
        source_rejection_reasons = tuple(
            sorted(
                (
                    _nonempty(reason, "source_rejection_reason"),
                    _counter(count, "source_rejection_count", positive=True),
                )
                for reason, count in batch.source_rejection_reasons
            )
        )
        if (
            sum(count for _, count in source_rejection_reasons)
            != source_rejected_rows
        ):
            raise ReplayHistoryArchiveError(
                "replay-history rejection reasons do not match rejected rows"
            )
        source_filter_policy = _nonempty(
            batch.source_filter_policy, "source_filter_policy"
        )
        pa, pq = _load_pyarrow()
        schema = pa.schema(
            [
                ("open_time", pa.int64()),
                ("close_time", pa.int64()),
                ("open", pa.float64()),
                ("high", pa.float64()),
                ("low", pa.float64()),
                ("close", pa.float64()),
                ("volume", pa.float64()),
                ("quote_volume", pa.float64()),
                ("trades", pa.int64()),
                ("taker_buy_base", pa.float64()),
                ("taker_buy_quote", pa.float64()),
                ("source", pa.string()),
            ],
            metadata={
                b"replay_schema": REPLAY_HISTORY_PARQUET_SCHEMA_VERSION.encode(),
                b"exchange": identity.exchange.encode(),
                b"market_type": identity.market_type.encode(),
                b"symbol": identity.symbol.encode(),
                b"interval": interval.encode(),
                b"source_provider": source_provider.encode(),
                b"source_object_key": source_object_key.encode(),
            },
        )
        table = pa.Table.from_pylist(rows, schema=schema)
        temporary = self.tmp_dir / f".bars-{uuid.uuid4().hex}.parquet.tmp"
        try:
            pq.write_table(
                table,
                temporary,
                compression="zstd",
                use_dictionary=("source",),
                row_group_size=min(65_536, len(rows)),
                write_statistics=True,
            )
            with temporary.open("r+b") as handle:
                os.fsync(handle.fileno())
            object_sha256 = _file_sha256(temporary)
            token = _digest_token(object_sha256)
            destination = self.objects_dir / token[:2] / f"{token}.parquet"
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                if _file_sha256(destination) != object_sha256:
                    raise ReplayHistoryArchiveError(
                        "content-addressed replay-history object changed"
                    )
            else:
                os.replace(temporary, destination)
            relative_path = destination.relative_to(self.root).as_posix()
            return ReplayHistoryObject(
                object_sha256=object_sha256,
                relative_path=relative_path,
                size_bytes=destination.stat().st_size,
                row_count=len(rows),
                first_open_ms=opens[0],
                last_open_ms=opens[-1],
                segments=segments,
                source_provider=source_provider,
                source_object_key=source_object_key,
                source_period=source_period,
                source_url=str(batch.source_url),
                source_content_sha256=source_content_sha256,
                source_provider_checksum=source_provider_checksum,
                source_row_count=source_row_count,
                source_rejected_rows=source_rejected_rows,
                source_normalized_rows=source_normalized_rows,
                source_filter_policy=source_filter_policy,
                source_rejection_reasons=source_rejection_reasons,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def publish_catalog(
        self,
        identity: ReplaySeriesIdentity,
        interval: str,
        new_objects: Sequence[ReplayHistoryObject],
        *,
        merge_current: bool = True,
        listing_boundary_source: str = "first_checksum_verified_archive_bar",
        source_bucket_anchor_ms: int | None = None,
        alignment_policy: str | None = None,
    ) -> ReplayHistoryCatalogManifest:
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            raise ReplayHistoryArchiveError(
                f"unsupported replay-history interval: {interval}"
            )
        existing = self.current_manifest(identity, interval)
        objects = _merge_catalog_objects(
            existing.objects if merge_current and existing is not None else (),
            tuple(new_objects),
        )
        if not objects:
            raise ReplayHistoryArchiveError(
                "cannot publish an empty replay-history catalog"
            )
        resolved_alignment_policy = (
            existing.alignment_policy
            if alignment_policy is None and merge_current and existing is not None
            else (
                _default_source_bucket_alignment(interval)
                if alignment_policy is None
                else _nonempty(alignment_policy, "alignment_policy")
            )
        )
        resolved_source_bucket_anchor_ms = source_bucket_anchor_ms
        if resolved_source_bucket_anchor_ms is None:
            resolved_source_bucket_anchor_ms = (
                existing.source_bucket_anchor_ms
                if merge_current
                and existing is not None
                and existing.alignment_policy == resolved_alignment_policy
                else (
                    objects[0].first_open_ms
                    % interval_ms
                    if resolved_alignment_policy
                    == SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED
                    else _canonical_source_bucket_anchor_ms(interval)
                )
            )
        _validate_source_bucket_alignment(
            interval=interval,
            interval_ms=interval_ms,
            alignment_policy=resolved_alignment_policy,
            source_bucket_anchor_ms=resolved_source_bucket_anchor_ms,
        )
        schema_version = (
            REPLAY_HISTORY_CATALOG_SCHEMA_VERSION
            if resolved_alignment_policy == SOURCE_BUCKET_ALIGNMENT_CANONICAL
            else REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
        )
        segments = _merge_segments(
            objects,
            interval_ms=interval_ms,
            **(
                {
                    "interval": interval,
                    "alignment_policy": resolved_alignment_policy,
                }
                if schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
                else {}
            ),
        )
        generated_at_ms = validate_timestamp_ms(
            self._now_ms(), field_name="generated_at_ms"
        )
        draft = ReplayHistoryCatalogManifest(
            catalog_epoch="sha256:" + "0" * 64,
            generated_at_ms=generated_at_ms,
            schema_version=schema_version,
            identity=identity,
            interval=validate_identifier(interval, field_name="interval"),
            interval_ms=interval_ms,
            source_bucket_anchor_ms=resolved_source_bucket_anchor_ms,
            alignment_policy=resolved_alignment_policy,
            calendar_id=REPLAY_HISTORY_CALENDAR_ID,
            listing_boundary_ms=objects[0].first_open_ms,
            listing_boundary_source=_nonempty(
                listing_boundary_source, "listing_boundary_source"
            ),
            earliest_open_ms=objects[0].first_open_ms,
            latest_open_ms=objects[-1].last_open_ms,
            total_count=sum(item.row_count for item in objects),
            objects=objects,
            segments=segments,
        )
        manifest = ReplayHistoryCatalogManifest(
            **{
                **{
                    field: getattr(draft, field)
                    for field in (
                        "generated_at_ms",
                        "schema_version",
                        "identity",
                        "interval",
                        "interval_ms",
                        "source_bucket_anchor_ms",
                        "alignment_policy",
                        "calendar_id",
                        "listing_boundary_ms",
                        "listing_boundary_source",
                        "earliest_open_ms",
                        "latest_open_ms",
                        "total_count",
                        "objects",
                        "segments",
                    )
                },
                "catalog_epoch": canonical_sha256(draft.hash_payload()),
            }
        )
        manifest._validate()
        catalog_dir = _catalog_directory(self.root, identity, interval)
        manifest_path = catalog_dir / f"{_digest_token(manifest.catalog_epoch)}.json"
        if manifest_path.exists():
            persisted = ReplayHistoryCatalogManifest.from_dict(
                _read_json(manifest_path)
            )
            if persisted.hash_payload() != manifest.hash_payload():
                raise ReplayHistoryArchiveError(
                    "immutable replay-history catalog epoch was reused"
                )
            manifest = persisted
        else:
            _atomic_write_json(manifest_path, manifest.to_dict())
        _atomic_write_json(
            catalog_dir / "current.json",
            {
                "schema_version": REPLAY_HISTORY_POINTER_SCHEMA_VERSION,
                "catalog_epoch": manifest.catalog_epoch,
                "manifest": manifest_path.name,
            },
        )
        return manifest

    def import_batches(
        self,
        identity: ReplaySeriesIdentity,
        interval: str,
        batches: Sequence[ReplayHistoryImportBatch],
        *,
        merge_current: bool = True,
        listing_boundary_source: str = "first_checksum_verified_archive_bar",
        source_bucket_anchor_ms: int | None = None,
        alignment_policy: str | None = None,
    ) -> ReplayHistoryCatalogManifest:
        with _archive_mutation_lock(self.root / ".mutation.lock"):
            return self._import_batches_locked(
                identity,
                interval,
                batches,
                merge_current=merge_current,
                listing_boundary_source=listing_boundary_source,
                source_bucket_anchor_ms=source_bucket_anchor_ms,
                alignment_policy=alignment_policy,
            )

    def _import_batches_locked(
        self,
        identity: ReplaySeriesIdentity,
        interval: str,
        batches: Sequence[ReplayHistoryImportBatch],
        *,
        merge_current: bool,
        listing_boundary_source: str,
        source_bucket_anchor_ms: int | None,
        alignment_policy: str | None,
    ) -> ReplayHistoryCatalogManifest:
        batch_alignment_policies = {
            batch.alignment_policy
            for batch in batches
            if batch.alignment_policy is not None
        }
        if alignment_policy is None and batch_alignment_policies:
            if len(batch_alignment_policies) != 1:
                raise ReplayHistoryArchiveError(
                    "replay-history import batches disagree on source alignment"
                )
            alignment_policy = next(iter(batch_alignment_policies))
        batch_anchors = [
            batch.source_bucket_anchor_ms
            for batch in batches
            if batch.source_bucket_anchor_ms is not None
        ]
        if source_bucket_anchor_ms is None and batch_anchors:
            source_bucket_anchor_ms = batch_anchors[0]
        objects = [
            self.write_object(identity, interval, batch) for batch in batches
        ]
        return self.publish_catalog(
            identity,
            interval,
            objects,
            merge_current=merge_current,
            listing_boundary_source=listing_boundary_source,
            source_bucket_anchor_ms=source_bucket_anchor_ms,
            alignment_policy=alignment_policy,
        )

    def collect_garbage(
        self,
        *,
        pinned_revisions: Sequence[str],
        dry_run: bool = True,
    ) -> dict[str, object]:
        """Remove only revisions and objects unreachable from current or Run pins."""

        with _archive_mutation_lock(self.root / ".mutation.lock"):
            return self._collect_garbage_locked(
                pinned_revisions=pinned_revisions,
                dry_run=dry_run,
            )

    def _collect_garbage_locked(
        self,
        *,
        pinned_revisions: Sequence[str],
        dry_run: bool,
    ) -> dict[str, object]:
        pinned = {_digest(value, "pinned_revision") for value in pinned_revisions}
        pointers = sorted(self.catalogs_dir.glob("*/*/*/*/current.json"))
        current: set[str] = set()
        for pointer in pointers:
            current.add(_manifest_from_pointer(pointer).catalog_epoch)

        manifests: dict[str, tuple[Path, ReplayHistoryCatalogManifest]] = {}
        for path in sorted(self.catalogs_dir.glob("*/*/*/*/*.json")):
            if path.name == "current.json":
                continue
            manifest = ReplayHistoryCatalogManifest.from_dict(_read_json(path))
            expected_directory = _catalog_directory(
                self.root,
                manifest.identity,
                manifest.interval,
            ).resolve()
            if path.parent.resolve() != expected_directory:
                raise ReplayHistoryArchiveError(
                    "replay-history manifest identity does not match its path"
                )
            expected_name = f"{_digest_token(manifest.catalog_epoch)}.json"
            if path.name != expected_name:
                raise ReplayHistoryArchiveError(
                    "replay-history manifest filename does not match its epoch"
                )
            manifests[manifest.catalog_epoch] = (path, manifest)

        missing_kept_revisions = sorted((current | pinned) - set(manifests))
        if missing_kept_revisions:
            raise ReplayHistoryArchiveError(
                "kept replay-history revision is missing; garbage collection refused"
            )
        kept_revisions = current | pinned
        for revision in sorted(kept_revisions):
            _, manifest = manifests[revision]
            for item in manifest.objects:
                object_path = (self.root / item.relative_path).resolve()
                expected_path = (
                    self.objects_dir
                    / _digest_token(item.object_sha256)[:2]
                    / f"{_digest_token(item.object_sha256)}.parquet"
                ).resolve()
                if object_path != expected_path or not object_path.is_file():
                    raise ReplayHistoryArchiveError(
                        "kept replay-history object is missing; garbage collection refused"
                    )
                if (
                    object_path.stat().st_size != item.size_bytes
                    or _file_sha256(object_path) != item.object_sha256
                ):
                    raise ReplayHistoryArchiveError(
                        "kept replay-history object changed; garbage collection refused"
                    )
        kept_objects = {
            item.object_sha256
            for revision, (_, manifest) in manifests.items()
            if revision in kept_revisions
            for item in manifest.objects
        }
        stale_manifests = [
            path
            for revision, (path, _) in sorted(manifests.items())
            if revision not in kept_revisions
        ]
        stale_objects: list[Path] = []
        stale_bytes = 0
        for path in sorted(self.objects_dir.glob("*/*.parquet")):
            object_id = f"sha256:{path.stem}"
            if _DIGEST_PATTERN.fullmatch(object_id) is None:
                continue
            if object_id in kept_objects:
                continue
            stale_objects.append(path)
            stale_bytes += path.stat().st_size

        if not dry_run:
            for path in stale_manifests:
                path.unlink()
            for path in stale_objects:
                path.unlink()

        return {
            "schema_version": "replay-history-gc.v1",
            "dry_run": bool(dry_run),
            "current_revision_count": len(current),
            "pinned_revision_count": len(pinned),
            "kept_object_count": len(kept_objects),
            "stale_manifest_count": len(stale_manifests),
            "stale_object_count": len(stale_objects),
            "stale_object_bytes": stale_bytes,
        }


def _merge_catalog_objects(
    existing: Sequence[ReplayHistoryObject],
    new: Sequence[ReplayHistoryObject],
) -> tuple[ReplayHistoryObject, ...]:
    if not new:
        return tuple(existing)
    new_by_key: dict[str, ReplayHistoryObject] = {}
    for item in new:
        if item.source_object_key in new_by_key:
            raise ReplayHistoryArchiveError(
                "replay-history import repeats a source object key"
            )
        new_by_key[item.source_object_key] = item
    retained: list[ReplayHistoryObject] = []
    for old in existing:
        if old.source_object_key in new_by_key:
            continue
        overlaps = [
            item
            for item in new
            if item.first_open_ms <= old.last_open_ms
            and item.last_open_ms >= old.first_open_ms
        ]
        if not overlaps:
            retained.append(old)
            continue
        if any(
            item.first_open_ms <= old.first_open_ms
            and item.last_open_ms >= old.last_open_ms
            for item in overlaps
        ):
            continue
        raise ReplayHistoryArchiveError(
            "new replay-history object partially overlaps an existing object"
        )
    combined = sorted(
        [*retained, *new],
        key=lambda item: (item.first_open_ms, item.last_open_ms, item.object_sha256),
    )
    for previous, current in zip(combined, combined[1:]):
        if current.first_open_ms <= previous.last_open_ms:
            raise ReplayHistoryArchiveError(
                "replay-history catalog objects overlap"
            )
    return tuple(combined)


def _raw_value(raw: object, field_name: str, *, default: object = None) -> object:
    if isinstance(raw, Mapping):
        return raw.get(field_name, default)
    return getattr(raw, field_name, default)


def _decimal_number(
    value: object,
    field_name: str,
    *,
    positive: bool = False,
    optional: bool = False,
) -> float | None:
    if value is None and optional:
        return None
    if isinstance(value, bool) or value is None:
        raise ReplayHistoryArchiveError(
            f"replay-history {field_name} is not numeric"
        )
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ReplayHistoryArchiveError(
            f"replay-history {field_name} is not numeric"
        ) from exc
    if (
        not parsed.is_finite()
        or (positive and parsed <= 0)
        or (not positive and parsed < 0)
    ):
        raise ReplayHistoryArchiveError(
            f"replay-history {field_name} is outside its valid range"
        )
    result = float(parsed)
    if not math.isfinite(result):
        raise ReplayHistoryArchiveError(
            f"replay-history {field_name} cannot be represented as float64"
        )
    return result


def _normalize_import_row(
    raw: object,
    *,
    identity: ReplaySeriesIdentity,
    interval: str,
    interval_ms: int,
    alignment_policy: str,
    source_bucket_anchor_ms: int,
) -> dict[str, object]:
    del identity
    open_time = validate_timestamp_ms(
        _raw_value(raw, "open_time"), field_name="open_time"
    )
    close_time = validate_timestamp_ms(
        _raw_value(raw, "close_time"), field_name="close_time"
    )
    expected_close_time = (
        _source_bucket_next_ms(
            open_time,
            interval=interval,
            interval_ms=interval_ms,
            alignment_policy=alignment_policy,
        )
        - 1
    )
    if not _source_bucket_is_aligned(
        open_time,
        interval=interval,
        interval_ms=interval_ms,
        alignment_policy=alignment_policy,
        source_bucket_anchor_ms=source_bucket_anchor_ms,
    ) or close_time != expected_close_time:
        raise ReplayHistoryArchiveError(
            "replay-history row is not aligned to the interval"
        )
    open_value = _decimal_number(_raw_value(raw, "open"), "open", positive=True)
    high = _decimal_number(_raw_value(raw, "high"), "high", positive=True)
    low = _decimal_number(_raw_value(raw, "low"), "low", positive=True)
    close = _decimal_number(_raw_value(raw, "close"), "close", positive=True)
    assert open_value is not None and high is not None and low is not None and close is not None
    if low > min(open_value, close) or high < max(open_value, close) or high < low:
        raise ReplayHistoryArchiveError("replay-history row violates OHLC invariants")
    trades_value = _raw_value(raw, "trades")
    if trades_value is None:
        trades: int | None = None
    elif (
        isinstance(trades_value, bool)
        or not isinstance(trades_value, int)
        or trades_value < 0
    ):
        raise ReplayHistoryArchiveError(
            "replay-history trades must be a non-negative integer or null"
        )
    else:
        trades = trades_value
    source = _nonempty(
        _raw_value(raw, "source", default="replay_history_import"), "source"
    )
    return {
        "open_time": open_time,
        "close_time": close_time,
        "open": open_value,
        "high": high,
        "low": low,
        "close": close,
        "volume": _decimal_number(_raw_value(raw, "volume"), "volume"),
        "quote_volume": _decimal_number(
            _raw_value(raw, "quote_volume"),
            "quote_volume",
            optional=True,
        ),
        "trades": trades,
        "taker_buy_base": _decimal_number(
            _raw_value(raw, "taker_buy_base"),
            "taker_buy_base",
            optional=True,
        ),
        "taker_buy_quote": _decimal_number(
            _raw_value(raw, "taker_buy_quote"),
            "taker_buy_quote",
            optional=True,
        ),
        "source": source,
    }


class ReplayHistoryRepository:
    """Read-only K-line repository backed only by replay-history manifests."""

    supports_unbounded_indexed_gap_scan = True

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.objects_dir = self.root / "objects" / "sha256"
        self.catalogs_dir = self.root / "catalogs"
        self._lock = threading.RLock()
        self._pointer_token: tuple[tuple[str, int, int], ...] | None = None
        self._current: dict[
            tuple[str, str, str, str], ReplayHistoryCatalogManifest
        ] = {}
        self._revision_cache: dict[
            tuple[str, str, str, str, str], ReplayHistoryCatalogManifest
        ] = {}
        self._series_errors: dict[str, str] = {}
        self._verified_objects: dict[Path, tuple[int, int, str]] = {}
        self._metrics = {
            "refreshes": 0,
            "metadata_gap_scans": 0,
            "parquet_queries": 0,
            "parquet_objects_read": 0,
            "checksum_verifications": 0,
            "aggregate_queries": 0,
            "aggregate_cache_hits": 0,
            "aggregate_cache_writes": 0,
        }
        self._refresh()

    def list_all_series(self, custom_only: bool = False) -> list[dict[str, object]]:
        del custom_only
        self._refresh()
        with self._lock:
            return [
                {
                    **manifest.identity.to_dict(),
                    "interval": manifest.interval,
                    "earliest_open_time": manifest.earliest_open_ms,
                    "latest_open_time": manifest.latest_open_ms,
                    "total_count": manifest.total_count,
                    "source_revision": manifest.catalog_epoch,
                    "source_bucket_anchor_ms": manifest.source_bucket_anchor_ms,
                    "alignment_policy": manifest.alignment_policy,
                    "catalog_schema_version": manifest.schema_version,
                }
                for _, manifest in sorted(self._current.items())
            ]

    def list_series(
        self,
        custom_only: bool = False,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict[str, object]]:
        return [
            item
            for item in self.list_all_series(custom_only=custom_only)
            if (exchange is None or item["exchange"] == exchange)
            and (market_type is None or item["market_type"] == market_type)
        ]

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, object]:
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        return _manifest_bounds(manifest)

    def get_bounds_at_revision(
        self,
        source_revision: str,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, object]:
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            source_revision=source_revision,
        )
        return _manifest_bounds(manifest)

    def scan_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        limit: int = 50_000,
        calendar: object | None = None,
    ) -> dict[str, object]:
        del calendar
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        return self._scan_manifest_gaps(
            manifest, start_ms=start_ms, end_ms=end_ms, limit=limit
        )

    def scan_gaps_at_revision(
        self,
        source_revision: str,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        limit: int = 50_000,
        calendar: object | None = None,
    ) -> dict[str, object]:
        del calendar
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            source_revision=source_revision,
        )
        return self._scan_manifest_gaps(
            manifest, start_ms=start_ms, end_ms=end_ms, limit=limit
        )

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict[str, object]]:
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        return self._query_manifest(
            manifest,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            order=order,
        )

    def query_bars_at_revision(
        self,
        source_revision: str,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict[str, object]]:
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            source_revision=source_revision,
        )
        return self._query_manifest(
            manifest,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            order=order,
        )

    def query_aggregated_bars_at_revision(
        self,
        source_revision: str,
        symbol: str,
        base_interval: str,
        display_interval: str,
        *,
        actual_start_ms: int,
        actual_end_ms: int,
        timeline_delta_ms: int,
        limit: int,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, object]:
        """Build one revision-bound chart page through a rebuildable disk cache."""

        manifest = self._manifest(
            symbol,
            base_interval,
            exchange=exchange,
            market_type=market_type,
            source_revision=source_revision,
        )
        display_ms = parse_interval_ms(display_interval)
        if (
            display_ms is None
            or display_ms <= manifest.interval_ms
            or display_ms % manifest.interval_ms
            or is_monthly_interval(display_interval)
        ):
            raise ReplayHistoryArchiveError(
                "display interval is not eligible for fixed aggregation"
            )
        if limit < 1 or actual_start_ms < 0 or actual_end_ms <= actual_start_ms:
            raise ValueError("aggregate history bounds are invalid")
        public_end_ms = actual_end_ms + timeline_delta_ms
        public_target_start = compute_bucket_start_ms(
            max(0, public_end_ms - (limit + 2) * display_ms),
            display_ms,
            interval=display_interval,
        )
        query_start_ms = max(
            actual_start_ms,
            public_target_start - timeline_delta_ms,
        )
        query_end_ms = actual_end_ms - 1
        objects = [
            item
            for item in manifest.objects
            if item.first_open_ms <= query_end_ms
            and item.last_open_ms >= query_start_ms
        ]
        object_state = []
        object_paths: list[tuple[ReplayHistoryObject, Path]] = []
        for item in objects:
            path = self._object_path(item)
            stat = path.stat()
            if stat.st_size != item.size_bytes:
                raise ReplayHistoryArchiveError(
                    "replay-history aggregate source size changed"
                )
            object_paths.append((item, path))
            object_state.append(
                {
                    "object_sha256": item.object_sha256,
                    "mtime_ns": stat.st_mtime_ns,
                    "size_bytes": stat.st_size,
                }
            )
        query = {
            "schema_version": "replay-history-aggregate-query.v1",
            "source_revision": manifest.catalog_epoch,
            "identity": manifest.identity.to_dict(),
            "base_interval": manifest.interval,
            "display_interval": display_interval,
            "actual_start_ms": query_start_ms,
            "actual_end_ms": actual_end_ms,
            # Public timestamps are part of the returned page.  Two blind Runs
            # can share the same bucket phase but have different synthetic
            # origins, so the full offset must participate in the cache key.
            "timeline_delta_ms": timeline_delta_ms,
            "limit": limit,
            "objects": object_state,
        }
        cache_key = canonical_sha256(query)
        cache_path = (
            self.root
            / "derived-cache"
            / "v1"
            / _digest_token(manifest.catalog_epoch)[:16]
            / f"{_digest_token(cache_key)}.json.zlib"
        )
        cached = self._read_aggregate_cache(cache_path, query)
        if cached is not None:
            with self._lock:
                self._metrics["aggregate_cache_hits"] += 1
            return cached

        # A valid derived result is already bound to the immutable revision,
        # expected object digests, sizes and current filesystem tokens.  Only a
        # cache miss needs to hash and inspect every Parquet input again.  This
        # keeps disk-cache hits fast across backend restarts without weakening
        # execution-snapshot verification.
        for item, path in object_paths:
            self._verify_object(manifest, item, path)
        bars = self._aggregate_manifest_range(
            manifest,
            objects,
            display_interval=display_interval,
            display_ms=display_ms,
            start_ms=query_start_ms,
            end_ms=query_end_ms,
            timeline_delta_ms=timeline_delta_ms,
        )
        selected = bars[-(limit + 1) :]
        result = {
            "bars": selected,
            "has_more": query_start_ms > actual_start_ms or len(bars) > limit,
        }
        self._write_aggregate_cache(cache_path, query, result)
        with self._lock:
            self._metrics["aggregate_queries"] += 1
            self._metrics["aggregate_cache_writes"] += 1
        return result

    def query_source_bucket_bars_at_revision(
        self,
        source_revision: str,
        symbol: str,
        base_interval: str,
        display_interval: str,
        *,
        actual_start_ms: int,
        actual_end_ms: int,
        actual_replay_start_ms: int,
        public_replay_start_ms: int,
        limit: int,
        include_partial: bool = False,
        source_bucket_anchor_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, object]:
        """Aggregate native source buckets and map only the result to public time.

        Unlike ``query_aggregated_bars_at_revision``, this path never floors a
        shifted base timestamp.  It is the server-authoritative path used by a
        blind training viewer, where exchange bucket membership must survive
        the synthetic-timeline projection.
        """

        manifest = self._manifest(
            symbol,
            base_interval,
            exchange=exchange,
            market_type=market_type,
            source_revision=source_revision,
        )
        display_ms = parse_interval_ms(display_interval)
        if (
            display_ms is None
            or display_ms <= manifest.interval_ms
            or (
                not is_monthly_interval(display_interval)
                and display_ms % manifest.interval_ms
            )
        ):
            raise ReplayHistoryArchiveError(
                "display interval is not eligible for source-bucket aggregation"
            )
        if (
            limit < 1
            or actual_start_ms < 0
            or actual_end_ms <= actual_start_ms
            or not isinstance(include_partial, bool)
        ):
            raise ValueError("source-bucket aggregate bounds are invalid")
        mapper = SourceBucketTimeMapper.create(
            interval=display_interval,
            actual_replay_start_ms=actual_replay_start_ms,
            public_replay_start_ms=public_replay_start_ms,
            source_bucket_anchor_ms=source_bucket_anchor_ms,
        )
        last_bucket_open_ms = mapper.actual_containing_bucket_open(
            actual_end_ms - 1
        )
        last_ordinal = mapper.actual_bucket_ordinal(last_bucket_open_ms)
        target_start_ms = mapper.actual_bucket_open(last_ordinal - limit - 2)
        query_start_ms = max(actual_start_ms, target_start_ms)
        query_end_ms = actual_end_ms - 1
        objects = [
            item
            for item in manifest.objects
            if item.first_open_ms <= query_end_ms
            and item.last_open_ms >= query_start_ms
        ]
        object_state = []
        object_paths: list[tuple[ReplayHistoryObject, Path]] = []
        for item in objects:
            path = self._object_path(item)
            stat = path.stat()
            if stat.st_size != item.size_bytes:
                raise ReplayHistoryArchiveError(
                    "replay-history aggregate source size changed"
                )
            object_paths.append((item, path))
            object_state.append(
                {
                    "object_sha256": item.object_sha256,
                    "mtime_ns": stat.st_mtime_ns,
                    "size_bytes": stat.st_size,
                }
            )
        query = {
            "schema_version": "replay-history-source-bucket-query.v2",
            "source_revision": manifest.catalog_epoch,
            "identity": manifest.identity.to_dict(),
            "base_interval": manifest.interval,
            "display_interval": display_interval,
            "actual_start_ms": query_start_ms,
            "actual_end_ms": actual_end_ms,
            "actual_replay_start_ms": actual_replay_start_ms,
            "public_replay_start_ms": public_replay_start_ms,
            "source_bucket_anchor_ms": mapper.source_bucket_anchor_ms,
            "limit": limit,
            "include_partial": include_partial,
            "objects": object_state,
        }
        cache_key = canonical_sha256(query)
        cache_path = (
            self.root
            / "derived-cache"
            / "source-bucket-v2"
            / _digest_token(manifest.catalog_epoch)[:16]
            / f"{_digest_token(cache_key)}.json.zlib"
        )
        # A forming bucket changes on every revealed base bar.  Persisting that
        # cursor-specific result would create an unbounded cache-file stream
        # during playback; only closed history pages are disk-cached.
        cached = None if include_partial else self._read_aggregate_cache(
            cache_path,
            query,
        )
        if cached is not None:
            with self._lock:
                self._metrics["aggregate_cache_hits"] += 1
            return cached

        for item, path in object_paths:
            self._verify_object(manifest, item, path)
        bars = self._aggregate_manifest_source_buckets(
            manifest,
            objects,
            mapper=mapper,
            display_interval=display_interval,
            display_ms=display_ms,
            start_ms=query_start_ms,
            end_ms=query_end_ms,
            actual_end_ms=actual_end_ms,
            actual_replay_start_ms=actual_replay_start_ms,
            public_replay_start_ms=public_replay_start_ms,
            include_partial=include_partial,
        )
        selected = bars[-(limit + 1) :]
        result = {
            "bars": selected,
            "has_more": query_start_ms > actual_start_ms or len(bars) > limit,
        }
        if not include_partial:
            self._write_aggregate_cache(cache_path, query, result)
        with self._lock:
            self._metrics["aggregate_queries"] += 1
            if not include_partial:
                self._metrics["aggregate_cache_writes"] += 1
        return result

    def describe_catalog(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str | None = None,
        market_type: str | None = None,
        source_revision: str | None = None,
    ) -> dict[str, object]:
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            source_revision=source_revision,
        )
        if manifest.schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2:
            expected_rows = _source_bucket_count(
                manifest.earliest_open_ms,
                manifest.latest_open_ms,
                interval=manifest.interval,
                interval_ms=manifest.interval_ms,
                alignment_policy=manifest.alignment_policy,
            )
        else:
            expected_rows = (
                (manifest.latest_open_ms - manifest.earliest_open_ms)
                // manifest.interval_ms
            ) + 1
        return {
            "schema_version": manifest.schema_version,
            "catalog_epoch": manifest.catalog_epoch,
            "identity": manifest.identity.to_dict(),
            "interval": manifest.interval,
            "interval_ms": manifest.interval_ms,
            "source_bucket_anchor_ms": manifest.source_bucket_anchor_ms,
            "alignment_policy": manifest.alignment_policy,
            "calendar_id": manifest.calendar_id,
            "listing_boundary_ms": manifest.listing_boundary_ms,
            "listing_boundary_source": manifest.listing_boundary_source,
            "earliest_open_ms": manifest.earliest_open_ms,
            "latest_open_ms": manifest.latest_open_ms,
            "total_count": manifest.total_count,
            "expected_grid_rows": expected_rows,
            "missing_grid_rows": expected_rows - manifest.total_count,
            "object_count": len(manifest.objects),
            "continuous_segment_count": len(manifest.segments),
            "source_row_count": sum(
                item.source_row_count for item in manifest.objects
            ),
            "source_rejected_rows": sum(
                item.source_rejected_rows for item in manifest.objects
            ),
            "source_normalized_rows": sum(
                item.source_normalized_rows for item in manifest.objects
            ),
            "source_rejection_reasons": _sum_rejection_reasons(
                manifest.objects
            ),
            "size_bytes": sum(item.size_bytes for item in manifest.objects),
        }

    def verify_catalog_objects(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str | None = None,
        market_type: str | None = None,
        source_revision: str | None = None,
    ) -> dict[str, object]:
        manifest = self._manifest(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            source_revision=source_revision,
        )
        verified_bytes = 0
        for item in manifest.objects:
            path = self._object_path(item)
            self._verify_object(manifest, item, path)
            verified_bytes += item.size_bytes
        return {
            "catalog_epoch": manifest.catalog_epoch,
            "verified": True,
            "verified_objects": len(manifest.objects),
            "verified_bytes": verified_bytes,
        }

    def diagnostics(self, *, redact_paths: bool = False) -> dict[str, object]:
        self._refresh()
        with self._lock:
            return {
                "backend": "replay-history.parquet.v1",
                "root": "<redacted>" if redact_paths else str(self.root),
                "series_count": len(self._current),
                "catalog_epochs": tuple(
                    sorted(item.catalog_epoch for item in self._current.values())
                ),
                "verified_objects": len(self._verified_objects),
                "series_errors": dict(sorted(self._series_errors.items())),
                **self._metrics,
            }

    @staticmethod
    def _read_aggregate_cache(
        path: Path,
        query: Mapping[str, object],
    ) -> dict[str, object] | None:
        if not path.is_file():
            return None
        try:
            payload = json.loads(zlib.decompress(path.read_bytes()))
            if (
                not isinstance(payload, dict)
                or payload.get("schema_version")
                != "replay-history-aggregate-cache.v1"
                or payload.get("query") != dict(query)
                or not isinstance(payload.get("result"), dict)
                or canonical_sha256(payload["result"])
                != payload.get("result_sha256")
            ):
                return None
            result = payload["result"]
            bars = result.get("bars")
            if not isinstance(bars, list) or not isinstance(
                result.get("has_more"), bool
            ):
                return None
            return {"bars": bars, "has_more": result["has_more"]}
        except (OSError, UnicodeError, ValueError, zlib.error, json.JSONDecodeError):
            return None

    @staticmethod
    def _write_aggregate_cache(
        path: Path,
        query: Mapping[str, object],
        result: Mapping[str, object],
    ) -> None:
        payload = {
            "schema_version": "replay-history-aggregate-cache.v1",
            "query": dict(query),
            "result": dict(result),
            "result_sha256": canonical_sha256(result),
        }
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with temporary.open("xb") as handle:
                handle.write(zlib.compress(canonical_json_bytes(payload), level=6))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError:
            # The derived cache is optional and rebuildable.
            pass
        finally:
            temporary.unlink(missing_ok=True)

    def _aggregate_manifest_range(
        self,
        manifest: ReplayHistoryCatalogManifest,
        objects: Sequence[ReplayHistoryObject],
        *,
        display_interval: str,
        display_ms: int,
        start_ms: int,
        end_ms: int,
        timeline_delta_ms: int,
    ) -> list[dict[str, object]]:
        try:
            import numpy as np
        except ImportError as exc:  # pragma: no cover - pyarrow installs numpy
            raise ReplayHistoryArchiveError(
                "replay-history aggregation requires numpy"
            ) from exc
        _, pq = _load_pyarrow()
        base_ms = manifest.interval_ms
        expected_components = display_ms // base_ms
        anchor = compute_bucket_start_ms(
            0,
            display_ms,
            interval=display_interval,
        )
        buckets: dict[int, dict[str, object]] = {}
        columns = [
            "open_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "quote_volume",
            "trades",
            "taker_buy_base",
            "taker_buy_quote",
        ]
        for item in objects:
            path = self._object_path(item)
            try:
                table = pq.read_table(
                    path,
                    columns=columns,
                    filters=[
                        ("open_time", ">=", start_ms),
                        ("open_time", "<=", end_ms),
                    ],
                )
            except Exception as exc:
                raise ReplayHistoryArchiveError(
                    "replay-history aggregate source could not be read"
                ) from exc
            if not table.num_rows:
                continue
            opens = table["open_time"].combine_chunks().to_numpy(
                zero_copy_only=False
            )
            public_opens = opens + timeline_delta_ms
            keys = ((public_opens - anchor) // display_ms) * display_ms + anchor
            group_starts = np.flatnonzero(
                np.r_[True, keys[1:] != keys[:-1]]
            )
            group_ends = np.r_[group_starts[1:], len(keys)]
            numeric = {
                name: table[name].combine_chunks().to_numpy(zero_copy_only=False)
                for name in ("open", "high", "low", "close", "volume")
            }
            optional = {
                name: table[name].combine_chunks().to_pylist()
                for name in (
                    "quote_volume",
                    "trades",
                    "taker_buy_base",
                    "taker_buy_quote",
                )
            }
            for group_start, group_end in zip(group_starts, group_ends):
                first = int(group_start)
                end = int(group_end)
                bucket = int(keys[first])
                group_opens = opens[first:end]
                contiguous = bool(
                    len(group_opens) < 2
                    or np.all(np.diff(group_opens) == base_ms)
                )

                def optional_sum(name: str) -> float | int | None:
                    values = optional[name][first:end]
                    if any(value is None for value in values):
                        return None
                    if name == "trades":
                        return sum(int(value) for value in values)
                    return math.fsum(float(value) for value in values)

                candidate = {
                    "open": float(numeric["open"][first]),
                    "high": float(np.max(numeric["high"][first:end])),
                    "low": float(np.min(numeric["low"][first:end])),
                    "close": float(numeric["close"][end - 1]),
                    "volume": math.fsum(
                        float(value) for value in numeric["volume"][first:end]
                    ),
                    "quote_volume": optional_sum("quote_volume"),
                    "trades": optional_sum("trades"),
                    "taker_buy_base": optional_sum("taker_buy_base"),
                    "taker_buy_quote": optional_sum("taker_buy_quote"),
                    "first_base_open_ms": int(group_opens[0]),
                    "last_base_open_ms": int(group_opens[-1]),
                    "component_count": end - first,
                    "contiguous": contiguous,
                }
                existing = buckets.get(bucket)
                if existing is None:
                    buckets[bucket] = candidate
                    continue
                if (
                    int(candidate["first_base_open_ms"])
                    != int(existing["last_base_open_ms"]) + base_ms
                ):
                    existing["contiguous"] = False
                existing["high"] = max(
                    float(existing["high"]),
                    float(candidate["high"]),
                )
                existing["low"] = min(
                    float(existing["low"]),
                    float(candidate["low"]),
                )
                existing["close"] = candidate["close"]
                existing["volume"] = math.fsum(
                    (float(existing["volume"]), float(candidate["volume"]))
                )
                for name in (
                    "quote_volume",
                    "taker_buy_base",
                    "taker_buy_quote",
                ):
                    left = existing[name]
                    right = candidate[name]
                    existing[name] = (
                        None
                        if left is None or right is None
                        else math.fsum((float(left), float(right)))
                    )
                existing["trades"] = (
                    None
                    if existing["trades"] is None or candidate["trades"] is None
                    else int(existing["trades"]) + int(candidate["trades"])
                )
                existing["last_base_open_ms"] = candidate["last_base_open_ms"]
                existing["component_count"] = int(
                    existing["component_count"]
                ) + int(candidate["component_count"])
                existing["contiguous"] = bool(
                    existing["contiguous"] and candidate["contiguous"]
                )

        def decimal_text(
            value: object,
            field_name: str,
            *,
            aggregate: bool = False,
        ) -> str:
            numeric = float(value)
            # Imported archive rows are float64. Preserve direct OHLC values;
            # only suppress sub-picounit summation noise on aggregate totals.
            normalized = round(numeric, 12) if aggregate else numeric
            return normalize_decimal_string(
                format(Decimal(str(normalized)), "f"),
                field_name=field_name,
            )

        bars: list[dict[str, object]] = []
        for bucket, value in sorted(buckets.items()):
            first_public = int(value["first_base_open_ms"]) + timeline_delta_ms
            last_public = int(value["last_base_open_ms"]) + timeline_delta_ms
            if (
                not value["contiguous"]
                or int(value["component_count"]) != expected_components
                or first_public != bucket
                or last_public != bucket + display_ms - base_ms
            ):
                continue

            def optional_text(name: str) -> str | None:
                raw = value[name]
                return (
                    None
                    if raw is None
                    else decimal_text(raw, name, aggregate=True)
                )

            bars.append(
                {
                    "open_time_ms": bucket,
                    "close_time_ms": bucket + display_ms - 1,
                    "open": decimal_text(value["open"], "open"),
                    "high": decimal_text(value["high"], "high"),
                    "low": decimal_text(value["low"], "low"),
                    "close": decimal_text(value["close"], "close"),
                    "volume": decimal_text(
                        value["volume"],
                        "volume",
                        aggregate=True,
                    ),
                    "quote_volume": optional_text("quote_volume"),
                    "trades": (
                        None
                        if value["trades"] is None
                        else int(value["trades"])
                    ),
                    "taker_buy_base": optional_text("taker_buy_base"),
                    "taker_buy_quote": optional_text("taker_buy_quote"),
                    "first_base_open_ms": first_public,
                    "last_base_open_ms": last_public,
                    "component_count": expected_components,
                    "expected_components": expected_components,
                    "is_closed": True,
                    "synthetic": False,
                }
            )
        return bars

    def _aggregate_manifest_source_buckets(
        self,
        manifest: ReplayHistoryCatalogManifest,
        objects: Sequence[ReplayHistoryObject],
        *,
        mapper: SourceBucketTimeMapper,
        display_interval: str,
        display_ms: int,
        start_ms: int,
        end_ms: int,
        actual_end_ms: int,
        actual_replay_start_ms: int,
        public_replay_start_ms: int,
        include_partial: bool,
    ) -> list[dict[str, object]]:
        try:
            import numpy as np
        except ImportError as exc:  # pragma: no cover - pyarrow installs numpy
            raise ReplayHistoryArchiveError(
                "replay-history aggregation requires numpy"
            ) from exc
        _, pq = _load_pyarrow()
        base_ms = manifest.interval_ms
        fixed_anchor = mapper.actual_anchor_ms
        buckets: dict[int, dict[str, object]] = {}
        columns = [
            "open_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "quote_volume",
            "trades",
            "taker_buy_base",
            "taker_buy_quote",
        ]
        for item in objects:
            path = self._object_path(item)
            try:
                table = pq.read_table(
                    path,
                    columns=columns,
                    filters=[
                        ("open_time", ">=", start_ms),
                        ("open_time", "<=", end_ms),
                    ],
                )
            except Exception as exc:
                raise ReplayHistoryArchiveError(
                    "replay-history aggregate source could not be read"
                ) from exc
            if not table.num_rows:
                continue
            opens = table["open_time"].combine_chunks().to_numpy(
                zero_copy_only=False
            )
            if mapper.monthly_count is None:
                keys = (
                    ((opens - fixed_anchor) // display_ms) * display_ms
                    + fixed_anchor
                )
            else:
                month_ordinals = (
                    opens.astype("datetime64[ms]")
                    .astype("datetime64[M]")
                    .astype(np.int64)
                )
                anchor_month_ordinal = int(
                    np.datetime64(mapper.actual_anchor_ms, "ms")
                    .astype("datetime64[M]")
                    .astype(np.int64)
                )
                bucket_months = (
                    (
                        (month_ordinals - anchor_month_ordinal)
                        // mapper.monthly_count
                    )
                    * mapper.monthly_count
                    + anchor_month_ordinal
                )
                keys = (
                    bucket_months.astype("datetime64[M]")
                    .astype("datetime64[ms]")
                    .astype(np.int64)
                )
            group_starts = np.flatnonzero(np.r_[True, keys[1:] != keys[:-1]])
            group_ends = np.r_[group_starts[1:], len(keys)]
            numeric = {
                name: table[name].combine_chunks().to_numpy(zero_copy_only=False)
                for name in ("open", "high", "low", "close", "volume")
            }
            optional = {
                name: table[name].combine_chunks().to_pylist()
                for name in (
                    "quote_volume",
                    "trades",
                    "taker_buy_base",
                    "taker_buy_quote",
                )
            }
            for group_start, group_end in zip(group_starts, group_ends):
                first = int(group_start)
                end = int(group_end)
                bucket = int(keys[first])
                group_opens = opens[first:end]
                contiguous = bool(
                    len(group_opens) < 2
                    or np.all(np.diff(group_opens) == base_ms)
                )

                def optional_sum(name: str) -> float | int | None:
                    values = optional[name][first:end]
                    if any(value is None for value in values):
                        return None
                    if name == "trades":
                        return sum(int(value) for value in values)
                    return math.fsum(float(value) for value in values)

                candidate = {
                    "open": float(numeric["open"][first]),
                    "high": float(np.max(numeric["high"][first:end])),
                    "low": float(np.min(numeric["low"][first:end])),
                    "close": float(numeric["close"][end - 1]),
                    "volume": math.fsum(
                        float(value) for value in numeric["volume"][first:end]
                    ),
                    "quote_volume": optional_sum("quote_volume"),
                    "trades": optional_sum("trades"),
                    "taker_buy_base": optional_sum("taker_buy_base"),
                    "taker_buy_quote": optional_sum("taker_buy_quote"),
                    "first_base_open_ms": int(group_opens[0]),
                    "last_base_open_ms": int(group_opens[-1]),
                    "component_count": end - first,
                    "contiguous": contiguous,
                }
                existing = buckets.get(bucket)
                if existing is None:
                    buckets[bucket] = candidate
                    continue
                if (
                    int(candidate["first_base_open_ms"])
                    != int(existing["last_base_open_ms"]) + base_ms
                ):
                    existing["contiguous"] = False
                existing["high"] = max(
                    float(existing["high"]),
                    float(candidate["high"]),
                )
                existing["low"] = min(
                    float(existing["low"]),
                    float(candidate["low"]),
                )
                existing["close"] = candidate["close"]
                existing["volume"] = math.fsum(
                    (float(existing["volume"]), float(candidate["volume"]))
                )
                for name in (
                    "quote_volume",
                    "taker_buy_base",
                    "taker_buy_quote",
                ):
                    left = existing[name]
                    right = candidate[name]
                    existing[name] = (
                        None
                        if left is None or right is None
                        else math.fsum((float(left), float(right)))
                    )
                existing["trades"] = (
                    None
                    if existing["trades"] is None or candidate["trades"] is None
                    else int(existing["trades"]) + int(candidate["trades"])
                )
                existing["last_base_open_ms"] = candidate["last_base_open_ms"]
                existing["component_count"] = int(
                    existing["component_count"]
                ) + int(candidate["component_count"])
                existing["contiguous"] = bool(
                    existing["contiguous"] and candidate["contiguous"]
                )

        def decimal_text(
            value: object,
            field_name: str,
            *,
            aggregate: bool = False,
        ) -> str:
            numeric = float(value)
            normalized = round(numeric, 12) if aggregate else numeric
            return normalize_decimal_string(
                format(Decimal(str(normalized)), "f"),
                field_name=field_name,
            )

        public_revealed_ms = (
            public_replay_start_ms
            + actual_end_ms
            - actual_replay_start_ms
            - 1
        )
        bars: list[dict[str, object]] = []
        for actual_bucket, value in sorted(buckets.items()):
            actual_bucket_end = mapper.actual_bucket_end(actual_bucket)
            duration_ms = actual_bucket_end - actual_bucket
            if duration_ms % base_ms:
                continue
            expected_components = duration_ms // base_ms
            component_count = int(value["component_count"])
            first_actual = int(value["first_base_open_ms"])
            last_actual = int(value["last_base_open_ms"])
            complete = (
                component_count == expected_components
                and last_actual == actual_bucket_end - base_ms
            )
            partial = (
                include_partial
                and not complete
                and component_count < expected_components
                and last_actual + base_ms == actual_end_ms
            )
            if (
                not value["contiguous"]
                or first_actual != actual_bucket
                or not (complete or partial)
            ):
                continue
            public_bucket = mapper.public_from_actual(actual_bucket)
            public_bucket_end = mapper.public_bucket_end(public_bucket)
            public_last_base = min(
                public_bucket_end - base_ms,
                public_bucket + (component_count - 1) * base_ms,
                public_revealed_ms,
            )
            if public_bucket < 0 or public_last_base < public_bucket:
                continue

            def optional_text(name: str) -> str | None:
                raw = value[name]
                return (
                    None
                    if raw is None
                    else decimal_text(raw, name, aggregate=True)
                )

            bars.append(
                {
                    "open_time_ms": public_bucket,
                    "close_time_ms": public_bucket_end - 1,
                    "open": decimal_text(value["open"], "open"),
                    "high": decimal_text(value["high"], "high"),
                    "low": decimal_text(value["low"], "low"),
                    "close": decimal_text(value["close"], "close"),
                    "volume": decimal_text(
                        value["volume"],
                        "volume",
                        aggregate=True,
                    ),
                    "quote_volume": optional_text("quote_volume"),
                    "trades": (
                        None
                        if value["trades"] is None
                        else int(value["trades"])
                    ),
                    "taker_buy_base": optional_text("taker_buy_base"),
                    "taker_buy_quote": optional_text("taker_buy_quote"),
                    "first_base_open_ms": public_bucket,
                    "last_base_open_ms": public_last_base,
                    "component_count": component_count,
                    "expected_components": expected_components,
                    "is_closed": complete,
                    "synthetic": False,
                }
            )
        return bars

    def _refresh(self) -> None:
        pointers = (
            sorted(self.catalogs_dir.glob("*/*/*/*/current.json"))
            if self.catalogs_dir.is_dir()
            else []
        )
        token = tuple(
            (
                str(path.relative_to(self.root)),
                path.stat().st_mtime_ns,
                path.stat().st_size,
            )
            for path in pointers
        )
        with self._lock:
            if token == self._pointer_token:
                return
            current: dict[
                tuple[str, str, str, str], ReplayHistoryCatalogManifest
            ] = {}
            errors: dict[str, str] = {}
            for pointer in pointers:
                pointer_name = pointer.relative_to(self.root).as_posix()
                try:
                    manifest = _manifest_from_pointer(pointer)
                    self._validate_manifest_objects_shallow(manifest)
                except Exception as exc:
                    errors[pointer_name] = f"{type(exc).__name__}: {exc}"[:500]
                    continue
                key = _manifest_key(manifest)
                if key in current:
                    errors[pointer_name] = (
                        "ReplayHistoryArchiveError: duplicate current catalog"
                    )
                    continue
                current[key] = manifest
                self._revision_cache[
                    (*key, manifest.catalog_epoch)
                ] = manifest
            self._current = current
            self._series_errors = errors
            self._pointer_token = token
            self._metrics["refreshes"] += 1

    def _validate_manifest_objects_shallow(
        self,
        manifest: ReplayHistoryCatalogManifest,
    ) -> None:
        for item in manifest.objects:
            path = self._object_path(item)
            try:
                stat = path.stat()
            except OSError as exc:
                raise ReplayHistoryArchiveError(
                    "replay-history object is unavailable"
                ) from exc
            if not path.is_file() or stat.st_size != item.size_bytes:
                raise ReplayHistoryArchiveError(
                    "replay-history object size does not match catalog"
                )

    def _manifest(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str | None,
        market_type: str | None,
        source_revision: str | None = None,
    ) -> ReplayHistoryCatalogManifest:
        self._refresh()
        key = (
            str(exchange or "binance"),
            str(market_type or "spot"),
            validate_identifier(symbol, field_name="symbol"),
            validate_identifier(interval, field_name="interval"),
        )
        with self._lock:
            if source_revision is None:
                manifest = self._current.get(key)
            else:
                revision = _digest(source_revision, "source_revision")
                manifest = self._revision_cache.get((*key, revision))
                if manifest is None:
                    identity = ReplaySeriesIdentity(key[0], key[1], key[2])
                    path = (
                        _catalog_directory(self.root, identity, key[3])
                        / f"{_digest_token(revision)}.json"
                    )
                    manifest = (
                        ReplayHistoryCatalogManifest.from_dict(_read_json(path))
                        if path.is_file()
                        else None
                    )
                    if manifest is not None:
                        if _manifest_key(manifest) != key:
                            raise ReplayHistoryArchiveError(
                                "replay-history revision identity does not match request"
                            )
                        self._revision_cache[(*key, revision)] = manifest
            if manifest is None:
                revision_note = (
                    f" at {source_revision}" if source_revision is not None else ""
                )
                raise ReplayHistoryArchiveError(
                    f"replay-history series is unavailable{revision_note}: "
                    f"{key[0]}:{key[1]}:{key[2]}:{key[3]}"
                )
            return manifest

    def _scan_manifest_gaps(
        self,
        manifest: ReplayHistoryCatalogManifest,
        *,
        start_ms: int | None,
        end_ms: int | None,
        limit: int,
    ) -> dict[str, object]:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("gap scan limit must be positive")
        start = manifest.earliest_open_ms if start_ms is None else int(start_ms)
        end = manifest.latest_open_ms if end_ms is None else int(end_ms)
        with self._lock:
            self._metrics["metadata_gap_scans"] += 1
        if start > end:
            return {
                **manifest.identity.to_dict(),
                "interval": manifest.interval,
                "start_ms": start,
                "end_ms": end,
                "gaps": [],
                "gap_count": 0,
                "missing_bars": 0,
                "scanned_bars": 0,
                "truncated": False,
                "calendar_id": manifest.calendar_id,
                "coverage_indexed": True,
                "source_revision": manifest.catalog_epoch,
            }
        is_v2 = (
            manifest.schema_version == REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2
        )
        if is_v2 and (
            not _source_bucket_is_aligned(
                start,
                interval=manifest.interval,
                interval_ms=manifest.interval_ms,
                alignment_policy=manifest.alignment_policy,
                source_bucket_anchor_ms=manifest.source_bucket_anchor_ms,
            )
            or not _source_bucket_is_aligned(
                end,
                interval=manifest.interval,
                interval_ms=manifest.interval_ms,
                alignment_policy=manifest.alignment_policy,
                source_bucket_anchor_ms=manifest.source_bucket_anchor_ms,
            )
        ):
            raise ReplayHistoryArchiveError(
                "replay-history gap scan bounds are not source-grid aligned"
            )

        def gap_payload(gap_start_ms: int, gap_end_ms: int) -> dict[str, object]:
            if not is_v2:
                return _gap_payload(
                    gap_start_ms,
                    gap_end_ms,
                    manifest.interval_ms,
                )
            return {
                "start_ms": gap_start_ms,
                "end_ms": gap_end_ms,
                "missing_bars": _source_bucket_count(
                    gap_start_ms,
                    gap_end_ms,
                    interval=manifest.interval,
                    interval_ms=manifest.interval_ms,
                    alignment_policy=manifest.alignment_policy,
                ),
                "reason": "replay_archive_gap",
                "status": "detected",
            }

        gaps: list[dict[str, object]] = []
        cursor = start
        present_rows = 0
        for segment in manifest.segments:
            overlap_start = max(start, segment.start_ms)
            overlap_end = min(end, segment.end_ms)
            if overlap_start > overlap_end:
                continue
            if cursor < overlap_start:
                gaps.append(
                    gap_payload(
                        cursor,
                        (
                            _source_bucket_previous_ms(
                                overlap_start,
                                interval=manifest.interval,
                                interval_ms=manifest.interval_ms,
                                alignment_policy=manifest.alignment_policy,
                            )
                            if is_v2
                            else overlap_start - manifest.interval_ms
                        ),
                    )
                )
            present_rows += (
                _source_bucket_count(
                    overlap_start,
                    overlap_end,
                    interval=manifest.interval,
                    interval_ms=manifest.interval_ms,
                    alignment_policy=manifest.alignment_policy,
                )
                if is_v2
                else ((overlap_end - overlap_start) // manifest.interval_ms) + 1
            )
            next_cursor = (
                _source_bucket_next_ms(
                    overlap_end,
                    interval=manifest.interval,
                    interval_ms=manifest.interval_ms,
                    alignment_policy=manifest.alignment_policy,
                )
                if is_v2
                else overlap_end + manifest.interval_ms
            )
            cursor = max(cursor, next_cursor)
        if cursor <= end:
            gaps.append(gap_payload(cursor, end))
        return {
            **manifest.identity.to_dict(),
            "interval": manifest.interval,
            "start_ms": start,
            "end_ms": end,
            "gaps": gaps,
            "gap_count": len(gaps),
            "missing_bars": sum(int(item["missing_bars"]) for item in gaps),
            "scanned_bars": present_rows,
            "truncated": False,
            "calendar_id": manifest.calendar_id,
            "coverage_indexed": True,
            "source_revision": manifest.catalog_epoch,
            "source_bucket_anchor_ms": manifest.source_bucket_anchor_ms,
            "alignment_policy": manifest.alignment_policy,
        }

    def _query_manifest(
        self,
        manifest: ReplayHistoryCatalogManifest,
        *,
        start_ms: int | None,
        end_ms: int | None,
        limit: int | None,
        order: str,
    ) -> list[dict[str, object]]:
        normalized_order = str(order).upper()
        if normalized_order not in {"ASC", "DESC"}:
            raise ValueError("order must be ASC or DESC")
        if limit is not None and (
            isinstance(limit, bool) or not isinstance(limit, int) or limit < 1
        ):
            raise ValueError("query limit must be positive or null")
        start = manifest.earliest_open_ms if start_ms is None else int(start_ms)
        end = manifest.latest_open_ms if end_ms is None else int(end_ms)
        if start > end:
            return []
        objects = [
            item
            for item in manifest.objects
            if item.first_open_ms <= end and item.last_open_ms >= start
        ]
        if normalized_order == "DESC":
            objects.reverse()
        result: list[dict[str, object]] = []
        with self._lock:
            self._metrics["parquet_queries"] += 1
        for item in objects:
            rows = self._read_object(
                manifest,
                item,
                start_ms=start,
                end_ms=end,
            )
            if normalized_order == "DESC":
                rows.reverse()
            result.extend(rows)
            if limit is not None and len(result) >= limit:
                result = result[:limit]
                break
        opens = [int(row["open_time"]) for row in result]
        comparison = (
            (lambda previous, current: current > previous)
            if normalized_order == "ASC"
            else (lambda previous, current: current < previous)
        )
        if any(
            not comparison(previous, current)
            for previous, current in zip(opens, opens[1:])
        ):
            raise ReplayHistoryArchiveError(
                "replay-history query returned overlapping or unordered rows"
            )
        return result

    def _read_object(
        self,
        manifest: ReplayHistoryCatalogManifest,
        item: ReplayHistoryObject,
        *,
        start_ms: int,
        end_ms: int,
    ) -> list[dict[str, object]]:
        path = self._object_path(item)
        self._verify_object(manifest, item, path)
        _, pq = _load_pyarrow()
        try:
            table = pq.read_table(
                path,
                columns=list(_PARQUET_COLUMNS),
                filters=[
                    ("open_time", ">=", start_ms),
                    ("open_time", "<=", end_ms),
                ],
            )
            raw_rows = table.to_pylist()
        except Exception as exc:
            raise ReplayHistoryArchiveError(
                "replay-history Parquet object could not be read"
            ) from exc
        rows = [
            {
                **manifest.identity.to_dict(),
                "interval": manifest.interval,
                **raw,
            }
            for raw in raw_rows
        ]
        rows.sort(key=lambda row: int(row["open_time"]))
        with self._lock:
            self._metrics["parquet_objects_read"] += 1
        return rows

    def _object_path(self, item: ReplayHistoryObject) -> Path:
        candidate = (self.root / item.relative_path).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise ReplayHistoryArchiveError(
                "replay-history object path escapes the archive root"
            ) from exc
        expected = (
            self.objects_dir
            / _digest_token(item.object_sha256)[:2]
            / f"{_digest_token(item.object_sha256)}.parquet"
        )
        if candidate != expected or candidate.is_symlink() or not candidate.is_file():
            raise ReplayHistoryArchiveError(
                "replay-history object path is missing or not content-addressed"
            )
        return candidate

    def _verify_object(
        self,
        manifest: ReplayHistoryCatalogManifest,
        item: ReplayHistoryObject,
        path: Path,
    ) -> None:
        stat = path.stat()
        cached = self._verified_objects.get(path)
        token = (stat.st_mtime_ns, stat.st_size, item.object_sha256)
        if cached == token:
            return
        if stat.st_size != item.size_bytes or _file_sha256(path) != item.object_sha256:
            raise ReplayHistoryArchiveError(
                "replay-history object checksum or size changed"
            )
        _, pq = _load_pyarrow()
        try:
            metadata = pq.read_metadata(path).metadata or {}
        except Exception as exc:
            raise ReplayHistoryArchiveError(
                "replay-history Parquet metadata could not be read"
            ) from exc
        expected = {
            b"replay_schema": REPLAY_HISTORY_PARQUET_SCHEMA_VERSION,
            b"exchange": manifest.identity.exchange,
            b"market_type": manifest.identity.market_type,
            b"symbol": manifest.identity.symbol,
            b"interval": manifest.interval,
            b"source_provider": item.source_provider,
            b"source_object_key": item.source_object_key,
        }
        for key, value in expected.items():
            if metadata.get(key, b"").decode("utf-8", errors="strict") != value:
                raise ReplayHistoryArchiveError(
                    "replay-history Parquet metadata does not match manifest"
                )
        self._verified_objects[path] = token
        with self._lock:
            self._metrics["checksum_verifications"] += 1


def _manifest_key(
    manifest: ReplayHistoryCatalogManifest,
) -> tuple[str, str, str, str]:
    return (
        manifest.identity.exchange,
        manifest.identity.market_type,
        manifest.identity.symbol,
        manifest.interval,
    )


def _manifest_bounds(
    manifest: ReplayHistoryCatalogManifest,
) -> dict[str, object]:
    return {
        "earliest_open_time": manifest.earliest_open_ms,
        "latest_open_time": manifest.latest_open_ms,
        "total_count": manifest.total_count,
        "source_revision": manifest.catalog_epoch,
        "source_bucket_anchor_ms": manifest.source_bucket_anchor_ms,
        "alignment_policy": manifest.alignment_policy,
        "listing_boundary_ms": manifest.listing_boundary_ms,
        "listing_boundary_source": manifest.listing_boundary_source,
    }


def _gap_payload(start_ms: int, end_ms: int, interval_ms: int) -> dict[str, object]:
    if start_ms > end_ms:
        raise ReplayHistoryArchiveError("replay-history gap is reversed")
    return {
        "start_ms": start_ms,
        "end_ms": end_ms,
        "missing_bars": ((end_ms - start_ms) // interval_ms) + 1,
        "reason": "replay_archive_gap",
        "status": "detected",
    }


def _sum_rejection_reasons(
    objects: Sequence[ReplayHistoryObject],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in objects:
        for reason, count in item.source_rejection_reasons:
            counts[reason] = counts.get(reason, 0) + count
    return dict(sorted(counts.items()))


__all__ = [
    "REPLAY_HISTORY_CALENDAR_ID",
    "REPLAY_HISTORY_CATALOG_SCHEMA_VERSION",
    "REPLAY_HISTORY_CATALOG_SCHEMA_VERSION_V2",
    "REPLAY_HISTORY_PARQUET_SCHEMA_VERSION",
    "REPLAY_HISTORY_POINTER_SCHEMA_VERSION",
    "SOURCE_BUCKET_ALIGNMENT_CALENDAR_MONTH",
    "SOURCE_BUCKET_ALIGNMENT_CANONICAL",
    "SOURCE_BUCKET_ALIGNMENT_CATALOG_FIXED",
    "ReplayHistoryArchiveError",
    "ReplayHistoryArchiveRuntimeLease",
    "ReplayHistoryArchiveWriter",
    "ReplayHistoryCatalogManifest",
    "ReplayHistoryImportBatch",
    "ReplayHistoryObject",
    "ReplayHistoryRepository",
    "ReplayHistorySegment",
]
