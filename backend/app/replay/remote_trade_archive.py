"""Official availability catalog and on-demand cache for aggTrade replay."""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable, Mapping

from app.data_engine.storage.raw_trade_archive import (
    BAR_COMPATIBILITY_SCHEMA_VERSION,
    ParquetRawAggTradeArchive,
    RawAggTradeSelectionWindow,
    RawAggTradeDatasetRef,
    RawAggTradeObjectManifest,
    RawAggTradePage,
    VerifiedRawAggTradeBarWindow,
    VerifiedRawAggTradeWindow,
    VERIFIED_IMPORT_SCHEMA_VERSION,
    VerifiedRawAggTradeDay,
    _canonical_sha256,
)

from .canonical import canonical_sha256
from .history_archive import ReplayHistoryArchiveError, _atomic_write_json, _file_sha256
from .remote_history import ReplayHistoryOrigin, ReplayHistoryOriginUnavailable
from .trade_import import (
    BINANCE_PUBLIC_DATA_ORIGIN,
    import_official_date_range,
    list_official_agg_trade_days,
    official_agg_trade_urls,
)


REPLAY_AGG_TRADE_REMOTE_INDEX_SCHEMA_VERSION = "replay-agg-trade-remote-index.v2"
_REPLAY_AGG_TRADE_REMOTE_INDEX_V1 = "replay-agg-trade-remote-index.v1"
OFFICIAL_AGG_TRADE_AVAILABILITY_SCHEMA_VERSION = (
    "replay-agg-trade-official-availability.v1"
)
_MAX_INDEX_BYTES = 16 * 1024 * 1024
_MAX_METADATA_BYTES = 64 * 1024 * 1024
_MAX_PARQUET_BODY_BYTES = 2 * 1024 * 1024 * 1024
_DAY_MS = 86_400_000


def _safe_relative_path(value: object) -> str:
    text = str(value)
    if (
        not text
        or "\\" in text
        or Path(text).is_absolute()
        or any(part in {"", ".", ".."} for part in text.split("/"))
    ):
        raise ReplayHistoryArchiveError("remote aggTrade path is unsafe")
    return text


@dataclass(frozen=True, slots=True)
class RemoteAggTradeMetadataObject:
    path: str
    sha256: str

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "sha256": self.sha256}

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "RemoteAggTradeMetadataObject":
        if set(payload) != {"path", "sha256"}:
            raise ReplayHistoryArchiveError(
                "remote aggTrade metadata object fields are incompatible"
            )
        value = cls(
            path=_safe_relative_path(payload["path"]),
            sha256=str(payload["sha256"]),
        )
        if len(value.sha256) != 64:
            raise ReplayHistoryArchiveError("remote aggTrade metadata checksum is invalid")
        try:
            int(value.sha256, 16)
        except ValueError as exc:
            raise ReplayHistoryArchiveError(
                "remote aggTrade metadata checksum is invalid"
            ) from exc
        return value


@dataclass(frozen=True, slots=True)
class OfficialAggTradeDailyRange:
    start_date: str
    end_date: str

    def __post_init__(self) -> None:
        start = _parse_date(self.start_date, "official availability start_date")
        end = _parse_date(self.end_date, "official availability end_date")
        if start > end:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability date range is inverted"
            )

    @property
    def start(self) -> date:
        return date.fromisoformat(self.start_date)

    @property
    def end(self) -> date:
        return date.fromisoformat(self.end_date)

    @property
    def day_count(self) -> int:
        return (self.end - self.start).days + 1

    def contains(self, value: date) -> bool:
        return self.start <= value <= self.end

    def to_dict(self) -> dict[str, str]:
        return {"start_date": self.start_date, "end_date": self.end_date}

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "OfficialAggTradeDailyRange":
        if set(payload) != {"start_date", "end_date"}:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability range fields are incompatible"
            )
        return cls(
            start_date=str(payload["start_date"]),
            end_date=str(payload["end_date"]),
        )


@dataclass(frozen=True, slots=True)
class OfficialAggTradeAvailability:
    exchange: str
    market_type: str
    symbol: str
    ranges: tuple[OfficialAggTradeDailyRange, ...]
    catalog_epoch: str
    generated_at_ms: int

    def hash_payload(self) -> dict[str, object]:
        return {
            "schema_version": OFFICIAL_AGG_TRADE_AVAILABILITY_SCHEMA_VERSION,
            "identity": {
                "exchange": self.exchange,
                "market_type": self.market_type,
                "symbol": self.symbol,
            },
            "source_origin": BINANCE_PUBLIC_DATA_ORIGIN,
            "ranges": [item.to_dict() for item in self.ranges],
        }

    def to_dict(self) -> dict[str, object]:
        return {
            **self.hash_payload(),
            "catalog_epoch": self.catalog_epoch,
            "generated_at_ms": self.generated_at_ms,
        }

    @classmethod
    def from_dict(
        cls, payload: Mapping[str, object]
    ) -> "OfficialAggTradeAvailability":
        expected = {
            "schema_version",
            "identity",
            "source_origin",
            "ranges",
            "catalog_epoch",
            "generated_at_ms",
        }
        if set(payload) != expected:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability fields are incompatible"
            )
        if payload["schema_version"] != OFFICIAL_AGG_TRADE_AVAILABILITY_SCHEMA_VERSION:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability schema is incompatible"
            )
        if payload["source_origin"] != BINANCE_PUBLIC_DATA_ORIGIN:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability origin is not trusted"
            )
        identity = payload["identity"]
        if not isinstance(identity, Mapping) or set(identity) != {
            "exchange",
            "market_type",
            "symbol",
        }:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability identity is invalid"
            )
        exchange = str(identity["exchange"]).lower()
        market_type = str(identity["market_type"]).lower()
        symbol = str(identity["symbol"]).upper()
        official_agg_trade_urls(
            market_type=market_type,
            symbol=symbol,
            day=date(2000, 1, 1),
        )
        if exchange != "binance":
            raise ReplayHistoryArchiveError(
                "official aggTrade availability exchange is unsupported"
            )
        raw_ranges = payload["ranges"]
        if not isinstance(raw_ranges, list) or not raw_ranges:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability ranges are invalid"
            )
        ranges = tuple(
            OfficialAggTradeDailyRange.from_dict(item)
            if isinstance(item, Mapping)
            else _raise_archive(
                "official aggTrade availability range must be an object"
            )
            for item in raw_ranges
        )
        previous_end: date | None = None
        for item in ranges:
            if previous_end is not None and item.start <= previous_end + timedelta(days=1):
                raise ReplayHistoryArchiveError(
                    "official aggTrade availability ranges overlap or are not compressed"
                )
            previous_end = item.end
        generated = payload["generated_at_ms"]
        if isinstance(generated, bool) or not isinstance(generated, int) or generated < 0:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability generated_at_ms is invalid"
            )
        value = cls(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            ranges=ranges,
            catalog_epoch=str(payload["catalog_epoch"]),
            generated_at_ms=generated,
        )
        if canonical_sha256(value.hash_payload()) != value.catalog_epoch:
            raise ReplayHistoryArchiveError(
                "official aggTrade availability does not match catalog_epoch"
            )
        return value


@dataclass(frozen=True, slots=True)
class RemoteAggTradeIndex:
    index_epoch: str
    generated_at_ms: int
    compatibility_indexes: tuple[RemoteAggTradeMetadataObject, ...]
    verified_receipts: tuple[RemoteAggTradeMetadataObject, ...]
    official_availability_indexes: tuple[RemoteAggTradeMetadataObject, ...] = ()
    schema_version: str = REPLAY_AGG_TRADE_REMOTE_INDEX_SCHEMA_VERSION

    def hash_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "compatibility_indexes": [
                item.to_dict() for item in self.compatibility_indexes
            ],
            "verified_receipts": [item.to_dict() for item in self.verified_receipts],
            **(
                {
                    "official_availability_indexes": [
                        item.to_dict() for item in self.official_availability_indexes
                    ]
                }
                if self.schema_version == REPLAY_AGG_TRADE_REMOTE_INDEX_SCHEMA_VERSION
                else {}
            ),
        }

    def to_dict(self) -> dict[str, object]:
        return {
            **self.hash_payload(),
            "index_epoch": self.index_epoch,
            "generated_at_ms": self.generated_at_ms,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "RemoteAggTradeIndex":
        schema_version = str(payload.get("schema_version"))
        expected = {
            "schema_version",
            "index_epoch",
            "generated_at_ms",
            "compatibility_indexes",
            "verified_receipts",
        }
        if schema_version == REPLAY_AGG_TRADE_REMOTE_INDEX_SCHEMA_VERSION:
            expected.add("official_availability_indexes")
        if set(payload) != expected:
            raise ReplayHistoryArchiveError(
                "remote aggTrade index fields are incompatible"
            )
        if schema_version not in {
            _REPLAY_AGG_TRADE_REMOTE_INDEX_V1,
            REPLAY_AGG_TRADE_REMOTE_INDEX_SCHEMA_VERSION,
        }:
            raise ReplayHistoryArchiveError("remote aggTrade index schema is incompatible")
        compatibility = _metadata_objects(payload["compatibility_indexes"])
        receipts = _metadata_objects(payload["verified_receipts"])
        availability = (
            _metadata_objects(payload["official_availability_indexes"])
            if schema_version == REPLAY_AGG_TRADE_REMOTE_INDEX_SCHEMA_VERSION
            else ()
        )
        if not receipts and not availability:
            raise ReplayHistoryArchiveError(
                "remote aggTrade index requires receipts or official availability"
            )
        generated = payload["generated_at_ms"]
        if isinstance(generated, bool) or not isinstance(generated, int) or generated < 0:
            raise ReplayHistoryArchiveError("remote aggTrade generated_at_ms is invalid")
        value = cls(
            index_epoch=str(payload["index_epoch"]),
            generated_at_ms=generated,
            compatibility_indexes=compatibility,
            verified_receipts=receipts,
            official_availability_indexes=availability,
            schema_version=schema_version,
        )
        if canonical_sha256(value.hash_payload()) != value.index_epoch:
            raise ReplayHistoryArchiveError(
                "remote aggTrade index does not match index_epoch"
            )
        return value


def _metadata_objects(value: object) -> tuple[RemoteAggTradeMetadataObject, ...]:
    if not isinstance(value, list):
        raise ReplayHistoryArchiveError("remote aggTrade metadata list is invalid")
    items = tuple(
        RemoteAggTradeMetadataObject.from_dict(item)
        if isinstance(item, Mapping)
        else _raise_archive("remote aggTrade metadata entry must be an object")
        for item in value
    )
    if tuple(sorted(items, key=lambda item: item.path)) != items:
        raise ReplayHistoryArchiveError("remote aggTrade metadata must be ordered")
    if len({item.path for item in items}) != len(items):
        raise ReplayHistoryArchiveError("remote aggTrade metadata paths are duplicated")
    return items


def _raise_archive(message: str):
    raise ReplayHistoryArchiveError(message)


@dataclass(frozen=True, slots=True)
class _CompatibilityRecord:
    dataset_ref: RawAggTradeDatasetRef
    interval: str
    interval_ms: int
    bar_source_revision: str
    parity_policy: Mapping[str, object]
    windows: tuple[VerifiedRawAggTradeBarWindow, ...]
    index_epoch: str


@dataclass(frozen=True, slots=True)
class _ReceiptRecord:
    path: str
    metadata: VerifiedRawAggTradeDay
    manifests: tuple[RawAggTradeObjectManifest, ...]
    start_time_ms: int
    end_time_ms: int


class RemoteRawAggTradeArchive:
    """Select from official metadata and cache only selected daily bodies."""

    enabled = True

    def __init__(
        self,
        cache_root: str | Path,
        origin_uri: str | Path,
        *,
        refresh_seconds: float = 300.0,
        download_timeout_seconds: float = 60.0,
        page_rows: int = 50_000,
        official_opener: Callable[..., BinaryIO] = urllib.request.urlopen,
    ) -> None:
        if refresh_seconds < 0:
            raise ValueError("remote aggTrade refresh interval cannot be negative")
        self.root = Path(cache_root).expanduser().resolve()
        self.origin = ReplayHistoryOrigin(
            origin_uri,
            timeout_seconds=download_timeout_seconds,
        )
        if self.origin.root is not None and self.origin.root == self.root:
            raise ValueError("remote aggTrade origin and cache must be different")
        self.cache = ParquetRawAggTradeArchive(
            self.root,
            read_only=True,
            max_scan_rows=max(1_000_000, int(page_rows) * 20),
        )
        self._refresh_seconds = float(refresh_seconds)
        self._download_timeout_seconds = float(download_timeout_seconds)
        self._official_opener = official_opener
        self._next_refresh = 0.0
        self._lock = threading.RLock()
        self._partition_locks: dict[str, threading.Lock] = {}
        self._index: RemoteAggTradeIndex | None = None
        self._compatibility: tuple[_CompatibilityRecord, ...] = ()
        self._receipt_payloads: dict[str, Mapping[str, object]] = {}
        self._receipt_manifests: dict[
            str, tuple[RawAggTradeObjectManifest, ...]
        ] = {}
        self._receipts: tuple[_ReceiptRecord, ...] = ()
        self._availability: tuple[OfficialAggTradeAvailability, ...] = ()
        self._metadata_fallback = False
        self._metrics = {
            "remote_index_refreshes": 0,
            "remote_metadata_cache_fallbacks": 0,
            "materialized_partitions": 0,
            "materialized_objects": 0,
            "materialized_bytes": 0,
            "materialization_failures": 0,
            "official_days_downloaded": 0,
            "official_rows_imported": 0,
            "official_cache_hits": 0,
        }
        self._refresh()

    def _refresh(self) -> None:
        now = time.monotonic()
        with self._lock:
            if self._index is not None and now < self._next_refresh:
                return
        try:
            (
                index,
                compatibility_payloads,
                receipt_payloads,
                availability_payloads,
            ) = self._load_origin_metadata()
            self._cache_metadata(
                index,
                compatibility_payloads,
                receipt_payloads,
                availability_payloads,
            )
            fallback = False
        except ReplayHistoryOriginUnavailable:
            (
                index,
                compatibility_payloads,
                receipt_payloads,
                availability_payloads,
            ) = self._load_cached_metadata()
            fallback = True
        records = tuple(
            self._parse_compatibility(payload) for payload in compatibility_payloads.values()
        )
        receipt_manifests, receipts = self._validate_metadata_bindings(
            records,
            receipt_payloads,
        )
        availability = self._parse_availability_payloads(availability_payloads)
        with self._lock:
            self._index = index
            self._compatibility = records
            self._receipt_payloads = dict(receipt_payloads)
            self._receipt_manifests = receipt_manifests
            self._receipts = receipts
            self._availability = availability
            self._metadata_fallback = fallback
            self._next_refresh = now + self._refresh_seconds
            self._metrics["remote_index_refreshes"] += 1
            if fallback:
                self._metrics["remote_metadata_cache_fallbacks"] += 1

    def _load_origin_metadata(
        self,
    ) -> tuple[
        RemoteAggTradeIndex,
        dict[str, Mapping[str, object]],
        dict[str, Mapping[str, object]],
        dict[str, Mapping[str, object]],
    ]:
        index = RemoteAggTradeIndex.from_dict(
            self.origin.read_json("trade-index.json", max_bytes=_MAX_INDEX_BYTES)
        )
        compatibility = {
            item.path: self._read_bound_remote_json(item)
            for item in index.compatibility_indexes
        }
        receipts = {
            item.path: self._read_bound_remote_json(item)
            for item in index.verified_receipts
        }
        availability = {
            item.path: self._read_bound_remote_json(item)
            for item in index.official_availability_indexes
        }
        return index, compatibility, receipts, availability

    def _read_bound_remote_json(
        self,
        item: RemoteAggTradeMetadataObject,
    ) -> Mapping[str, object]:
        encoded = self.origin.read_bytes(item.path, max_bytes=_MAX_METADATA_BYTES)
        if _sha256_bytes(encoded) != item.sha256:
            raise ReplayHistoryArchiveError(
                "remote aggTrade metadata checksum does not match its index"
            )
        try:
            payload = json.loads(encoded.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReplayHistoryArchiveError("remote aggTrade metadata is unreadable") from exc
        if not isinstance(payload, Mapping):
            raise ReplayHistoryArchiveError("remote aggTrade metadata must be an object")
        canonical = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        if _sha256_bytes(canonical) != item.sha256:
            raise ReplayHistoryArchiveError(
                "remote aggTrade metadata must use canonical JSON"
            )
        return payload

    def _cache_metadata(
        self,
        index: RemoteAggTradeIndex,
        compatibility: Mapping[str, Mapping[str, object]],
        receipts: Mapping[str, Mapping[str, object]],
        availability: Mapping[str, Mapping[str, object]],
    ) -> None:
        metadata_root = self.root / "_remote_metadata"
        for relative, payload in {
            **compatibility,
            **receipts,
            **availability,
        }.items():
            _atomic_write_json(metadata_root / relative, payload)
        _atomic_write_json(metadata_root / "trade-index.json", index.to_dict())

    def _load_cached_metadata(
        self,
    ) -> tuple[
        RemoteAggTradeIndex,
        dict[str, Mapping[str, object]],
        dict[str, Mapping[str, object]],
        dict[str, Mapping[str, object]],
    ]:
        metadata_root = self.root / "_remote_metadata"
        index_path = metadata_root / "trade-index.json"
        if not index_path.is_file():
            raise ReplayHistoryOriginUnavailable(
                "remote aggTrade metadata is unavailable and no cache exists"
            )
        index = RemoteAggTradeIndex.from_dict(_read_json(index_path))
        compatibility = {
            item.path: self._read_bound_cached_json(metadata_root, item)
            for item in index.compatibility_indexes
        }
        receipts = {
            item.path: self._read_bound_cached_json(metadata_root, item)
            for item in index.verified_receipts
        }
        availability = {
            item.path: self._read_bound_cached_json(metadata_root, item)
            for item in index.official_availability_indexes
        }
        return index, compatibility, receipts, availability

    @staticmethod
    def _read_bound_cached_json(
        metadata_root: Path,
        item: RemoteAggTradeMetadataObject,
    ) -> Mapping[str, object]:
        path = metadata_root / item.path
        if (
            not path.is_file()
            or _file_sha256(path).removeprefix("sha256:") != item.sha256
        ):
            raise ReplayHistoryArchiveError(
                "cached remote aggTrade metadata failed checksum validation"
            )
        return _read_json(path)

    @staticmethod
    def _parse_availability_payloads(
        payloads: Mapping[str, Mapping[str, object]],
    ) -> tuple[OfficialAggTradeAvailability, ...]:
        records: list[OfficialAggTradeAvailability] = []
        identities: set[tuple[str, str, str]] = set()
        for relative_path, payload in payloads.items():
            record = OfficialAggTradeAvailability.from_dict(payload)
            expected_path = _official_availability_path(
                exchange=record.exchange,
                market_type=record.market_type,
                symbol=record.symbol,
            )
            if relative_path != expected_path:
                raise ReplayHistoryArchiveError(
                    "official aggTrade availability path does not match its identity"
                )
            identity = (record.exchange, record.market_type, record.symbol)
            if identity in identities:
                raise ReplayHistoryArchiveError(
                    "official aggTrade availability identity is duplicated"
                )
            identities.add(identity)
            records.append(record)
        return tuple(
            sorted(
                records,
                key=lambda item: (item.exchange, item.market_type, item.symbol),
            )
        )

    @staticmethod
    def _parse_compatibility(payload: Mapping[str, object]) -> _CompatibilityRecord:
        expected = {
            "schema_version",
            "identity",
            "interval",
            "interval_ms",
            "bar_source_revision",
            "parity_policy",
            "raw_dataset_ref",
            "checked_bar_count",
            "mismatch_bar_count",
            "compatible_windows",
            "index_epoch",
        }
        if set(payload) != expected or payload.get("schema_version") != BAR_COMPATIBILITY_SCHEMA_VERSION:
            raise ReplayHistoryArchiveError(
                "remote aggTrade compatibility proof schema is invalid"
            )
        unsigned = {key: value for key, value in payload.items() if key != "index_epoch"}
        if str(payload["index_epoch"]) != _canonical_sha256(unsigned):
            raise ReplayHistoryArchiveError(
                "remote aggTrade compatibility proof hash is invalid"
            )
        if not isinstance(payload["raw_dataset_ref"], Mapping):
            raise ReplayHistoryArchiveError(
                "remote aggTrade compatibility dataset ref is invalid"
            )
        dataset_ref = RawAggTradeDatasetRef.from_dict(payload["raw_dataset_ref"])
        identity = payload["identity"]
        if identity != {
            "exchange": dataset_ref.exchange,
            "market_type": dataset_ref.market_type,
            "symbol": dataset_ref.symbol,
        }:
            raise ReplayHistoryArchiveError(
                "remote aggTrade compatibility identity changed"
            )
        expected_epoch = ParquetRawAggTradeArchive._dataset_epoch(
            identity=(dataset_ref.exchange, dataset_ref.market_type, dataset_ref.symbol),
            start_time_ms=dataset_ref.start_time_ms,
            end_time_ms=dataset_ref.end_time_ms,
            first_agg_trade_id=dataset_ref.expected_first_agg_trade_id,
            last_agg_trade_id=dataset_ref.expected_last_agg_trade_id,
            objects=dataset_ref.objects,
        )
        if expected_epoch != dataset_ref.data_epoch:
            raise ReplayHistoryArchiveError(
                "remote aggTrade compatibility dataset epoch changed"
            )
        raw_windows = payload["compatible_windows"]
        if not isinstance(raw_windows, list) or any(
            not isinstance(item, Mapping) for item in raw_windows
        ):
            raise ReplayHistoryArchiveError(
                "remote aggTrade compatible windows are invalid"
            )
        windows = tuple(
            VerifiedRawAggTradeBarWindow(**item) for item in raw_windows
        )
        interval_ms = int(payload["interval_ms"])
        ParquetRawAggTradeArchive._validate_bar_compatibility_windows(
            windows,
            dataset_ref=dataset_ref,
            interval_ms=interval_ms,
            checked_bar_count=int(payload["checked_bar_count"]),
            mismatch_bar_count=int(payload["mismatch_bar_count"]),
        )
        policy = payload["parity_policy"]
        if not isinstance(policy, Mapping):
            raise ReplayHistoryArchiveError("remote aggTrade parity policy is invalid")
        return _CompatibilityRecord(
            dataset_ref=dataset_ref,
            interval=str(payload["interval"]),
            interval_ms=interval_ms,
            bar_source_revision=str(payload["bar_source_revision"]),
            parity_policy=dict(policy),
            windows=windows,
            index_epoch=str(payload["index_epoch"]),
        )

    @staticmethod
    def _validate_metadata_bindings(
        records: tuple[_CompatibilityRecord, ...],
        receipt_payloads: Mapping[str, Mapping[str, object]],
    ) -> tuple[
        dict[str, tuple[RawAggTradeObjectManifest, ...]],
        tuple[_ReceiptRecord, ...],
    ]:
        receipt_manifests: dict[
            str, tuple[RawAggTradeObjectManifest, ...]
        ] = {}
        receipt_records: list[_ReceiptRecord] = []
        object_bindings: dict[str, RawAggTradeObjectManifest] = {}
        for receipt_path, payload in receipt_payloads.items():
            if (
                set(payload) != {"schema_version", "metadata", "objects"}
                or payload.get("schema_version") != VERIFIED_IMPORT_SCHEMA_VERSION
                or not isinstance(payload.get("metadata"), Mapping)
                or not isinstance(payload.get("objects"), list)
                or not payload["objects"]
            ):
                raise ReplayHistoryArchiveError(
                    "remote aggTrade receipt schema is invalid"
                )
            try:
                metadata = VerifiedRawAggTradeDay(**payload["metadata"])
                manifests = tuple(
                    RawAggTradeObjectManifest.from_dict(item)
                    if isinstance(item, Mapping)
                    else _raise_archive(
                        "remote aggTrade receipt object is invalid"
                    )
                    for item in payload["objects"]
                )
            except (TypeError, ValueError) as exc:
                raise ReplayHistoryArchiveError(
                    "remote aggTrade receipt content is invalid"
                ) from exc
            expected_partition = (
                f"exchange={metadata.exchange}/market_type={metadata.market_type}/"
                f"symbol={metadata.symbol}/date={metadata.date}"
            )
            if receipt_path != f"{expected_partition}/_verified_import.json":
                raise ReplayHistoryArchiveError(
                    "remote aggTrade receipt path does not match its metadata"
                )
            for item in manifests:
                if Path(item.object_id).parent.as_posix() != expected_partition:
                    raise ReplayHistoryArchiveError(
                        "remote aggTrade receipt object escaped its partition"
                    )
                existing = object_bindings.setdefault(item.object_id, item)
                if existing != item:
                    raise ReplayHistoryArchiveError(
                        "remote aggTrade object has conflicting receipts"
                    )
            ordered = tuple(sorted(manifests, key=lambda item: item.min_agg_trade_id))
            if (
                sum(item.row_count for item in ordered) != metadata.row_count
                or ordered[0].min_agg_trade_id != metadata.first_agg_trade_id
                or ordered[-1].max_agg_trade_id != metadata.last_agg_trade_id
                or min(item.min_trade_time_ms for item in ordered)
                != metadata.first_trade_time_ms
                or max(item.max_trade_time_ms for item in ordered)
                != metadata.last_trade_time_ms
                or any(
                    item.row_count != item.max_agg_trade_id - item.min_agg_trade_id + 1
                    or item.source_quality != "binance_public_checksum"
                    or item.source_checksum_sha256
                    != metadata.source_checksum_sha256
                    for item in ordered
                )
                or any(
                    current.min_agg_trade_id != previous.max_agg_trade_id + 1
                    for previous, current in zip(ordered, ordered[1:], strict=False)
                )
            ):
                raise ReplayHistoryArchiveError(
                    "remote aggTrade receipt bounds do not match its objects"
                )
            receipt_manifests[receipt_path] = manifests
            day_start_ms = int(
                datetime.strptime(metadata.date, "%Y-%m-%d")
                .replace(tzinfo=timezone.utc)
                .timestamp()
                * 1_000
            )
            receipt_records.append(
                _ReceiptRecord(
                    path=receipt_path,
                    metadata=metadata,
                    manifests=manifests,
                    start_time_ms=day_start_ms,
                    end_time_ms=day_start_ms + _DAY_MS - 1,
                )
            )
        for record in records:
            for item in record.dataset_ref.objects:
                receipt_path = (
                    Path(item.object_id).parent / "_verified_import.json"
                ).as_posix()
                if (
                    receipt_path not in receipt_manifests
                    or object_bindings.get(item.object_id) != item
                ):
                    raise ReplayHistoryArchiveError(
                        "remote aggTrade compatibility proof is not bound to a receipt"
                    )
        receipt_records.sort(
            key=lambda item: (
                item.metadata.exchange,
                item.metadata.market_type,
                item.metadata.symbol,
                item.start_time_ms,
            )
        )
        return receipt_manifests, tuple(receipt_records)

    def list_verified_identities(self) -> list[dict[str, str]]:
        """List identities available from receipts or the official catalog."""

        self._refresh()
        with self._lock:
            identities = {
                (
                    item.metadata.exchange,
                    item.metadata.market_type,
                    item.metadata.symbol,
                )
                for item in self._receipts
            }
            identities.update(
                (item.exchange, item.market_type, item.symbol)
                for item in self._availability
            )
        return [
            {"exchange": item[0], "market_type": item[1], "symbol": item[2]}
            for item in sorted(identities)
        ]

    def list_verified_windows(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
    ) -> tuple[VerifiedRawAggTradeWindow, ...]:
        """Return receipt-proven coverage without consulting the body cache."""

        self._refresh()
        identity = (
            str(exchange).lower(),
            str(market_type).lower(),
            str(symbol).upper(),
        )
        with self._lock:
            receipts = tuple(
                item
                for item in self._receipts
                if (
                    item.metadata.exchange,
                    item.metadata.market_type,
                    item.metadata.symbol,
                )
                == identity
            )
        merged: list[VerifiedRawAggTradeWindow] = []
        for receipt in receipts:
            current = VerifiedRawAggTradeWindow(
                start_time_ms=receipt.start_time_ms,
                end_time_ms=receipt.end_time_ms,
                first_agg_trade_id=receipt.metadata.first_agg_trade_id,
                last_agg_trade_id=receipt.metadata.last_agg_trade_id,
                partition_count=1,
            )
            if (
                merged
                and current.start_time_ms == merged[-1].end_time_ms + 1
                and current.first_agg_trade_id == merged[-1].last_agg_trade_id + 1
            ):
                previous = merged[-1]
                merged[-1] = VerifiedRawAggTradeWindow(
                    start_time_ms=previous.start_time_ms,
                    end_time_ms=current.end_time_ms,
                    first_agg_trade_id=previous.first_agg_trade_id,
                    last_agg_trade_id=current.last_agg_trade_id,
                    partition_count=previous.partition_count + 1,
                )
            else:
                merged.append(current)
        return tuple(merged)

    def list_selection_windows(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
    ) -> tuple[RawAggTradeSelectionWindow, ...]:
        """Return official daily availability independently of cached bodies."""

        return self.selection_snapshot(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
        )[1]

    def selection_snapshot(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
    ) -> tuple[str, tuple[RawAggTradeSelectionWindow, ...]]:
        """Atomically bind selection coverage to its metadata revision."""

        self._refresh()
        identity = (
            str(exchange).lower(),
            str(market_type).lower(),
            str(symbol).upper(),
        )
        with self._lock:
            index = self._index
            availability = next(
                (
                    item
                    for item in self._availability
                    if (item.exchange, item.market_type, item.symbol) == identity
                ),
                None,
            )
        if availability is None:
            if index is None:
                raise ReplayHistoryArchiveError(
                    "remote aggTrade selection index is unavailable"
                )
            return (
                index.index_epoch,
                tuple(
                    RawAggTradeSelectionWindow(
                        start_time_ms=item.start_time_ms,
                        end_time_ms=item.end_time_ms,
                        partition_count=item.partition_count,
                    )
                    for item in self.list_verified_windows(
                        exchange=exchange,
                        market_type=market_type,
                        symbol=symbol,
                    )
                )
            )
        return (
            availability.catalog_epoch,
            tuple(
                RawAggTradeSelectionWindow(
                    start_time_ms=_day_start_ms(item.start),
                    end_time_ms=_day_start_ms(item.end) + _DAY_MS - 1,
                    partition_count=item.day_count,
                )
                for item in availability.ranges
            ),
        )

    def list_verified_bar_windows(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        interval_ms: int,
        bar_source_revision: str,
        parity_policy: Mapping[str, object],
    ) -> tuple[VerifiedRawAggTradeBarWindow, ...]:
        self._refresh()
        normalized_policy = json.loads(
            json.dumps(dict(parity_policy), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        )
        with self._lock:
            records = [
                item
                for item in self._compatibility
                if (
                    item.dataset_ref.exchange,
                    item.dataset_ref.market_type,
                    item.dataset_ref.symbol,
                    item.interval,
                    item.interval_ms,
                    item.bar_source_revision,
                    item.parity_policy,
                )
                == (
                    str(exchange).lower(),
                    str(market_type).lower(),
                    str(symbol).upper(),
                    str(interval),
                    int(interval_ms),
                    str(bar_source_revision),
                    normalized_policy,
                )
            ]
        records.sort(
            key=lambda item: (
                item.dataset_ref.start_time_ms,
                item.dataset_ref.end_time_ms,
                item.index_epoch,
            )
        )
        previous_end: int | None = None
        combined: list[VerifiedRawAggTradeBarWindow] = []
        for item in records:
            if previous_end is not None and item.dataset_ref.start_time_ms <= previous_end:
                raise ReplayHistoryArchiveError(
                    "remote aggTrade compatibility proofs overlap"
                )
            previous_end = item.dataset_ref.end_time_ms
            combined.extend(item.windows)
        return tuple(combined)

    def freeze_dataset(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int,
        end_time_ms: int,
        page_rows: int = 50_000,
    ) -> RawAggTradeDatasetRef:
        self._refresh()
        identity = (str(exchange).lower(), str(market_type).lower(), str(symbol).upper())
        requested_days = _utc_days(start_time_ms, end_time_ms)
        with self._lock:
            receipts_by_day = {
                item.metadata.date: item
                for item in self._receipts
                if (
                    item.metadata.exchange,
                    item.metadata.market_type,
                    item.metadata.symbol,
                )
                == identity
            }
            availability = next(
                (
                    item
                    for item in self._availability
                    if (item.exchange, item.market_type, item.symbol) == identity
                ),
                None,
            )
        if any(
            day.isoformat() not in receipts_by_day
            and (
                availability is None
                or not any(item.contains(day) for item in availability.ranges)
            )
            for day in requested_days
        ):
            raise RuntimeError(
                "remote aggTrade catalog does not continuously cover the selected range"
            )
        cached_windows = self.cache.list_verified_windows(
            exchange=identity[0],
            market_type=identity[1],
            symbol=identity[2],
        )
        try:
            for day in requested_days:
                day_start_ms = _day_start_ms(day)
                if any(
                    item.start_time_ms <= day_start_ms
                    and item.end_time_ms >= day_start_ms + _DAY_MS - 1
                    for item in cached_windows
                ):
                    with self._lock:
                        self._metrics["official_cache_hits"] += 1
                    continue
                receipt = receipts_by_day.get(day.isoformat())
                if receipt is not None:
                    self._materialize_receipt(receipt.path)
                else:
                    self._materialize_official_day(
                        exchange=identity[0],
                        market_type=identity[1],
                        symbol=identity[2],
                        day=day,
                    )
        except BaseException:
            with self._lock:
                self._metrics["materialization_failures"] += 1
            raise
        return self.cache.freeze_dataset(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            page_rows=page_rows,
        )

    def _materialize_official_day(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        day: date,
    ) -> None:
        receipt_path = (
            f"exchange={exchange}/market_type={market_type}/symbol={symbol}/"
            f"date={day.isoformat()}/_verified_import.json"
        )
        with self._lock:
            partition_lock = self._partition_locks.setdefault(
                receipt_path,
                threading.Lock(),
            )
        with partition_lock:
            # A concurrent preparation may have finished while this caller was
            # waiting.  Revalidate the immutable receipt before avoiding I/O.
            day_start_ms = _day_start_ms(day)
            if any(
                item.start_time_ms <= day_start_ms
                and item.end_time_ms >= day_start_ms + _DAY_MS - 1
                for item in self.cache.list_verified_windows(
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                )
            ):
                with self._lock:
                    self._metrics["official_cache_hits"] += 1
                return
            report = import_official_date_range(
                archive_dir=self.root,
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                start=day,
                end=day,
                require_checksum=True,
                download_timeout_seconds=self._download_timeout_seconds,
                opener=self._official_opener,
            )
            raw_days = report.get("days")
            if not isinstance(raw_days, list) or len(raw_days) != 1:
                raise ReplayHistoryArchiveError(
                    "official aggTrade import report is incomplete"
                )
            imported = raw_days[0]
            if not isinstance(imported, Mapping):
                raise ReplayHistoryArchiveError(
                    "official aggTrade import report day is invalid"
                )
            with self._lock:
                self._metrics["official_days_downloaded"] += 1
                self._metrics["official_rows_imported"] += int(
                    imported.get("accepted_rows", 0)
                )

    def _materialize_receipt(self, receipt_path: str) -> None:
        with self._lock:
            payload = self._receipt_payloads.get(receipt_path)
            manifests = self._receipt_manifests.get(receipt_path)
            index = self._index
            partition_lock = self._partition_locks.setdefault(
                receipt_path,
                threading.Lock(),
            )
        if payload is None or manifests is None or index is None:
            raise ReplayHistoryArchiveError(
                "remote aggTrade receipt is not indexed"
            )
        with partition_lock:
            for item in manifests:
                if (Path(item.object_id).parent / "_verified_import.json").as_posix() != receipt_path:
                    raise ReplayHistoryArchiveError(
                        "remote aggTrade receipt object escaped its partition"
                    )
                self._materialize_file(item.object_id, item.parquet_sha256)
                self._materialize_file(
                    f"{item.object_id}.manifest.json",
                    item.manifest_sha256,
                )
            receipt_item = next(
                (item for item in index.verified_receipts if item.path == receipt_path),
                None,
            )
            if receipt_item is None:
                raise ReplayHistoryArchiveError("remote aggTrade receipt index is missing")
            receipt_destination = self._cache_path(receipt_path)
            encoded = json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            if _sha256_bytes(encoded) != receipt_item.sha256:
                # Published receipts already use canonical compact JSON.  A
                # non-canonical source is fetched verbatim to retain its hash.
                encoded = self.origin.read_bytes(
                    receipt_path,
                    max_bytes=_MAX_METADATA_BYTES,
                )
            if _sha256_bytes(encoded) != receipt_item.sha256:
                raise ReplayHistoryArchiveError("remote aggTrade receipt hash changed")
            _atomic_write_bytes(receipt_destination, encoded)
            with self._lock:
                self._metrics["materialized_partitions"] += 1

    def _materialize_file(self, relative_path: str, expected_sha256: str) -> None:
        destination = self._cache_path(relative_path)
        if destination.is_file():
            if _file_sha256(destination).removeprefix("sha256:") != expected_sha256:
                destination.unlink()
            else:
                return
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.root / f".remote-{uuid.uuid4().hex}.tmp"
        try:
            self.origin.fetch_object(
                relative_path,
                temporary,
                max_bytes=(
                    _MAX_METADATA_BYTES
                    if relative_path.endswith(".manifest.json")
                    else _MAX_PARQUET_BODY_BYTES
                ),
            )
            if _file_sha256(temporary).removeprefix("sha256:") != expected_sha256:
                raise ReplayHistoryArchiveError(
                    "downloaded aggTrade object failed checksum validation"
                )
            size = temporary.stat().st_size
            os.replace(temporary, destination)
            with self._lock:
                self._metrics["materialized_objects"] += 1
                self._metrics["materialized_bytes"] += size
        finally:
            temporary.unlink(missing_ok=True)

    def _cache_path(self, relative_path: str) -> Path:
        safe = _safe_relative_path(relative_path)
        destination = (self.root / safe).resolve()
        try:
            destination.relative_to(self.root)
        except ValueError as exc:
            raise ReplayHistoryArchiveError("remote aggTrade cache path escaped") from exc
        if destination.is_symlink():
            raise ReplayHistoryArchiveError("remote aggTrade cache path is a symlink")
        return destination

    def diagnostics(self) -> dict[str, Any]:
        self._refresh()
        with self._lock:
            official_day_count = sum(
                date_range.day_count
                for catalog in self._availability
                for date_range in catalog.ranges
            )
            return {
                "enabled": True,
                "state": "ready",
                "backend": "raw-agg-trade.remote-cache.v2",
                "origin_kind": self.origin.kind,
                "origin": self.origin.base_uri,
                "remote_index_epoch": None if self._index is None else self._index.index_epoch,
                "remote_metadata_fallback": self._metadata_fallback,
                "verified_partitions_available": bool(
                    self._receipt_payloads or self._availability
                ),
                "official_daily_archives_available": bool(self._availability),
                "official_daily_archive_count": official_day_count,
                "compatibility_proofs_available": bool(self._compatibility),
                "selection_basis": (
                    "official_daily_availability"
                    if self._availability
                    else "verified_receipts"
                ),
                "bar_parity_required": False,
                **self._metrics,
            }

    def scan_range(self, **kwargs: Any) -> list[dict[str, Any]]:
        return self.cache.scan_range(**kwargs)

    def scan_page(self, **kwargs: Any) -> RawAggTradePage:
        return self.cache.scan_page(**kwargs)

    def coverage(self, **kwargs: Any):
        return self.cache.coverage(**kwargs)

    def validate_dataset(self, dataset_ref: RawAggTradeDatasetRef) -> None:
        self.cache.validate_dataset(dataset_ref)

    def pin_dataset(self, dataset_ref: RawAggTradeDatasetRef) -> str:
        return self.cache.pin_dataset(dataset_ref)

    def release_dataset(self, pin_token: str) -> None:
        self.cache.release_dataset(pin_token)

    def append(self, rows: Iterable[dict[str, Any]]) -> int:
        del rows
        raise RuntimeError("remote aggTrade replay cache is read-only")

    def import_verified_day(self, *args: Any, **kwargs: Any) -> int:
        del args, kwargs
        raise RuntimeError("remote aggTrade replay cache is read-only")

    def publish_bar_compatibility(self, **kwargs: Any) -> dict[str, object]:
        del kwargs
        raise RuntimeError("remote aggTrade replay cache is read-only")


def sync_official_agg_trade_availability(
    origin_root: str | Path,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    as_of_date: date | None = None,
    timeout_seconds: float = 60.0,
    now_ms: int | None = None,
    opener: Callable[..., BinaryIO] = urllib.request.urlopen,
) -> OfficialAggTradeAvailability:
    """Publish a checksum-pair-proven official daily availability catalog."""

    normalized_exchange = str(exchange).strip().lower()
    normalized_market = str(market_type).strip().lower()
    normalized_symbol = str(symbol).strip().upper()
    if normalized_exchange != "binance":
        raise ReplayHistoryArchiveError(
            "official aggTrade availability supports Binance only"
        )
    days = list_official_agg_trade_days(
        market_type=normalized_market,
        symbol=normalized_symbol,
        as_of_date=as_of_date,
        timeout_seconds=timeout_seconds,
        opener=opener,
    )
    ranges = _compress_dates(days)
    generated = int(time.time() * 1_000) if now_ms is None else int(now_ms)
    draft = OfficialAggTradeAvailability(
        exchange=normalized_exchange,
        market_type=normalized_market,
        symbol=normalized_symbol,
        ranges=ranges,
        catalog_epoch="sha256:" + "0" * 64,
        generated_at_ms=generated,
    )
    catalog = OfficialAggTradeAvailability(
        exchange=draft.exchange,
        market_type=draft.market_type,
        symbol=draft.symbol,
        ranges=draft.ranges,
        catalog_epoch=canonical_sha256(draft.hash_payload()),
        generated_at_ms=generated,
    )
    root = Path(origin_root).expanduser().resolve()
    destination = root / _official_availability_path(
        exchange=catalog.exchange,
        market_type=catalog.market_type,
        symbol=catalog.symbol,
    )
    _atomic_write_json(destination, catalog.to_dict())
    return OfficialAggTradeAvailability.from_dict(catalog.to_dict())


def publish_remote_agg_trade_index(
    origin_root: str | Path,
    *,
    now_ms: int | None = None,
) -> RemoteAggTradeIndex:
    root = Path(origin_root).expanduser().resolve()
    compatibility_paths = sorted(
        path
        for path in (root / "_bar_compatibility").rglob("*.json")
        if path.is_file()
    )
    receipt_paths = sorted(
        path for path in root.rglob("_verified_import.json") if path.is_file()
    )
    availability_paths = sorted(
        path
        for path in (root / "_official_availability").rglob("availability.json")
        if path.is_file()
    )
    if not receipt_paths and not availability_paths:
        raise ReplayHistoryArchiveError(
            "cannot publish remote aggTrade index without receipts or official availability"
        )
    compatibility = tuple(
        RemoteAggTradeMetadataObject(
            path=path.relative_to(root).as_posix(),
            sha256=_file_sha256(path).removeprefix("sha256:"),
        )
        for path in compatibility_paths
    )
    receipts = tuple(
        RemoteAggTradeMetadataObject(
            path=path.relative_to(root).as_posix(),
            sha256=_file_sha256(path).removeprefix("sha256:"),
        )
        for path in receipt_paths
    )
    availability = tuple(
        RemoteAggTradeMetadataObject(
            path=path.relative_to(root).as_posix(),
            sha256=_file_sha256(path).removeprefix("sha256:"),
        )
        for path in availability_paths
    )
    generated = int(time.time() * 1_000) if now_ms is None else int(now_ms)
    draft = RemoteAggTradeIndex(
        index_epoch="sha256:" + "0" * 64,
        generated_at_ms=generated,
        compatibility_indexes=compatibility,
        verified_receipts=receipts,
        official_availability_indexes=availability,
    )
    index = RemoteAggTradeIndex(
        index_epoch=canonical_sha256(draft.hash_payload()),
        generated_at_ms=generated,
        compatibility_indexes=compatibility,
        verified_receipts=receipts,
        official_availability_indexes=availability,
    )
    _atomic_write_json(root / "trade-index.json", index.to_dict())
    return RemoteAggTradeIndex.from_dict(index.to_dict())


def _read_json(path: Path) -> Mapping[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReplayHistoryArchiveError("remote aggTrade cached JSON is unreadable") from exc
    if not isinstance(payload, Mapping):
        raise ReplayHistoryArchiveError("remote aggTrade cached JSON is invalid")
    return payload


def _official_availability_path(
    *, exchange: str, market_type: str, symbol: str
) -> str:
    return (
        f"_official_availability/exchange={exchange}/market_type={market_type}/"
        f"symbol={symbol}/availability.json"
    )


def _parse_date(value: object, label: str) -> date:
    text = str(value)
    try:
        parsed = date.fromisoformat(text)
    except ValueError as exc:
        raise ReplayHistoryArchiveError(f"{label} must use YYYY-MM-DD") from exc
    if parsed.isoformat() != text:
        raise ReplayHistoryArchiveError(f"{label} must use canonical YYYY-MM-DD")
    return parsed


def _compress_dates(values: Iterable[date]) -> tuple[OfficialAggTradeDailyRange, ...]:
    ordered = tuple(sorted(set(values)))
    if not ordered:
        raise ReplayHistoryArchiveError(
            "official aggTrade availability cannot be empty"
        )
    ranges: list[OfficialAggTradeDailyRange] = []
    range_start = ordered[0]
    range_end = ordered[0]
    for current in ordered[1:]:
        if current == range_end + timedelta(days=1):
            range_end = current
            continue
        ranges.append(
            OfficialAggTradeDailyRange(range_start.isoformat(), range_end.isoformat())
        )
        range_start = current
        range_end = current
    ranges.append(
        OfficialAggTradeDailyRange(range_start.isoformat(), range_end.isoformat())
    )
    return tuple(ranges)


def _day_start_ms(value: date) -> int:
    return int(
        datetime.combine(value, datetime.min.time(), tzinfo=timezone.utc).timestamp()
        * 1_000
    )


def _utc_days(start_time_ms: int, end_time_ms: int) -> tuple[date, ...]:
    if start_time_ms > end_time_ms:
        raise ReplayHistoryArchiveError("aggTrade materialization range is inverted")
    start = datetime.fromtimestamp(start_time_ms / 1_000, tz=timezone.utc).date()
    end = datetime.fromtimestamp(end_time_ms / 1_000, tz=timezone.utc).date()
    values: list[date] = []
    current = start
    while current <= end:
        values.append(current)
        current += timedelta(days=1)
    return tuple(values)


def _atomic_write_bytes(path: Path, encoded: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _sha256_bytes(value: bytes) -> str:
    import hashlib

    return hashlib.sha256(value).hexdigest()


__all__ = [
    "OFFICIAL_AGG_TRADE_AVAILABILITY_SCHEMA_VERSION",
    "REPLAY_AGG_TRADE_REMOTE_INDEX_SCHEMA_VERSION",
    "OfficialAggTradeAvailability",
    "OfficialAggTradeDailyRange",
    "RemoteAggTradeIndex",
    "RemoteRawAggTradeArchive",
    "publish_remote_agg_trade_index",
    "sync_official_agg_trade_availability",
]
