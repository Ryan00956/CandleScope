"""Immutable historical account inputs for replay.v2 exact modelled accounts."""

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
from typing import TYPE_CHECKING, TypeAlias

from app.replay.broker.models import canonical_decimal
from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.models import validate_identifier, validate_timestamp_ms
from app.replay.storage import ReplaySQLiteStore

from .account import MaintenanceTier
from .control import compatible_step_interval_ms
from .errors import TrainingRunError
from .models import (
    AccountHistoryRef,
    CapabilityState,
    FundingMode,
    StartMode,
    TrainingRunCreateRequest,
)

if TYPE_CHECKING:
    from sqlite3 import Row


ARCHIVE_PROTOCOL = "replay.account-history.archive.v1"
ARCHIVE_SCHEMA_VERSION = "replay.account-history.linear.v1"
ARCHIVE_CONTRACT_MODEL = "LINEAR_QUOTE_SETTLED_V1"
ARCHIVE_POSITION_MODE = "ONE_WAY"
ARCHIVE_MARGIN_ASSET_MODE = "SINGLE_QUOTE"
ARCHIVE_FORMULA_VERSION = "CANDLESCOPE_LINEAR_ACCOUNT_V1"
ARCHIVE_ROUNDING_MODE = "DECIMAL_EXACT_QUOTE_STEP_CEILING"
ARCHIVE_CAPTURE_MODE = "OPERATOR_CAPTURED"
ACCOUNT_AUDIT_SCHEMA_VERSION = "replay.account-audit.v1"
ACCOUNT_GC_PROTOCOL = "replay.account-history.gc.v1"
EXACT_ACCOUNT_FIDELITY = "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
RULE_EVENT_PHASE = 10
MARK_INDEX_EVENT_PHASE = 30
FUNDING_EVENT_PHASE = 40
_ROOT_HASH = "sha256:" + "0" * 64

_META_COLUMNS = ("key", "value")
_RULE_COLUMNS = (
    "sequence",
    "effective_time_ms",
    "source_kind",
    "price_tick",
    "quantity_step",
    "min_quantity",
    "max_quantity",
    "min_notional",
    "max_notional",
    "quote_step",
    "contract_size",
    "max_leverage",
    "liquidation_fee_bps",
    "maintenance_tiers_json",
    "rule_hash",
)
_MARK_COLUMNS = (
    "sequence",
    "event_time_ms",
    "mark_price",
    "index_price",
)
_FUNDING_COLUMNS = (
    "sequence",
    "settlement_time_ms",
    "funding_rate",
    "mark_price",
)
_EVENT_COLUMNS = (
    "event_sequence",
    "event_time_ms",
    "event_phase",
    "event_kind",
    "component_sequence",
    "previous_hash",
    "event_hash",
)
_META_KEYS = frozenset(
    {
        "protocol",
        "schema_version",
        "archive_id",
        "exchange",
        "market_type",
        "symbol",
        "settlement_asset",
        "contract_model",
        "position_mode",
        "margin_asset_mode",
        "dataset_epoch",
        "range_start_ms",
        "range_end_ms",
        "source",
        "provenance",
        "capture_mode",
        "formula_version",
        "rounding_mode",
        "max_mark_gap_ms",
        "funding_interval_ms",
        "funding_anchor_ms",
        "declared_rule_count",
        "declared_mark_count",
        "declared_funding_count",
        "declared_event_count",
        "event_chain_tail",
        "created_at_ms",
    }
)
_DIGEST_LENGTH = 71
_CHECKSUM_CACHE_ENTRIES = 256

_AccountRow: TypeAlias = "Row | Mapping[str, object]"


@dataclass(frozen=True, slots=True)
class AccountHistoryArchiveDescriptor:
    archive_id: str
    identity_key: str
    exchange: str
    market_type: str
    symbol: str
    settlement_asset: str
    range_start_ms: int
    range_end_ms: int
    dataset_epoch: str
    checksum_sha256: str
    proof_hash: str
    event_chain_tail: str
    rule_count: int
    mark_count: int
    funding_count: int
    event_count: int
    max_mark_gap_ms: int
    byte_size: int
    trusted_source_path: str
    trusted_origin: str
    metadata: Mapping[str, str]

    def ref(self) -> AccountHistoryRef:
        return AccountHistoryRef(
            schema_version="replay.account-history-ref.v1",
            archive_id=self.archive_id,
            dataset_epoch=self.dataset_epoch,
            checksum_sha256=self.checksum_sha256,
        )


@dataclass(frozen=True, slots=True)
class AccountHistoryEvent:
    archive_id: str
    event_sequence: int
    event_time_ms: int
    event_phase: int
    event_kind: str
    component_sequence: int
    previous_hash: str
    event_hash: str
    payload: Mapping[str, object]

    @property
    def stable_track_id_prefix(self) -> str:
        return "account"


@dataclass(frozen=True, slots=True)
class AccountHistoryProjection:
    archive_id: str
    archive_generation: int
    last_event_sequence: int
    last_rule_sequence: int
    last_mark_sequence: int
    last_funding_sequence: int
    as_of_actual_time_ms: int
    as_of_virtual_time_ms: int
    current_rule: Mapping[str, object]
    current_rule_hash: str
    mark_price: str
    index_price: str
    input_chain_hash: str


@dataclass(frozen=True, slots=True)
class PreparedAccountHistoryBinding:
    descriptor: AccountHistoryArchiveDescriptor
    projection: AccountHistoryProjection


def _digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _file_change_token(path: Path, stat: os.stat_result) -> int:
    """Return an OS change token that cannot be reset with ordinary utime."""

    if os.name != "nt":
        return int(stat.st_ctime_ns)

    import ctypes
    from ctypes import wintypes

    class FileBasicInfo(ctypes.Structure):
        _fields_ = [
            ("creation_time", ctypes.c_longlong),
            ("last_access_time", ctypes.c_longlong),
            ("last_write_time", ctypes.c_longlong),
            ("change_time", ctypes.c_longlong),
            ("file_attributes", wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    get_information = kernel32.GetFileInformationByHandleEx
    get_information.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    )
    get_information.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
    handle = create_file(
        str(path),
        0x0080,  # FILE_READ_ATTRIBUTES
        0x0001 | 0x0002 | 0x0004,  # share read/write/delete
        None,
        3,  # OPEN_EXISTING
        0,
        None,
    )
    if handle == wintypes.HANDLE(-1).value:
        raise OSError(ctypes.get_last_error(), f"cannot stat account archive {path}")
    try:
        information = FileBasicInfo()
        if not get_information(
            handle,
            0,  # FileBasicInfo
            ctypes.byref(information),
            ctypes.sizeof(information),
        ):
            raise OSError(
                ctypes.get_last_error(),
                f"cannot read account archive change token {path}",
            )
        return int(information.change_time)
    finally:
        close_handle(handle)


def _digest(value: object, field_name: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != _DIGEST_LENGTH
        or not value.startswith("sha256:")
    ):
        raise ValueError(f"{field_name} must be a sha256 digest")
    try:
        int(value[7:], 16)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a sha256 digest") from exc
    if value != value.lower():
        raise ValueError(f"{field_name} must use lowercase hexadecimal")
    return value


def _counter(value: object, field_name: str, *, positive: bool = False) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{field_name} must be an integer")
    try:
        result = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise TypeError(f"{field_name} must be an integer") from exc
    if result < (1 if positive else 0):
        qualifier = "positive" if positive else "non-negative"
        raise ValueError(f"{field_name} must be {qualifier}")
    return result


def _canonical(
    value: object,
    field_name: str,
    *,
    positive: bool = False,
    nonnegative: bool = False,
) -> str:
    result = canonical_decimal(
        value,
        field_name=field_name,
        positive=positive,
        nonnegative=nonnegative,
    )
    if result != value:
        raise ValueError(f"{field_name} must use canonical Decimal encoding")
    return result


def _read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(
        f"file:{path.as_posix()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    return connection


def _assert_columns(
    connection: sqlite3.Connection,
    table: str,
    expected: Sequence[str],
) -> None:
    rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    columns = tuple(str(row["name"]) for row in rows)
    if columns != tuple(expected):
        raise ValueError(
            f"{table} columns drifted: expected {tuple(expected)!r}, got {columns!r}"
        )


def _metadata(connection: sqlite3.Connection) -> dict[str, str]:
    _assert_columns(connection, "archive_meta", _META_COLUMNS)
    rows = connection.execute(
        "SELECT key, value FROM archive_meta ORDER BY key"
    ).fetchall()
    if len(rows) != len({str(row["key"]) for row in rows}):
        raise ValueError("archive_meta contains duplicate keys")
    metadata = {str(row["key"]): str(row["value"]) for row in rows}
    if set(metadata) != _META_KEYS:
        missing = sorted(_META_KEYS - set(metadata))
        extra = sorted(set(metadata) - _META_KEYS)
        raise ValueError(
            f"archive_meta contract mismatch: missing={missing}, extra={extra}"
        )
    return metadata


def account_rule_payload(row: Mapping[str, object]) -> dict[str, object]:
    try:
        raw_tiers = json.loads(str(row["maintenance_tiers_json"]))
    except json.JSONDecodeError as exc:
        raise ValueError("maintenance_tiers_json is invalid") from exc
    if not isinstance(raw_tiers, list) or not raw_tiers:
        raise ValueError("maintenance_tiers_json must be a non-empty array")
    tiers = [MaintenanceTier.from_mapping(item).to_dict() for item in raw_tiers]
    if canonical_json(tiers) != str(row["maintenance_tiers_json"]):
        raise ValueError("maintenance_tiers_json must use canonical JSON")
    return {
        "sequence": _counter(row["sequence"], "rule.sequence", positive=True),
        "effective_time_ms": validate_timestamp_ms(
            row["effective_time_ms"],
            field_name="rule.effective_time_ms",
        ),
        "source_kind": str(row["source_kind"]),
        "price_tick": _canonical(
            row["price_tick"], "rule.price_tick", positive=True
        ),
        "quantity_step": _canonical(
            row["quantity_step"], "rule.quantity_step", positive=True
        ),
        "min_quantity": _canonical(
            row["min_quantity"], "rule.min_quantity", positive=True
        ),
        "max_quantity": _canonical(
            row["max_quantity"], "rule.max_quantity", positive=True
        ),
        "min_notional": _canonical(
            row["min_notional"], "rule.min_notional", positive=True
        ),
        "max_notional": _canonical(
            row["max_notional"], "rule.max_notional", positive=True
        ),
        "quote_step": _canonical(
            row["quote_step"], "rule.quote_step", positive=True
        ),
        "contract_size": _canonical(
            row["contract_size"], "rule.contract_size", positive=True
        ),
        "max_leverage": _canonical(
            row["max_leverage"], "rule.max_leverage", positive=True
        ),
        "liquidation_fee_bps": _canonical(
            row["liquidation_fee_bps"],
            "rule.liquidation_fee_bps",
            nonnegative=True,
        ),
        "maintenance_tiers": tiers,
    }


def account_mark_payload(row: Mapping[str, object]) -> dict[str, object]:
    return {
        "sequence": _counter(row["sequence"], "mark.sequence", positive=True),
        "event_time_ms": validate_timestamp_ms(
            row["event_time_ms"],
            field_name="mark.event_time_ms",
        ),
        "mark_price": _canonical(
            row["mark_price"], "mark.mark_price", positive=True
        ),
        "index_price": _canonical(
            row["index_price"], "mark.index_price", positive=True
        ),
    }


def account_funding_payload(row: Mapping[str, object]) -> dict[str, object]:
    return {
        "sequence": _counter(
            row["sequence"], "funding.sequence", positive=True
        ),
        "settlement_time_ms": validate_timestamp_ms(
            row["settlement_time_ms"],
            field_name="funding.settlement_time_ms",
        ),
        "funding_rate": _canonical(
            row["funding_rate"], "funding.funding_rate"
        ),
        "mark_price": _canonical(
            row["mark_price"], "funding.mark_price", positive=True
        ),
    }


def account_archive_dataset_epoch(
    *,
    metadata_identity: Mapping[str, object],
    rules: Sequence[Mapping[str, object]],
    marks: Sequence[Mapping[str, object]],
    funding: Sequence[Mapping[str, object]],
) -> str:
    return canonical_sha256(
        {
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "metadata_identity": dict(metadata_identity),
            "instrument_rules": [dict(item) for item in rules],
            "mark_index_events": [dict(item) for item in marks],
            "funding_events": [dict(item) for item in funding],
        }
    )


def account_rule_component_hash(payload: Mapping[str, object]) -> str:
    return canonical_sha256(
        {
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "component": "instrument_rule",
            "payload": dict(payload),
        }
    )


def account_archive_root_hash(*, archive_id: str, dataset_epoch: str) -> str:
    return canonical_sha256(
        {
            "protocol": ARCHIVE_PROTOCOL,
            "archive_id": validate_identifier(archive_id, field_name="archive_id"),
            "dataset_epoch": _digest(dataset_epoch, "dataset_epoch"),
        }
    )


def account_archive_event_hash(
    *,
    previous_hash: str,
    event_sequence: int,
    event_time_ms: int,
    event_phase: int,
    event_kind: str,
    component_sequence: int,
    component: Mapping[str, object],
) -> str:
    return canonical_sha256(
        {
            "protocol": ARCHIVE_PROTOCOL,
            "previous_hash": _digest(previous_hash, "previous_hash"),
            "event_sequence": _counter(
                event_sequence, "event_sequence", positive=True
            ),
            "event_time_ms": validate_timestamp_ms(
                event_time_ms, field_name="event_time_ms"
            ),
            "event_phase": event_phase,
            "event_kind": event_kind,
            "component_sequence": _counter(
                component_sequence, "component_sequence", positive=True
            ),
            "component": dict(component),
        }
    )


def _identity_metadata(metadata: Mapping[str, str]) -> dict[str, object]:
    return {
        "archive_id": metadata["archive_id"],
        "exchange": metadata["exchange"],
        "market_type": metadata["market_type"],
        "symbol": metadata["symbol"],
        "settlement_asset": metadata["settlement_asset"],
        "contract_model": metadata["contract_model"],
        "position_mode": metadata["position_mode"],
        "margin_asset_mode": metadata["margin_asset_mode"],
        "range_start_ms": _counter(metadata["range_start_ms"], "range_start_ms"),
        "range_end_ms": _counter(metadata["range_end_ms"], "range_end_ms"),
        "source": metadata["source"],
        "provenance": metadata["provenance"],
        "capture_mode": metadata["capture_mode"],
        "formula_version": metadata["formula_version"],
        "rounding_mode": metadata["rounding_mode"],
        "max_mark_gap_ms": _counter(
            metadata["max_mark_gap_ms"], "max_mark_gap_ms", positive=True
        ),
        "funding_interval_ms": _counter(
            metadata["funding_interval_ms"], "funding_interval_ms"
        ),
        "funding_anchor_ms": _counter(
            metadata["funding_anchor_ms"], "funding_anchor_ms"
        ),
    }


def _component_payload(
    kind: str,
    component_sequence: int,
    *,
    rules: Mapping[int, Mapping[str, object]],
    marks: Mapping[int, Mapping[str, object]],
    funding: Mapping[int, Mapping[str, object]],
) -> Mapping[str, object]:
    table = {
        "RULE": rules,
        "MARK_INDEX": marks,
        "FUNDING": funding,
    }.get(kind)
    if table is None or component_sequence not in table:
        raise ValueError("archive_event references a missing component")
    return table[component_sequence]


def verify_account_history_archive(
    path: Path,
    *,
    trusted_origin: str = "OPERATOR_VERIFIED_CAPTURE",
) -> AccountHistoryArchiveDescriptor:
    """Fully verify an operator-captured immutable linear-account archive."""

    source = path.expanduser().resolve(strict=True)
    if not source.is_file():
        raise ValueError("account history archive must be a regular file")
    byte_size = source.stat().st_size
    if byte_size < 1:
        raise ValueError("account history archive cannot be empty")
    with closing(_read_only(source)) as connection:
        quick = connection.execute("PRAGMA quick_check").fetchall()
        if [str(row[0]) for row in quick] != ["ok"]:
            raise ValueError("account history archive failed SQLite quick_check")
        metadata = _metadata(connection)
        if metadata["protocol"] != ARCHIVE_PROTOCOL:
            raise ValueError("account history archive protocol is unsupported")
        if metadata["schema_version"] != ARCHIVE_SCHEMA_VERSION:
            raise ValueError("account history archive schema is unsupported")
        if metadata["contract_model"] != ARCHIVE_CONTRACT_MODEL:
            raise ValueError("account history contract model is unsupported")
        if metadata["position_mode"] != ARCHIVE_POSITION_MODE:
            raise ValueError("account history position mode is unsupported")
        if metadata["margin_asset_mode"] != ARCHIVE_MARGIN_ASSET_MODE:
            raise ValueError("account history margin asset mode is unsupported")
        if metadata["formula_version"] != ARCHIVE_FORMULA_VERSION:
            raise ValueError("account history formula version is unsupported")
        if metadata["rounding_mode"] != ARCHIVE_ROUNDING_MODE:
            raise ValueError("account history rounding mode is unsupported")
        verified_origin = validate_identifier(
            trusted_origin, field_name="trusted_origin"
        )
        if verified_origin != "OPERATOR_VERIFIED_CAPTURE":
            raise ValueError(
                "account history trusted_origin is not an operator verification"
            )
        if metadata["capture_mode"] != ARCHIVE_CAPTURE_MODE:
            raise ValueError(
                "account history archive is not an operator-captured source"
            )
        normalized_source = metadata["source"].upper()
        normalized_provenance = metadata["provenance"].upper()
        if not normalized_source.startswith("OPERATOR_CAPTURED_"):
            raise ValueError(
                "account history source is not an operator-captured source"
            )
        forbidden_proxy_markers = (
            "PUBLIC_KLINE",
            "KLINE_PROXY",
            "SYNTHETIC",
            "DERIVED_KLINE",
            "RECONSTRUCTED_KLINE",
        )
        if any(
            marker in normalized_source or marker in normalized_provenance
            for marker in forbidden_proxy_markers
        ):
            raise ValueError(
                "public K-line proxy data cannot claim historical exact account fidelity"
            )
        archive_id = validate_identifier(
            metadata["archive_id"], field_name="archive_id"
        )
        for key in (
            "exchange",
            "market_type",
            "symbol",
            "settlement_asset",
            "source",
            "provenance",
        ):
            if not metadata[key] or len(metadata[key]) > 512:
                raise ValueError(f"archive_meta.{key} is invalid")
        range_start = _counter(metadata["range_start_ms"], "range_start_ms")
        range_end = _counter(metadata["range_end_ms"], "range_end_ms")
        if range_end <= range_start:
            raise ValueError("account history range must have positive duration")
        max_gap = _counter(
            metadata["max_mark_gap_ms"], "max_mark_gap_ms", positive=True
        )
        created_at_ms = _counter(metadata["created_at_ms"], "created_at_ms")
        if created_at_ms > range_end + 100 * 365 * 86_400_000:
            raise ValueError("account history created_at_ms is implausible")

        _assert_columns(connection, "instrument_rule", _RULE_COLUMNS)
        _assert_columns(connection, "mark_index_event", _MARK_COLUMNS)
        _assert_columns(connection, "funding_event", _FUNDING_COLUMNS)
        _assert_columns(connection, "archive_event", _EVENT_COLUMNS)
        rule_rows = connection.execute(
            "SELECT * FROM instrument_rule ORDER BY sequence"
        ).fetchall()
        mark_rows = connection.execute(
            "SELECT * FROM mark_index_event ORDER BY sequence"
        ).fetchall()
        funding_rows = connection.execute(
            "SELECT * FROM funding_event ORDER BY sequence"
        ).fetchall()
        event_rows = connection.execute(
            "SELECT * FROM archive_event ORDER BY event_sequence"
        ).fetchall()
        declared_counts = (
            _counter(
                metadata["declared_rule_count"],
                "declared_rule_count",
                positive=True,
            ),
            _counter(
                metadata["declared_mark_count"],
                "declared_mark_count",
                positive=True,
            ),
            _counter(
                metadata["declared_funding_count"],
                "declared_funding_count",
            ),
            _counter(
                metadata["declared_event_count"],
                "declared_event_count",
                positive=True,
            ),
        )
        actual_counts = (
            len(rule_rows),
            len(mark_rows),
            len(funding_rows),
            len(event_rows),
        )
        if declared_counts != actual_counts:
            raise ValueError(
                f"account history row counts disagree: {declared_counts!r} != "
                f"{actual_counts!r}"
            )
        if len(mark_rows) < 2:
            raise ValueError("account history needs at least two mark/index events")

        rules: dict[int, Mapping[str, object]] = {}
        previous_time: int | None = None
        for expected, row in enumerate(rule_rows, 1):
            payload = account_rule_payload(row)
            sequence = int(payload["sequence"])
            if sequence != expected:
                raise ValueError("instrument_rule sequence is not contiguous")
            effective = int(payload["effective_time_ms"])
            if previous_time is not None and effective <= previous_time:
                raise ValueError("instrument_rule times are not strictly increasing")
            if effective < range_start or effective > range_end:
                raise ValueError("instrument_rule is outside the declared range")
            if expected == 1 and effective != range_start:
                raise ValueError("first instrument_rule must start at range_start_ms")
            if payload["source_kind"] not in {"BAR", "AGG_TRADE", "BOTH"}:
                raise ValueError("instrument_rule source_kind is unsupported")
            if Decimal(str(payload["min_quantity"])) > Decimal(
                str(payload["max_quantity"])
            ):
                raise ValueError("instrument_rule quantity bounds are inverted")
            if Decimal(str(payload["min_notional"])) > Decimal(
                str(payload["max_notional"])
            ):
                raise ValueError("instrument_rule notional bounds are inverted")
            tiers = payload["maintenance_tiers"]
            assert isinstance(tiers, list)
            last_cap = Decimal(0)
            for tier in tiers:
                assert isinstance(tier, Mapping)
                cap = Decimal(str(tier["notional_cap"]))
                if cap <= last_cap:
                    raise ValueError(
                        "instrument_rule maintenance tiers are not increasing"
                    )
                last_cap = cap
            if last_cap < Decimal(str(payload["max_notional"])):
                raise ValueError(
                    "instrument_rule maintenance tiers do not cover max_notional"
                )
            expected_hash = account_rule_component_hash(payload)
            if _digest(row["rule_hash"], "rule_hash") != expected_hash:
                raise ValueError("instrument_rule hash mismatch")
            rules[sequence] = payload
            previous_time = effective

        marks: dict[int, Mapping[str, object]] = {}
        mark_by_time: dict[int, Mapping[str, object]] = {}
        previous_time = None
        for expected, row in enumerate(mark_rows, 1):
            payload = account_mark_payload(row)
            sequence = int(payload["sequence"])
            if sequence != expected:
                raise ValueError("mark_index_event sequence is not contiguous")
            event_time = int(payload["event_time_ms"])
            if previous_time is not None:
                if event_time <= previous_time:
                    raise ValueError(
                        "mark_index_event times are not strictly increasing"
                    )
                if event_time - previous_time > max_gap:
                    raise ValueError("mark/index coverage exceeds max_mark_gap_ms")
            if event_time < range_start or event_time > range_end:
                raise ValueError("mark_index_event is outside the declared range")
            marks[sequence] = payload
            mark_by_time[event_time] = payload
            previous_time = event_time
        if int(marks[1]["event_time_ms"]) != range_start:
            raise ValueError("mark/index coverage must start at range_start_ms")
        if int(marks[len(marks)]["event_time_ms"]) != range_end:
            raise ValueError("mark/index coverage must end at range_end_ms")

        funding: dict[int, Mapping[str, object]] = {}
        previous_time = None
        for expected, row in enumerate(funding_rows, 1):
            payload = account_funding_payload(row)
            sequence = int(payload["sequence"])
            if sequence != expected:
                raise ValueError("funding_event sequence is not contiguous")
            settlement = int(payload["settlement_time_ms"])
            if previous_time is not None and settlement <= previous_time:
                raise ValueError("funding_event times are not strictly increasing")
            if settlement < range_start or settlement > range_end:
                raise ValueError("funding_event is outside the declared range")
            matching_mark = mark_by_time.get(settlement)
            if matching_mark is None:
                raise ValueError("funding_event has no same-time exact mark")
            if matching_mark["mark_price"] != payload["mark_price"]:
                raise ValueError("funding_event mark disagrees with mark/index history")
            funding[sequence] = payload
            previous_time = settlement

        funding_interval = _counter(
            metadata["funding_interval_ms"], "funding_interval_ms"
        )
        funding_anchor = _counter(
            metadata["funding_anchor_ms"], "funding_anchor_ms"
        )
        if funding_interval == 0:
            if funding_anchor != 0 or funding:
                raise ValueError("funding rows require a declared interval and anchor")
        else:
            if funding_interval < 60_000:
                raise ValueError("funding_interval_ms is below the supported bound")
            first = funding_anchor
            if first < range_start:
                delta = range_start - first
                first += ((delta + funding_interval - 1) // funding_interval) * (
                    funding_interval
                )
            expected_times = list(range(first, range_end + 1, funding_interval))
            actual_times = [
                int(item["settlement_time_ms"]) for item in funding.values()
            ]
            if expected_times != actual_times:
                raise ValueError("funding_event coverage has a missing or extra boundary")

        identity_meta = _identity_metadata(metadata)
        expected_dataset_epoch = account_archive_dataset_epoch(
            metadata_identity=identity_meta,
            rules=list(rules.values()),
            marks=list(marks.values()),
            funding=list(funding.values()),
        )
        dataset_epoch = _digest(metadata["dataset_epoch"], "dataset_epoch")
        if dataset_epoch != expected_dataset_epoch:
            raise ValueError("account history dataset_epoch does not match components")

        expected_components = {
            ("RULE", sequence) for sequence in rules
        } | {
            ("MARK_INDEX", sequence) for sequence in marks
        } | {
            ("FUNDING", sequence) for sequence in funding
        }
        seen_components: set[tuple[str, int]] = set()
        previous_hash = account_archive_root_hash(
            archive_id=archive_id,
            dataset_epoch=dataset_epoch,
        )
        previous_key: tuple[int, int, str, int] | None = None
        for expected, row in enumerate(event_rows, 1):
            sequence = _counter(
                row["event_sequence"], "archive_event.event_sequence", positive=True
            )
            if sequence != expected:
                raise ValueError("archive_event sequence is not contiguous")
            event_time = validate_timestamp_ms(
                row["event_time_ms"], field_name="archive_event.event_time_ms"
            )
            event_phase = _counter(
                row["event_phase"], "archive_event.event_phase", positive=True
            )
            event_kind = str(row["event_kind"])
            expected_phase = {
                "RULE": RULE_EVENT_PHASE,
                "MARK_INDEX": MARK_INDEX_EVENT_PHASE,
                "FUNDING": FUNDING_EVENT_PHASE,
            }.get(event_kind)
            if expected_phase is None or event_phase != expected_phase:
                raise ValueError("archive_event kind/phase contract is invalid")
            component_sequence = _counter(
                row["component_sequence"],
                "archive_event.component_sequence",
                positive=True,
            )
            component_key = (event_kind, component_sequence)
            if component_key in seen_components:
                raise ValueError("archive_event references a component twice")
            component = _component_payload(
                event_kind,
                component_sequence,
                rules=rules,
                marks=marks,
                funding=funding,
            )
            component_time = int(
                component[
                    {
                        "RULE": "effective_time_ms",
                        "MARK_INDEX": "event_time_ms",
                        "FUNDING": "settlement_time_ms",
                    }[event_kind]
                ]
            )
            if event_time != component_time:
                raise ValueError("archive_event time disagrees with its component")
            key = (event_time, event_phase, event_kind, component_sequence)
            if previous_key is not None and key <= previous_key:
                raise ValueError("archive_event stable ordering is not strictly increasing")
            if _digest(row["previous_hash"], "archive_event.previous_hash") != previous_hash:
                raise ValueError("archive_event previous hash mismatch")
            expected_hash = account_archive_event_hash(
                previous_hash=previous_hash,
                event_sequence=sequence,
                event_time_ms=event_time,
                event_phase=event_phase,
                event_kind=event_kind,
                component_sequence=component_sequence,
                component=component,
            )
            if _digest(row["event_hash"], "archive_event.event_hash") != expected_hash:
                raise ValueError("archive_event hash mismatch")
            previous_hash = expected_hash
            previous_key = key
            seen_components.add(component_key)
        if seen_components != expected_components:
            raise ValueError("archive_event does not cover every account component")
        event_chain_tail = _digest(
            metadata["event_chain_tail"], "event_chain_tail"
        )
        if previous_hash != event_chain_tail:
            raise ValueError("archive event-chain tail mismatch")

    checksum = _digest_file(source)
    identity_key = canonical_sha256(
        {
            "protocol": ARCHIVE_PROTOCOL,
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "metadata_identity": identity_meta,
            "dataset_epoch": dataset_epoch,
            "event_chain_tail": event_chain_tail,
        }
    )
    proof_hash = canonical_sha256(
        {
            "protocol": ARCHIVE_PROTOCOL,
            "identity_key": identity_key,
            "checksum_sha256": checksum,
            "row_counts": {
                "instrument_rule": len(rule_rows),
                "mark_index_event": len(mark_rows),
                "funding_event": len(funding_rows),
                "archive_event": len(event_rows),
            },
        }
    )
    return AccountHistoryArchiveDescriptor(
        archive_id=archive_id,
        identity_key=identity_key,
        exchange=metadata["exchange"],
        market_type=metadata["market_type"],
        symbol=metadata["symbol"],
        settlement_asset=metadata["settlement_asset"],
        range_start_ms=range_start,
        range_end_ms=range_end,
        dataset_epoch=dataset_epoch,
        checksum_sha256=checksum,
        proof_hash=proof_hash,
        event_chain_tail=event_chain_tail,
        rule_count=len(rule_rows),
        mark_count=len(mark_rows),
        funding_count=len(funding_rows),
        event_count=len(event_rows),
        max_mark_gap_ms=max_gap,
        byte_size=byte_size,
        trusted_source_path=str(source),
        trusted_origin=verified_origin,
        metadata=metadata,
    )


def _event_component(
    connection: sqlite3.Connection,
    event: Mapping[str, object],
) -> Mapping[str, object]:
    kind = str(event["event_kind"])
    sequence = int(event["component_sequence"])
    table, parser = {
        "RULE": ("instrument_rule", account_rule_payload),
        "MARK_INDEX": ("mark_index_event", account_mark_payload),
        "FUNDING": ("funding_event", account_funding_payload),
    }[kind]
    row = connection.execute(
        f"SELECT * FROM {table} WHERE sequence = ?",
        (sequence,),
    ).fetchone()
    if row is None:
        raise ValueError("account archive component disappeared")
    return parser(row)


def _archive_events(
    path: Path,
    *,
    after_sequence: int,
    event_time_ms: int | None = None,
    through_time_ms: int | None = None,
) -> tuple[AccountHistoryEvent, ...]:
    if event_time_ms is not None and through_time_ms is not None:
        raise ValueError("event_time_ms and through_time_ms are mutually exclusive")
    sql = "SELECT * FROM archive_event WHERE event_sequence > ?"
    values: list[object] = [after_sequence]
    if event_time_ms is not None:
        sql += " AND event_time_ms = ?"
        values.append(event_time_ms)
    if through_time_ms is not None:
        sql += " AND event_time_ms <= ?"
        values.append(through_time_ms)
    sql += " ORDER BY event_sequence"
    with closing(_read_only(path)) as connection:
        metadata = _metadata(connection)
        rows = connection.execute(sql, values).fetchall()
        result = []
        for row in rows:
            result.append(
                AccountHistoryEvent(
                    archive_id=metadata["archive_id"],
                    event_sequence=int(row["event_sequence"]),
                    event_time_ms=int(row["event_time_ms"]),
                    event_phase=int(row["event_phase"]),
                    event_kind=str(row["event_kind"]),
                    component_sequence=int(row["component_sequence"]),
                    previous_hash=str(row["previous_hash"]),
                    event_hash=str(row["event_hash"]),
                    payload=_event_component(connection, row),
                )
            )
        return tuple(result)


def _initial_projection(
    path: Path,
    *,
    archive_generation: int,
    actual_time_ms: int,
    virtual_time_ms: int,
) -> AccountHistoryProjection:
    with closing(_read_only(path)) as connection:
        metadata = _metadata(connection)
        rule = connection.execute(
            """
            SELECT * FROM instrument_rule
            WHERE effective_time_ms <= ?
            ORDER BY effective_time_ms DESC, sequence DESC LIMIT 1
            """,
            (actual_time_ms,),
        ).fetchone()
        mark = connection.execute(
            """
            SELECT * FROM mark_index_event
            WHERE event_time_ms <= ?
            ORDER BY event_time_ms DESC, sequence DESC LIMIT 1
            """,
            (actual_time_ms,),
        ).fetchone()
        if rule is None or mark is None:
            raise ValueError("account history lacks a rule or mark at run start")
        last_event = connection.execute(
            """
            SELECT COALESCE(MAX(event_sequence), 0) AS value
            FROM archive_event WHERE event_time_ms <= ?
            """,
            (actual_time_ms,),
        ).fetchone()
        last_funding = connection.execute(
            """
            SELECT COALESCE(MAX(sequence), 0) AS value
            FROM funding_event WHERE settlement_time_ms <= ?
            """,
            (actual_time_ms,),
        ).fetchone()
        rule_payload = account_rule_payload(rule)
        mark_payload = account_mark_payload(mark)
        return AccountHistoryProjection(
            archive_id=metadata["archive_id"],
            archive_generation=archive_generation,
            last_event_sequence=int(last_event["value"]),
            last_rule_sequence=int(rule["sequence"]),
            last_mark_sequence=int(mark["sequence"]),
            last_funding_sequence=int(last_funding["value"]),
            as_of_actual_time_ms=actual_time_ms,
            as_of_virtual_time_ms=virtual_time_ms,
            current_rule=rule_payload,
            current_rule_hash=str(rule["rule_hash"]),
            mark_price=str(mark_payload["mark_price"]),
            index_price=str(mark_payload["index_price"]),
            input_chain_hash=(
                str(
                    connection.execute(
                        """
                        SELECT event_hash FROM archive_event
                        WHERE event_sequence = ?
                        """,
                        (int(last_event["value"]),),
                    ).fetchone()["event_hash"]
                )
                if int(last_event["value"]) > 0
                else account_archive_root_hash(
                    archive_id=metadata["archive_id"],
                    dataset_epoch=metadata["dataset_epoch"],
                )
            ),
        )


def bind_account_history_archive(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    track_id: str,
    binding: PreparedAccountHistoryBinding,
    bound_range_start_ms: int,
    bound_range_end_ms: int,
    source_kind: str,
    now_ms: int,
) -> None:
    """Atomically pin one verified object and its no-lookahead start projection."""

    descriptor = binding.descriptor
    if (
        bound_range_start_ms < descriptor.range_start_ms
        or bound_range_end_ms > descriptor.range_end_ms
        or bound_range_end_ms < bound_range_start_ms
    ):
        raise ValueError("account history archive does not cover the atomic bind range")
    row = connection.execute(
        """
        SELECT health, checksum_sha256, generation
        FROM replay_account_history_archive WHERE archive_id = ?
        """,
        (descriptor.archive_id,),
    ).fetchone()
    if (
        row is None
        or row["health"] != "READY"
        or row["checksum_sha256"] != descriptor.checksum_sha256
        or int(row["generation"]) != binding.projection.archive_generation
    ):
        raise ValueError("account history archive changed before atomic bind")
    connection.execute(
        """
        UPDATE replay_account_history_ref
        SET active = 0, released_at_ms = ?
        WHERE run_id = ? AND track_id = ? AND active = 1
        """,
        (now_ms, run_id, track_id),
    )
    generation = int(
        connection.execute(
            """
            SELECT COALESCE(MAX(binding_generation), 0) + 1
            FROM replay_account_history_ref WHERE run_id = ? AND track_id = ?
            """,
            (run_id, track_id),
        ).fetchone()[0]
    )
    connection.execute(
        """
        INSERT INTO replay_account_history_ref(
            archive_id, run_id, track_id, binding_generation, active,
            bound_range_start_ms, bound_range_end_ms, dataset_epoch,
            checksum_sha256, archive_generation, event_chain_tail,
            created_at_ms, released_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            descriptor.archive_id,
            run_id,
            track_id,
            generation,
            bound_range_start_ms,
            bound_range_end_ms,
            descriptor.dataset_epoch,
            descriptor.checksum_sha256,
            binding.projection.archive_generation,
            descriptor.event_chain_tail,
            now_ms,
        ),
    )
    runtime_rule = runtime_instrument_rule(
        binding.projection.current_rule,
        track_id=track_id,
        source_kind=source_kind,
        actual_replay_start_ms=bound_range_start_ms,
        virtual_replay_start_ms=(
            binding.projection.as_of_virtual_time_ms
            - (
                binding.projection.as_of_actual_time_ms
                - bound_range_start_ms
            )
        ),
    )
    runtime_rule_hash = canonical_sha256(runtime_rule)
    connection.execute(
        """
        DELETE FROM replay_training_instrument_rule
        WHERE run_id = ? AND track_id = ?
        """,
        (run_id, track_id),
    )
    connection.execute(
        """
        INSERT INTO replay_training_instrument_rule(
            run_id, track_id, revision, effective_virtual_time_ms,
            rule_json, rule_hash, fidelity, created_at_ms
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            track_id,
            runtime_rule["effective_virtual_time_ms"],
            canonical_json(runtime_rule),
            runtime_rule_hash,
            "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE",
            now_ms,
        ),
    )
    projection = binding.projection
    connection.execute(
        """
        INSERT INTO replay_account_history_projection(
            run_id, track_id, archive_id, archive_generation,
            last_event_sequence, last_rule_sequence, last_mark_sequence,
            last_funding_sequence, as_of_actual_time_ms, as_of_virtual_time_ms,
            current_rule_json, current_rule_hash, mark_price, index_price,
            input_chain_hash, status, degraded_reason, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', NULL, ?)
        """,
        (
            run_id,
            track_id,
            descriptor.archive_id,
            projection.archive_generation,
            projection.last_event_sequence,
            projection.last_rule_sequence,
            projection.last_mark_sequence,
            projection.last_funding_sequence,
            projection.as_of_actual_time_ms,
            projection.as_of_virtual_time_ms,
            canonical_json(projection.current_rule),
            projection.current_rule_hash,
            projection.mark_price,
            projection.index_price,
            projection.input_chain_hash,
            now_ms,
        ),
    )
    bound_proofs = [
        {
            "track_id": str(row["track_id"]),
            "archive_id": str(row["archive_id"]),
            "proof_hash": str(row["proof_hash"]),
            "binding_generation": int(row["binding_generation"]),
        }
        for row in connection.execute(
            """
            SELECT ref.track_id, ref.archive_id, ref.binding_generation,
                   archive.proof_hash
            FROM replay_account_history_ref AS ref
            JOIN replay_account_history_archive AS archive USING(archive_id)
            WHERE ref.run_id = ? AND ref.active = 1
            ORDER BY ref.track_id
            """,
            (run_id,),
        ).fetchall()
    ]
    combined_proof = canonical_sha256(
        {
            "schema_version": "replay.account-history-binding-set.v1",
            "run_id": run_id,
            "bindings": bound_proofs,
        }
    )
    connection.execute(
        """
        INSERT INTO replay_training_account_history(
            run_id, account_data_mode, status, fidelity, archive_proof_hash,
            degraded_reason, auditor_status, auditor_proof_hash,
            auditor_differences_json, created_at_ms, updated_at_ms
        ) VALUES (?, 'HISTORICAL_EXACT', 'ACTIVE', ?, ?, NULL,
                  'NOT_RUN', NULL, '[]', ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
            account_data_mode = excluded.account_data_mode,
            status = excluded.status,
            fidelity = excluded.fidelity,
            archive_proof_hash = excluded.archive_proof_hash,
            degraded_reason = NULL,
            updated_at_ms = excluded.updated_at_ms
        """,
        (
            run_id,
            EXACT_ACCOUNT_FIDELITY,
            combined_proof,
            now_ms,
            now_ms,
        ),
    )
    connection.execute(
        """
        UPDATE replay_training_contract_account
        SET fidelity = ?, updated_at_ms = ? WHERE run_id = ?
        """,
        (EXACT_ACCOUNT_FIDELITY, now_ms, run_id),
    )
    connection.execute(
        """
        UPDATE replay_account_history_archive
        SET last_used_at_ms = ?, updated_at_ms = ? WHERE archive_id = ?
        """,
        (now_ms, now_ms, descriptor.archive_id),
    )


def runtime_instrument_rule(
    archive_rule: Mapping[str, object],
    *,
    track_id: str,
    source_kind: str,
    actual_replay_start_ms: int,
    virtual_replay_start_ms: int,
) -> dict[str, object]:
    declared_source = str(archive_rule["source_kind"])
    if declared_source not in {source_kind, "BOTH"}:
        raise ValueError("account history rule does not support the replay source")
    effective_actual = int(archive_rule["effective_time_ms"])
    effective_virtual = (
        virtual_replay_start_ms + effective_actual - actual_replay_start_ms
    )
    return {
        "track_id": validate_identifier(track_id, field_name="track_id"),
        "rule_version": "EXCHANGE_HISTORICAL_LINEAR_V1",
        "source_kind": source_kind,
        "price_tick": archive_rule["price_tick"],
        "quantity_step": archive_rule["quantity_step"],
        "min_quantity": archive_rule["min_quantity"],
        "max_quantity": archive_rule["max_quantity"],
        "min_notional": archive_rule["min_notional"],
        "max_notional": archive_rule["max_notional"],
        "quote_step": archive_rule["quote_step"],
        "contract_size": archive_rule["contract_size"],
        "max_leverage": archive_rule["max_leverage"],
        "liquidation_fee_bps": archive_rule["liquidation_fee_bps"],
        "maintenance_tiers": archive_rule["maintenance_tiers"],
        "mark_fidelity": "HISTORICAL_EXACT_ARCHIVE_MARK",
        "rule_fidelity": "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE",
        "effective_virtual_time_ms": validate_timestamp_ms(
            effective_virtual,
            field_name="effective_virtual_time_ms",
        ),
    }


class AccountHistoryArchiveManager:
    """Own verified account inputs and refuse every implicit proxy fallback."""

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
        self.max_archive_bytes = _counter(
            max_archive_bytes, "max_archive_bytes", positive=True
        )
        self.root = (
            root
            if root is not None
            else store.path.parent / f"{store.path.stem}-account-history"
        ).resolve()
        self._lock = asyncio.Lock()
        self._checksum_cache: OrderedDict[
            tuple[str, int, int, int], str
        ] = OrderedDict()
        self._checksum_cache_lock = threading.Lock()

    async def start(self) -> None:
        await asyncio.to_thread(self._ensure_dirs)
        await self._recover_gc_claims()
        if not self.enabled:
            await self._disable_exact_runs()

    async def import_archive(
        self,
        path: Path,
        *,
        trusted_origin: str = "OPERATOR_VERIFIED_CAPTURE",
    ) -> dict[str, object]:
        async with self._lock:
            descriptor = await asyncio.to_thread(
                verify_account_history_archive,
                path,
                trusted_origin=trusted_origin,
            )
            source = Path(descriptor.trusted_source_path)
            if source == self.root or source.is_relative_to(self.root):
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_TRUSTED_SOURCE_NOT_EXTERNAL",
                    "trusted account-history source must remain outside replay-owned storage",
                    status_code=409,
                )
            if descriptor.byte_size > self.max_archive_bytes:
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_ARCHIVE_BUDGET_EXCEEDED",
                    "account history archive exceeds its configured byte budget",
                    status_code=409,
                    details={
                        "byte_size": descriptor.byte_size,
                        "max_archive_bytes": self.max_archive_bytes,
                    },
                )
            existing = await self.store.run_extension_read(
                lambda connection: connection.execute(
                    """
                    SELECT * FROM replay_account_history_archive
                    WHERE identity_key = ?
                    """,
                    (descriptor.identity_key,),
                ).fetchone()
            )
            if existing is not None and existing["health"] == "READY":
                try:
                    await asyncio.to_thread(self._owned_file, existing, True)
                except Exception:
                    pass
                else:
                    return self._public_archive(existing)
            await self._assert_budget(
                descriptor.byte_size,
                excluding=(
                    None if existing is None else str(existing["archive_id"])
                ),
            )
            self._ensure_dirs()
            relative = f"objects/{descriptor.archive_id}.sqlite3"
            final = self._owned_path(relative)
            temp = self._owned_path(f".tmp/import-{uuid.uuid4().hex}.part")
            await asyncio.to_thread(shutil.copyfile, source, temp)
            if (
                await asyncio.to_thread(_digest_file, temp)
                != descriptor.checksum_sha256
                or temp.stat().st_size != descriptor.byte_size
            ):
                temp.unlink(missing_ok=True)
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_ARCHIVE_COPY_MISMATCH",
                    "immutable account-history copy failed verification",
                    status_code=409,
                )
            os.replace(temp, final)
            now_ms = self.store._validated_now_ms()

            def write(connection: sqlite3.Connection) -> sqlite3.Row:
                connection.execute(
                    """
                    INSERT INTO replay_account_history_archive(
                        archive_id, identity_key, protocol, schema_version,
                        exchange, market_type, symbol, settlement_asset,
                        range_start_ms, range_end_ms, dataset_epoch,
                        checksum_sha256, proof_hash, event_chain_tail,
                        rule_count, mark_count, funding_count, event_count,
                        max_mark_gap_ms, byte_size, health, local_path,
                        trusted_source_path, trusted_origin, metadata_json,
                        quarantine_reason, generation, last_used_at_ms,
                        created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                              ?, ?, ?, ?, 'READY', ?, ?, ?, ?, NULL, 1, ?, ?, ?)
                    ON CONFLICT(identity_key) DO UPDATE SET
                        health = 'READY',
                        local_path = excluded.local_path,
                        trusted_source_path = excluded.trusted_source_path,
                        trusted_origin = excluded.trusted_origin,
                        byte_size = excluded.byte_size,
                        metadata_json = excluded.metadata_json,
                        quarantine_reason = NULL,
                        generation = replay_account_history_archive.generation + 1,
                        last_used_at_ms = excluded.last_used_at_ms,
                        updated_at_ms = excluded.updated_at_ms
                    """,
                    (
                        descriptor.archive_id,
                        descriptor.identity_key,
                        ARCHIVE_PROTOCOL,
                        ARCHIVE_SCHEMA_VERSION,
                        descriptor.exchange,
                        descriptor.market_type,
                        descriptor.symbol,
                        descriptor.settlement_asset,
                        descriptor.range_start_ms,
                        descriptor.range_end_ms,
                        descriptor.dataset_epoch,
                        descriptor.checksum_sha256,
                        descriptor.proof_hash,
                        descriptor.event_chain_tail,
                        descriptor.rule_count,
                        descriptor.mark_count,
                        descriptor.funding_count,
                        descriptor.event_count,
                        descriptor.max_mark_gap_ms,
                        descriptor.byte_size,
                        relative,
                        descriptor.trusted_source_path,
                        descriptor.trusted_origin,
                        canonical_json(descriptor.metadata),
                        now_ms,
                        now_ms,
                        now_ms,
                    ),
                )
                row = connection.execute(
                    """
                    SELECT * FROM replay_account_history_archive
                    WHERE identity_key = ?
                    """,
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

    async def list_archives(self) -> dict[str, object]:
        rows = await self.store.run_extension_read(
            lambda connection: tuple(
                connection.execute(
                    """
                    SELECT archive.*,
                           (SELECT COUNT(*) FROM replay_account_history_ref AS ref
                            WHERE ref.archive_id = archive.archive_id
                              AND ref.active = 1) AS active_pins
                    FROM replay_account_history_archive AS archive
                    ORDER BY created_at_ms DESC, archive_id
                    """
                ).fetchall()
            )
        )
        items = [self._public_archive(row) for row in rows]
        return {
            "protocol": ARCHIVE_PROTOCOL,
            "feature_enabled": self.enabled,
            "max_archive_bytes": self.max_archive_bytes,
            "items": items,
            "summary": {
                "archive_count": len(items),
                "ready_count": sum(item["health"] == "READY" for item in items),
                "evicted_count": sum(item["health"] == "EVICTED" for item in items),
                "quarantined_count": sum(
                    item["health"] == "QUARANTINED" for item in items
                ),
                "pinned_count": sum(
                    int(item["active_pins"]) > 0 for item in items
                ),
                "local_bytes": sum(
                    int(row["byte_size"])
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
            raise ValueError(
                "target_reclaim_bytes must be between 1 and 1000000000000"
            )
        if (
            isinstance(max_archives, bool)
            or not isinstance(max_archives, int)
            or not 1 <= max_archives <= 10_000
        ):
            raise ValueError("max_archives must be between 1 and 10000")

        def read(
            connection: sqlite3.Connection,
        ) -> tuple[tuple[_AccountRow, ...], int]:
            rows = tuple(
                connection.execute(
                    """
                    SELECT archive.*,
                           (SELECT COUNT(*)
                            FROM replay_account_history_ref AS ref
                            WHERE ref.archive_id = archive.archive_id
                              AND ref.active = 1) AS active_pins
                    FROM replay_account_history_archive AS archive
                    WHERE archive.health = 'READY'
                    ORDER BY archive.last_used_at_ms, archive.archive_id
                    """
                ).fetchall()
            )
            total = connection.execute(
                """
                SELECT COALESCE(SUM(byte_size), 0)
                FROM replay_account_history_archive
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
            active_pins = int(row["active_pins"])
            if active_pins > 0:
                reasons.append("ACTIVE_ARCHIVE_PIN")
            try:
                self._owned_file(row, True)
            except Exception as exc:
                reasons.append(f"OWNED_OBJECT_{type(exc).__name__.upper()}")
            trusted_issue = self._trusted_source_issue(row)
            if trusted_issue is not None:
                reasons.append(trusted_issue)
            item = {
                "archive_id": str(row["archive_id"]),
                "generation": int(row["generation"]),
                "byte_size": int(row["byte_size"]),
                "active_pin_count": active_pins,
                "recoverability": "TRUSTED_LOCAL_SOURCE_CHECKSUM_BOUND",
            }
            if reasons:
                protected.append(
                    {**item, "protection_reasons": sorted(set(reasons))}
                )
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
                "protocol": ACCOUNT_GC_PROTOCOL,
                "request": request,
                "candidates": candidates,
            }
        )
        plan = {
            "protocol": ACCOUNT_GC_PROTOCOL,
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
        async with self._lock:
            plan = await self._gc_plan(
                target_reclaim_bytes=target_reclaim_bytes,
                max_archives=max_archives,
                audit=False,
            )
            if plan["plan_hash"] != plan_hash:
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_GC_PLAN_CHANGED",
                    "account history GC plan changed; run dry-run again",
                    status_code=409,
                    details={"current_plan_hash": plan["plan_hash"]},
                )
            raw_candidates = plan["candidates"]
            if not isinstance(raw_candidates, list):
                raise RuntimeError("account history GC plan candidates are malformed")
            reclaimed: list[dict[str, object]] = []
            skipped: list[dict[str, object]] = []
            for candidate in raw_candidates:
                if not isinstance(candidate, Mapping):
                    raise RuntimeError(
                        "account history GC candidate is malformed"
                    )
                result = await self._reclaim_archive(candidate)
                (reclaimed if result["reclaimed"] else skipped).append(result)
            result = {
                "protocol": ACCOUNT_GC_PROTOCOL,
                "mode": "RUN",
                "plan_hash": plan_hash,
                "request": plan["request"],
                "reclaimed": reclaimed,
                "skipped": skipped,
                "reclaimed_bytes": sum(
                    int(item["byte_size"]) for item in reclaimed
                ),
                "exact_dry_run_set": not skipped,
                "pinned_auto_reclaimed": False,
            }
            await self._audit_gc("RUN", plan_hash, plan["request"], result)
            return result

    async def rehydrate_archive(self, archive_id: str) -> dict[str, object]:
        normalized = validate_identifier(archive_id, field_name="archive_id")
        async with self._lock:
            row = await self.store.run_extension_read(
                lambda connection: connection.execute(
                    """
                    SELECT archive.*,
                           (SELECT COUNT(*)
                            FROM replay_account_history_ref AS ref
                            WHERE ref.archive_id = archive.archive_id
                              AND ref.active = 1) AS active_pins
                    FROM replay_account_history_archive AS archive
                    WHERE archive.archive_id = ?
                    """,
                    (normalized,),
                ).fetchone()
            )
            if row is None:
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_ARCHIVE_NOT_FOUND",
                    "account history archive does not exist",
                    status_code=404,
                )
            if row["health"] == "READY":
                try:
                    await asyncio.to_thread(self._owned_file, row, True)
                except Exception as exc:
                    await self._quarantine(
                        normalized,
                        f"OWNED_OBJECT_{type(exc).__name__.upper()}",
                    )
                    row = await self.store.run_extension_read(
                        lambda connection: connection.execute(
                            """
                            SELECT archive.*,
                                   (SELECT COUNT(*)
                                    FROM replay_account_history_ref AS ref
                                    WHERE ref.archive_id = archive.archive_id
                                      AND ref.active = 1) AS active_pins
                            FROM replay_account_history_archive AS archive
                            WHERE archive.archive_id = ?
                            """,
                            (normalized,),
                        ).fetchone()
                    )
                    assert row is not None
                else:
                    return self._public_archive(row)
            await self._rehydrate_row(row)
            restored = await self.store.run_extension_read(
                lambda connection: connection.execute(
                    """
                    SELECT archive.*,
                           (SELECT COUNT(*)
                            FROM replay_account_history_ref AS ref
                            WHERE ref.archive_id = archive.archive_id
                              AND ref.active = 1) AS active_pins
                    FROM replay_account_history_archive AS archive
                    WHERE archive.archive_id = ?
                    """,
                    (normalized,),
                ).fetchone()
            )
            assert restored is not None
            result = self._public_archive(restored)
            audit_hash = canonical_sha256(
                {
                    "protocol": ACCOUNT_GC_PROTOCOL,
                    "action": "REHYDRATE",
                    "archive_id": normalized,
                    "proof_hash": result["proof_hash"],
                }
            )
            await self._audit_gc(
                "REHYDRATE",
                audit_hash,
                {"archive_id": normalized},
                result,
            )
            return result

    async def plan_for_request(
        self,
        request: TrainingRunCreateRequest,
    ) -> dict[str, object]:
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
        state = CapabilityState.UNSUPPORTED_NO_HISTORY.value
        reason = "FEATURE_DISABLED"
        row: _AccountRow | None = None
        if self.enabled:
            if request.start_mode is not StartMode.MANUAL or requested_start is None:
                state = CapabilityState.UNSUPPORTED_SOURCE_MODE.value
                reason = "MANUAL_START_REQUIRED"
            else:
                row = await self._select_archive(
                    exchange=request.exchange,
                    market_type=request.market_type,
                    symbol=request.symbol,
                    settlement_asset=request.settlement_asset,
                    range_start_ms=requested_start,
                    range_end_ms=int(requested_end),
                    require_funding=(
                        request.funding_mode is FundingMode.HISTORICAL_EXACT
                    ),
                )
                if row is None:
                    state = CapabilityState.UNSUPPORTED_NO_HISTORY.value
                    reason = "NO_COMPLETE_PINNABLE_ARCHIVE"
                else:
                    try:
                        await asyncio.to_thread(self._owned_file, row, True)
                    except Exception:
                        await self._quarantine(
                            str(row["archive_id"]),
                            "PLAN_OBJECT_VERIFICATION_FAILED",
                        )
                        state = CapabilityState.DEGRADED.value
                        reason = "ARCHIVE_OBJECT_UNAVAILABLE"
                        row = None
                    else:
                        state = CapabilityState.AVAILABLE_EXACT.value
                        reason = "VERIFIED_OPERATOR_CAPTURE"
        return {
            "protocol": ARCHIVE_PROTOCOL,
            "feature_enabled": self.enabled,
            "requested_mode": request.account_data_mode.value,
            "capability_state": state,
            "reason": reason,
            "fidelity": EXACT_ACCOUNT_FIDELITY,
            "supported_contract_model": ARCHIVE_CONTRACT_MODEL,
            "supported_position_mode": ARCHIVE_POSITION_MODE,
            "supported_margin_asset_mode": ARCHIVE_MARGIN_ASSET_MODE,
            "historical_funding_exact": (
                row is not None and int(row["funding_count"]) > 0
            ),
            "public_kline_proxy_accepted": False,
            "ready_archive_bytes": 0 if row is None else int(row["byte_size"]),
            "max_archive_bytes": self.max_archive_bytes,
            "coverage": (
                None
                if row is None
                else {
                    "range_start_ms": int(row["range_start_ms"]),
                    "range_end_ms": int(row["range_end_ms"]),
                }
            ),
            "account_history_ref": (
                None
                if row is None
                else {
                    "schema_version": "replay.account-history-ref.v1",
                    "archive_id": str(row["archive_id"]),
                    "dataset_epoch": str(row["dataset_epoch"]),
                    "checksum_sha256": str(row["checksum_sha256"]),
                }
            ),
        }

    async def prepare_binding(
        self,
        *,
        request: TrainingRunCreateRequest,
        bound_range_start_ms: int,
        bound_range_end_ms: int,
        actual_time_ms: int,
        virtual_time_ms: int,
    ) -> PreparedAccountHistoryBinding:
        if not self.enabled:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_DISABLED",
                "REPLAY_ACCOUNT_HISTORY_ENABLED is disabled",
                status_code=409,
                details={"fallback_applied": False},
            )
        if request.start_mode is not StartMode.MANUAL:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_MANUAL_START_REQUIRED",
                "historical exact account data requires a manual start",
                status_code=409,
                details={"fallback_applied": False},
            )
        reference = request.account_history_ref
        if reference is None:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REF_REQUIRED",
                "create must return the exact account-history ref from plan",
                status_code=409,
                details={"fallback_applied": False},
            )
        row = await self.store.run_extension_read(
            lambda connection: connection.execute(
                """
                SELECT * FROM replay_account_history_archive
                WHERE archive_id = ? AND dataset_epoch = ?
                  AND checksum_sha256 = ? AND health = 'READY'
                """,
                (
                    reference.archive_id,
                    reference.dataset_epoch,
                    reference.checksum_sha256,
                ),
            ).fetchone()
        )
        if row is None:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REF_STALE",
                "planned account-history ref is absent or changed",
                status_code=409,
                details={"fallback_applied": False},
            )
        if (
            str(row["exchange"]) != request.exchange
            or str(row["market_type"]) != request.market_type
            or str(row["symbol"]) != request.symbol
            or str(row["settlement_asset"]) != request.settlement_asset
        ):
            raise TrainingRunError(
                "ACCOUNT_HISTORY_IDENTITY_MISMATCH",
                "account-history ref belongs to a different instrument",
                status_code=409,
                details={"fallback_applied": False},
            )
        if (
            int(row["range_start_ms"]) > bound_range_start_ms
            or int(row["range_end_ms"]) < bound_range_end_ms
        ):
            raise TrainingRunError(
                "ACCOUNT_HISTORY_COVERAGE_UNAVAILABLE",
                "account-history ref does not cover the selected training range",
                status_code=409,
                details={"fallback_applied": False},
            )
        if (
            request.funding_mode is FundingMode.HISTORICAL_EXACT
            and int(row["funding_count"]) < 1
        ):
            raise TrainingRunError(
                "HISTORICAL_FUNDING_UNAVAILABLE",
                "account-history ref has no complete funding component",
                status_code=409,
                details={"fallback_applied": False},
            )
        try:
            path = await asyncio.to_thread(self._owned_file, row, True)
            descriptor = await asyncio.to_thread(
                verify_account_history_archive,
                path,
                trusted_origin=str(row["trusted_origin"]),
            )
            projection = await asyncio.to_thread(
                _initial_projection,
                path,
                archive_generation=int(row["generation"]),
                actual_time_ms=actual_time_ms,
                virtual_time_ms=virtual_time_ms,
            )
        except Exception as exc:
            await self._quarantine(
                str(row["archive_id"]), f"PREPARE_{type(exc).__name__}"
            )
            raise TrainingRunError(
                "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                "account-history object failed immutable verification",
                status_code=409,
                details={"reason": str(exc)[:300], "fallback_applied": False},
            ) from exc
        if (
            descriptor.checksum_sha256 != reference.checksum_sha256
            or descriptor.dataset_epoch != reference.dataset_epoch
        ):
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REF_STALE",
                "verified account-history object no longer matches its plan ref",
                status_code=409,
                details={"fallback_applied": False},
            )
        return PreparedAccountHistoryBinding(descriptor, projection)

    async def prepare_track_binding(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        settlement_asset: str,
        source_kind: str,
        bound_range_start_ms: int,
        bound_range_end_ms: int,
        actual_time_ms: int,
        virtual_time_ms: int,
        require_funding: bool,
    ) -> PreparedAccountHistoryBinding:
        """Select and verify an archive while atomically preparing an added track."""

        if not self.enabled:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_DISABLED",
                "REPLAY_ACCOUNT_HISTORY_ENABLED is disabled",
                status_code=409,
                details={"fallback_applied": False},
            )
        row = await self._select_archive(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            settlement_asset=settlement_asset,
            range_start_ms=bound_range_start_ms,
            range_end_ms=bound_range_end_ms,
            require_funding=require_funding,
        )
        if row is None:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_COVERAGE_UNAVAILABLE",
                "exact account track has no complete immutable archive",
                status_code=409,
                details={
                    "exchange": exchange,
                    "market_type": market_type,
                    "symbol": symbol,
                    "fallback_applied": False,
                },
            )
        try:
            path = await asyncio.to_thread(self._owned_file, row, True)
            descriptor = await asyncio.to_thread(
                verify_account_history_archive,
                path,
                trusted_origin=str(row["trusted_origin"]),
            )
            projection = await asyncio.to_thread(
                _initial_projection,
                path,
                archive_generation=int(row["generation"]),
                actual_time_ms=actual_time_ms,
                virtual_time_ms=virtual_time_ms,
            )
            runtime_instrument_rule(
                projection.current_rule,
                track_id="track-probe",
                source_kind=source_kind,
                actual_replay_start_ms=bound_range_start_ms,
                virtual_replay_start_ms=(
                    virtual_time_ms
                    - (actual_time_ms - bound_range_start_ms)
                ),
            )
        except Exception as exc:
            await self._quarantine(
                str(row["archive_id"]), f"TRACK_PREPARE_{type(exc).__name__}"
            )
            raise TrainingRunError(
                "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                "added-track account archive failed immutable verification",
                status_code=409,
                details={"reason": str(exc)[:300], "fallback_applied": False},
            ) from exc
        return PreparedAccountHistoryBinding(descriptor, projection)

    async def guard_run(
        self,
        *,
        run_id: str,
        tracks: Sequence[Mapping[str, object]],
    ) -> None:
        mode = await self.store.run_extension_read(
            lambda connection: connection.execute(
                """
                SELECT account_data_mode, status
                FROM replay_training_account_history WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
        )
        if mode is None or mode["account_data_mode"] != "HISTORICAL_EXACT":
            return
        if not self.enabled:
            await self._degrade_run(run_id, None, "ACCOUNT_HISTORY_FEATURE_DISABLED")
            raise TrainingRunError(
                "ACCOUNT_HISTORY_DISABLED",
                "exact account run is paused because its feature is disabled",
                status_code=409,
                details={"fallback_applied": False},
            )
        if mode["status"] != "ACTIVE":
            raise TrainingRunError(
                "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                "exact account run is not active",
                status_code=409,
                details={"fallback_applied": False},
            )
        track_ids = tuple(
            str(track["track_id"])
            for track in tracks
            if track.get("subscription_tier") == "FULL"
        )
        bindings = await self._active_bindings(run_id, track_ids)
        for track_id in track_ids:
            row = bindings.get(track_id)
            if row is None:
                await self._degrade_run(
                    run_id, track_id, "ACCOUNT_HISTORY_BINDING_MISSING"
                )
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_BINDING_MISSING",
                    "a FULL exact-account track has no active immutable binding",
                    status_code=409,
                    details={"track_id": track_id, "fallback_applied": False},
                )
            try:
                await asyncio.to_thread(self._owned_file, row, True)
            except Exception as exc:
                await self._quarantine(
                    str(row["archive_id"]), f"GUARD_{type(exc).__name__}"
                )
                await self._degrade_run(
                    run_id, track_id, "ACCOUNT_HISTORY_OBJECT_UNAVAILABLE"
                )
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                    "exact account object changed or disappeared",
                    status_code=409,
                    details={"track_id": track_id, "fallback_applied": False},
                ) from exc

    async def authoritative_projections(
        self,
        *,
        run_id: str,
        tracks: Sequence[Mapping[str, object]],
    ) -> dict[str, dict[str, object]]:
        """Re-read pinned objects for an auditor independent of runtime projections."""

        await self.guard_run(run_id=run_id, tracks=tracks)
        track_ids = tuple(
            str(track["track_id"])
            for track in tracks
            if track.get("subscription_tier") == "FULL"
        )
        bindings = await self._active_bindings(run_id, track_ids)

        def read_projection(
            track_id: str,
            row: _AccountRow,
        ) -> tuple[str, AccountHistoryProjection]:
            path = self._owned_file(row, True)
            return (
                track_id,
                _initial_projection(
                    path,
                    archive_generation=int(row["generation"]),
                    actual_time_ms=int(row["as_of_actual_time_ms"]),
                    virtual_time_ms=int(row["as_of_virtual_time_ms"]),
                ),
            )

        loaded = await asyncio.gather(
            *(
                asyncio.to_thread(
                    read_projection,
                    track_id,
                    bindings[track_id],
                )
                for track_id in track_ids
                if track_id in bindings
            )
        )
        return {
            track_id: {
                "archive_id": projection.archive_id,
                "archive_generation": projection.archive_generation,
                "last_event_sequence": projection.last_event_sequence,
                "last_rule_sequence": projection.last_rule_sequence,
                "last_mark_sequence": projection.last_mark_sequence,
                "last_funding_sequence": projection.last_funding_sequence,
                "as_of_actual_time_ms": projection.as_of_actual_time_ms,
                "as_of_virtual_time_ms": projection.as_of_virtual_time_ms,
                "current_rule_json": canonical_json(projection.current_rule),
                "current_rule_hash": projection.current_rule_hash,
                "mark_price": projection.mark_price,
                "index_price": projection.index_price,
                "input_chain_hash": projection.input_chain_hash,
            }
            for track_id, projection in loaded
        }

    async def next_event_time(
        self,
        *,
        run_id: str,
        tracks: Sequence[Mapping[str, object]],
        target_actual_time_ms: int,
        guarded: bool = False,
    ) -> int | None:
        if not guarded:
            await self.guard_run(run_id=run_id, tracks=tracks)
        track_ids = tuple(
            str(track["track_id"])
            for track in tracks
            if track.get("subscription_tier") == "FULL"
        )
        bindings = await self._active_bindings(run_id, track_ids)

        def read_next(row: _AccountRow) -> int | None:
            path = self._owned_file(row, True)
            projection_sequence = int(row["last_event_sequence"])
            with closing(_read_only(path)) as connection:
                event = connection.execute(
                    """
                    SELECT event_time_ms FROM archive_event
                    WHERE event_sequence > ? AND event_time_ms <= ?
                    ORDER BY event_sequence LIMIT 1
                    """,
                    (projection_sequence, target_actual_time_ms),
                ).fetchone()
                return None if event is None else int(event["event_time_ms"])

        values = await asyncio.gather(
            *(
                asyncio.to_thread(read_next, bindings[track_id])
                for track_id in track_ids
                if track_id in bindings
            )
        )
        return min(
            (value for value in values if value is not None),
            default=None,
        )

    async def events_at(
        self,
        *,
        run_id: str,
        tracks: Sequence[Mapping[str, object]],
        actual_time_ms: int,
        guarded: bool = False,
    ) -> tuple[tuple[str, AccountHistoryEvent], ...]:
        if not guarded:
            await self.guard_run(run_id=run_id, tracks=tracks)
        track_ids = tuple(
            str(track["track_id"])
            for track in tracks
            if track.get("subscription_tier") == "FULL"
        )
        bindings = await self._active_bindings(run_id, track_ids)

        def read_events(
            track_id: str,
            row: _AccountRow,
        ) -> tuple[str, tuple[AccountHistoryEvent, ...]]:
            path = self._owned_file(row, True)
            return (
                track_id,
                _archive_events(
                    path,
                    after_sequence=int(row["last_event_sequence"]),
                    event_time_ms=actual_time_ms,
                ),
            )

        loaded = await asyncio.gather(
            *(
                asyncio.to_thread(
                    read_events,
                    track_id,
                    bindings[track_id],
                )
                for track_id in track_ids
                if track_id in bindings
            )
        )
        prepared = [
            (track_id, event)
            for track_id, events in loaded
            for event in events
        ]
        prepared.sort(
            key=lambda item: (
                item[1].event_time_ms,
                item[1].event_phase,
                item[0],
                item[1].event_sequence,
            )
        )
        return tuple(prepared)

    async def _active_bindings(
        self,
        run_id: str,
        track_ids: Sequence[str],
    ) -> dict[str, _AccountRow]:
        if not track_ids:
            return {}
        placeholders = ", ".join("?" for _ in track_ids)
        values = (run_id, *track_ids)
        rows = await self.store.run_extension_read(
            lambda connection: tuple(
                connection.execute(
                    f"""
                    SELECT ref.track_id, archive.*,
                           projection.last_event_sequence,
                           projection.last_rule_sequence,
                           projection.last_mark_sequence,
                           projection.last_funding_sequence,
                           projection.as_of_actual_time_ms,
                           projection.as_of_virtual_time_ms,
                           projection.input_chain_hash,
                           ref.binding_generation
                    FROM replay_account_history_ref AS ref
                    JOIN replay_account_history_archive AS archive
                      USING(archive_id)
                    JOIN replay_account_history_projection AS projection
                      ON projection.run_id = ref.run_id
                     AND projection.track_id = ref.track_id
                     AND projection.archive_id = ref.archive_id
                    WHERE ref.run_id = ? AND ref.active = 1
                      AND ref.track_id IN ({placeholders})
                    ORDER BY ref.track_id, ref.binding_generation DESC
                    """,
                    values,
                ).fetchall()
            )
        )
        return {
            str(row["track_id"]): row
            for row in rows
        }

    async def _active_binding(
        self,
        run_id: str,
        track_id: str,
    ) -> _AccountRow | None:
        return (await self._active_bindings(run_id, (track_id,))).get(track_id)

    async def _select_archive(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        settlement_asset: str,
        range_start_ms: int,
        range_end_ms: int,
        require_funding: bool,
    ) -> _AccountRow | None:
        return await self.store.run_extension_read(
            lambda connection: connection.execute(
                """
                SELECT * FROM replay_account_history_archive
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND settlement_asset = ? AND health = 'READY'
                  AND range_start_ms <= ? AND range_end_ms >= ?
                  AND (? = 0 OR funding_count > 0)
                ORDER BY byte_size ASC, range_start_ms DESC, archive_id
                LIMIT 1
                """,
                (
                    exchange,
                    market_type,
                    symbol,
                    settlement_asset,
                    range_start_ms,
                    range_end_ms,
                    int(require_funding),
                ),
            ).fetchone()
        )

    async def _reclaim_archive(
        self,
        candidate: Mapping[str, object],
    ) -> dict[str, object]:
        archive_id = validate_identifier(
            str(candidate["archive_id"]),
            field_name="archive_id",
        )
        generation = int(candidate["generation"])
        token = uuid.uuid4().hex
        claim_reason = f"GC_RECLAIMING:{token}"
        now_ms = self.store._validated_now_ms()

        def claim(connection: sqlite3.Connection) -> _AccountRow | None:
            connection.execute(
                """
                UPDATE replay_account_history_archive
                SET health = 'QUARANTINED', quarantine_reason = ?,
                    generation = generation + 1, updated_at_ms = ?
                WHERE archive_id = ? AND generation = ? AND health = 'READY'
                  AND NOT EXISTS(
                      SELECT 1 FROM replay_account_history_ref AS ref
                      WHERE ref.archive_id =
                            replay_account_history_archive.archive_id
                        AND ref.active = 1
                  )
                """,
                (claim_reason, now_ms, archive_id, generation),
            )
            return connection.execute(
                """
                SELECT * FROM replay_account_history_archive
                WHERE archive_id = ? AND health = 'QUARANTINED'
                  AND quarantine_reason = ?
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
        expected = f"objects/{archive_id}.sqlite3"
        if row["local_path"] != expected:
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
            await asyncio.to_thread(self._assert_regular_owned_file, expected)
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
        except (TypeError, ValueError) as exc:
            await self._restore_gc_claim(
                archive_id,
                claim_reason,
                type(exc).__name__,
                ready=False,
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
                UPDATE replay_account_history_archive
                SET health = 'EVICTED', local_path = NULL,
                    quarantine_reason = NULL, updated_at_ms = ?
                WHERE archive_id = ? AND health = 'QUARANTINED'
                  AND quarantine_reason = ?
                  AND NOT EXISTS(
                      SELECT 1 FROM replay_account_history_ref AS ref
                      WHERE ref.archive_id =
                            replay_account_history_archive.archive_id
                        AND ref.active = 1
                  )
                """,
                (finished, archive_id, claim_reason),
            )
            return cursor.rowcount == 1

        try:
            finalized = await self.store.run_extension_write(finalize)
        except BaseException:
            await asyncio.to_thread(os.replace, trash, source)
            await self._restore_gc_claim(
                archive_id,
                claim_reason,
                "FINALIZE_FAILED",
                ready=True,
            )
            raise
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
            # EVICTED is already authoritative; a replay-owned trash residue is
            # safe and will be removed on the next manager start.
            pass
        with self._checksum_cache_lock:
            self._checksum_cache.clear()
        return {
            "archive_id": archive_id,
            "reclaimed": True,
            "byte_size": int(candidate["byte_size"]),
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
        now_ms = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_account_history_archive
                SET health = ?, quarantine_reason = ?,
                    generation = generation + 1, updated_at_ms = ?
                WHERE archive_id = ? AND health = 'QUARANTINED'
                  AND quarantine_reason = ?
                """,
                (
                    "READY" if ready else "QUARANTINED",
                    None if ready else reason[:256],
                    now_ms,
                    archive_id,
                    claim_reason,
                ),
            )
        )

    async def _recover_gc_claims(self) -> None:
        rows = await self.store.run_extension_read(
            lambda connection: tuple(
                connection.execute(
                    """
                    SELECT * FROM replay_account_history_archive
                    WHERE health = 'QUARANTINED'
                      AND quarantine_reason LIKE 'GC_RECLAIMING:%'
                    ORDER BY archive_id
                    """
                ).fetchall()
            )
        )
        for row in rows:
            archive_id = str(row["archive_id"])
            claim_reason = str(row["quarantine_reason"])
            token = claim_reason.partition(":")[2]
            relative = f"objects/{archive_id}.sqlite3"
            source = self._owned_path(relative)
            trash = self._owned_path(f".trash/{archive_id}-{token}.trash")
            restored = False
            try:
                if not source.exists() and trash.is_file() and not trash.is_symlink():
                    await asyncio.to_thread(os.replace, trash, source)
                restored = (
                    source.is_file()
                    and not source.is_symlink()
                    and source.stat().st_size == int(row["byte_size"])
                    and await asyncio.to_thread(_digest_file, source)
                    == str(row["checksum_sha256"])
                )
            except OSError:
                restored = False
            await self._restore_gc_claim(
                archive_id,
                claim_reason,
                "GC_RECOVERY_OBJECT_UNAVAILABLE",
                ready=restored,
            )
        for trash in (self.root / ".trash").glob("*.trash"):
            try:
                if trash.is_file() and not trash.is_symlink():
                    trash.unlink()
            except OSError:
                continue

    async def _rehydrate_row(self, row: _AccountRow) -> None:
        raw_source = Path(str(row["trusted_source_path"])).expanduser()
        if raw_source.is_symlink():
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REHYDRATION_SOURCE_INVALID",
                "trusted account-history source must not be a symlink",
                status_code=409,
            )
        source = raw_source.resolve()
        if (
            not source.is_file()
            or source.is_symlink()
            or source == self.root
            or source.is_relative_to(self.root)
        ):
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REHYDRATION_SOURCE_INVALID",
                "trusted account-history source is unavailable",
                status_code=409,
            )
        descriptor = await asyncio.to_thread(
            verify_account_history_archive,
            source,
            trusted_origin=str(row["trusted_origin"]),
        )
        if (
            descriptor.archive_id != str(row["archive_id"])
            or descriptor.identity_key != str(row["identity_key"])
            or descriptor.checksum_sha256 != str(row["checksum_sha256"])
            or descriptor.proof_hash != str(row["proof_hash"])
            or descriptor.event_chain_tail != str(row["event_chain_tail"])
            or descriptor.byte_size != int(row["byte_size"])
        ):
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REHYDRATION_MISMATCH",
                "trusted account-history source no longer matches its immutable proof",
                status_code=409,
            )
        await self._assert_budget(
            descriptor.byte_size,
            excluding=descriptor.archive_id,
        )
        relative = f"objects/{descriptor.archive_id}.sqlite3"
        final = self._owned_path(relative)
        temp = self._owned_path(f".tmp/rehydrate-{uuid.uuid4().hex}.part")
        await asyncio.to_thread(shutil.copyfile, source, temp)
        if (
            temp.stat().st_size != descriptor.byte_size
            or await asyncio.to_thread(_digest_file, temp)
            != descriptor.checksum_sha256
        ):
            temp.unlink(missing_ok=True)
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REHYDRATION_MISMATCH",
                "rehydrated account-history object failed checksum validation",
                status_code=409,
            )
        os.replace(temp, final)
        now_ms = self.store._validated_now_ms()

        def publish(connection: sqlite3.Connection) -> None:
            cursor = connection.execute(
                """
                UPDATE replay_account_history_archive
                SET health = 'READY', local_path = ?, byte_size = ?,
                    quarantine_reason = NULL, generation = generation + 1,
                    last_used_at_ms = ?, updated_at_ms = ?
                WHERE archive_id = ? AND health != 'READY'
                  AND NOT EXISTS(
                      SELECT 1 FROM replay_account_history_ref AS ref
                      WHERE ref.archive_id =
                            replay_account_history_archive.archive_id
                        AND ref.active = 1
                        AND replay_account_history_archive.health = 'EVICTED'
                  )
                """,
                (
                    relative,
                    descriptor.byte_size,
                    now_ms,
                    now_ms,
                    descriptor.archive_id,
                ),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(
                    "account history rehydration state changed before commit"
                )

        try:
            await self.store.run_extension_write(publish)
        except BaseException:
            final.unlink(missing_ok=True)
            raise
        with self._checksum_cache_lock:
            self._checksum_cache.clear()

    async def _audit_gc(
        self,
        action: str,
        plan_hash: str,
        request: object,
        result: object,
    ) -> None:
        now_ms = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                INSERT INTO replay_account_history_gc_audit(
                    action, plan_hash, request_json, result_json, created_at_ms
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    action,
                    plan_hash,
                    canonical_json(request),
                    canonical_json(result),
                    now_ms,
                ),
            )
        )

    @staticmethod
    def _trusted_source_issue(row: _AccountRow) -> str | None:
        try:
            raw = Path(str(row["trusted_source_path"])).expanduser()
            if raw.is_symlink():
                return "TRUSTED_SOURCE_SYMLINK"
            source = raw.resolve()
            if not source.is_file() or source.is_symlink():
                return "TRUSTED_SOURCE_UNAVAILABLE"
            if source.stat().st_size != int(row["byte_size"]):
                return "TRUSTED_SOURCE_SIZE_MISMATCH"
            if _digest_file(source) != str(row["checksum_sha256"]):
                return "TRUSTED_SOURCE_CHECKSUM_MISMATCH"
        except (OSError, TypeError, ValueError):
            return "TRUSTED_SOURCE_UNAVAILABLE"
        return None

    async def _assert_budget(
        self,
        incoming: int,
        *,
        excluding: str | None,
    ) -> None:
        total = await self.store.run_extension_read(
            lambda connection: int(
                connection.execute(
                    """
                    SELECT COALESCE(SUM(byte_size), 0)
                    FROM replay_account_history_archive
                    WHERE health = 'READY' AND (? IS NULL OR archive_id != ?)
                    """,
                    (excluding, excluding),
                ).fetchone()[0]
            )
        )
        if total + incoming > self.max_archive_bytes:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_STORAGE_BUDGET_EXCEEDED",
                "replay-owned account history storage budget is exhausted",
                status_code=409,
                details={
                    "ready_bytes": total,
                    "incoming_bytes": incoming,
                    "max_archive_bytes": self.max_archive_bytes,
                },
            )

    async def _quarantine(self, archive_id: str, reason: str) -> None:
        now_ms = self.store._validated_now_ms()
        await self.store.run_extension_write(
            lambda connection: connection.execute(
                """
                UPDATE replay_account_history_archive
                SET health = 'QUARANTINED', quarantine_reason = ?,
                    updated_at_ms = ?
                WHERE archive_id = ?
                """,
                (reason[:256], now_ms, archive_id),
            )
        )

    async def _degrade_run(
        self,
        run_id: str,
        track_id: str | None,
        reason: str,
    ) -> None:
        now_ms = self.store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                UPDATE replay_training_account_history
                SET status = 'DEGRADED', degraded_reason = ?,
                    auditor_status = 'FAIL',
                    auditor_differences_json = ?,
                    updated_at_ms = ?
                WHERE run_id = ? AND account_data_mode = 'HISTORICAL_EXACT'
                """,
                (
                    reason,
                    canonical_json([{"field": "archive", "reason": reason}]),
                    now_ms,
                    run_id,
                ),
            )
            connection.execute(
                """
                UPDATE replay_training_run
                SET state = 'PAUSED', compatibility = 'DEGRADED',
                    updated_at_ms = ?
                WHERE run_id = ?
                """,
                (now_ms, run_id),
            )
            connection.execute(
                """
                UPDATE replay_training_market_track
                SET state = 'DEGRADED', degraded_reason = ?, updated_at_ms = ?
                WHERE run_id = ? AND (? IS NULL OR track_id = ?)
                """,
                (reason, now_ms, run_id, track_id, track_id),
            )
            connection.execute(
                """
                UPDATE replay_account_history_projection
                SET status = 'DEGRADED', degraded_reason = ?, updated_at_ms = ?
                WHERE run_id = ? AND (? IS NULL OR track_id = ?)
                """,
                (reason, now_ms, run_id, track_id, track_id),
            )

        await self.store.run_extension_write(write)

    async def _disable_exact_runs(self) -> None:
        rows = await self.store.run_extension_read(
            lambda connection: tuple(
                connection.execute(
                    """
                    SELECT run_id FROM replay_training_account_history
                    WHERE account_data_mode = 'HISTORICAL_EXACT'
                      AND status = 'ACTIVE'
                    """
                ).fetchall()
            )
        )
        for row in rows:
            await self._degrade_run(
                str(row["run_id"]),
                None,
                "ACCOUNT_HISTORY_FEATURE_DISABLED",
            )

    def _owned_file(
        self,
        row: _AccountRow,
        verify_checksum: bool,
    ) -> Path:
        relative = row["local_path"]
        if not isinstance(relative, str):
            raise ValueError("account history owned path is missing")
        self._assert_regular_owned_file(relative)
        path = self._owned_path(relative)
        if path.stat().st_size != int(row["byte_size"]):
            raise ValueError("account history owned object size changed")
        if verify_checksum:
            stat = path.stat()
            cache_key = (
                str(path),
                stat.st_size,
                stat.st_mtime_ns,
                _file_change_token(path, stat),
            )
            with self._checksum_cache_lock:
                checksum = self._checksum_cache.get(cache_key)
                if checksum is not None:
                    self._checksum_cache.move_to_end(cache_key)
            if checksum is None:
                checksum = _digest_file(path)
                with self._checksum_cache_lock:
                    self._checksum_cache[cache_key] = checksum
                    self._checksum_cache.move_to_end(cache_key)
                    while len(self._checksum_cache) > _CHECKSUM_CACHE_ENTRIES:
                        self._checksum_cache.popitem(last=False)
            if checksum != row["checksum_sha256"]:
                raise ValueError("account history owned object checksum changed")
        return path

    def _assert_regular_owned_file(self, relative: str) -> None:
        relative_path = Path(relative)
        if relative_path.is_absolute():
            raise ValueError("account history path must be relative")
        raw = self.root / relative_path
        if raw.is_symlink():
            raise ValueError("account history owned object must not be a symlink")
        path = self._owned_path(relative)
        if not path.is_file() or path.is_symlink():
            raise FileNotFoundError(path)

    def _owned_path(self, relative: str) -> Path:
        if Path(relative).is_absolute():
            raise ValueError("account history path must be relative")
        path = (self.root / relative).resolve()
        if path == self.root or not path.is_relative_to(self.root):
            raise ValueError("account history path escapes its object store")
        return path

    def _ensure_dirs(self) -> None:
        (self.root / "objects").mkdir(parents=True, exist_ok=True)
        (self.root / ".tmp").mkdir(parents=True, exist_ok=True)
        (self.root / ".trash").mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _public_archive(row: _AccountRow) -> dict[str, object]:
        return {
            "archive_id": str(row["archive_id"]),
            "protocol": str(row["protocol"]),
            "schema_version": str(row["schema_version"]),
            "exchange": str(row["exchange"]),
            "market_type": str(row["market_type"]),
            "symbol": str(row["symbol"]),
            "settlement_asset": str(row["settlement_asset"]),
            "range_start_ms": int(row["range_start_ms"]),
            "range_end_ms": int(row["range_end_ms"]),
            "dataset_epoch": str(row["dataset_epoch"]),
            "checksum_sha256": str(row["checksum_sha256"]),
            "proof_hash": str(row["proof_hash"]),
            "event_chain_tail": str(row["event_chain_tail"]),
            "rule_count": int(row["rule_count"]),
            "mark_count": int(row["mark_count"]),
            "funding_count": int(row["funding_count"]),
            "event_count": int(row["event_count"]),
            "byte_size": int(row["byte_size"]),
            "health": str(row["health"]),
            "generation": int(row["generation"]),
            "active_pins": int(row["active_pins"]) if "active_pins" in row.keys() else 0,
            "quarantine_reason": row["quarantine_reason"],
        }


__all__ = [
    "ACCOUNT_AUDIT_SCHEMA_VERSION",
    "ACCOUNT_GC_PROTOCOL",
    "ARCHIVE_CONTRACT_MODEL",
    "ARCHIVE_FORMULA_VERSION",
    "ARCHIVE_MARGIN_ASSET_MODE",
    "ARCHIVE_POSITION_MODE",
    "ARCHIVE_PROTOCOL",
    "ARCHIVE_ROUNDING_MODE",
    "ARCHIVE_SCHEMA_VERSION",
    "EXACT_ACCOUNT_FIDELITY",
    "FUNDING_EVENT_PHASE",
    "MARK_INDEX_EVENT_PHASE",
    "RULE_EVENT_PHASE",
    "AccountHistoryArchiveDescriptor",
    "AccountHistoryArchiveManager",
    "AccountHistoryEvent",
    "AccountHistoryProjection",
    "PreparedAccountHistoryBinding",
    "account_archive_dataset_epoch",
    "account_archive_event_hash",
    "account_archive_root_hash",
    "account_funding_payload",
    "account_mark_payload",
    "account_rule_component_hash",
    "account_rule_payload",
    "bind_account_history_archive",
    "runtime_instrument_rule",
    "verify_account_history_archive",
]
