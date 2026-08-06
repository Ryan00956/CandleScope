"""Verified, replay-owned historical L2 archives for BOOK_ASSISTED_REQUIRED.

This module deliberately does not import or reuse the live full-order-book
engine.  A historical archive is an immutable, operator-captured SQLite file
whose snapshot and Binance USD-M diff-depth deltas are validated before the
archive can be bound to a TrainingRun.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
import threading
import uuid
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from contextlib import closing
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from app.replay.broker.models import canonical_decimal
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.storage.sqlite_store import ReplaySQLiteStore

from .errors import TrainingRunError
from .control import compatible_step_interval_ms
from .models import CapabilityState, StartMode, TrainingRunCreateRequest


ARCHIVE_PROTOCOL = "replay.historical-book.archive.v1"
ARCHIVE_SCHEMA_VERSION = "replay.historical-book.binance-usdm.v1"
ARCHIVE_ADAPTER_KIND = "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1"
BOOK_GC_PROTOCOL = "replay.historical-book.gc.v1"
ARCHIVE_SOURCE_CONTRACT_URL = (
    "https://developers.binance.com/en/docs/products/"
    "derivatives-trading-usds-futures/websocket-market-streams/"
    "How-to-manage-a-local-order-book-correctly"
)
BOOK_EXECUTION_FIDELITY = "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE"
HISTORICAL_L2_LIQUIDATION_FIDELITY = "HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1"
BOOK_PROJECTION_DEPTH = 5_000
BOOK_PROJECTION_CACHE_MAX_TRACKS = 32

_BookRow = sqlite3.Row | Mapping[str, object]

_META_COLUMNS = (
    "singleton",
    "protocol",
    "schema_version",
    "exchange",
    "market_type",
    "symbol",
    "range_start_ms",
    "range_end_ms",
    "dataset_epoch",
    "source",
    "source_contract_url",
    "max_depth_levels",
)
_FRAME_COLUMNS = (
    "ordinal",
    "kind",
    "event_time_ms",
    "transaction_time_ms",
    "first_update_id",
    "final_update_id",
    "previous_final_update_id",
    "bids_json",
    "asks_json",
)


@dataclass(frozen=True, slots=True)
class HistoricalBookArchiveDescriptor:
    archive_id: str
    identity_key: str
    exchange: str
    market_type: str
    symbol: str
    range_start_ms: int
    range_end_ms: int
    dataset_epoch: str
    checksum_sha256: str
    byte_size: int
    snapshot_count: int
    delta_count: int
    max_depth_levels: int
    trusted_origin: str
    trusted_source_path: str


@dataclass(frozen=True, slots=True)
class HistoricalBookProjection:
    archive_id: str
    actual_time_ms: int
    virtual_time_ms: int
    last_update_id: int
    bids: tuple[tuple[str, str], ...]
    asks: tuple[tuple[str, str], ...]
    book_hash: str

    def to_storage(self) -> dict[str, object]:
        return {
            "archive_id": self.archive_id,
            "capability_state": CapabilityState.AVAILABLE_EXACT.value,
            "status": "READY",
            "execution_fidelity": BOOK_EXECUTION_FIDELITY,
            "queue_exact": 0,
            "as_of_actual_ms": self.actual_time_ms,
            "as_of_virtual_ms": self.virtual_time_ms,
            "last_update_id": self.last_update_id,
            "bids_json": canonical_json([list(level) for level in self.bids]),
            "asks_json": canonical_json([list(level) for level in self.asks]),
            "book_hash": self.book_hash,
            "message": "连续历史 L2 已验证；成交仍不声明真实排队位置",
        }


@dataclass(frozen=True, slots=True)
class PreparedHistoricalBookBinding:
    descriptor: HistoricalBookArchiveDescriptor
    projection: HistoricalBookProjection


@dataclass(slots=True)
class _ReconstructionState:
    target_ms: int
    previous_ordinal: int
    previous_event_time_ms: int
    previous_u: int
    bids: dict[Decimal, Decimal]
    asks: dict[Decimal, Decimal]
    snapshot_count: int
    delta_count: int


@dataclass(slots=True)
class _ProjectionCacheEntry:
    archive_id: str
    generation: int
    checksum_sha256: str
    state: _ReconstructionState


def _digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _counter(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return value


def _digest(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a SHA-256 digest")
    raw = value.removeprefix("sha256:")
    if len(raw) != 64 or any(character not in "0123456789abcdef" for character in raw):
        raise ValueError(f"{field_name} must be a lowercase SHA-256 digest")
    return f"sha256:{raw}"


def _read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(
        f"{path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def _assert_columns(
    connection: sqlite3.Connection,
    table: str,
    expected: Sequence[str],
) -> None:
    rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    actual = tuple(str(row[1]) for row in rows)
    if actual != tuple(expected):
        raise ValueError(f"historical book {table} schema is incompatible")


def _levels(
    raw: object,
    *,
    field_name: str,
    allow_zero: bool,
    max_levels: int,
) -> tuple[tuple[str, str], ...]:
    try:
        value = json.loads(str(raw))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} must be valid JSON") from exc
    if not isinstance(value, list) or len(value) > max_levels:
        raise ValueError(f"{field_name} exceeds the archive depth budget")
    parsed: list[tuple[str, str]] = []
    seen: set[str] = set()
    for index, level in enumerate(value):
        if not isinstance(level, list) or len(level) != 2:
            raise ValueError(f"{field_name}[{index}] must be [price, quantity]")
        price = canonical_decimal(
            level[0], field_name=f"{field_name}[{index}].price", positive=True
        )
        quantity = canonical_decimal(
            level[1],
            field_name=f"{field_name}[{index}].quantity",
            nonnegative=allow_zero,
            positive=not allow_zero,
        )
        if price in seen:
            raise ValueError(f"{field_name} contains a duplicate price")
        seen.add(price)
        parsed.append((price, quantity))
    return tuple(parsed)


def _apply_levels(
    book: dict[Decimal, Decimal],
    updates: Sequence[tuple[str, str]],
) -> None:
    for raw_price, raw_quantity in updates:
        price = Decimal(raw_price)
        quantity = Decimal(raw_quantity)
        if quantity == 0:
            book.pop(price, None)
        else:
            book[price] = quantity


def _assert_uncrossed(
    bids: Mapping[Decimal, Decimal],
    asks: Mapping[Decimal, Decimal],
) -> None:
    if not bids or not asks:
        raise ValueError("historical book cannot lose an entire side")
    if max(bids) >= min(asks):
        raise ValueError("historical book is crossed or locked")


def _assert_book_depth(
    bids: Mapping[Decimal, Decimal],
    asks: Mapping[Decimal, Decimal],
    *,
    max_depth: int,
) -> None:
    if len(bids) > max_depth or len(asks) > max_depth:
        raise ValueError("historical book resident depth exceeds the archive budget")


def _meta(connection: sqlite3.Connection) -> sqlite3.Row:
    _assert_columns(connection, "archive_meta", _META_COLUMNS)
    _assert_columns(connection, "book_frame", _FRAME_COLUMNS)
    rows = connection.execute("SELECT * FROM archive_meta").fetchall()
    if len(rows) != 1 or rows[0]["singleton"] != 1:
        raise ValueError("historical book archive must have one metadata row")
    row = rows[0]
    if row["protocol"] != ARCHIVE_PROTOCOL:
        raise ValueError("historical book archive protocol is unsupported")
    if row["schema_version"] != ARCHIVE_SCHEMA_VERSION:
        raise ValueError("historical book archive schema is unsupported")
    if row["exchange"] != "binance" or row["market_type"] != "futures":
        raise ValueError("Phase 9 historical book source must be Binance USD-M")
    if row["source"] != "BINANCE_USDM_DIFF_DEPTH_CAPTURE":
        raise ValueError("historical book source provenance is unsupported")
    if row["source_contract_url"] != ARCHIVE_SOURCE_CONTRACT_URL:
        raise ValueError(
            "historical book source contract does not match the frozen URL"
        )
    if not isinstance(row["symbol"], str) or not row["symbol"]:
        raise ValueError("historical book symbol is missing")
    _counter(row["range_start_ms"], "range_start_ms")
    _counter(row["range_end_ms"], "range_end_ms")
    if row["range_end_ms"] < row["range_start_ms"]:
        raise ValueError("historical book archive range is invalid")
    _digest(row["dataset_epoch"], "dataset_epoch")
    max_depth = _counter(row["max_depth_levels"], "max_depth_levels")
    if not 1 <= max_depth <= 5_000:
        raise ValueError("historical book max_depth_levels must be between 1 and 5000")
    return row


def _reconstruct_state(
    connection: sqlite3.Connection,
    *,
    meta: _BookRow,
    target_ms: int,
    require_full_coverage: bool,
    initial: _ReconstructionState | None = None,
) -> _ReconstructionState:
    range_start = _counter(meta["range_start_ms"], "range_start_ms")
    range_end = _counter(meta["range_end_ms"], "range_end_ms")
    if target_ms < range_start or target_ms > range_end:
        raise ValueError("historical book target is outside exact archive coverage")
    if initial is not None and target_ms < initial.target_ms:
        raise ValueError("historical book cached projection cannot move backward")
    max_depth = _counter(meta["max_depth_levels"], "max_depth_levels")
    endpoint = range_end if require_full_coverage else target_ms
    if initial is None:
        rows = connection.execute(
            """
            SELECT * FROM book_frame
            WHERE event_time_ms <= ?
            ORDER BY ordinal
            """,
            (endpoint,),
        )
        bids: dict[Decimal, Decimal] = {}
        asks: dict[Decimal, Decimal] = {}
        previous_ordinal = -1
        previous_event_time = -1
        previous_u: int | None = None
        snapshot_count = 0
        delta_count = 0
        last_frame_time = -1
    else:
        rows = connection.execute(
            """
            SELECT * FROM book_frame
            WHERE ordinal > ? AND event_time_ms <= ?
            ORDER BY ordinal
            """,
            (initial.previous_ordinal, endpoint),
        )
        bids = dict(initial.bids)
        asks = dict(initial.asks)
        previous_ordinal = initial.previous_ordinal
        previous_event_time = initial.previous_event_time_ms
        previous_u = initial.previous_u
        snapshot_count = initial.snapshot_count
        delta_count = initial.delta_count
        last_frame_time = initial.previous_event_time_ms
    for row in rows:
        ordinal = _counter(row["ordinal"], "frame ordinal")
        if ordinal != previous_ordinal + 1:
            raise ValueError("historical book frame ordinal has a gap")
        event_time = _counter(row["event_time_ms"], "frame event_time_ms")
        _counter(row["transaction_time_ms"], "frame transaction_time_ms")
        if event_time < previous_event_time:
            raise ValueError("historical book frame time is not monotonic")
        kind = row["kind"]
        if ordinal == 0:
            if kind != "SNAPSHOT":
                raise ValueError("historical book must begin with a snapshot")
            if event_time > range_start:
                raise ValueError(
                    "historical book snapshot is not aligned before coverage"
                )
            if (
                row["first_update_id"] is not None
                or row["previous_final_update_id"] is not None
            ):
                raise ValueError("historical book snapshot sequence fields are invalid")
            previous_u = _counter(row["final_update_id"], "snapshot lastUpdateId")
            bid_updates = _levels(
                row["bids_json"],
                field_name="snapshot bids",
                allow_zero=False,
                max_levels=max_depth,
            )
            ask_updates = _levels(
                row["asks_json"],
                field_name="snapshot asks",
                allow_zero=False,
                max_levels=max_depth,
            )
            _apply_levels(bids, bid_updates)
            _apply_levels(asks, ask_updates)
            snapshot_count = 1
        else:
            if kind != "DELTA" or previous_u is None:
                raise ValueError(
                    "historical book archive cannot contain implicit resync"
                )
            first_u = _counter(row["first_update_id"], "delta U")
            final_u = _counter(row["final_update_id"], "delta u")
            previous_final = _counter(row["previous_final_update_id"], "delta pu")
            if first_u > final_u or final_u <= previous_u:
                raise ValueError("historical book delta U/u range is invalid")
            if previous_final != previous_u:
                raise ValueError(
                    f"historical book sequence gap: expected pu={previous_u}, observed pu={previous_final}"
                )
            if delta_count == 0 and not (first_u <= previous_u <= final_u):
                raise ValueError(
                    "first delta does not bridge the snapshot lastUpdateId"
                )
            bid_updates = _levels(
                row["bids_json"],
                field_name=f"delta[{ordinal}] bids",
                allow_zero=True,
                max_levels=max_depth,
            )
            ask_updates = _levels(
                row["asks_json"],
                field_name=f"delta[{ordinal}] asks",
                allow_zero=True,
                max_levels=max_depth,
            )
            if not bid_updates and not ask_updates:
                raise ValueError("historical book delta cannot be empty")
            _apply_levels(bids, bid_updates)
            _apply_levels(asks, ask_updates)
            previous_u = final_u
            delta_count += 1
        _assert_book_depth(bids, asks, max_depth=max_depth)
        _assert_uncrossed(bids, asks)
        previous_ordinal = ordinal
        previous_event_time = event_time
        last_frame_time = event_time
    if snapshot_count != 1 or previous_u is None:
        raise ValueError("historical book archive has no usable snapshot")
    if require_full_coverage and last_frame_time < range_end:
        raise ValueError("historical book frames do not cover the declared range end")
    return _ReconstructionState(
        target_ms=target_ms,
        previous_ordinal=previous_ordinal,
        previous_event_time_ms=last_frame_time,
        previous_u=previous_u,
        bids=bids,
        asks=asks,
        snapshot_count=snapshot_count,
        delta_count=delta_count,
    )


def _reconstruct(
    connection: sqlite3.Connection,
    *,
    meta: _BookRow,
    target_ms: int,
    require_full_coverage: bool,
) -> tuple[int, tuple[tuple[str, str], ...], tuple[tuple[str, str], ...], int, int]:
    state = _reconstruct_state(
        connection,
        meta=meta,
        target_ms=target_ms,
        require_full_coverage=require_full_coverage,
    )
    sorted_bids = tuple(
        (format(price, "f"), format(quantity, "f"))
        for price, quantity in sorted(state.bids.items(), reverse=True)
    )
    sorted_asks = tuple(
        (format(price, "f"), format(quantity, "f"))
        for price, quantity in sorted(state.asks.items())
    )
    return (
        state.previous_u,
        sorted_bids,
        sorted_asks,
        state.snapshot_count,
        state.delta_count,
    )


def verify_historical_book_archive(
    path: Path,
    *,
    trusted_origin: str,
) -> HistoricalBookArchiveDescriptor:
    candidate = path.expanduser()
    if candidate.is_symlink():
        raise ValueError("historical book source must not be a symlink")
    resolved = candidate.resolve()
    if not resolved.is_file() or resolved.is_symlink():
        raise ValueError("historical book source must be a regular non-symlink file")
    if (
        not isinstance(trusted_origin, str)
        or not 1 <= len(trusted_origin) <= 128
        or any(
            character
            not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"
            for character in trusted_origin
        )
    ):
        raise ValueError("historical book trusted_origin is invalid")
    byte_size = resolved.stat().st_size
    checksum = _digest_file(resolved)
    with closing(_read_only(resolved)) as connection:
        meta = _meta(connection)
        _, _, _, snapshot_count, delta_count = _reconstruct(
            connection,
            meta=meta,
            target_ms=_counter(meta["range_end_ms"], "range_end_ms"),
            require_full_coverage=True,
        )
        extra = connection.execute(
            "SELECT COUNT(*) FROM book_frame WHERE event_time_ms > ?",
            (_counter(meta["range_end_ms"], "range_end_ms"),),
        ).fetchone()[0]
        if int(extra) != 0:
            raise ValueError(
                "historical book frames exceed the declared immutable range"
            )
        descriptor_payload = {
            "protocol": ARCHIVE_PROTOCOL,
            "adapter_kind": ARCHIVE_ADAPTER_KIND,
            "exchange": str(meta["exchange"]),
            "market_type": str(meta["market_type"]),
            "symbol": str(meta["symbol"]),
            "range_start_ms": _counter(meta["range_start_ms"], "range_start_ms"),
            "range_end_ms": _counter(meta["range_end_ms"], "range_end_ms"),
            "schema_version": str(meta["schema_version"]),
            "dataset_epoch": str(meta["dataset_epoch"]),
            "checksum_sha256": checksum,
        }
    identity_key = canonical_sha256(descriptor_payload)
    archive_id = f"book-{identity_key.removeprefix('sha256:')[:40]}"
    return HistoricalBookArchiveDescriptor(
        archive_id=archive_id,
        identity_key=identity_key,
        exchange=str(descriptor_payload["exchange"]),
        market_type=str(descriptor_payload["market_type"]),
        symbol=str(descriptor_payload["symbol"]),
        range_start_ms=_counter(descriptor_payload["range_start_ms"], "range_start_ms"),
        range_end_ms=_counter(descriptor_payload["range_end_ms"], "range_end_ms"),
        dataset_epoch=str(descriptor_payload["dataset_epoch"]),
        checksum_sha256=checksum,
        byte_size=byte_size,
        snapshot_count=snapshot_count,
        delta_count=delta_count,
        max_depth_levels=_counter(meta["max_depth_levels"], "max_depth_levels"),
        trusted_origin=trusted_origin,
        trusted_source_path=str(resolved),
    )


def bind_historical_book_archive(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    track_id: str,
    binding: PreparedHistoricalBookBinding,
    bound_range_start_ms: int,
    bound_range_end_ms: int,
    now_ms: int,
) -> None:
    descriptor = binding.descriptor
    if (
        descriptor.range_start_ms > bound_range_start_ms
        or descriptor.range_end_ms < bound_range_end_ms
    ):
        raise ValueError(
            "historical book archive no longer covers the frozen run range"
        )
    row = connection.execute(
        """
        SELECT health, checksum_sha256 FROM replay_historical_book_archive
        WHERE archive_id = ?
        """,
        (descriptor.archive_id,),
    ).fetchone()
    if (
        row is None
        or row["health"] != "READY"
        or row["checksum_sha256"] != descriptor.checksum_sha256
    ):
        raise ValueError("historical book archive is not READY at bind time")
    generation_row = connection.execute(
        """
        SELECT COALESCE(MAX(binding_generation), 0) + 1
        FROM replay_historical_book_ref WHERE run_id = ? AND track_id = ?
        """,
        (run_id, track_id),
    ).fetchone()
    generation = int(generation_row[0])
    connection.execute(
        """
        UPDATE replay_historical_book_ref
        SET active = 0, released_at_ms = ?
        WHERE run_id = ? AND track_id = ? AND active = 1
        """,
        (now_ms, run_id, track_id),
    )
    connection.execute(
        """
        INSERT INTO replay_historical_book_ref(
            archive_id, run_id, track_id, binding_generation,
            bound_range_start_ms, bound_range_end_ms, active,
            created_at_ms, released_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)
        """,
        (
            descriptor.archive_id,
            run_id,
            track_id,
            generation,
            bound_range_start_ms,
            bound_range_end_ms,
            now_ms,
        ),
    )
    storage = binding.projection.to_storage()
    connection.execute(
        """
        INSERT INTO replay_historical_book_projection(
            run_id, track_id, archive_id, capability_state, status,
            execution_fidelity, queue_exact, as_of_actual_ms, as_of_virtual_ms,
            last_update_id, bids_json, asks_json, book_hash, message, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, track_id) DO UPDATE SET
            archive_id = excluded.archive_id,
            capability_state = excluded.capability_state,
            status = excluded.status,
            execution_fidelity = excluded.execution_fidelity,
            queue_exact = 0,
            as_of_actual_ms = excluded.as_of_actual_ms,
            as_of_virtual_ms = excluded.as_of_virtual_ms,
            last_update_id = excluded.last_update_id,
            bids_json = excluded.bids_json,
            asks_json = excluded.asks_json,
            book_hash = excluded.book_hash,
            message = excluded.message,
            updated_at_ms = excluded.updated_at_ms
        """,
        (
            run_id,
            track_id,
            descriptor.archive_id,
            storage["capability_state"],
            storage["status"],
            storage["execution_fidelity"],
            storage["as_of_actual_ms"],
            storage["as_of_virtual_ms"],
            storage["last_update_id"],
            storage["bids_json"],
            storage["asks_json"],
            storage["book_hash"],
            storage["message"],
            now_ms,
        ),
    )
    connection.execute(
        """
        UPDATE replay_training_market_track
        SET capabilities_json = json_set(
            capabilities_json, '$.ORDER_BOOK', 'AVAILABLE_EXACT'
        ), updated_at_ms = ?
        WHERE run_id = ? AND track_id = ?
        """,
        (now_ms, run_id, track_id),
    )
    connection.execute(
        """
        INSERT INTO replay_historical_book_event(
            run_id, track_id, archive_id, event_type, at_virtual_time_ms,
            expected_previous_u, observed_pu, reason, details_json, created_at_ms
        ) VALUES (?, ?, ?, 'BOUND', ?, NULL, NULL, NULL, ?, ?)
        """,
        (
            run_id,
            track_id,
            descriptor.archive_id,
            binding.projection.virtual_time_ms,
            canonical_json(
                {
                    "dataset_epoch": descriptor.dataset_epoch,
                    "checksum_sha256": descriptor.checksum_sha256,
                    "binding_generation": generation,
                    "queue_exact": False,
                }
            ),
            now_ms,
        ),
    )


class HistoricalBookArchiveManager:
    """Own immutable historical book files and their fail-closed projections."""

    def __init__(
        self,
        store: ReplaySQLiteStore,
        *,
        enabled: bool,
        max_archive_bytes: int,
        root: Path | None = None,
    ) -> None:
        self.store = store
        self.enabled = bool(enabled)
        self.max_archive_bytes = max_archive_bytes
        self.root = (
            root
            if root is not None
            else store.path.parent / f"{store.path.stem}-historical-books"
        ).resolve()
        self._checksum_cache: dict[tuple[str, int, int], str] = {}
        self._projection_cache: OrderedDict[tuple[str, str], _ProjectionCacheEntry] = (
            OrderedDict()
        )
        self._projection_cache_lock = threading.RLock()
        self._archive_lock = asyncio.Lock()

    async def start(self) -> None:
        await asyncio.to_thread(self._ensure_dirs)
        if not self.enabled:
            await self._disable_existing_runs()

    async def import_archive(
        self,
        path: Path,
        *,
        trusted_origin: str = "OPERATOR_VERIFIED_CAPTURE",
    ) -> dict[str, object]:
        async with self._archive_lock:
            return await self._import_archive(path, trusted_origin=trusted_origin)

    async def _import_archive(
        self,
        path: Path,
        *,
        trusted_origin: str,
    ) -> dict[str, object]:
        descriptor = await asyncio.to_thread(
            verify_historical_book_archive,
            path,
            trusted_origin=trusted_origin,
        )
        if descriptor.trusted_source_path == str(self.root) or Path(
            descriptor.trusted_source_path
        ).is_relative_to(self.root):
            raise TrainingRunError(
                "HISTORICAL_BOOK_TRUSTED_SOURCE_NOT_EXTERNAL",
                "trusted rehydration source must remain outside replay-owned storage",
                status_code=409,
            )
        if descriptor.byte_size > self.max_archive_bytes:
            raise TrainingRunError(
                "HISTORICAL_BOOK_ARCHIVE_BUDGET_EXCEEDED",
                "historical book archive exceeds the configured byte budget",
                status_code=409,
                details={
                    "byte_size": descriptor.byte_size,
                    "max_archive_bytes": self.max_archive_bytes,
                },
            )
        existing = await self.store.run_extension_read(
            lambda connection: connection.execute(
                "SELECT * FROM replay_historical_book_archive WHERE identity_key = ?",
                (descriptor.identity_key,),
            ).fetchone()
        )
        if existing is not None and existing["health"] == "READY":
            try:
                await asyncio.to_thread(self._verify_owned_row, existing)
            except Exception:
                pass
            else:
                return self._public_archive(existing)
        await self._assert_storage_budget(
            incoming_bytes=descriptor.byte_size,
            excluding_archive_id=(
                None if existing is None else str(existing["archive_id"])
            ),
        )
        self._ensure_dirs()
        relative = f"objects/{descriptor.archive_id}.sqlite3"
        final = self._owned_path(relative)
        temp = self._owned_path(f".tmp/import-{uuid.uuid4().hex}.part")
        await asyncio.to_thread(shutil.copyfile, descriptor.trusted_source_path, temp)
        copied_checksum = await asyncio.to_thread(_digest_file, temp)
        if (
            copied_checksum != descriptor.checksum_sha256
            or temp.stat().st_size != descriptor.byte_size
        ):
            temp.unlink(missing_ok=True)
            raise TrainingRunError(
                "HISTORICAL_BOOK_ARCHIVE_COPY_MISMATCH",
                "historical book immutable copy failed checksum validation",
                status_code=409,
            )
        os.replace(temp, final)
        now = self.store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> sqlite3.Row:
            connection.execute(
                """
                INSERT INTO replay_historical_book_archive(
                    archive_id, identity_key, protocol, adapter_kind, exchange,
                    market_type, symbol, range_start_ms, range_end_ms,
                    schema_version, dataset_epoch, checksum_sha256, snapshot_count,
                    delta_count, max_depth_levels, coverage_state, continuity_state,
                    health, local_path, trusted_source_path, byte_size, trusted_origin,
                    source_contract_url, quarantine_reason, generation,
                    last_used_at_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT',
                          'CONTIGUOUS', 'READY', ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)
                ON CONFLICT(identity_key) DO UPDATE SET
                    health = 'READY', local_path = excluded.local_path,
                    trusted_source_path = excluded.trusted_source_path,
                    byte_size = excluded.byte_size, quarantine_reason = NULL,
                    generation = replay_historical_book_archive.generation + 1,
                    last_used_at_ms = excluded.last_used_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (
                    descriptor.archive_id,
                    descriptor.identity_key,
                    ARCHIVE_PROTOCOL,
                    ARCHIVE_ADAPTER_KIND,
                    descriptor.exchange,
                    descriptor.market_type,
                    descriptor.symbol,
                    descriptor.range_start_ms,
                    descriptor.range_end_ms,
                    ARCHIVE_SCHEMA_VERSION,
                    descriptor.dataset_epoch,
                    descriptor.checksum_sha256,
                    descriptor.snapshot_count,
                    descriptor.delta_count,
                    descriptor.max_depth_levels,
                    relative,
                    descriptor.trusted_source_path,
                    descriptor.byte_size,
                    descriptor.trusted_origin,
                    ARCHIVE_SOURCE_CONTRACT_URL,
                    now,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM replay_historical_book_archive WHERE identity_key = ?",
                (descriptor.identity_key,),
            ).fetchone()
            assert row is not None
            return row

        try:
            row = await self.store.run_extension_write(write)
        except BaseException:
            final.unlink(missing_ok=True)
            raise
        return self._public_archive(row)

    async def plan_for_request(
        self,
        request: TrainingRunCreateRequest,
    ) -> dict[str, object]:
        state = CapabilityState.UNSUPPORTED_NO_HISTORY.value
        reason = "FEATURE_DISABLED"
        archive: _BookRow | None = None
        requested_start = request.requested_start_ms
        requested_end = (
            None
            if requested_start is None
            else requested_start
            + request.forward_cache_ms
            + compatible_step_interval_ms(
                base_interval=request.base_interval,
                step_interval=request.display_interval,
            )
        )
        if self.enabled:
            if request.exchange != "binance" or request.market_type != "futures":
                state = CapabilityState.UNSUPPORTED_SOURCE_MODE.value
                reason = "BINANCE_USDM_ONLY"
            elif request.start_mode is not StartMode.MANUAL or requested_start is None:
                state = CapabilityState.UNSUPPORTED_SOURCE_MODE.value
                reason = "MANUAL_START_REQUIRED"
            else:
                archive = await self._select_archive(
                    exchange=request.exchange,
                    market_type=request.market_type,
                    symbol=request.symbol,
                    range_start_ms=requested_start,
                    range_end_ms=_counter(requested_end, "requested_end_ms"),
                )
                if archive is None:
                    degraded = await self.store.run_extension_read(
                        lambda connection: connection.execute(
                            """
                            SELECT 1 FROM replay_historical_book_archive
                            WHERE exchange = ? AND market_type = ? AND symbol = ?
                              AND health != 'READY' LIMIT 1
                            """,
                            (request.exchange, request.market_type, request.symbol),
                        ).fetchone()
                    )
                    state = (
                        CapabilityState.DEGRADED.value
                        if degraded is not None
                        else CapabilityState.UNSUPPORTED_NO_HISTORY.value
                    )
                    reason = "NO_CONTIGUOUS_PINNABLE_ARCHIVE"
                else:
                    try:
                        self._owned_file(archive, verify_checksum=False)
                    except Exception:
                        state = CapabilityState.DEGRADED.value
                        reason = "ARCHIVE_OBJECT_UNAVAILABLE"
                    else:
                        state = CapabilityState.AVAILABLE_EXACT.value
                        reason = "VERIFIED_BINANCE_USDM_DIFF_DEPTH"
        return {
            "feature_enabled": self.enabled,
            "requested_mode": request.book_mode.value,
            "capability_state": state,
            "reason": reason,
            "source": "BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1",
            "snapshot_and_ordered_deltas": state
            == CapabilityState.AVAILABLE_EXACT.value,
            "continuity_contract": "SNAPSHOT_BRIDGE_AND_U_u_pu",
            "pinnable": state == CapabilityState.AVAILABLE_EXACT.value,
            "queue_exact": False,
            "execution_fidelity": BOOK_EXECUTION_FIDELITY,
            "ready_archive_bytes": (
                0 if archive is None else _counter(archive["byte_size"], "byte_size")
            ),
            "max_archive_bytes": self.max_archive_bytes,
        }

    async def prepare_binding(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        range_start_ms: int,
        range_end_ms: int,
        actual_time_ms: int,
        virtual_time_ms: int,
        projection_cache_key: tuple[str, str] | None = None,
    ) -> PreparedHistoricalBookBinding:
        if not self.enabled:
            raise TrainingRunError(
                "HISTORICAL_BOOK_DISABLED",
                "REPLAY_HISTORICAL_BOOK_ENABLED is disabled",
                status_code=409,
                details={"fallback_applied": False},
            )
        archive = await self._select_archive(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
        )
        if archive is None:
            raise TrainingRunError(
                "HISTORICAL_BOOK_EXACT_COVERAGE_UNAVAILABLE",
                "BOOK_ASSISTED_REQUIRED needs one continuous pinned L2 archive",
                status_code=409,
                details={"fallback_applied": False},
            )
        try:
            path = await asyncio.to_thread(self._owned_file, archive, True)
            projection = await asyncio.to_thread(
                self._projection_from_path,
                archive,
                path,
                actual_time_ms,
                virtual_time_ms,
                cache_key=projection_cache_key,
            )
        except Exception as exc:
            await self._quarantine_archive(
                str(archive["archive_id"]), type(exc).__name__
            )
            raise TrainingRunError(
                "HISTORICAL_BOOK_ARCHIVE_DEGRADED",
                "historical book archive failed immutable continuity validation",
                status_code=409,
                details={"reason": str(exc)[:300], "fallback_applied": False},
            ) from exc
        return PreparedHistoricalBookBinding(
            descriptor=self._descriptor_from_row(archive),
            projection=projection,
        )

    async def prepare_run_projection(
        self,
        *,
        run_id: str,
        tracks: Sequence[Mapping[str, object]],
        actual_time_ms: int,
        virtual_time_ms: int,
    ) -> tuple[tuple[str, HistoricalBookProjection], ...]:
        if not self.enabled:
            await self._degrade_run(
                run_id=run_id,
                failed_track_id=None,
                archive_id=None,
                virtual_time_ms=virtual_time_ms,
                reason="HISTORICAL_BOOK_FEATURE_DISABLED",
                event_type="FEATURE_DISABLED",
            )
            raise TrainingRunError(
                "HISTORICAL_BOOK_DISABLED",
                "book-assisted run is paused because the historical book feature is disabled",
                status_code=409,
                details={"fallback_applied": False},
            )
        prepared: list[tuple[str, HistoricalBookProjection]] = []
        for track in tracks:
            if track.get("subscription_tier") != "FULL":
                continue
            track_id = str(track["track_id"])
            row = await self._active_binding(run_id, track_id)
            if row is None:
                await self._degrade_run(
                    run_id=run_id,
                    failed_track_id=track_id,
                    archive_id=None,
                    virtual_time_ms=virtual_time_ms,
                    reason="HISTORICAL_BOOK_BINDING_MISSING",
                )
                raise TrainingRunError(
                    "HISTORICAL_BOOK_BINDING_MISSING",
                    "a required FULL track has no pinned historical book archive",
                    status_code=409,
                    details={"track_id": track_id, "fallback_applied": False},
                )
            try:
                path = await asyncio.to_thread(self._owned_file, row, True)
                projection = await asyncio.to_thread(
                    self._projection_from_path,
                    row,
                    path,
                    actual_time_ms,
                    virtual_time_ms,
                    cache_key=(run_id, track_id),
                )
                prepared.append((track_id, projection))
            except Exception as exc:
                await self._quarantine_archive(
                    str(row["archive_id"]),
                    exc.code
                    if isinstance(exc, TrainingRunError)
                    else type(exc).__name__,
                )
                await self._degrade_run(
                    run_id=run_id,
                    failed_track_id=track_id,
                    archive_id=str(row["archive_id"]),
                    virtual_time_ms=virtual_time_ms,
                    reason=(
                        exc.code
                        if isinstance(exc, TrainingRunError)
                        else type(exc).__name__
                    ),
                )
                if isinstance(exc, TrainingRunError):
                    raise
                raise TrainingRunError(
                    "HISTORICAL_BOOK_GAP",
                    "historical book continuity failed; the whole run is paused",
                    status_code=409,
                    details={"track_id": track_id, "fallback_applied": False},
                ) from exc
        return tuple(prepared)

    async def commit_run_projection(
        self,
        *,
        run_id: str,
        prepared: Sequence[tuple[str, HistoricalBookProjection]],
        event_type: str = "READY",
    ) -> None:
        now = self.store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            for track_id, projection in prepared:
                values = projection.to_storage()
                connection.execute(
                    """
                    UPDATE replay_historical_book_projection
                    SET capability_state = 'AVAILABLE_EXACT', status = 'READY',
                        as_of_actual_ms = ?, as_of_virtual_ms = ?, last_update_id = ?,
                        bids_json = ?, asks_json = ?, book_hash = ?, message = ?,
                        updated_at_ms = ?
                    WHERE run_id = ? AND track_id = ? AND archive_id = ?
                    """,
                    (
                        values["as_of_actual_ms"],
                        values["as_of_virtual_ms"],
                        values["last_update_id"],
                        values["bids_json"],
                        values["asks_json"],
                        values["book_hash"],
                        values["message"],
                        now,
                        run_id,
                        track_id,
                        projection.archive_id,
                    ),
                )
                connection.execute(
                    """
                    UPDATE replay_historical_book_archive
                    SET last_used_at_ms = ?, updated_at_ms = ? WHERE archive_id = ?
                    """,
                    (now, now, projection.archive_id),
                )
                connection.execute(
                    """
                    INSERT INTO replay_historical_book_event(
                        run_id, track_id, archive_id, event_type, at_virtual_time_ms,
                        expected_previous_u, observed_pu, reason, details_json, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                    """,
                    (
                        run_id,
                        track_id,
                        projection.archive_id,
                        event_type,
                        projection.virtual_time_ms,
                        projection.last_update_id,
                        projection.last_update_id,
                        canonical_json({"book_hash": projection.book_hash}),
                        now,
                    ),
                )

        await self.store.run_extension_write(write)

    async def resync_run(
        self,
        *,
        run_id: str,
        tracks: Sequence[Mapping[str, object]],
        actual_time_ms: int,
        virtual_time_ms: int,
    ) -> tuple[tuple[str, HistoricalBookProjection], ...]:
        if not self.enabled:
            raise TrainingRunError(
                "HISTORICAL_BOOK_DISABLED",
                "historical book resync requires the feature flag",
                status_code=409,
            )
        self._invalidate_projection_cache(run_id=run_id)
        for track in tracks:
            if track.get("subscription_tier") != "FULL":
                continue
            row = await self._active_binding(run_id, str(track["track_id"]))
            if row is not None and row["health"] != "READY":
                await self._rehydrate_row(row)
        prepared = await self.prepare_run_projection(
            run_id=run_id,
            tracks=tracks,
            actual_time_ms=actual_time_ms,
            virtual_time_ms=virtual_time_ms,
        )
        await self.commit_run_projection(
            run_id=run_id,
            prepared=prepared,
            event_type="RESYNC",
        )
        now = self.store._validated_now_ms()

        def clear(connection: sqlite3.Connection) -> None:
            for track in tracks:
                if track.get("subscription_tier") != "FULL":
                    continue
                track_id = str(track["track_id"])
                row = connection.execute(
                    """
                    SELECT forced_full_reasons_json
                    FROM replay_training_market_track
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (run_id, track_id),
                ).fetchone()
                if row is None:
                    continue
                reasons = json.loads(str(row["forced_full_reasons_json"]))
                kept = [
                    reason for reason in reasons if reason != "BOOK_ASSISTED_REQUIRED"
                ]
                connection.execute(
                    """
                    UPDATE replay_training_market_track
                    SET state = 'READY', degraded_reason = NULL,
                        forced_full_reasons_json = ?,
                        capabilities_json = json_set(
                            capabilities_json, '$.ORDER_BOOK', 'AVAILABLE_EXACT'
                        ), updated_at_ms = ?
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (canonical_json(kept), now, run_id, track_id),
                )
            connection.execute(
                """
                UPDATE replay_training_run SET compatibility = 'READY', updated_at_ms = ?
                WHERE run_id = ?
                """,
                (now, run_id),
            )

        await self.store.run_extension_write(clear)
        return prepared

    async def list_archives(self) -> dict[str, object]:
        rows = await self.store.run_extension_read(
            lambda connection: tuple(
                connection.execute(
                    """
                    SELECT a.*,
                           (SELECT COUNT(*) FROM replay_historical_book_ref AS r
                            WHERE r.archive_id = a.archive_id AND r.active = 1) AS ref_count
                    FROM replay_historical_book_archive AS a
                    ORDER BY a.last_used_at_ms DESC, a.archive_id
                    """
                ).fetchall()
            )
        )
        items = [self._public_archive(row) for row in rows]
        return {
            "protocol": ARCHIVE_PROTOCOL,
            "feature_enabled": self.enabled,
            "items": items,
            "summary": {
                "archive_count": len(items),
                "ready_count": sum(item["health"] == "READY" for item in items),
                "pinned_count": sum(
                    _counter(item["ref_count"], "ref_count") > 0 for item in items
                ),
                "local_bytes": sum(
                    _counter(row["byte_size"], "byte_size")
                    for row in rows
                    if isinstance(row["local_path"], str) and row["local_path"]
                ),
                "max_archive_bytes": self.max_archive_bytes,
            },
        }

    async def gc_plan(
        self,
        *,
        target_reclaim_bytes: int,
        max_archives: int,
    ) -> dict[str, object]:
        return await self._gc_plan(
            target_reclaim_bytes=target_reclaim_bytes,
            max_archives=max_archives,
            audit=True,
        )

    async def _gc_plan(
        self,
        *,
        target_reclaim_bytes: int,
        max_archives: int,
        audit: bool,
    ) -> dict[str, object]:
        if (
            isinstance(target_reclaim_bytes, bool)
            or not isinstance(target_reclaim_bytes, int)
            or not 1 <= target_reclaim_bytes <= 1_000_000_000_000
        ):
            raise ValueError("target_reclaim_bytes must be between 1 and 1000000000000")
        if (
            isinstance(max_archives, bool)
            or not isinstance(max_archives, int)
            or not 1 <= max_archives <= 10_000
        ):
            raise ValueError("max_archives must be between 1 and 10000")

        def read(connection: sqlite3.Connection) -> tuple[tuple[sqlite3.Row, ...], int]:
            rows = tuple(
                connection.execute(
                    """
                    SELECT a.*,
                           (SELECT COUNT(*) FROM replay_historical_book_ref AS r
                            WHERE r.archive_id = a.archive_id AND r.active = 1) AS ref_count
                    FROM replay_historical_book_archive AS a
                    WHERE a.health = 'READY'
                    ORDER BY a.last_used_at_ms, a.archive_id
                    """
                ).fetchall()
            )
            total = connection.execute(
                """
                SELECT COALESCE(SUM(byte_size), 0)
                FROM replay_historical_book_archive
                WHERE local_path IS NOT NULL
                """
            ).fetchone()
            assert total is not None
            return rows, int(total[0])

        rows, local_bytes = await self.store.run_extension_read(read)
        candidates: list[dict[str, object]] = []
        protected: list[dict[str, object]] = []
        estimated = 0
        for row in rows:
            reasons: list[str] = []
            if int(row["ref_count"]) > 0:
                reasons.append("ACTIVE_ARCHIVE_PIN")
            try:
                self._owned_file(row, verify_checksum=True)
            except Exception as exc:
                reasons.append(f"OWNED_OBJECT_{type(exc).__name__.upper()}")
            trusted_issue = self._trusted_source_issue(row)
            if trusted_issue is not None:
                reasons.append(trusted_issue)
            item = {
                "archive_id": str(row["archive_id"]),
                "generation": int(row["generation"]),
                "byte_size": int(row["byte_size"]),
                "last_used_at_ms": int(row["last_used_at_ms"]),
                "checksum_sha256": str(row["checksum_sha256"]),
                "active_ref_count": int(row["ref_count"]),
                "recoverability": "TRUSTED_LOCAL_SOURCE_CHECKSUM_BOUND",
            }
            if reasons:
                protected.append({**item, "protection_reasons": sorted(set(reasons))})
                continue
            if len(candidates) >= max_archives or estimated >= target_reclaim_bytes:
                continue
            candidates.append(item)
            estimated += int(row["byte_size"])
        request = {
            "target_reclaim_bytes": target_reclaim_bytes,
            "max_archives": max_archives,
        }
        plan_hash = canonical_sha256(
            {
                "protocol": BOOK_GC_PROTOCOL,
                "request": request,
                "candidates": candidates,
            }
        )
        plan = {
            "protocol": BOOK_GC_PROTOCOL,
            "mode": "DRY_RUN",
            "plan_hash": plan_hash,
            "request": request,
            "current_local_bytes": local_bytes,
            "estimated_reclaim_bytes": estimated,
            "candidates": candidates,
            "protected": protected,
            "pinned_auto_reclaimed": False,
        }
        if audit:
            await self._audit_gc("DRY_RUN", plan_hash, request, plan)
        return plan

    async def gc_run(
        self,
        *,
        plan_hash: str,
        target_reclaim_bytes: int,
        max_archives: int,
    ) -> dict[str, object]:
        async with self._archive_lock:
            plan = await self._gc_plan(
                target_reclaim_bytes=target_reclaim_bytes,
                max_archives=max_archives,
                audit=False,
            )
            if plan["plan_hash"] != plan_hash:
                raise TrainingRunError(
                    "HISTORICAL_BOOK_GC_PLAN_CHANGED",
                    "historical book GC plan changed; run dry-run again",
                    status_code=409,
                    details={"current_plan_hash": plan["plan_hash"]},
                )
            raw_candidates = plan["candidates"]
            if not isinstance(raw_candidates, list):
                raise RuntimeError("historical book GC plan candidates are malformed")
            reclaimed: list[dict[str, object]] = []
            skipped: list[dict[str, object]] = []
            for candidate in raw_candidates:
                if not isinstance(candidate, Mapping):
                    raise RuntimeError("historical book GC candidate is malformed")
                result = await self._reclaim_archive(candidate)
                (reclaimed if result["reclaimed"] else skipped).append(result)
            result = {
                "protocol": BOOK_GC_PROTOCOL,
                "mode": "RUN",
                "plan_hash": plan_hash,
                "request": plan["request"],
                "reclaimed": reclaimed,
                "skipped": skipped,
                "reclaimed_bytes": sum(
                    _counter(item["byte_size"], "byte_size") for item in reclaimed
                ),
                "exact_dry_run_set": not skipped,
                "pinned_auto_reclaimed": False,
            }
            await self._audit_gc("RUN", plan_hash, plan["request"], result)
            return result

    async def rehydrate_archive(self, archive_id: str) -> dict[str, object]:
        async with self._archive_lock:
            row = await self.store.run_extension_read(
                lambda connection: connection.execute(
                    "SELECT * FROM replay_historical_book_archive WHERE archive_id = ?",
                    (archive_id,),
                ).fetchone()
            )
            if row is None:
                raise TrainingRunError(
                    "HISTORICAL_BOOK_ARCHIVE_NOT_FOUND",
                    "historical book archive does not exist",
                    status_code=404,
                )
            if row["health"] == "READY":
                try:
                    await asyncio.to_thread(self._verify_owned_row, row)
                except Exception as exc:
                    await self._quarantine_archive(archive_id, type(exc).__name__)
                    row = await self.store.run_extension_read(
                        lambda connection: connection.execute(
                            "SELECT * FROM replay_historical_book_archive WHERE archive_id = ?",
                            (archive_id,),
                        ).fetchone()
                    )
                    assert row is not None
                else:
                    return self._public_archive(row)
            await self._rehydrate_row(row)
            restored = await self.store.run_extension_read(
                lambda connection: connection.execute(
                    """
                    SELECT a.*,
                           (SELECT COUNT(*) FROM replay_historical_book_ref AS r
                            WHERE r.archive_id = a.archive_id AND r.active = 1) AS ref_count
                    FROM replay_historical_book_archive AS a WHERE archive_id = ?
                    """,
                    (archive_id,),
                ).fetchone()
            )
            assert restored is not None
            result = self._public_archive(restored)
            plan_hash = canonical_sha256(
                {
                    "protocol": BOOK_GC_PROTOCOL,
                    "action": "REHYDRATE",
                    "archive_id": archive_id,
                    "checksum_sha256": result["checksum_sha256"],
                }
            )
            await self._audit_gc(
                "REHYDRATE",
                plan_hash,
                {"archive_id": archive_id},
                result,
            )
            return result

    async def _reclaim_archive(
        self,
        candidate: Mapping[str, object],
    ) -> dict[str, object]:
        archive_id = str(candidate["archive_id"])
        generation = _counter(candidate["generation"], "generation")
        token = uuid.uuid4().hex
        claim_reason = f"GC_RECLAIMING:{token}"
        now = self.store._validated_now_ms()

        def claim(connection: sqlite3.Connection) -> sqlite3.Row | None:
            connection.execute(
                """
                UPDATE replay_historical_book_archive
                SET health = 'ERROR', quarantine_reason = ?,
                    generation = generation + 1, updated_at_ms = ?
                WHERE archive_id = ? AND generation = ? AND health = 'READY'
                  AND NOT EXISTS(
                      SELECT 1 FROM replay_historical_book_ref AS r
                      WHERE r.archive_id = replay_historical_book_archive.archive_id
                        AND r.active = 1
                  )
                """,
                (claim_reason, now, archive_id, generation),
            )
            return connection.execute(
                """
                SELECT * FROM replay_historical_book_archive
                WHERE archive_id = ? AND health = 'ERROR' AND quarantine_reason = ?
                """,
                (archive_id, claim_reason),
            ).fetchone()

        row = await self.store.run_extension_write(claim)
        if row is None:
            return {
                "archive_id": archive_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "PIN_OR_GENERATION_CHANGED",
            }
        trusted_issue = self._trusted_source_issue(row)
        if trusted_issue is not None:
            await self._restore_gc_claim(
                archive_id,
                claim_reason,
                trusted_issue,
                ready=True,
            )
            return {
                "archive_id": archive_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": trusted_issue,
            }
        relative = row["local_path"]
        expected = f"objects/{archive_id}.sqlite3"
        if relative != expected:
            await self._restore_gc_claim(
                archive_id,
                claim_reason,
                "OWNED_PATH_INVALID",
                ready=False,
            )
            return {
                "archive_id": archive_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "OWNED_PATH_INVALID",
            }
        source = self._owned_path(expected)
        trash = self._owned_path(f".trash/{archive_id}-{token}.trash")
        try:
            if not source.is_file() or source.is_symlink():
                raise FileNotFoundError("historical book owned object is unavailable")
            await asyncio.to_thread(os.replace, source, trash)
        except OSError as exc:
            await self._restore_gc_claim(
                archive_id,
                claim_reason,
                type(exc).__name__,
                ready=True,
            )
            return {
                "archive_id": archive_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": type(exc).__name__,
            }
        finished = self.store._validated_now_ms()

        def finalize(connection: sqlite3.Connection) -> bool:
            cursor = connection.execute(
                """
                UPDATE replay_historical_book_archive
                SET health = 'EVICTED', local_path = NULL, quarantine_reason = NULL,
                    updated_at_ms = ?
                WHERE archive_id = ? AND health = 'ERROR' AND quarantine_reason = ?
                  AND NOT EXISTS(
                      SELECT 1 FROM replay_historical_book_ref AS r
                      WHERE r.archive_id = replay_historical_book_archive.archive_id
                        AND r.active = 1
                  )
                """,
                (finished, archive_id, claim_reason),
            )
            return cursor.rowcount == 1

        finalized = await self.store.run_extension_write(finalize)
        if not finalized:
            await asyncio.to_thread(os.replace, trash, source)
            await self._restore_gc_claim(
                archive_id,
                claim_reason,
                "PIN_CHANGED_DURING_RECLAIM",
                ready=True,
            )
            return {
                "archive_id": archive_id,
                "reclaimed": False,
                "byte_size": 0,
                "reason": "PIN_CHANGED_DURING_RECLAIM",
            }
        try:
            await asyncio.to_thread(trash.unlink)
        except OSError:
            pass
        self._checksum_cache.clear()
        self._invalidate_projection_cache(archive_id=archive_id)
        return {
            "archive_id": archive_id,
            "reclaimed": True,
            "byte_size": _counter(candidate["byte_size"], "byte_size"),
            "reason": "TRUSTED_SOURCE_MANIFEST_RETAINED",
        }

    async def _restore_gc_claim(
        self,
        archive_id: str,
        claim_reason: str,
        reason: str,
        *,
        ready: bool,
    ) -> None:
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_historical_book_archive
                SET health = ?, quarantine_reason = ?,
                    generation = generation + 1, updated_at_ms = ?
                WHERE archive_id = ? AND health = 'ERROR' AND quarantine_reason = ?
                """,
                (
                    "READY" if ready else "ERROR",
                    None if ready else reason[:300],
                    now,
                    archive_id,
                    claim_reason,
                ),
            )
        )

    async def _assert_storage_budget(
        self,
        *,
        incoming_bytes: int,
        excluding_archive_id: str | None,
    ) -> None:
        local_bytes = await self.store.run_extension_read(
            lambda connection: int(
                connection.execute(
                    """
                    SELECT COALESCE(SUM(byte_size), 0)
                    FROM replay_historical_book_archive
                    WHERE local_path IS NOT NULL AND (? IS NULL OR archive_id != ?)
                    """,
                    (excluding_archive_id, excluding_archive_id),
                ).fetchone()[0]
            )
        )
        if local_bytes + incoming_bytes > self.max_archive_bytes:
            raise TrainingRunError(
                "HISTORICAL_BOOK_STORAGE_BUDGET_EXCEEDED",
                "historical book storage budget would be exceeded",
                status_code=409,
                details={
                    "current_local_bytes": local_bytes,
                    "incoming_bytes": incoming_bytes,
                    "max_archive_bytes": self.max_archive_bytes,
                },
            )

    async def _audit_gc(
        self,
        action: str,
        plan_hash: str,
        request: object,
        result: object,
    ) -> None:
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                INSERT INTO replay_historical_book_gc_audit(
                    action, plan_hash, request_json, result_json, created_at_ms
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    action,
                    plan_hash,
                    canonical_json(request),
                    canonical_json(result),
                    now,
                ),
            )
        )

    async def _select_archive(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        range_start_ms: int,
        range_end_ms: int,
    ) -> _BookRow | None:
        return await self.store.run_extension_read(
            lambda connection: connection.execute(
                """
                SELECT * FROM replay_historical_book_archive
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND health = 'READY' AND coverage_state = 'EXACT'
                  AND continuity_state = 'CONTIGUOUS'
                  AND range_start_ms <= ? AND range_end_ms >= ?
                ORDER BY byte_size, range_start_ms DESC, archive_id
                LIMIT 1
                """,
                (exchange, market_type, symbol, range_start_ms, range_end_ms),
            ).fetchone()
        )

    async def _active_binding(self, run_id: str, track_id: str) -> _BookRow | None:
        return await self.store.run_extension_read(
            lambda connection: connection.execute(
                """
                SELECT a.*, r.bound_range_start_ms, r.bound_range_end_ms,
                       r.binding_generation
                FROM replay_historical_book_ref AS r
                JOIN replay_historical_book_archive AS a USING(archive_id)
                WHERE r.run_id = ? AND r.track_id = ? AND r.active = 1
                ORDER BY r.binding_generation DESC LIMIT 1
                """,
                (run_id, track_id),
            ).fetchone()
        )

    async def _quarantine_archive(self, archive_id: str, reason: str) -> None:
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_historical_book_archive
                SET health = 'QUARANTINED', quarantine_reason = ?, updated_at_ms = ?
                WHERE archive_id = ?
                """,
                (reason[:300], now, archive_id),
            )
        )
        self._invalidate_projection_cache(archive_id=archive_id)

    async def _degrade_run(
        self,
        *,
        run_id: str,
        failed_track_id: str | None,
        archive_id: str | None,
        virtual_time_ms: int,
        reason: str,
        event_type: str = "GAP",
    ) -> None:
        now = self.store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            rows = connection.execute(
                """
                SELECT track_id, forced_full_reasons_json
                FROM replay_training_market_track
                WHERE run_id = ? AND subscription_tier = 'FULL'
                """,
                (run_id,),
            ).fetchall()
            for row in rows:
                track_id = str(row["track_id"])
                reasons = json.loads(str(row["forced_full_reasons_json"]))
                reasons = list(reasons) if isinstance(reasons, list) else []
                reasons.append("BOOK_ASSISTED_REQUIRED")
                connection.execute(
                    """
                    UPDATE replay_training_market_track
                    SET state = 'DEGRADED', degraded_reason = ?,
                        forced_full_reasons_json = ?,
                        capabilities_json = json_set(
                            capabilities_json, '$.ORDER_BOOK', 'DEGRADED'
                        ), updated_at_ms = ?
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (
                        reason[:500],
                        canonical_json(sorted(set(str(value) for value in reasons))),
                        now,
                        run_id,
                        track_id,
                    ),
                )
                projection = connection.execute(
                    """
                    SELECT archive_id FROM replay_historical_book_projection
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (run_id, track_id),
                ).fetchone()
                if projection is not None:
                    connection.execute(
                        """
                        UPDATE replay_historical_book_projection
                        SET capability_state = 'DEGRADED',
                            status = CASE WHEN ? = 'FEATURE_DISABLED'
                                          THEN 'DISABLED' ELSE 'CLEARED' END,
                            as_of_actual_ms = NULL, as_of_virtual_ms = ?,
                            last_update_id = NULL, bids_json = '[]', asks_json = '[]',
                            book_hash = NULL, message = ?, updated_at_ms = ?
                        WHERE run_id = ? AND track_id = ?
                        """,
                        (
                            event_type,
                            virtual_time_ms,
                            reason[:500],
                            now,
                            run_id,
                            track_id,
                        ),
                    )
                connection.execute(
                    """
                    INSERT INTO replay_historical_book_event(
                        run_id, track_id, archive_id, event_type, at_virtual_time_ms,
                        expected_previous_u, observed_pu, reason, details_json, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
                    """,
                    (
                        run_id,
                        track_id,
                        archive_id if track_id == failed_track_id else None,
                        event_type
                        if track_id == failed_track_id or failed_track_id is None
                        else "CLEARED",
                        virtual_time_ms,
                        reason[:500],
                        canonical_json(
                            {
                                "failed_track_id": failed_track_id,
                                "fallback_applied": False,
                            }
                        ),
                        now,
                    ),
                )
            connection.execute(
                """
                UPDATE replay_training_run
                SET compatibility = 'UNAVAILABLE', updated_at_ms = ? WHERE run_id = ?
                """,
                (now, run_id),
            )

        await self.store.run_extension_write(write)
        self._invalidate_projection_cache(run_id=run_id)

    async def _disable_existing_runs(self) -> None:
        runs = await self.store.run_extension_read(
            lambda connection: tuple(
                (str(row["run_id"]), int(row["virtual_time_ms"]))
                for row in connection.execute(
                    """
                    SELECT r.run_id,
                           COALESCE(MAX(t.virtual_time_ms), 0) AS virtual_time_ms
                    FROM replay_training_run AS r
                    LEFT JOIN replay_training_market_track AS t
                      ON t.run_id = r.run_id AND t.subscription_tier = 'FULL'
                    WHERE r.book_mode = 'BOOK_ASSISTED_REQUIRED'
                      AND r.state NOT IN ('ENDED', 'ARCHIVED')
                    GROUP BY r.run_id
                    """
                ).fetchall()
            )
        )
        for run_id, virtual_time_ms in runs:
            await self._degrade_run(
                run_id=run_id,
                failed_track_id=None,
                archive_id=None,
                virtual_time_ms=virtual_time_ms,
                reason="HISTORICAL_BOOK_FEATURE_DISABLED",
                event_type="FEATURE_DISABLED",
            )

    async def _rehydrate_row(self, row: _BookRow) -> None:
        source = Path(str(row["trusted_source_path"])).expanduser().resolve()
        descriptor = await asyncio.to_thread(
            verify_historical_book_archive,
            source,
            trusted_origin=str(row["trusted_origin"]),
        )
        if descriptor.archive_id != str(
            row["archive_id"]
        ) or descriptor.checksum_sha256 != str(row["checksum_sha256"]):
            raise TrainingRunError(
                "HISTORICAL_BOOK_REHYDRATION_MISMATCH",
                "trusted historical book source no longer matches the pinned checksum",
                status_code=409,
            )
        await self._assert_storage_budget(
            incoming_bytes=descriptor.byte_size,
            excluding_archive_id=descriptor.archive_id,
        )
        relative = (
            str(row["local_path"])
            if isinstance(row["local_path"], str) and row["local_path"]
            else f"objects/{descriptor.archive_id}.sqlite3"
        )
        final = self._owned_path(relative)
        temp = self._owned_path(f".tmp/rehydrate-{uuid.uuid4().hex}.part")
        await asyncio.to_thread(shutil.copyfile, source, temp)
        if await asyncio.to_thread(_digest_file, temp) != descriptor.checksum_sha256:
            temp.unlink(missing_ok=True)
            raise TrainingRunError(
                "HISTORICAL_BOOK_REHYDRATION_MISMATCH",
                "rehydrated historical book failed checksum validation",
                status_code=409,
            )
        os.replace(temp, final)
        now = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_historical_book_archive
                SET health = 'READY', local_path = ?, byte_size = ?,
                    quarantine_reason = NULL,
                    generation = generation + 1, last_used_at_ms = ?, updated_at_ms = ?
                WHERE archive_id = ?
                """,
                (relative, descriptor.byte_size, now, now, descriptor.archive_id),
            )
        )
        self._checksum_cache.clear()
        self._invalidate_projection_cache(archive_id=descriptor.archive_id)

    def _projection_from_path(
        self,
        row: _BookRow,
        path: Path,
        actual_time_ms: int,
        virtual_time_ms: int,
        *,
        cache_key: tuple[str, str] | None = None,
    ) -> HistoricalBookProjection:
        with closing(_read_only(path)) as connection:
            meta = _meta(connection)
            if str(meta["dataset_epoch"]) != str(row["dataset_epoch"]) or str(
                meta["symbol"]
            ) != str(row["symbol"]):
                raise ValueError(
                    "historical book object identity does not match registry"
                )
            if cache_key is None:
                state = _reconstruct_state(
                    connection,
                    meta=meta,
                    target_ms=actual_time_ms,
                    require_full_coverage=False,
                )
            else:
                archive_id = str(row["archive_id"])
                generation = _counter(row["generation"], "generation")
                checksum = str(row["checksum_sha256"])
                with self._projection_cache_lock:
                    cached = self._projection_cache.get(cache_key)
                    initial = None
                    if (
                        cached is not None
                        and cached.archive_id == archive_id
                        and cached.generation == generation
                        and cached.checksum_sha256 == checksum
                        and actual_time_ms >= cached.state.target_ms
                    ):
                        initial = cached.state
                    state = _reconstruct_state(
                        connection,
                        meta=meta,
                        target_ms=actual_time_ms,
                        require_full_coverage=False,
                        initial=initial,
                    )
                    self._projection_cache[cache_key] = _ProjectionCacheEntry(
                        archive_id=archive_id,
                        generation=generation,
                        checksum_sha256=checksum,
                        state=state,
                    )
                    self._projection_cache.move_to_end(cache_key)
                    while (
                        len(self._projection_cache) > BOOK_PROJECTION_CACHE_MAX_TRACKS
                    ):
                        self._projection_cache.popitem(last=False)
        update_id = state.previous_u
        bids = tuple(
            (format(price, "f"), format(quantity, "f"))
            for price, quantity in sorted(state.bids.items(), reverse=True)
        )
        asks = tuple(
            (format(price, "f"), format(quantity, "f"))
            for price, quantity in sorted(state.asks.items())
        )
        visible_bids = bids[:BOOK_PROJECTION_DEPTH]
        visible_asks = asks[:BOOK_PROJECTION_DEPTH]
        book_hash = canonical_sha256(
            {
                "archive_id": str(row["archive_id"]),
                "actual_time_ms": actual_time_ms,
                "last_update_id": update_id,
                "bids": [list(level) for level in visible_bids],
                "asks": [list(level) for level in visible_asks],
            }
        )
        return HistoricalBookProjection(
            archive_id=str(row["archive_id"]),
            actual_time_ms=actual_time_ms,
            virtual_time_ms=virtual_time_ms,
            last_update_id=update_id,
            bids=visible_bids,
            asks=visible_asks,
            book_hash=book_hash,
        )

    def _invalidate_projection_cache(
        self,
        *,
        run_id: str | None = None,
        archive_id: str | None = None,
    ) -> None:
        with self._projection_cache_lock:
            remove = [
                key
                for key, entry in self._projection_cache.items()
                if (run_id is not None and key[0] == run_id)
                or (archive_id is not None and entry.archive_id == archive_id)
                or (run_id is None and archive_id is None)
            ]
            for key in remove:
                self._projection_cache.pop(key, None)

    def _verify_owned_row(self, row: _BookRow) -> Path:
        return self._owned_file(row, verify_checksum=True)

    @staticmethod
    def _trusted_source_issue(row: _BookRow) -> str | None:
        try:
            path = Path(str(row["trusted_source_path"])).expanduser()
            if path.is_symlink():
                return "TRUSTED_SOURCE_SYMLINK"
            resolved = path.resolve()
            if not resolved.is_file() or resolved.is_symlink():
                return "TRUSTED_SOURCE_UNAVAILABLE"
            if resolved.stat().st_size != _counter(row["byte_size"], "byte_size"):
                return "TRUSTED_SOURCE_SIZE_MISMATCH"
            if _digest_file(resolved) != str(row["checksum_sha256"]):
                return "TRUSTED_SOURCE_CHECKSUM_MISMATCH"
        except (OSError, TypeError, ValueError):
            return "TRUSTED_SOURCE_UNAVAILABLE"
        return None

    def _owned_file(
        self,
        row: _BookRow,
        verify_checksum: bool,
    ) -> Path:
        local_path = row["local_path"]
        if not isinstance(local_path, str) or not local_path:
            raise ValueError("historical book local object is missing")
        path = self._owned_path(local_path)
        if not path.is_file() or path.is_symlink():
            raise ValueError("historical book local object is not a regular file")
        stat = path.stat()
        if stat.st_size != _counter(row["byte_size"], "byte_size"):
            raise ValueError("historical book local object size changed")
        if verify_checksum:
            key = (str(path), stat.st_mtime_ns, stat.st_size)
            checksum = self._checksum_cache.get(key)
            if checksum is None:
                checksum = _digest_file(path)
                self._checksum_cache = {key: checksum}
            if checksum != str(row["checksum_sha256"]):
                raise ValueError("historical book local object checksum changed")
        return path

    def _owned_path(self, relative: str) -> Path:
        if Path(relative).is_absolute():
            raise ValueError("historical book local path must be relative")
        candidate = (self.root / relative).resolve()
        if not candidate.is_relative_to(self.root):
            raise ValueError("historical book local path escapes the owned root")
        return candidate

    def _ensure_dirs(self) -> None:
        (self.root / "objects").mkdir(parents=True, exist_ok=True)
        (self.root / ".tmp").mkdir(parents=True, exist_ok=True)
        (self.root / ".trash").mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _descriptor_from_row(row: _BookRow) -> HistoricalBookArchiveDescriptor:
        return HistoricalBookArchiveDescriptor(
            archive_id=str(row["archive_id"]),
            identity_key=str(row["identity_key"]),
            exchange=str(row["exchange"]),
            market_type=str(row["market_type"]),
            symbol=str(row["symbol"]),
            range_start_ms=_counter(row["range_start_ms"], "range_start_ms"),
            range_end_ms=_counter(row["range_end_ms"], "range_end_ms"),
            dataset_epoch=str(row["dataset_epoch"]),
            checksum_sha256=str(row["checksum_sha256"]),
            byte_size=_counter(row["byte_size"], "byte_size"),
            snapshot_count=_counter(row["snapshot_count"], "snapshot_count"),
            delta_count=_counter(row["delta_count"], "delta_count"),
            max_depth_levels=_counter(row["max_depth_levels"], "max_depth_levels"),
            trusted_origin=str(row["trusted_origin"]),
            trusted_source_path=str(row["trusted_source_path"]),
        )

    @staticmethod
    def _public_archive(row: _BookRow) -> dict[str, object]:
        keys = row.keys() if hasattr(row, "keys") else ()
        return {
            "archive_id": str(row["archive_id"]),
            "protocol": str(row["protocol"]),
            "adapter_kind": str(row["adapter_kind"]),
            "identity": {
                "exchange": str(row["exchange"]),
                "market_type": str(row["market_type"]),
                "symbol": str(row["symbol"]),
            },
            "range": {
                "start_ms": _counter(row["range_start_ms"], "range_start_ms"),
                "end_ms": _counter(row["range_end_ms"], "range_end_ms"),
            },
            "schema_version": str(row["schema_version"]),
            "dataset_epoch": str(row["dataset_epoch"]),
            "checksum_sha256": str(row["checksum_sha256"]),
            "snapshot_count": _counter(row["snapshot_count"], "snapshot_count"),
            "delta_count": _counter(row["delta_count"], "delta_count"),
            "max_depth_levels": _counter(row["max_depth_levels"], "max_depth_levels"),
            "coverage_state": str(row["coverage_state"]),
            "continuity_state": str(row["continuity_state"]),
            "health": str(row["health"]),
            "byte_size": _counter(row["byte_size"], "byte_size"),
            "trusted_origin": str(row["trusted_origin"]),
            "source_contract_url": str(row["source_contract_url"]),
            "quarantine_reason": row["quarantine_reason"],
            "generation": _counter(row["generation"], "generation"),
            "ref_count": (
                _counter(row["ref_count"], "ref_count") if "ref_count" in keys else 0
            ),
        }


__all__ = [
    "ARCHIVE_ADAPTER_KIND",
    "ARCHIVE_PROTOCOL",
    "ARCHIVE_SCHEMA_VERSION",
    "ARCHIVE_SOURCE_CONTRACT_URL",
    "BOOK_EXECUTION_FIDELITY",
    "BOOK_GC_PROTOCOL",
    "HistoricalBookArchiveDescriptor",
    "HistoricalBookArchiveManager",
    "HistoricalBookProjection",
    "HISTORICAL_L2_LIQUIDATION_FIDELITY",
    "PreparedHistoricalBookBinding",
    "bind_historical_book_archive",
    "verify_historical_book_archive",
]
