"""Persistent Host-native control and confirmation ledger for Live authority."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

from app.plugin_host.framing import JsonLineError, strict_json_loads

from .errors import LiveBrokerError, broker_error


LIVE_CONTROL_SCHEMA_VERSION = 1
LIVE_CONTROL_FILENAME = "live-control-v1.sqlite3"
LIVE_CONTROL_STATUS_SCHEMA = "candlescope.live-control-status/1"
LIVE_CONFIRMATION_SCHEMA = "candlescope.live-confirmation/1"
MIN_CONFIRMATION_TTL_SECONDS = 15
MAX_CONFIRMATION_TTL_SECONDS = 120
MAX_CONFIRMATIONS = 4096
MAX_CONTROL_EVENTS = 16_384

_MODES = frozenset({"disarmed", "armed", "killed"})
_RECEIPT_STATES = frozenset({"issued", "consumed", "revoked", "expired"})
_EVENT_TYPES = frozenset(
    {
        "control-created",
        "control-armed",
        "control-disarmed",
        "control-killed",
        "control-recovered",
        "authority-revoked",
        "confirmation-issued",
        "confirmation-consumed",
        "confirmation-revoked",
        "confirmation-expired",
    }
)
_HEX_32 = re.compile(r"^[0-9a-f]{32}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_RECEIPT_REF = re.compile(r"^livecfm_[A-Za-z0-9_-]{43}$")
_ID = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$")
_CLIENT_ORDER_ID = re.compile(r"^[A-Za-z0-9]{32}$")
_EXPECTED_COLUMNS = {
    "control_meta": (
        ("singleton", "INTEGER", 0, 1),
        ("schema_version", "INTEGER", 1, 0),
        ("broker_id", "TEXT", 1, 0),
        ("mode", "TEXT", 1, 0),
        ("generation", "INTEGER", 1, 0),
        ("policy_epoch", "INTEGER", 1, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "confirmation": (
        ("receipt_id", "TEXT", 1, 1),
        ("handle_sha256", "TEXT", 1, 0),
        ("shadow_handle_sha256", "TEXT", 1, 0),
        ("account_handle_sha256", "TEXT", 1, 0),
        ("intent_sha256", "TEXT", 1, 0),
        ("plugin_id", "TEXT", 1, 0),
        ("connector_id", "TEXT", 1, 0),
        ("publisher_identity", "TEXT", 1, 0),
        ("version", "TEXT", 1, 0),
        ("client_order_id", "TEXT", 1, 0),
        ("instrument_id", "TEXT", 1, 0),
        ("side", "TEXT", 1, 0),
        ("order_type", "TEXT", 1, 0),
        ("quantity", "TEXT", 1, 0),
        ("limit_price", "TEXT", 1, 0),
        ("policy_epoch", "INTEGER", 1, 0),
        ("control_generation", "INTEGER", 1, 0),
        ("state", "TEXT", 1, 0),
        ("issued_at", "TEXT", 1, 0),
        ("expires_at", "TEXT", 1, 0),
        ("resolved_at", "TEXT", 0, 0),
    ),
    "control_event": (
        ("sequence", "INTEGER", 0, 1),
        ("event_type", "TEXT", 1, 0),
        ("payload_json", "TEXT", 1, 0),
        ("occurred_at", "TEXT", 1, 0),
        ("previous_sha256", "TEXT", 0, 0),
        ("event_sha256", "TEXT", 1, 0),
    ),
}
_EXPECTED_UNIQUE_INDEX_COLUMNS = {
    "control_meta": set(),
    "confirmation": {
        ("receipt_id",),
        ("handle_sha256",),
    },
    "control_event": {("event_sha256",)},
}


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("timestamp must be timezone aware")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError("control timestamp is invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("control timestamp is invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError("control timestamp is invalid")
    return parsed.astimezone(UTC)


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _bounded_text(value: Any, label: str, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or "\0" in value
    ):
        raise broker_error(
            "LIVE_CONTROL_PARAMS_INVALID",
            f"{label} is invalid",
        )
    return value


def _digest(value: str, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} digest is invalid")
    return value


@dataclass(frozen=True, slots=True)
class LiveConfirmationRecord:
    receipt_id: str
    handle_sha256: str
    shadow_handle_sha256: str
    account_handle_sha256: str
    intent_sha256: str
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    client_order_id: str
    instrument_id: str
    side: str
    order_type: str
    quantity: str
    limit_price: str
    policy_epoch: int
    control_generation: int
    state: str
    issued_at: str
    expires_at: str
    resolved_at: str | None

    def __post_init__(self) -> None:
        if (
            _HEX_32.fullmatch(self.receipt_id) is None
            or any(
                _SHA256.fullmatch(value) is None
                for value in (
                    self.handle_sha256,
                    self.shadow_handle_sha256,
                    self.account_handle_sha256,
                    self.intent_sha256,
                )
            )
            or _ID.fullmatch(self.plugin_id) is None
            or _ID.fullmatch(self.connector_id) is None
            or not self.publisher_identity
            or len(self.publisher_identity) > 256
            or not self.version
            or len(self.version) > 64
            or _CLIENT_ORDER_ID.fullmatch(self.client_order_id) is None
            or not self.instrument_id
            or len(self.instrument_id) > 64
            or self.side not in {"buy", "sell"}
            or self.order_type != "limit"
            or not self.quantity
            or len(self.quantity) > 64
            or not self.limit_price
            or len(self.limit_price) > 64
            or isinstance(self.policy_epoch, bool)
            or not isinstance(self.policy_epoch, int)
            or self.policy_epoch < 0
            or isinstance(self.control_generation, bool)
            or not isinstance(self.control_generation, int)
            or self.control_generation < 0
            or self.state not in _RECEIPT_STATES
        ):
            raise ValueError("confirmation receipt metadata is invalid")
        issued = _parse_timestamp(self.issued_at)
        expires = _parse_timestamp(self.expires_at)
        resolved = (
            None
            if self.resolved_at is None
            else _parse_timestamp(self.resolved_at)
        )
        if (
            expires <= issued
            or expires > issued + timedelta(seconds=MAX_CONFIRMATION_TTL_SECONDS)
            or (self.state == "issued" and resolved is not None)
            or (self.state != "issued" and resolved is None)
        ):
            raise ValueError("confirmation receipt lifecycle is invalid")

    def public_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": LIVE_CONFIRMATION_SCHEMA,
            "receiptId": self.receipt_id,
            "intentSha256": self.intent_sha256,
            "pluginId": self.plugin_id,
            "connectorId": self.connector_id,
            "publisherIdentity": self.publisher_identity,
            "version": self.version,
            "clientOrderId": self.client_order_id,
            "instrumentId": self.instrument_id,
            "side": self.side,
            "orderType": self.order_type,
            "quantity": self.quantity,
            "limitPrice": self.limit_price,
            "policyEpoch": self.policy_epoch,
            "controlGeneration": self.control_generation,
            "state": self.state,
            "issuedAt": self.issued_at,
            "expiresAt": self.expires_at,
            "resolvedAt": self.resolved_at,
        }

    def event_wire(self) -> dict[str, Any]:
        return {
            **self.public_wire(),
            "handleSha256": self.handle_sha256,
            "shadowHandleSha256": self.shadow_handle_sha256,
            "accountHandleSha256": self.account_handle_sha256,
        }


class LiveControlLedger:
    """Own a bounded control projection, one-shot receipts and hash chain."""

    def __init__(
        self,
        root: Path | str,
        *,
        broker_id: str,
        policy_epoch: int,
        testnet_execution_enabled: bool = False,
    ) -> None:
        if _HEX_32.fullmatch(broker_id) is None:
            raise ValueError("broker_id is invalid")
        if not isinstance(testnet_execution_enabled, bool):
            raise TypeError("testnet_execution_enabled must be a boolean")
        if (
            isinstance(policy_epoch, bool)
            or not isinstance(policy_epoch, int)
            or policy_epoch < 0
        ):
            raise ValueError("policy_epoch is invalid")
        self.root = Path(root).expanduser().resolve(strict=False)
        self.path = self.root / LIVE_CONTROL_FILENAME
        self.broker_id = broker_id
        self.testnet_execution_enabled = testnet_execution_enabled
        for path in (
            self.path,
            self.path.with_name(f"{self.path.name}-wal"),
            self.path.with_name(f"{self.path.name}-shm"),
        ):
            if path.is_symlink() or (path.exists() and not path.is_file()):
                raise broker_error(
                    "LIVE_CONTROL_PATH_UNSAFE",
                    "Live control ledger path is unsafe",
                    fatal=True,
                )
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            self.connection = sqlite3.connect(
                self.path,
                timeout=5.0,
                isolation_level=None,
            )
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA busy_timeout=5000")
            mode = self.connection.execute("PRAGMA journal_mode=WAL").fetchone()
            if mode is None or str(mode[0]).casefold() != "wal":
                raise sqlite3.DatabaseError("WAL mode was not enabled")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA trusted_schema=OFF")
            self._initialize_or_validate(policy_epoch)
            if self.policy_epoch != policy_epoch:
                if self.policy_epoch > policy_epoch:
                    raise ValueError("control policy epoch is ahead of Broker state")
                self.force_killed(
                    policy_epoch=policy_epoch,
                    reason="policy-epoch-mismatch-recovery",
                    event_type="control-recovered",
                )
        except (OSError, sqlite3.DatabaseError, ValueError, LiveBrokerError) as exc:
            connection = getattr(self, "connection", None)
            if connection is not None:
                connection.close()
            if isinstance(exc, LiveBrokerError):
                raise
            raise broker_error(
                "LIVE_CONTROL_LEDGER_INVALID",
                "Live control ledger failed validation",
                fatal=True,
                details={"errorType": type(exc).__name__},
            ) from exc

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            yield
            self.connection.execute("COMMIT")
        except BaseException:
            if self.connection.in_transaction:
                self.connection.execute("ROLLBACK")
            raise

    def _initialize_or_validate(self, policy_epoch: int) -> None:
        tables = {
            row["name"]
            for row in self.connection.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                """
            )
        }
        if not tables:
            self._create_schema(policy_epoch)
        elif tables != {"control_meta", "confirmation", "control_event"}:
            raise ValueError("control ledger tables are invalid")
        self._validate_schema()
        quick = self.connection.execute("PRAGMA quick_check").fetchone()
        if quick is None or quick[0] != "ok":
            raise ValueError("control ledger quick_check failed")
        if any(
            tuple(self.connection.execute(f"PRAGMA foreign_key_list({table})"))
            for table in _EXPECTED_COLUMNS
        ):
            raise ValueError("control ledger foreign keys are invalid")
        user_version = self.connection.execute("PRAGMA user_version").fetchone()
        if user_version is None or user_version[0] != LIVE_CONTROL_SCHEMA_VERSION:
            raise ValueError("control ledger schema version is unsupported")
        meta = self.connection.execute(
            "SELECT * FROM control_meta WHERE singleton = 1"
        ).fetchone()
        if (
            meta is None
            or self.connection.execute(
                "SELECT COUNT(*) FROM control_meta"
            ).fetchone()[0]
            != 1
            or meta["schema_version"] != LIVE_CONTROL_SCHEMA_VERSION
            or meta["broker_id"] != self.broker_id
            or meta["mode"] not in _MODES
            or isinstance(meta["generation"], bool)
            or not isinstance(meta["generation"], int)
            or meta["generation"] < 0
            or isinstance(meta["policy_epoch"], bool)
            or not isinstance(meta["policy_epoch"], int)
            or meta["policy_epoch"] < 0
        ):
            raise ValueError("control ledger metadata is invalid")
        _parse_timestamp(meta["created_at"])
        _parse_timestamp(meta["updated_at"])
        confirmations = tuple(
            self._record(row)
            for row in self.connection.execute(
                "SELECT * FROM confirmation ORDER BY receipt_id"
            )
        )
        event_count = self.connection.execute(
            "SELECT COUNT(*) FROM control_event"
        ).fetchone()[0]
        if (
            len(confirmations) > MAX_CONFIRMATIONS
            or event_count > MAX_CONTROL_EVENTS
        ):
            raise ValueError("control ledger limits are exceeded")
        self._validate_event_chain(meta, confirmations)

    def _create_schema(self, policy_epoch: int) -> None:
        occurred_at = _timestamp(_utc_now())
        with self._transaction():
            self.connection.execute(
                """
                CREATE TABLE control_meta (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    schema_version INTEGER NOT NULL,
                    broker_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    policy_epoch INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                ) STRICT
                """
            )
            self.connection.execute(
                """
                CREATE TABLE confirmation (
                    receipt_id TEXT PRIMARY KEY,
                    handle_sha256 TEXT NOT NULL UNIQUE,
                    shadow_handle_sha256 TEXT NOT NULL,
                    account_handle_sha256 TEXT NOT NULL,
                    intent_sha256 TEXT NOT NULL,
                    plugin_id TEXT NOT NULL,
                    connector_id TEXT NOT NULL,
                    publisher_identity TEXT NOT NULL,
                    version TEXT NOT NULL,
                    client_order_id TEXT NOT NULL,
                    instrument_id TEXT NOT NULL,
                    side TEXT NOT NULL,
                    order_type TEXT NOT NULL,
                    quantity TEXT NOT NULL,
                    limit_price TEXT NOT NULL,
                    policy_epoch INTEGER NOT NULL,
                    control_generation INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    issued_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    resolved_at TEXT
                ) STRICT
                """
            )
            self.connection.execute(
                """
                CREATE TABLE control_event (
                    sequence INTEGER PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    previous_sha256 TEXT,
                    event_sha256 TEXT NOT NULL UNIQUE
                ) STRICT
                """
            )
            self.connection.execute(
                """
                INSERT INTO control_meta(
                    singleton, schema_version, broker_id, mode, generation,
                    policy_epoch, created_at, updated_at
                ) VALUES(1, ?, ?, 'disarmed', 0, ?, ?, ?)
                """,
                (
                    LIVE_CONTROL_SCHEMA_VERSION,
                    self.broker_id,
                    policy_epoch,
                    occurred_at,
                    occurred_at,
                ),
            )
            self.connection.execute(
                f"PRAGMA user_version={LIVE_CONTROL_SCHEMA_VERSION}"
            )
            self._append_event(
                "control-created",
                {
                    "mode": "disarmed",
                    "generation": 0,
                    "policyEpoch": policy_epoch,
                },
                occurred_at,
            )

    def _validate_schema(self) -> None:
        unexpected = tuple(
            self.connection.execute(
                """
                SELECT type, name
                FROM sqlite_master
                WHERE type IN ('view', 'trigger')
                   OR (type = 'index' AND sql IS NOT NULL)
                """
            )
        )
        if unexpected:
            raise ValueError("control ledger schema objects are invalid")
        for table, expected in _EXPECTED_COLUMNS.items():
            table_metadata = self.connection.execute(
                """
                SELECT ncol, wr, strict
                FROM pragma_table_list
                WHERE schema = 'main' AND name = ?
                """,
                (table,),
            ).fetchone()
            if (
                table_metadata is None
                or table_metadata["ncol"] != len(expected)
                or table_metadata["wr"] != 0
                or table_metadata["strict"] != 1
            ):
                raise ValueError("control ledger table mode is invalid")
            actual = tuple(
                (
                    row["name"],
                    row["type"],
                    row["notnull"],
                    row["pk"],
                )
                for row in self.connection.execute(
                    f"PRAGMA table_info({table})"
                )
            )
            if actual != expected:
                raise ValueError("control ledger columns are invalid")
            unique_columns: set[tuple[str, ...]] = set()
            for index in self.connection.execute(
                f"PRAGMA index_list({table})"
            ):
                if index["unique"] != 1 or index["partial"] != 0:
                    raise ValueError("control ledger indexes are invalid")
                unique_columns.add(
                    tuple(
                        column["name"]
                        for column in self.connection.execute(
                            """
                            SELECT name
                            FROM pragma_index_info(?)
                            ORDER BY seqno
                            """,
                            (index["name"],),
                        )
                    )
                )
            if unique_columns != _EXPECTED_UNIQUE_INDEX_COLUMNS[table]:
                raise ValueError("control ledger unique indexes are invalid")

    @property
    def mode(self) -> str:
        return str(
            self.connection.execute(
                "SELECT mode FROM control_meta WHERE singleton = 1"
            ).fetchone()[0]
        )

    @property
    def generation(self) -> int:
        return int(
            self.connection.execute(
                "SELECT generation FROM control_meta WHERE singleton = 1"
            ).fetchone()[0]
        )

    @property
    def policy_epoch(self) -> int:
        return int(
            self.connection.execute(
                "SELECT policy_epoch FROM control_meta WHERE singleton = 1"
            ).fetchone()[0]
        )

    @staticmethod
    def _record(row: sqlite3.Row) -> LiveConfirmationRecord:
        return LiveConfirmationRecord(
            receipt_id=row["receipt_id"],
            handle_sha256=row["handle_sha256"],
            shadow_handle_sha256=row["shadow_handle_sha256"],
            account_handle_sha256=row["account_handle_sha256"],
            intent_sha256=row["intent_sha256"],
            plugin_id=row["plugin_id"],
            connector_id=row["connector_id"],
            publisher_identity=row["publisher_identity"],
            version=row["version"],
            client_order_id=row["client_order_id"],
            instrument_id=row["instrument_id"],
            side=row["side"],
            order_type=row["order_type"],
            quantity=row["quantity"],
            limit_price=row["limit_price"],
            policy_epoch=row["policy_epoch"],
            control_generation=row["control_generation"],
            state=row["state"],
            issued_at=row["issued_at"],
            expires_at=row["expires_at"],
            resolved_at=row["resolved_at"],
        )

    def _validate_event_chain(
        self,
        meta: sqlite3.Row,
        confirmations: tuple[LiveConfirmationRecord, ...],
    ) -> None:
        projected_mode: str | None = None
        projected_generation: int | None = None
        projected_epoch: int | None = None
        projected_receipts: dict[str, tuple[str, str | None]] = {}
        previous: str | None = None
        expected_sequence = 1
        for row in self.connection.execute(
            "SELECT * FROM control_event ORDER BY sequence"
        ):
            if (
                row["sequence"] != expected_sequence
                or row["event_type"] not in _EVENT_TYPES
                or row["previous_sha256"] != previous
                or _SHA256.fullmatch(row["event_sha256"]) is None
            ):
                raise ValueError("control event sequence is invalid")
            occurred_at = row["occurred_at"]
            _parse_timestamp(occurred_at)
            try:
                payload = strict_json_loads(
                    row["payload_json"].encode("utf-8"),
                    max_message_bytes=64 * 1024,
                )
            except JsonLineError as exc:
                raise ValueError("control event payload is invalid") from exc
            if not isinstance(payload, dict):
                raise ValueError("control event payload is invalid")
            body = {
                "schemaVersion": LIVE_CONTROL_SCHEMA_VERSION,
                "sequence": row["sequence"],
                "eventType": row["event_type"],
                "payload": payload,
                "occurredAt": occurred_at,
                "previousSha256": previous,
            }
            actual = _sha256_text(_canonical_json(body))
            if actual != row["event_sha256"]:
                raise ValueError("control event hash is invalid")
            event_type = row["event_type"]
            if event_type.startswith("control-") or event_type == "authority-revoked":
                mode = payload.get("mode")
                generation = payload.get("generation")
                epoch = payload.get("policyEpoch")
                if (
                    mode not in _MODES
                    or isinstance(generation, bool)
                    or not isinstance(generation, int)
                    or generation < 0
                    or isinstance(epoch, bool)
                    or not isinstance(epoch, int)
                    or epoch < 0
                    or (
                        projected_generation is not None
                        and generation < projected_generation
                    )
                    or (
                        projected_epoch is not None
                        and epoch < projected_epoch
                    )
                ):
                    raise ValueError("control projection event is invalid")
                projected_mode = mode
                projected_generation = generation
                projected_epoch = epoch
            elif event_type == "confirmation-issued":
                receipt = self._event_record(payload)
                if (
                    receipt.receipt_id in projected_receipts
                    or receipt.state != "issued"
                ):
                    raise ValueError("confirmation issue event is invalid")
                projected_receipts[receipt.receipt_id] = ("issued", None)
            else:
                receipt_id = payload.get("receiptId")
                state = payload.get("state")
                resolved_at = payload.get("resolvedAt")
                expected_state = event_type.removeprefix("confirmation-")
                current = projected_receipts.get(receipt_id)
                if (
                    not isinstance(receipt_id, str)
                    or _HEX_32.fullmatch(receipt_id) is None
                    or state != expected_state
                    or expected_state not in {"consumed", "revoked", "expired"}
                    or not isinstance(resolved_at, str)
                    or current is None
                    or current[0] != "issued"
                ):
                    raise ValueError("confirmation resolution event is invalid")
                _parse_timestamp(resolved_at)
                projected_receipts[receipt_id] = (state, resolved_at)
            previous = actual
            expected_sequence += 1
        if (
            projected_mode != meta["mode"]
            or projected_generation != meta["generation"]
            or projected_epoch != meta["policy_epoch"]
            or set(projected_receipts)
            != {record.receipt_id for record in confirmations}
            or any(
                projected_receipts[record.receipt_id]
                != (record.state, record.resolved_at)
                for record in confirmations
            )
        ):
            raise ValueError("control event projection is invalid")

    @staticmethod
    def _event_record(payload: dict[str, Any]) -> LiveConfirmationRecord:
        expected = {
            "schemaVersion",
            "receiptId",
            "handleSha256",
            "shadowHandleSha256",
            "accountHandleSha256",
            "intentSha256",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "clientOrderId",
            "instrumentId",
            "side",
            "orderType",
            "quantity",
            "limitPrice",
            "policyEpoch",
            "controlGeneration",
            "state",
            "issuedAt",
            "expiresAt",
            "resolvedAt",
        }
        if set(payload) != expected or payload["schemaVersion"] != LIVE_CONFIRMATION_SCHEMA:
            raise ValueError("confirmation issue event payload is invalid")
        return LiveConfirmationRecord(
            receipt_id=payload["receiptId"],
            handle_sha256=payload["handleSha256"],
            shadow_handle_sha256=payload["shadowHandleSha256"],
            account_handle_sha256=payload["accountHandleSha256"],
            intent_sha256=payload["intentSha256"],
            plugin_id=payload["pluginId"],
            connector_id=payload["connectorId"],
            publisher_identity=payload["publisherIdentity"],
            version=payload["version"],
            client_order_id=payload["clientOrderId"],
            instrument_id=payload["instrumentId"],
            side=payload["side"],
            order_type=payload["orderType"],
            quantity=payload["quantity"],
            limit_price=payload["limitPrice"],
            policy_epoch=payload["policyEpoch"],
            control_generation=payload["controlGeneration"],
            state=payload["state"],
            issued_at=payload["issuedAt"],
            expires_at=payload["expiresAt"],
            resolved_at=payload["resolvedAt"],
        )

    def _append_event(
        self,
        event_type: str,
        payload: dict[str, Any],
        occurred_at: str,
    ) -> None:
        if event_type not in _EVENT_TYPES:
            raise ValueError("control event type is invalid")
        count = self.connection.execute(
            "SELECT COUNT(*) FROM control_event"
        ).fetchone()[0]
        if count >= MAX_CONTROL_EVENTS:
            raise broker_error(
                "LIVE_CONTROL_EVENT_LIMIT",
                "Live control event limit has been reached",
            )
        last = self.connection.execute(
            """
            SELECT sequence, event_sha256
            FROM control_event ORDER BY sequence DESC LIMIT 1
            """
        ).fetchone()
        sequence = 1 if last is None else last["sequence"] + 1
        previous = None if last is None else last["event_sha256"]
        body = {
            "schemaVersion": LIVE_CONTROL_SCHEMA_VERSION,
            "sequence": sequence,
            "eventType": event_type,
            "payload": payload,
            "occurredAt": occurred_at,
            "previousSha256": previous,
        }
        event_sha256 = _sha256_text(_canonical_json(body))
        self.connection.execute(
            """
            INSERT INTO control_event(
                sequence, event_type, payload_json, occurred_at,
                previous_sha256, event_sha256
            ) VALUES(?, ?, ?, ?, ?, ?)
            """,
            (
                sequence,
                event_type,
                _canonical_json(payload),
                occurred_at,
                previous,
                event_sha256,
            ),
        )

    def _expire_due_locked(self, now: datetime) -> int:
        now_text = _timestamp(now)
        rows = tuple(
            self.connection.execute(
                """
                SELECT * FROM confirmation
                WHERE state = 'issued' AND expires_at <= ?
                ORDER BY receipt_id
                """,
                (now_text,),
            )
        )
        for row in rows:
            self.connection.execute(
                """
                UPDATE confirmation
                SET state = 'expired', resolved_at = ?
                WHERE receipt_id = ? AND state = 'issued'
                """,
                (now_text, row["receipt_id"]),
            )
            self._append_event(
                "confirmation-expired",
                {
                    "receiptId": row["receipt_id"],
                    "state": "expired",
                    "resolvedAt": now_text,
                },
                now_text,
            )
        return len(rows)

    def expire_due(self, *, now: datetime | None = None) -> int:
        with self._transaction():
            return self._expire_due_locked(_utc_now() if now is None else now)

    def status(self, *, now: datetime | None = None) -> dict[str, Any]:
        self.expire_due(now=now)
        meta = self.connection.execute(
            "SELECT * FROM control_meta WHERE singleton = 1"
        ).fetchone()
        counts = {
            row["state"]: int(row["count"])
            for row in self.connection.execute(
                """
                SELECT state, COUNT(*) AS count
                FROM confirmation GROUP BY state
                """
            )
        }
        head = self.event_head()
        return {
            "schemaVersion": LIVE_CONTROL_STATUS_SCHEMA,
            "available": True,
            "mode": meta["mode"],
            "generation": meta["generation"],
            "policyEpoch": meta["policy_epoch"],
            "updatedAt": meta["updated_at"],
            "outstandingConfirmationCount": counts.get("issued", 0),
            "confirmationCounts": {
                state: counts.get(state, 0)
                for state in sorted(_RECEIPT_STATES)
            },
            "eventSequence": head["sequence"],
            "eventSha256": head["sha256"],
            "liveSubmitAvailable": self.testnet_execution_enabled,
            "liveCancelAvailable": self.testnet_execution_enabled,
            "liveTransferAvailable": False,
        }

    def _resolve_all_issued_locked(
        self,
        *,
        state: str,
        occurred_at: str,
    ) -> int:
        rows = tuple(
            self.connection.execute(
                """
                SELECT receipt_id FROM confirmation
                WHERE state = 'issued' ORDER BY receipt_id
                """
            )
        )
        for row in rows:
            self.connection.execute(
                """
                UPDATE confirmation
                SET state = ?, resolved_at = ?
                WHERE receipt_id = ? AND state = 'issued'
                """,
                (state, occurred_at, row["receipt_id"]),
            )
            self._append_event(
                f"confirmation-{state}",
                {
                    "receiptId": row["receipt_id"],
                    "state": state,
                    "resolvedAt": occurred_at,
                },
                occurred_at,
            )
        return len(rows)

    def set_mode(
        self,
        mode: str,
        *,
        policy_epoch: int,
        reason: str,
        acknowledge_kill: bool,
    ) -> dict[str, Any]:
        if mode not in {"armed", "disarmed"}:
            raise broker_error(
                "LIVE_CONTROL_PARAMS_INVALID",
                "control mode must be armed or disarmed",
            )
        reason = _bounded_text(reason, "control reason", maximum=128)
        if policy_epoch != self.policy_epoch:
            raise broker_error(
                "LIVE_CONTROL_POLICY_EPOCH_REJECTED",
                "control policy epoch is stale",
                details={"currentPolicyEpoch": self.policy_epoch},
            )
        occurred_at = _timestamp(_utc_now())
        with self._transaction():
            current = self.connection.execute(
                "SELECT * FROM control_meta WHERE singleton = 1"
            ).fetchone()
            if current["mode"] == "killed" and mode == "armed" and not acknowledge_kill:
                raise broker_error(
                    "LIVE_CONTROL_KILL_ACK_REQUIRED",
                    "re-arming killed Live control requires explicit acknowledgement",
            )
            if current["mode"] == mode:
                pass
            else:
                generation = current["generation"] + 1
                self.connection.execute(
                    """
                    UPDATE control_meta
                    SET mode = ?, generation = ?, updated_at = ?
                    WHERE singleton = 1
                    """,
                    (mode, generation, occurred_at),
                )
                self._append_event(
                    f"control-{mode}",
                    {
                        "mode": mode,
                        "generation": generation,
                        "policyEpoch": policy_epoch,
                        "reason": reason,
                    },
                    occurred_at,
                )
                if mode == "disarmed":
                    self._resolve_all_issued_locked(
                        state="revoked",
                        occurred_at=occurred_at,
                    )
        return self.status()

    def force_killed(
        self,
        *,
        policy_epoch: int,
        reason: str,
        event_type: str = "control-killed",
        scope_type: str | None = None,
        subject_sha256: str | None = None,
    ) -> dict[str, Any]:
        reason = _bounded_text(reason, "kill reason", maximum=128)
        if (
            isinstance(policy_epoch, bool)
            or not isinstance(policy_epoch, int)
            or policy_epoch < self.policy_epoch
        ):
            raise broker_error(
                "LIVE_CONTROL_POLICY_EPOCH_REJECTED",
                "kill policy epoch is stale",
            )
        if event_type not in {
            "control-killed",
            "control-recovered",
            "authority-revoked",
        }:
            raise ValueError("kill event type is invalid")
        if scope_type is not None:
            if scope_type not in {
                "grant",
                "plugin",
                "publisher",
                "credential",
                "global",
            }:
                raise ValueError("revoke scope type is invalid")
            _digest(subject_sha256 or "", "revoke subject")
        occurred_at = _timestamp(_utc_now())
        with self._transaction():
            current = self.connection.execute(
                "SELECT * FROM control_meta WHERE singleton = 1"
            ).fetchone()
            generation = current["generation"] + 1
            self.connection.execute(
                """
                UPDATE control_meta
                SET mode = 'killed', generation = ?, policy_epoch = ?,
                    updated_at = ?
                WHERE singleton = 1
                """,
                (generation, policy_epoch, occurred_at),
            )
            payload: dict[str, Any] = {
                "mode": "killed",
                "generation": generation,
                "policyEpoch": policy_epoch,
                "reason": reason,
            }
            if scope_type is not None:
                payload.update(
                    {
                        "scopeType": scope_type,
                        "subjectSha256": subject_sha256,
                    }
                )
            self._append_event(event_type, payload, occurred_at)
            revoked = self._resolve_all_issued_locked(
                state="revoked",
                occurred_at=occurred_at,
            )
        return {**self.status(), "revokedConfirmationCount": revoked}

    def issue(
        self,
        *,
        shadow_ref: str,
        account_ref: str,
        metadata: dict[str, Any],
        ttl_seconds: int,
        now: datetime | None = None,
    ) -> tuple[str, LiveConfirmationRecord]:
        if (
            isinstance(ttl_seconds, bool)
            or not isinstance(ttl_seconds, int)
            or not MIN_CONFIRMATION_TTL_SECONDS
            <= ttl_seconds
            <= MAX_CONFIRMATION_TTL_SECONDS
        ):
            raise broker_error(
                "LIVE_CONFIRMATION_TTL_INVALID",
                "confirmation TTL is outside the supported range",
            )
        if self.mode != "armed":
            raise broker_error(
                "LIVE_CONTROL_NOT_ARMED",
                "Live control must be armed before confirmation",
            )
        required = {
            "intentSha256",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "clientOrderId",
            "instrumentId",
            "side",
            "orderType",
            "quantity",
            "limitPrice",
            "policyEpoch",
        }
        if set(metadata) != required:
            raise ValueError("confirmation metadata shape is invalid")
        current = _utc_now() if now is None else now
        issued_at = _timestamp(current)
        expires_at = _timestamp(current + timedelta(seconds=ttl_seconds))
        shadow_sha256 = _sha256_text(shadow_ref)
        account_sha256 = _sha256_text(account_ref)
        receipt_ref = f"livecfm_{secrets.token_urlsafe(32)}"
        receipt = LiveConfirmationRecord(
            receipt_id=uuid.uuid4().hex,
            handle_sha256=_sha256_text(receipt_ref),
            shadow_handle_sha256=shadow_sha256,
            account_handle_sha256=account_sha256,
            intent_sha256=metadata["intentSha256"],
            plugin_id=metadata["pluginId"],
            connector_id=metadata["connectorId"],
            publisher_identity=metadata["publisherIdentity"],
            version=metadata["version"],
            client_order_id=metadata["clientOrderId"],
            instrument_id=metadata["instrumentId"],
            side=metadata["side"],
            order_type=metadata["orderType"],
            quantity=metadata["quantity"],
            limit_price=metadata["limitPrice"],
            policy_epoch=metadata["policyEpoch"],
            control_generation=self.generation,
            state="issued",
            issued_at=issued_at,
            expires_at=expires_at,
            resolved_at=None,
        )
        with self._transaction():
            self._expire_due_locked(current)
            if self.connection.execute(
                "SELECT COUNT(*) FROM confirmation"
            ).fetchone()[0] >= MAX_CONFIRMATIONS:
                raise broker_error(
                    "LIVE_CONFIRMATION_LIMIT",
                    "confirmation receipt limit has been reached",
                )
            if self.connection.execute(
                """
                SELECT 1 FROM confirmation
                WHERE shadow_handle_sha256 = ? AND state = 'issued'
                """,
                (shadow_sha256,),
            ).fetchone() is not None:
                raise broker_error(
                    "LIVE_CONFIRMATION_ALREADY_ISSUED",
                    "an outstanding confirmation already exists for this intent",
                )
            if (
                self.mode != "armed"
                or self.policy_epoch != receipt.policy_epoch
                or self.generation != receipt.control_generation
            ):
                raise broker_error(
                    "LIVE_CONFIRMATION_STALE",
                    "Live control changed before confirmation was issued",
                )
            self.connection.execute(
                """
                INSERT INTO confirmation(
                    receipt_id, handle_sha256, shadow_handle_sha256,
                    account_handle_sha256, intent_sha256, plugin_id,
                    connector_id, publisher_identity, version, client_order_id,
                    instrument_id, side, order_type, quantity, limit_price,
                    policy_epoch, control_generation, state, issued_at,
                    expires_at, resolved_at
                ) VALUES(
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, NULL
                )
                """,
                (
                    receipt.receipt_id,
                    receipt.handle_sha256,
                    receipt.shadow_handle_sha256,
                    receipt.account_handle_sha256,
                    receipt.intent_sha256,
                    receipt.plugin_id,
                    receipt.connector_id,
                    receipt.publisher_identity,
                    receipt.version,
                    receipt.client_order_id,
                    receipt.instrument_id,
                    receipt.side,
                    receipt.order_type,
                    receipt.quantity,
                    receipt.limit_price,
                    receipt.policy_epoch,
                    receipt.control_generation,
                    receipt.state,
                    receipt.issued_at,
                    receipt.expires_at,
                ),
            )
            self._append_event(
                "confirmation-issued",
                receipt.event_wire(),
                issued_at,
            )
        return receipt_ref, receipt

    def describe(
        self,
        receipt_ref: str,
        *,
        now: datetime | None = None,
    ) -> LiveConfirmationRecord:
        if not isinstance(receipt_ref, str) or _RECEIPT_REF.fullmatch(receipt_ref) is None:
            raise broker_error(
                "LIVE_CONFIRMATION_NOT_FOUND",
                "confirmation receipt is unavailable",
            )
        self.expire_due(now=now)
        row = self.connection.execute(
            "SELECT * FROM confirmation WHERE handle_sha256 = ?",
            (_sha256_text(receipt_ref),),
        ).fetchone()
        if row is None:
            raise broker_error(
                "LIVE_CONFIRMATION_NOT_FOUND",
                "confirmation receipt is unavailable",
            )
        return self._record(row)

    def revoke(
        self,
        receipt_ref: str,
        *,
        reason: str,
        now: datetime | None = None,
    ) -> LiveConfirmationRecord:
        _bounded_text(reason, "confirmation revoke reason", maximum=128)
        if (
            not isinstance(receipt_ref, str)
            or _RECEIPT_REF.fullmatch(receipt_ref) is None
        ):
            raise broker_error(
                "LIVE_CONFIRMATION_NOT_FOUND",
                "confirmation receipt is unavailable",
            )
        current = _utc_now() if now is None else now
        occurred_at = _timestamp(current)
        with self._transaction():
            self._expire_due_locked(current)
            row = self.connection.execute(
                "SELECT * FROM confirmation WHERE handle_sha256 = ?",
                (_sha256_text(receipt_ref),),
            ).fetchone()
            if row is None:
                raise broker_error(
                    "LIVE_CONFIRMATION_NOT_FOUND",
                    "confirmation receipt is unavailable",
                )
            if row["state"] == "issued":
                self.connection.execute(
                    """
                    UPDATE confirmation
                    SET state = 'revoked', resolved_at = ?
                    WHERE receipt_id = ? AND state = 'issued'
                    """,
                    (occurred_at, row["receipt_id"]),
                )
                self._append_event(
                    "confirmation-revoked",
                    {
                        "receiptId": row["receipt_id"],
                        "state": "revoked",
                        "resolvedAt": occurred_at,
                    },
                    occurred_at,
                )
        return self.describe(receipt_ref, now=current)

    def consume_for_execution(
        self,
        receipt_ref: str,
        *,
        shadow_ref: str,
        account_ref: str,
        intent_sha256: str,
        plugin_id: str,
        publisher_identity: str,
        connector_id: str,
        policy_epoch: int,
        control_generation: int,
        now: datetime | None = None,
    ) -> LiveConfirmationRecord:
        """Atomically consume once; intentionally not exposed by the WP-E protocol."""

        current = _utc_now() if now is None else now
        occurred_at = _timestamp(current)
        with self._transaction():
            self._expire_due_locked(current)
            row = self.connection.execute(
                "SELECT * FROM confirmation WHERE handle_sha256 = ?",
                (_sha256_text(receipt_ref),),
            ).fetchone()
            if row is None:
                raise broker_error(
                    "LIVE_CONFIRMATION_NOT_FOUND",
                    "confirmation receipt is unavailable",
                )
            receipt = self._record(row)
            if (
                self.mode != "armed"
                or receipt.state != "issued"
                or receipt.shadow_handle_sha256 != _sha256_text(shadow_ref)
                or receipt.account_handle_sha256 != _sha256_text(account_ref)
                or receipt.intent_sha256 != intent_sha256
                or receipt.plugin_id != plugin_id
                or receipt.publisher_identity != publisher_identity
                or receipt.connector_id != connector_id
                or receipt.policy_epoch != policy_epoch
                or receipt.control_generation != control_generation
                or self.policy_epoch != policy_epoch
                or self.generation != control_generation
            ):
                raise broker_error(
                    "LIVE_CONFIRMATION_REJECTED",
                    "confirmation receipt is stale, spent, or bound to another intent",
                )
            updated = self.connection.execute(
                """
                UPDATE confirmation
                SET state = 'consumed', resolved_at = ?
                WHERE receipt_id = ? AND state = 'issued'
                """,
                (occurred_at, receipt.receipt_id),
            )
            if updated.rowcount != 1:
                raise broker_error(
                    "LIVE_CONFIRMATION_REJECTED",
                    "confirmation receipt has already been resolved",
                )
            self._append_event(
                "confirmation-consumed",
                {
                    "receiptId": receipt.receipt_id,
                    "state": "consumed",
                    "resolvedAt": occurred_at,
                },
                occurred_at,
            )
        return self.describe(receipt_ref, now=current)

    def event_head(self) -> dict[str, Any]:
        row = self.connection.execute(
            """
            SELECT sequence, event_sha256
            FROM control_event ORDER BY sequence DESC LIMIT 1
            """
        ).fetchone()
        return {
            "sequence": 0 if row is None else row["sequence"],
            "sha256": None if row is None else row["event_sha256"],
        }

    def audit_events(
        self,
        *,
        after_sequence: int,
        through_sequence: int,
        limit: int,
    ) -> list[dict[str, Any]]:
        if (
            isinstance(after_sequence, bool)
            or not isinstance(after_sequence, int)
            or after_sequence < 0
            or isinstance(through_sequence, bool)
            or not isinstance(through_sequence, int)
            or through_sequence < after_sequence
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 64
        ):
            raise ValueError("control audit page is invalid")
        events: list[dict[str, Any]] = []
        for row in self.connection.execute(
            """
            SELECT * FROM control_event
            WHERE sequence > ? AND sequence <= ?
            ORDER BY sequence LIMIT ?
            """,
            (after_sequence, through_sequence, limit),
        ):
            payload = strict_json_loads(
                row["payload_json"].encode("utf-8"),
                max_message_bytes=64 * 1024,
            )
            events.append(
                {
                    "schemaVersion": LIVE_CONTROL_SCHEMA_VERSION,
                    "sequence": row["sequence"],
                    "eventType": row["event_type"],
                    "payload": payload,
                    "occurredAt": row["occurred_at"],
                    "previousSha256": row["previous_sha256"],
                    "eventSha256": row["event_sha256"],
                }
            )
        return events

    def close(self) -> None:
        try:
            self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            self.connection.close()


__all__ = [
    "LIVE_CONFIRMATION_SCHEMA",
    "LIVE_CONTROL_FILENAME",
    "LIVE_CONTROL_SCHEMA_VERSION",
    "LIVE_CONTROL_STATUS_SCHEMA",
    "MAX_CONFIRMATION_TTL_SECONDS",
    "MIN_CONFIRMATION_TTL_SECONDS",
    "LiveConfirmationRecord",
    "LiveControlLedger",
]
