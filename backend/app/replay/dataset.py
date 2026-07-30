"""Immutable BAR dataset snapshots and bounded active-session ownership."""

from __future__ import annotations

import sys
import threading
from dataclasses import dataclass, fields, is_dataclass, replace
from decimal import Decimal
from types import MappingProxyType
from typing import Mapping

from app.data_engine.interval_policy import last_closed_bar_open_ms, parse_interval_ms, row_is_closed

from .canonical import canonical_sha256
from .catalog import EligibleWindow, ReplayCatalogEntry, ReplaySeriesIdentity
from .errors import ReplayDomainError, ReplayErrorCode
from .models import (
    normalize_decimal_string,
    validate_identifier,
    validate_timestamp_ms,
)


BAR_DATASET_SCHEMA_VERSION = "replay-bar-dataset.v1"
BAR_DATASET_HASH_SCHEMA_VERSION = "replay-bar-dataset-hash.v1"


def _decimal_value(
    value: object,
    *,
    field_name: str,
    positive: bool = False,
) -> str:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{field_name} must be a finite Decimal-compatible value")
    normalized = normalize_decimal_string(str(value), field_name=field_name)
    decimal_value = Decimal(normalized)
    if positive and decimal_value <= 0:
        raise ValueError(f"{field_name} must be positive")
    if not positive and decimal_value < 0:
        raise ValueError(f"{field_name} cannot be negative")
    return normalized


def _optional_decimal(value: object, *, field_name: str) -> str | None:
    if value is None:
        return None
    return _decimal_value(value, field_name=field_name)


@dataclass(frozen=True, slots=True)
class ReplayBar:
    open_time_ms: int
    close_time_ms: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    quote_volume: str | None
    trades: int | None
    taker_buy_base: str | None
    taker_buy_quote: str | None
    source: str

    def to_dict(self) -> dict[str, object]:
        return {
            "open_time_ms": self.open_time_ms,
            "close_time_ms": self.close_time_ms,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "quote_volume": self.quote_volume,
            "trades": self.trades,
            "taker_buy_base": self.taker_buy_base,
            "taker_buy_quote": self.taker_buy_quote,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ReplayBar":
        expected = {
            "open_time_ms",
            "close_time_ms",
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
        }
        if set(payload) != expected:
            raise ValueError("replay BAR fields are incompatible")
        trades = payload["trades"]
        if trades is not None and (
            isinstance(trades, bool) or not isinstance(trades, int) or trades < 0
        ):
            raise ValueError("replay BAR trades must be a non-negative integer or null")
        return cls(
            open_time_ms=validate_timestamp_ms(
                payload["open_time_ms"], field_name="open_time_ms"
            ),
            close_time_ms=validate_timestamp_ms(
                payload["close_time_ms"], field_name="close_time_ms"
            ),
            open=_decimal_value(payload["open"], field_name="open", positive=True),
            high=_decimal_value(payload["high"], field_name="high", positive=True),
            low=_decimal_value(payload["low"], field_name="low", positive=True),
            close=_decimal_value(payload["close"], field_name="close", positive=True),
            volume=_decimal_value(payload["volume"], field_name="volume"),
            quote_volume=_optional_decimal(
                payload["quote_volume"], field_name="quote_volume"
            ),
            trades=trades,
            taker_buy_base=_optional_decimal(
                payload["taker_buy_base"], field_name="taker_buy_base"
            ),
            taker_buy_quote=_optional_decimal(
                payload["taker_buy_quote"], field_name="taker_buy_quote"
            ),
            source=validate_identifier(payload["source"], field_name="source"),
        )


@dataclass(frozen=True, slots=True)
class BarDatasetProvenance:
    repository_backend: str
    identity: ReplaySeriesIdentity
    interval: str
    source_fingerprint: str
    catalog_epoch: str
    source_earliest_open_ms: int
    source_latest_open_ms: int
    source_latest_closed_open_ms: int
    row_count: int
    first_open_ms: int
    last_open_ms: int
    gap_count: int
    gap_scan_bars: int
    calendar_id: str
    hash_schema: str

    def to_dict(self) -> dict[str, object]:
        return {
            "repository_backend": self.repository_backend,
            "identity": self.identity.to_dict(),
            "interval": self.interval,
            "source_fingerprint": self.source_fingerprint,
            "catalog_epoch": self.catalog_epoch,
            "source_earliest_open_ms": self.source_earliest_open_ms,
            "source_latest_open_ms": self.source_latest_open_ms,
            "source_latest_closed_open_ms": self.source_latest_closed_open_ms,
            "row_count": self.row_count,
            "first_open_ms": self.first_open_ms,
            "last_open_ms": self.last_open_ms,
            "gap_count": self.gap_count,
            "gap_scan_bars": self.gap_scan_bars,
            "calendar_id": self.calendar_id,
            "hash_schema": self.hash_schema,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "BarDatasetProvenance":
        expected = {
            "repository_backend",
            "identity",
            "interval",
            "source_fingerprint",
            "catalog_epoch",
            "source_earliest_open_ms",
            "source_latest_open_ms",
            "source_latest_closed_open_ms",
            "row_count",
            "first_open_ms",
            "last_open_ms",
            "gap_count",
            "gap_scan_bars",
            "calendar_id",
            "hash_schema",
        }
        if set(payload) != expected or not isinstance(payload["identity"], Mapping):
            raise ValueError("BAR dataset provenance fields are incompatible")
        integer_fields = (
            "source_earliest_open_ms",
            "source_latest_open_ms",
            "source_latest_closed_open_ms",
            "row_count",
            "first_open_ms",
            "last_open_ms",
            "gap_count",
            "gap_scan_bars",
        )
        values: dict[str, int] = {}
        for name in integer_fields:
            value = payload[name]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"provenance.{name} must be a non-negative integer")
            values[name] = value
        return cls(
            repository_backend=validate_identifier(
                payload["repository_backend"], field_name="repository_backend"
            ),
            identity=ReplaySeriesIdentity.from_dict(payload["identity"]),
            interval=validate_identifier(payload["interval"], field_name="interval"),
            source_fingerprint=str(payload["source_fingerprint"]),
            catalog_epoch=str(payload["catalog_epoch"]),
            calendar_id=validate_identifier(
                payload["calendar_id"], field_name="calendar_id"
            ),
            hash_schema=_nonempty_string(payload["hash_schema"], "hash_schema"),
            **values,
        )


@dataclass(frozen=True, slots=True)
class BarDatasetRef:
    schema_version: str
    data_epoch: str
    identity: ReplaySeriesIdentity
    interval: str
    warmup_start_ms: int
    replay_start_ms: int
    replay_end_open_ms: int
    row_count: int
    repository_backend: str

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "data_epoch": self.data_epoch,
            "identity": self.identity.to_dict(),
            "interval": self.interval,
            "warmup_start_ms": self.warmup_start_ms,
            "replay_start_ms": self.replay_start_ms,
            "replay_end_open_ms": self.replay_end_open_ms,
            "row_count": self.row_count,
            "repository_backend": self.repository_backend,
        }


@dataclass(frozen=True, slots=True)
class BarDatasetSnapshot:
    schema_version: str
    data_epoch: str
    identity: ReplaySeriesIdentity
    interval: str
    rows: tuple[ReplayBar, ...]
    warmup_bars: int
    replay_start_index: int
    replay_start_ms: int
    replay_end_open_ms: int
    provenance: BarDatasetProvenance
    estimated_size_bytes: int

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def warmup_rows(self) -> tuple[ReplayBar, ...]:
        return self.rows[: self.replay_start_index]

    @property
    def replay_rows(self) -> tuple[ReplayBar, ...]:
        return self.rows[self.replay_start_index :]

    def snapshot_ref(self) -> BarDatasetRef:
        return BarDatasetRef(
            schema_version=self.schema_version,
            data_epoch=self.data_epoch,
            identity=self.identity,
            interval=self.interval,
            warmup_start_ms=self.rows[0].open_time_ms,
            replay_start_ms=self.replay_start_ms,
            replay_end_open_ms=self.replay_end_open_ms,
            row_count=self.row_count,
            repository_backend=self.provenance.repository_backend,
        )

    def hash_payload(self) -> dict[str, object]:
        return {
            "schema_version": BAR_DATASET_HASH_SCHEMA_VERSION,
            "identity": self.identity.to_dict(),
            "interval": self.interval,
            "warmup_bars": self.warmup_bars,
            "replay_start_index": self.replay_start_index,
            "replay_start_ms": self.replay_start_ms,
            "replay_end_open_ms": self.replay_end_open_ms,
            "rows": [row.to_dict() for row in self.rows],
            "provenance": self.provenance.to_dict(),
        }

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "data_epoch": self.data_epoch,
            "identity": self.identity.to_dict(),
            "interval": self.interval,
            "rows": [row.to_dict() for row in self.rows],
            "warmup_bars": self.warmup_bars,
            "replay_start_index": self.replay_start_index,
            "replay_start_ms": self.replay_start_ms,
            "replay_end_open_ms": self.replay_end_open_ms,
            "provenance": self.provenance.to_dict(),
            "estimated_size_bytes": self.estimated_size_bytes,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "BarDatasetSnapshot":
        expected = {
            "schema_version",
            "data_epoch",
            "identity",
            "interval",
            "rows",
            "warmup_bars",
            "replay_start_index",
            "replay_start_ms",
            "replay_end_open_ms",
            "provenance",
            "estimated_size_bytes",
        }
        if set(payload) != expected:
            raise ValueError("BAR dataset snapshot fields are incompatible")
        if not isinstance(payload["identity"], Mapping) or not isinstance(
            payload["provenance"], Mapping
        ):
            raise TypeError("BAR dataset identity/provenance must be objects")
        rows_payload = payload["rows"]
        if not isinstance(rows_payload, list) or not rows_payload:
            raise ValueError("BAR dataset rows must be a non-empty array")
        rows = tuple(
            ReplayBar.from_dict(row)
            if isinstance(row, Mapping)
            else (_raise_invalid_row())
            for row in rows_payload
        )
        integer_fields = (
            "warmup_bars",
            "replay_start_index",
            "replay_start_ms",
            "replay_end_open_ms",
            "estimated_size_bytes",
        )
        integers: dict[str, int] = {}
        for name in integer_fields:
            value = payload[name]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"BAR dataset {name} must be a non-negative integer")
            integers[name] = value
        snapshot = cls(
            schema_version=str(payload["schema_version"]),
            data_epoch=str(payload["data_epoch"]),
            identity=ReplaySeriesIdentity.from_dict(payload["identity"]),
            interval=str(payload["interval"]),
            rows=rows,
            provenance=BarDatasetProvenance.from_dict(payload["provenance"]),
            **integers,
        )
        if snapshot.schema_version != BAR_DATASET_SCHEMA_VERSION:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted BAR dataset schema is incompatible",
            )
        if canonical_sha256(snapshot.hash_payload()) != snapshot.data_epoch:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted BAR dataset content hash does not match data_epoch",
            )
        return snapshot


def _raise_invalid_row():
    raise TypeError("BAR dataset row must be an object")


def _nonempty_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field_name} must be a non-empty string")
    return value


def remap_bar_snapshot_time(
    snapshot: BarDatasetSnapshot,
    *,
    synthetic_replay_start_ms: int,
) -> BarDatasetSnapshot:
    """Create an actor-only synthetic timeline while retaining protected epoch."""

    synthetic_start = validate_timestamp_ms(
        synthetic_replay_start_ms,
        field_name="synthetic_replay_start_ms",
    )
    delta = synthetic_start - snapshot.replay_start_ms

    def shifted(value: int) -> int:
        candidate = value + delta
        return validate_timestamp_ms(candidate, field_name="synthetic timestamp")

    rows = tuple(
        replace(
            row,
            open_time_ms=shifted(row.open_time_ms),
            close_time_ms=shifted(row.close_time_ms),
        )
        for row in snapshot.rows
    )
    provenance = replace(
        snapshot.provenance,
        source_earliest_open_ms=shifted(snapshot.provenance.source_earliest_open_ms),
        source_latest_open_ms=shifted(snapshot.provenance.source_latest_open_ms),
        source_latest_closed_open_ms=shifted(
            snapshot.provenance.source_latest_closed_open_ms
        ),
        first_open_ms=shifted(snapshot.provenance.first_open_ms),
        last_open_ms=shifted(snapshot.provenance.last_open_ms),
        repository_backend="replay.synthetic.blind",
    )
    return replace(
        snapshot,
        rows=rows,
        replay_start_ms=synthetic_start,
        replay_end_open_ms=shifted(snapshot.replay_end_open_ms),
        provenance=provenance,
    )


class BarDatasetBuilder:
    def __init__(
        self,
        repository: object,
        *,
        now_ms,
        max_rows: int = 100_000,
        repository_backend: str | None = None,
    ) -> None:
        if max_rows < 1:
            raise ValueError("max_rows must be positive")
        self._repository = repository
        self._now_ms = now_ms
        self._max_rows = max_rows
        self._repository_backend = repository_backend or (
            f"{type(repository).__module__}.{type(repository).__qualname__}"
        )

    def create(
        self,
        entry: ReplayCatalogEntry,
        window: EligibleWindow,
    ) -> BarDatasetSnapshot:
        try:
            snapshot_now_ms = validate_timestamp_ms(self._now_ms(), field_name="now_ms")
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "BAR dataset snapshot clock is invalid",
            ) from exc
        if entry.selected_base_interval is None or entry.bounds is None:
            raise ReplayDomainError(
                ReplayErrorCode.NO_ELIGIBLE_WINDOW,
                "catalog entry has no eligible BAR base interval",
            )
        if window.interval != entry.selected_base_interval:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "eligible window interval does not match catalog entry",
            )
        expected_rows = window.total_rows
        if expected_rows > self._max_rows:
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                f"BAR dataset row count {expected_rows} exceeds limit {self._max_rows}",
                details={"row_count": expected_rows, "limit": self._max_rows},
            )
        interval_ms = parse_interval_ms(window.interval)
        if interval_ms is None or interval_ms != window.interval_ms:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "eligible window interval policy changed",
            )
        last_closed = last_closed_bar_open_ms(snapshot_now_ms, window.interval)
        if last_closed is None or window.replay_end_open_ms > last_closed:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "BAR dataset horizon is not fully closed",
                details={
                    "replay_end_open_ms": window.replay_end_open_ms,
                    "last_closed_open_ms": last_closed,
                },
            )

        gap_result = self._repository.scan_gaps(
            entry.identity.symbol,
            window.interval,
            start_ms=window.warmup_start_ms,
            end_ms=window.replay_end_open_ms,
            exchange=entry.identity.exchange,
            market_type=entry.identity.market_type,
            limit=expected_rows,
        )
        if gap_result.get("error") or gap_result.get("truncated"):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "BAR dataset gap revalidation did not complete",
                details={"gap_result": dict(gap_result)},
            )
        if int(gap_result.get("gap_count", 0)) != 0:
            raise ReplayDomainError(
                ReplayErrorCode.DATA_GAP,
                "BAR dataset range contains a gap",
                details={"gaps": list(gap_result.get("gaps", []))},
            )

        raw_rows = self._repository.query_bars(
            entry.identity.symbol,
            window.interval,
            start_ms=window.warmup_start_ms,
            end_ms=window.replay_end_open_ms,
            limit=expected_rows + 1,
            order="ASC",
            exchange=entry.identity.exchange,
            market_type=entry.identity.market_type,
        )
        if len(raw_rows) != expected_rows:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                f"BAR dataset row count mismatch: expected {expected_rows}, got {len(raw_rows)}",
            )
        try:
            opens = [int(row.get("open_time", -1)) for row in raw_rows]
        except (AttributeError, TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "BAR open_time is invalid",
            ) from exc
        if any(current <= previous for previous, current in zip(opens, opens[1:])):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "BAR dataset open times must be strictly increasing",
            )

        rows: list[ReplayBar] = []
        for index, raw in enumerate(raw_rows):
            expected_open = window.warmup_start_ms + index * interval_ms
            rows.append(
                self._validate_row(
                    raw,
                    entry=entry,
                    interval_ms=interval_ms,
                    expected_open_ms=expected_open,
                    now_ms=snapshot_now_ms,
                )
            )
        immutable_rows = tuple(rows)
        provenance = BarDatasetProvenance(
            repository_backend=self._repository_backend,
            identity=entry.identity,
            interval=window.interval,
            source_fingerprint=entry.source_fingerprint,
            catalog_epoch=entry.catalog_epoch,
            source_earliest_open_ms=entry.bounds.earliest_open_ms,
            source_latest_open_ms=entry.bounds.latest_source_open_ms,
            source_latest_closed_open_ms=entry.bounds.latest_closed_open_ms,
            row_count=len(immutable_rows),
            first_open_ms=immutable_rows[0].open_time_ms,
            last_open_ms=immutable_rows[-1].open_time_ms,
            gap_count=int(gap_result.get("gap_count", 0)),
            gap_scan_bars=int(gap_result.get("scanned_bars", 0)),
            calendar_id=str(gap_result.get("calendar_id", "")),
            hash_schema=BAR_DATASET_HASH_SCHEMA_VERSION,
        )
        payload = {
            "schema_version": BAR_DATASET_HASH_SCHEMA_VERSION,
            "identity": entry.identity.to_dict(),
            "interval": window.interval,
            "warmup_bars": window.warmup_bars,
            "replay_start_index": window.warmup_bars,
            "replay_start_ms": window.replay_start_ms,
            "replay_end_open_ms": window.replay_end_open_ms,
            "rows": [row.to_dict() for row in immutable_rows],
            "provenance": provenance.to_dict(),
        }
        data_epoch = canonical_sha256(payload)
        estimated_size_bytes = _deep_size(
            (
                entry.identity,
                window.interval,
                immutable_rows,
                provenance,
                data_epoch,
            )
        )
        return BarDatasetSnapshot(
            schema_version=BAR_DATASET_SCHEMA_VERSION,
            data_epoch=data_epoch,
            identity=entry.identity,
            interval=window.interval,
            rows=immutable_rows,
            warmup_bars=window.warmup_bars,
            replay_start_index=window.warmup_bars,
            replay_start_ms=window.replay_start_ms,
            replay_end_open_ms=window.replay_end_open_ms,
            provenance=provenance,
            estimated_size_bytes=estimated_size_bytes,
        )

    @staticmethod
    def _validate_row(
        raw: Mapping[str, object],
        *,
        entry: ReplayCatalogEntry,
        interval_ms: int,
        expected_open_ms: int,
        now_ms: int,
    ) -> ReplayBar:
        return validate_replay_repository_bar(
            raw,
            identity=entry.identity,
            interval=entry.selected_base_interval,
            interval_ms=interval_ms,
            expected_open_ms=expected_open_ms,
            now_ms=now_ms,
        )


def validate_replay_repository_bar(
    raw: Mapping[str, object],
    *,
    identity: ReplaySeriesIdentity,
    interval: str,
    interval_ms: int,
    expected_open_ms: int,
    now_ms: int,
) -> ReplayBar:
    """Validate one repository row before it enters any replay projection."""

    try:
        open_time_ms = int(raw["open_time"])
        close_time_ms = int(raw["close_time"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            "BAR open_time/close_time is invalid",
        ) from exc
    if open_time_ms != expected_open_ms:
        raise ReplayDomainError(
            ReplayErrorCode.DATA_GAP,
            f"BAR open_time sequence gap: expected {expected_open_ms}, got {open_time_ms}",
        )
    expected_close = open_time_ms + interval_ms - 1
    if close_time_ms != expected_close or close_time_ms >= now_ms:
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            "BAR close_time does not identify a fully closed interval",
        )
    if not row_is_closed(dict(raw), default=True):
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            "BAR row is marked forming rather than closed",
        )
    for field_name, expected in (
        ("exchange", identity.exchange),
        ("market_type", identity.market_type),
        ("symbol", identity.symbol),
        ("interval", interval),
    ):
        actual = raw.get(field_name)
        if actual is not None and str(actual) != expected:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                f"BAR {field_name} does not match catalog identity",
            )
    try:
        open_value = _decimal_value(raw.get("open"), field_name="open", positive=True)
        high_value = _decimal_value(raw.get("high"), field_name="high", positive=True)
        low_value = _decimal_value(raw.get("low"), field_name="low", positive=True)
        close_value = _decimal_value(raw.get("close"), field_name="close", positive=True)
        volume = _decimal_value(raw.get("volume"), field_name="volume")
        quote_volume = _optional_decimal(
            raw.get("quote_volume"), field_name="quote_volume"
        )
        taker_buy_base = _optional_decimal(
            raw.get("taker_buy_base"), field_name="taker_buy_base"
        )
        taker_buy_quote = _optional_decimal(
            raw.get("taker_buy_quote"), field_name="taker_buy_quote"
        )
    except (TypeError, ValueError) as exc:
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            f"BAR {exc}",
        ) from exc
    open_decimal = Decimal(open_value)
    high_decimal = Decimal(high_value)
    low_decimal = Decimal(low_value)
    close_decimal = Decimal(close_value)
    if (
        high_decimal < max(open_decimal, close_decimal)
        or low_decimal > min(open_decimal, close_decimal)
        or low_decimal > high_decimal
    ):
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            "BAR OHLC relationship is invalid",
        )
    trades_raw = raw.get("trades")
    if trades_raw is None:
        trades = None
    elif (
        isinstance(trades_raw, bool)
        or not isinstance(trades_raw, int)
        or trades_raw < 0
    ):
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            "BAR trades must be a non-negative integer or null",
        )
    else:
        trades = trades_raw
    source = raw.get("source", "unknown")
    try:
        source_value = validate_identifier(source, field_name="source")
    except (TypeError, ValueError) as exc:
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            "BAR source identifier is invalid",
        ) from exc
    return ReplayBar(
        open_time_ms=open_time_ms,
        close_time_ms=close_time_ms,
        open=open_value,
        high=high_value,
        low=low_value,
        close=close_value,
        volume=volume,
        quote_volume=quote_volume,
        trades=trades,
        taker_buy_base=taker_buy_base,
        taker_buy_quote=taker_buy_quote,
        source=source_value,
    )


class BarDatasetPool:
    """Bounded active-session ownership; never evicts an active snapshot."""

    def __init__(self, *, max_active_snapshots: int, max_total_bytes: int) -> None:
        if max_active_snapshots < 1 or max_total_bytes < 1:
            raise ValueError("snapshot pool limits must be positive")
        self._max_active_snapshots = max_active_snapshots
        self._max_total_bytes = max_total_bytes
        self._snapshots: dict[str, BarDatasetSnapshot] = {}
        self._total_bytes = 0
        self._lock = threading.RLock()

    def pin(self, session_id: str, snapshot: BarDatasetSnapshot) -> None:
        normalized_id = validate_identifier(session_id, field_name="session_id")
        with self._lock:
            if normalized_id in self._snapshots:
                raise ReplayDomainError(
                    ReplayErrorCode.REVISION_CONFLICT,
                    "session already owns a BAR dataset snapshot",
                )
            if len(self._snapshots) >= self._max_active_snapshots:
                raise ReplayDomainError(
                    ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                    "active BAR dataset session limit exceeded",
                    details={"limit": self._max_active_snapshots},
                )
            projected_bytes = self._total_bytes + snapshot.estimated_size_bytes
            if projected_bytes > self._max_total_bytes:
                raise ReplayDomainError(
                    ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                    "BAR dataset memory budget exceeded",
                    details={
                        "projected_bytes": projected_bytes,
                        "limit_bytes": self._max_total_bytes,
                    },
                )
            self._snapshots[normalized_id] = snapshot
            self._total_bytes = projected_bytes

    def get(self, session_id: str) -> BarDatasetSnapshot | None:
        with self._lock:
            return self._snapshots.get(session_id)

    def release(self, session_id: str) -> BarDatasetSnapshot | None:
        with self._lock:
            snapshot = self._snapshots.pop(session_id, None)
            if snapshot is not None:
                self._total_bytes -= snapshot.estimated_size_bytes
            return snapshot

    def diagnostics(self) -> Mapping[str, int]:
        with self._lock:
            return MappingProxyType(
                {
                    "active_sessions": len(self._snapshots),
                    "max_active_sessions": self._max_active_snapshots,
                    "total_estimated_bytes": self._total_bytes,
                    "max_total_bytes": self._max_total_bytes,
                }
            )


def _deep_size(value: object, seen: set[int] | None = None) -> int:
    visited = seen if seen is not None else set()
    identity = id(value)
    if identity in visited:
        return 0
    visited.add(identity)
    size = sys.getsizeof(value)
    if is_dataclass(value) and not isinstance(value, type):
        return size + sum(
            _deep_size(getattr(value, field.name), visited) for field in fields(value)
        )
    if isinstance(value, Mapping):
        return size + sum(
            _deep_size(key, visited) + _deep_size(child, visited)
            for key, child in value.items()
        )
    if isinstance(value, (tuple, list, set, frozenset)):
        return size + sum(_deep_size(child, visited) for child in value)
    return size
