"""Crash-consistent SQLite journal for WP-D query-only order shadows."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from app.plugin_host.framing import JsonLineError, strict_json_loads

from .errors import LiveBrokerError, broker_error
from .shadow import (
    ORDER_QUERY_STATES,
    OrderQueryProof,
    ShadowOrderIntent,
    canonical_positive_decimal,
)
from .state import AccountBinding


SHADOW_JOURNAL_SCHEMA_VERSION = 1
SHADOW_JOURNAL_FILENAME = "live-order-shadow-v1.sqlite"
MAX_SHADOW_ORDERS = 10_000
MAX_JOURNAL_EVENTS = 100_000
MAX_RECONCILE_ATTEMPTS = 1_000
SHADOW_ORDER_STATES = frozenset(
    {"prepared", "querying", "unknown", *ORDER_QUERY_STATES}
)
_NONTERMINAL_RECONCILE_STATES = frozenset(
    {"prepared", "unknown", "live", "partially_filled"}
)
_HEX_32 = re.compile(r"^[0-9a-f]{32}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_HANDLE = re.compile(r"^shdw_[A-Za-z0-9_-]{43}$")
_CLIENT_ORDER_ID = re.compile(r"^[A-Za-z0-9]{32}$")
_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
_EVENT_TYPES = frozenset(
    {
        "prepared",
        "reconcile-started",
        "reconcile-observed",
        "reconcile-failed",
        "reconcile-recovered-unknown",
    }
)
_EXPECTED_COLUMNS = {
    "broker_meta": (
        ("singleton", "INTEGER", 0, 1),
        ("schema_version", "INTEGER", 1, 0),
        ("broker_id", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "shadow_order": (
        ("record_id", "TEXT", 1, 1),
        ("handle_sha256", "TEXT", 1, 0),
        ("idempotency_sha256", "TEXT", 1, 0),
        ("account_handle_sha256", "TEXT", 1, 0),
        ("canonical_account_sha256", "TEXT", 1, 0),
        ("credential_handle_sha256", "TEXT", 1, 0),
        ("plugin_id", "TEXT", 1, 0),
        ("connector_id", "TEXT", 1, 0),
        ("publisher_identity", "TEXT", 1, 0),
        ("version", "TEXT", 1, 0),
        ("client_order_id", "TEXT", 1, 0),
        ("intent_sha256", "TEXT", 1, 0),
        ("instrument_id", "TEXT", 1, 0),
        ("side", "TEXT", 1, 0),
        ("order_type", "TEXT", 1, 0),
        ("quantity", "TEXT", 1, 0),
        ("limit_price", "TEXT", 1, 0),
        ("state", "TEXT", 1, 0),
        ("venue_order_id", "TEXT", 0, 0),
        ("accumulated_fill_size", "TEXT", 1, 0),
        ("average_price", "TEXT", 0, 0),
        ("reconcile_attempt_count", "INTEGER", 1, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
        ("created_policy_epoch", "INTEGER", 1, 0),
    ),
    "journal_event": (
        ("sequence", "INTEGER", 0, 1),
        ("record_id", "TEXT", 1, 0),
        ("event_type", "TEXT", 1, 0),
        ("payload_json", "TEXT", 1, 0),
        ("occurred_at", "TEXT", 1, 0),
        ("previous_sha256", "TEXT", 0, 0),
        ("event_sha256", "TEXT", 1, 0),
    ),
}
_EXPECTED_UNIQUE_INDEX_COLUMNS = {
    "broker_meta": set(),
    "shadow_order": {
        ("record_id",),
        ("handle_sha256",),
        ("idempotency_sha256",),
        ("client_order_id",),
    },
    "journal_event": {("event_sha256",)},
}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _sha256_text(value: str) -> str:
    return _sha256_bytes(value.encode("utf-8"))


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _hmac_digest(broker_id: str, domain: bytes, value: str) -> bytes:
    return hmac.digest(
        broker_id.encode("ascii"),
        domain + b"\0" + value.encode("ascii"),
        hashlib.sha256,
    )


def _shadow_handle(broker_id: str, idempotency_key: str) -> str:
    encoded = base64.urlsafe_b64encode(
        _hmac_digest(broker_id, b"shadow-handle-v1", idempotency_key)
    ).decode("ascii")
    return f"shdw_{encoded.rstrip('=')}"


def _client_order_id(broker_id: str, idempotency_key: str) -> str:
    encoded = base64.b32encode(
        _hmac_digest(broker_id, b"okx-client-order-v1", idempotency_key)
    ).decode("ascii")
    return f"CS{encoded[:30]}"


@dataclass(frozen=True, slots=True)
class ShadowOrderRecord:
    record_id: str
    handle_sha256: str
    idempotency_sha256: str
    account_handle_sha256: str
    canonical_account_sha256: str
    credential_handle_sha256: str
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    client_order_id: str
    intent_sha256: str
    instrument_id: str
    side: str
    order_type: str
    quantity: str
    limit_price: str
    state: str
    venue_order_id: str | None
    accumulated_fill_size: str
    average_price: str | None
    reconcile_attempt_count: int
    created_at: str
    updated_at: str
    created_policy_epoch: int

    def __post_init__(self) -> None:
        digests = (
            self.handle_sha256,
            self.idempotency_sha256,
            self.account_handle_sha256,
            self.canonical_account_sha256,
            self.credential_handle_sha256,
            self.intent_sha256,
        )
        if (
            not isinstance(self.record_id, str)
            or _HEX_32.fullmatch(self.record_id) is None
            or any(
                not isinstance(value, str) or _SHA256.fullmatch(value) is None
                for value in digests
            )
            or not isinstance(self.plugin_id, str)
            or _ID.fullmatch(self.plugin_id) is None
            or not isinstance(self.connector_id, str)
            or _ID.fullmatch(self.connector_id) is None
            or not isinstance(self.publisher_identity, str)
            or not self.publisher_identity
            or len(self.publisher_identity) > 256
            or not isinstance(self.version, str)
            or not self.version
            or len(self.version) > 64
            or not isinstance(self.client_order_id, str)
            or _CLIENT_ORDER_ID.fullmatch(self.client_order_id) is None
            or self.state not in SHADOW_ORDER_STATES
            or isinstance(self.reconcile_attempt_count, bool)
            or not isinstance(self.reconcile_attempt_count, int)
            or not 0 <= self.reconcile_attempt_count <= MAX_RECONCILE_ATTEMPTS
            or isinstance(self.created_policy_epoch, bool)
            or not isinstance(self.created_policy_epoch, int)
            or self.created_policy_epoch < 0
        ):
            raise ValueError("shadow order record metadata is invalid")
        ShadowOrderIntent(
            idempotency_key="intent_" + "A" * 43,
            instrument_id=self.instrument_id,
            side=self.side,
            order_type=self.order_type,
            quantity=self.quantity,
            limit_price=self.limit_price,
        )
        if (
            self.venue_order_id is not None
            and (
                not isinstance(self.venue_order_id, str)
                or re.fullmatch(r"[0-9]{1,32}", self.venue_order_id) is None
            )
        ):
            raise ValueError("shadow venue order identity is invalid")
        if self.accumulated_fill_size == "0":
            accumulated = Decimal(0)
        else:
            canonical_positive_decimal(
                self.accumulated_fill_size,
                "shadow accumulated fill size",
            )
            accumulated = Decimal(self.accumulated_fill_size)
        if self.average_price is not None:
            canonical_positive_decimal(
                self.average_price,
                "shadow average price",
            )
        if (
            accumulated > Decimal(self.quantity)
            or (
                self.state == "prepared"
                and (
                    self.venue_order_id is not None
                    or accumulated != 0
                    or self.average_price is not None
                    or self.reconcile_attempt_count != 0
                )
            )
            or (
                self.state != "prepared"
                and self.reconcile_attempt_count == 0
            )
            or (
                self.state in ORDER_QUERY_STATES
                and self.venue_order_id is None
            )
            or (self.state == "live" and accumulated != 0)
            or (
                self.state in {"partially_filled", "filled"}
                and accumulated == 0
            )
            or (accumulated == 0 and self.average_price is not None)
            or (accumulated > 0 and self.average_price is None)
        ):
            raise ValueError("shadow order projection is inconsistent")
        for value in (self.created_at, self.updated_at):
            if not isinstance(value, str) or not value or len(value) > 64:
                raise ValueError("shadow order timestamp is invalid")

    def metadata(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "connectorId": self.connector_id,
            "publisherIdentity": self.publisher_identity,
            "version": self.version,
            "clientOrderId": self.client_order_id,
            "intentSha256": self.intent_sha256,
            "instrumentId": self.instrument_id,
            "side": self.side,
            "orderType": self.order_type,
            "quantity": self.quantity,
            "limitPrice": self.limit_price,
            "state": self.state,
            "venueOrderId": self.venue_order_id,
            "accumulatedFillSize": self.accumulated_fill_size,
            "averagePrice": self.average_price,
            "reconcileAttemptCount": self.reconcile_attempt_count,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "createdPolicyEpoch": self.created_policy_epoch,
        }


class ShadowOrderJournal:
    """Own a bounded journal and recover any interrupted query as unknown."""

    def __init__(self, root: Path | str, *, broker_id: str) -> None:
        if not isinstance(broker_id, str) or _HEX_32.fullmatch(broker_id) is None:
            raise ValueError("broker_id is invalid")
        self.root = Path(root).expanduser().resolve(strict=False)
        self.path = self.root / SHADOW_JOURNAL_FILENAME
        self.broker_id = broker_id
        for path in (
            self.path,
            self.path.with_name(f"{self.path.name}-wal"),
            self.path.with_name(f"{self.path.name}-shm"),
        ):
            if path.is_symlink() or (
                path.exists() and not path.is_file()
            ):
                raise broker_error(
                    "LIVE_SHADOW_JOURNAL_PATH_UNSAFE",
                    "shadow journal path is unsafe",
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
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.execute("PRAGMA busy_timeout=5000")
            mode = self.connection.execute(
                "PRAGMA journal_mode=WAL"
            ).fetchone()
            if mode is None or str(mode[0]).casefold() != "wal":
                raise sqlite3.DatabaseError("WAL mode was not enabled")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA trusted_schema=OFF")
            self._initialize_or_validate()
            self._recover_interrupted_queries()
        except (
            OSError,
            sqlite3.DatabaseError,
            ValueError,
            LiveBrokerError,
        ) as exc:
            connection = getattr(self, "connection", None)
            if connection is not None:
                connection.close()
            if isinstance(exc, LiveBrokerError):
                raise
            raise broker_error(
                "LIVE_SHADOW_JOURNAL_INVALID",
                "shadow journal failed validation",
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

    def _initialize_or_validate(self) -> None:
        tables = {
            row["name"]
            for row in self.connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                """
            )
        }
        if not tables:
            self._create_schema()
        elif tables != {"broker_meta", "shadow_order", "journal_event"}:
            raise ValueError("shadow journal tables are invalid")
        self._validate_schema()
        quick = self.connection.execute("PRAGMA quick_check").fetchone()
        if quick is None or quick[0] != "ok":
            raise ValueError("shadow journal quick_check failed")
        if tuple(self.connection.execute("PRAGMA foreign_key_check")):
            raise ValueError("shadow journal foreign keys are invalid")
        user_version = self.connection.execute("PRAGMA user_version").fetchone()
        if user_version is None or user_version[0] != SHADOW_JOURNAL_SCHEMA_VERSION:
            raise ValueError("shadow journal schema version is unsupported")
        meta = self.connection.execute(
            """
            SELECT schema_version, broker_id
            FROM broker_meta
            WHERE singleton = 1
            """
        ).fetchone()
        if (
            meta is None
            or meta["schema_version"] != SHADOW_JOURNAL_SCHEMA_VERSION
            or meta["broker_id"] != self.broker_id
            or self.connection.execute(
                "SELECT COUNT(*) FROM broker_meta"
            ).fetchone()[0]
            != 1
        ):
            raise ValueError("shadow journal broker metadata is invalid")
        order_count = self.connection.execute(
            "SELECT COUNT(*) FROM shadow_order"
        ).fetchone()[0]
        event_count = self.connection.execute(
            "SELECT COUNT(*) FROM journal_event"
        ).fetchone()[0]
        if order_count > MAX_SHADOW_ORDERS or event_count > MAX_JOURNAL_EVENTS:
            raise ValueError("shadow journal limits are exceeded")
        for row in self.connection.execute(
            "SELECT * FROM shadow_order ORDER BY record_id"
        ):
            self._record(row)
        self._validate_event_chain()

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
            raise ValueError("shadow journal schema objects are invalid")
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
                raise ValueError("shadow journal table mode is invalid")
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
                raise ValueError("shadow journal columns are invalid")
            unique_columns: set[tuple[str, ...]] = set()
            for index in self.connection.execute(
                f"PRAGMA index_list({table})"
            ):
                if index["unique"] != 1 or index["partial"] != 0:
                    raise ValueError("shadow journal indexes are invalid")
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
                raise ValueError("shadow journal unique indexes are invalid")
        foreign_keys = tuple(
            tuple(row)
            for row in self.connection.execute(
                "PRAGMA foreign_key_list(journal_event)"
            )
        )
        if foreign_keys != (
            (
                0,
                0,
                "shadow_order",
                "record_id",
                "record_id",
                "NO ACTION",
                "NO ACTION",
                "NONE",
            ),
        ):
            raise ValueError("shadow journal schema foreign key is invalid")

    def _create_schema(self) -> None:
        with self._transaction():
            for statement in (
                """
                CREATE TABLE broker_meta (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    schema_version INTEGER NOT NULL,
                    broker_id TEXT NOT NULL,
                    created_at TEXT NOT NULL
                ) STRICT
                """,
                """
                CREATE TABLE shadow_order (
                    record_id TEXT PRIMARY KEY,
                    handle_sha256 TEXT NOT NULL UNIQUE,
                    idempotency_sha256 TEXT NOT NULL UNIQUE,
                    account_handle_sha256 TEXT NOT NULL,
                    canonical_account_sha256 TEXT NOT NULL,
                    credential_handle_sha256 TEXT NOT NULL,
                    plugin_id TEXT NOT NULL,
                    connector_id TEXT NOT NULL,
                    publisher_identity TEXT NOT NULL,
                    version TEXT NOT NULL,
                    client_order_id TEXT NOT NULL UNIQUE,
                    intent_sha256 TEXT NOT NULL,
                    instrument_id TEXT NOT NULL,
                    side TEXT NOT NULL,
                    order_type TEXT NOT NULL,
                    quantity TEXT NOT NULL,
                    limit_price TEXT NOT NULL,
                    state TEXT NOT NULL,
                    venue_order_id TEXT,
                    accumulated_fill_size TEXT NOT NULL,
                    average_price TEXT,
                    reconcile_attempt_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    created_policy_epoch INTEGER NOT NULL
                ) STRICT
                """,
                """
                CREATE TABLE journal_event (
                    sequence INTEGER PRIMARY KEY,
                    record_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    previous_sha256 TEXT,
                    event_sha256 TEXT NOT NULL UNIQUE,
                    FOREIGN KEY (record_id) REFERENCES shadow_order(record_id)
                ) STRICT
                """,
            ):
                self.connection.execute(statement)
            self.connection.execute(
                """
                INSERT INTO broker_meta(
                    singleton, schema_version, broker_id, created_at
                ) VALUES(1, ?, ?, ?)
                """,
                (SHADOW_JOURNAL_SCHEMA_VERSION, self.broker_id, _utc_now()),
            )
            self.connection.execute(
                f"PRAGMA user_version={SHADOW_JOURNAL_SCHEMA_VERSION}"
            )

    def _validate_event_chain(self) -> None:
        records = {
            record.record_id: record
            for record in (
                self._record(row)
                for row in self.connection.execute(
                    "SELECT * FROM shadow_order ORDER BY record_id"
                )
            )
        }
        projected: dict[str, tuple[str, int]] = {}
        previous: str | None = None
        expected_sequence = 1
        for row in self.connection.execute(
            "SELECT * FROM journal_event ORDER BY sequence"
        ):
            if (
                row["sequence"] != expected_sequence
                or row["event_type"] not in _EVENT_TYPES
                or row["previous_sha256"] != previous
                or row["record_id"] not in records
                or not isinstance(row["occurred_at"], str)
                or not row["occurred_at"]
                or len(row["occurred_at"]) > 64
                or not isinstance(row["event_sha256"], str)
                or _SHA256.fullmatch(row["event_sha256"]) is None
            ):
                raise ValueError("shadow journal event sequence is invalid")
            try:
                payload = strict_json_loads(
                    row["payload_json"].encode("utf-8"),
                    max_message_bytes=64 * 1024,
                )
            except JsonLineError as exc:
                raise ValueError("shadow journal event payload is invalid") from exc
            if not isinstance(payload, dict):
                raise ValueError("shadow journal event payload is invalid")
            record = records[row["record_id"]]
            current = projected.get(row["record_id"])
            event_type = row["event_type"]
            if event_type == "prepared":
                if (
                    set(payload)
                    != {"clientOrderId", "intentSha256", "state"}
                    or current is not None
                    or payload["clientOrderId"] != record.client_order_id
                    or payload["intentSha256"] != record.intent_sha256
                    or payload["state"] != "prepared"
                ):
                    raise ValueError(
                        "shadow journal prepared event is invalid"
                    )
                next_projection = ("prepared", 0)
            elif event_type == "reconcile-started":
                if (
                    set(payload) != {"attempt", "state"}
                    or current is None
                    or current[0] not in _NONTERMINAL_RECONCILE_STATES
                    or isinstance(payload["attempt"], bool)
                    or not isinstance(payload["attempt"], int)
                    or payload["attempt"] != current[1] + 1
                    or not 1
                    <= payload["attempt"]
                    <= MAX_RECONCILE_ATTEMPTS
                    or payload["state"] != "querying"
                ):
                    raise ValueError(
                        "shadow journal reconcile start event is invalid"
                    )
                next_projection = ("querying", payload["attempt"])
            elif event_type == "reconcile-observed":
                if (
                    set(payload)
                    != {
                        "attempt",
                        "state",
                        "venueOrderIdSha256",
                    }
                    or current is None
                    or current[0] != "querying"
                    or payload["attempt"] != current[1]
                    or payload["state"] not in ORDER_QUERY_STATES
                    or not isinstance(
                        payload["venueOrderIdSha256"],
                        str,
                    )
                    or _SHA256.fullmatch(
                        payload["venueOrderIdSha256"]
                    )
                    is None
                ):
                    raise ValueError(
                        "shadow journal observed event is invalid"
                    )
                next_projection = (payload["state"], current[1])
            elif event_type == "reconcile-failed":
                if (
                    set(payload)
                    != {"attempt", "errorCode", "state"}
                    or current is None
                    or current[0] != "querying"
                    or payload["attempt"] != current[1]
                    or not isinstance(payload["errorCode"], str)
                    or _ERROR_CODE.fullmatch(payload["errorCode"]) is None
                    or payload["state"] != "unknown"
                ):
                    raise ValueError(
                        "shadow journal failed event is invalid"
                    )
                next_projection = ("unknown", current[1])
            else:
                if (
                    set(payload) != {"attempt", "state"}
                    or current is None
                    or current[0] != "querying"
                    or payload["attempt"] != current[1]
                    or payload["state"] != "unknown"
                ):
                    raise ValueError(
                        "shadow journal recovery event is invalid"
                    )
                next_projection = ("unknown", current[1])
            body = {
                "schemaVersion": SHADOW_JOURNAL_SCHEMA_VERSION,
                "sequence": row["sequence"],
                "recordId": row["record_id"],
                "eventType": row["event_type"],
                "payload": payload,
                "occurredAt": row["occurred_at"],
                "previousSha256": previous,
            }
            actual = _sha256_text(_canonical_json(body))
            if row["event_sha256"] != actual:
                raise ValueError("shadow journal event hash is invalid")
            projected[row["record_id"]] = next_projection
            previous = actual
            expected_sequence += 1
        if set(projected) != set(records) or any(
            projected[record_id]
            != (record.state, record.reconcile_attempt_count)
            for record_id, record in records.items()
        ):
            raise ValueError("shadow journal projection is invalid")

    def _append_event(
        self,
        record_id: str,
        event_type: str,
        payload: dict[str, Any],
        occurred_at: str,
    ) -> None:
        if event_type not in _EVENT_TYPES:
            raise ValueError("shadow journal event type is invalid")
        count = self.connection.execute(
            "SELECT COUNT(*) FROM journal_event"
        ).fetchone()[0]
        if count >= MAX_JOURNAL_EVENTS:
            raise broker_error(
                "LIVE_SHADOW_EVENT_LIMIT",
                "shadow journal event limit has been reached",
            )
        last = self.connection.execute(
            """
            SELECT sequence, event_sha256
            FROM journal_event
            ORDER BY sequence DESC
            LIMIT 1
            """
        ).fetchone()
        sequence = 1 if last is None else last["sequence"] + 1
        previous = None if last is None else last["event_sha256"]
        body = {
            "schemaVersion": SHADOW_JOURNAL_SCHEMA_VERSION,
            "sequence": sequence,
            "recordId": record_id,
            "eventType": event_type,
            "payload": payload,
            "occurredAt": occurred_at,
            "previousSha256": previous,
        }
        encoded = _canonical_json(payload)
        event_hash = _sha256_text(_canonical_json(body))
        self.connection.execute(
            """
            INSERT INTO journal_event(
                sequence, record_id, event_type, payload_json, occurred_at,
                previous_sha256, event_sha256
            ) VALUES(?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sequence,
                record_id,
                event_type,
                encoded,
                occurred_at,
                previous,
                event_hash,
            ),
        )

    @staticmethod
    def _record(row: sqlite3.Row) -> ShadowOrderRecord:
        return ShadowOrderRecord(
            record_id=row["record_id"],
            handle_sha256=row["handle_sha256"],
            idempotency_sha256=row["idempotency_sha256"],
            account_handle_sha256=row["account_handle_sha256"],
            canonical_account_sha256=row["canonical_account_sha256"],
            credential_handle_sha256=row["credential_handle_sha256"],
            plugin_id=row["plugin_id"],
            connector_id=row["connector_id"],
            publisher_identity=row["publisher_identity"],
            version=row["version"],
            client_order_id=row["client_order_id"],
            intent_sha256=row["intent_sha256"],
            instrument_id=row["instrument_id"],
            side=row["side"],
            order_type=row["order_type"],
            quantity=row["quantity"],
            limit_price=row["limit_price"],
            state=row["state"],
            venue_order_id=row["venue_order_id"],
            accumulated_fill_size=row["accumulated_fill_size"],
            average_price=row["average_price"],
            reconcile_attempt_count=row["reconcile_attempt_count"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            created_policy_epoch=row["created_policy_epoch"],
        )

    def _find(self, shadow_ref: str) -> ShadowOrderRecord | None:
        if not isinstance(shadow_ref, str) or _HANDLE.fullmatch(shadow_ref) is None:
            return None
        row = self.connection.execute(
            """
            SELECT *
            FROM shadow_order
            WHERE handle_sha256 = ?
            """,
            (_sha256_text(shadow_ref),),
        ).fetchone()
        return None if row is None else self._record(row)

    def prepare(
        self,
        *,
        account_ref: str,
        account: AccountBinding,
        intent: ShadowOrderIntent,
        policy_epoch: int,
    ) -> tuple[str, ShadowOrderRecord]:
        shadow_ref = _shadow_handle(self.broker_id, intent.idempotency_key)
        client_order_id = _client_order_id(
            self.broker_id,
            intent.idempotency_key,
        )
        idempotency_sha256 = _sha256_text(intent.idempotency_key)
        intent_body = {
            "schemaVersion": SHADOW_JOURNAL_SCHEMA_VERSION,
            "accountHandleSha256": _sha256_text(account_ref),
            "canonicalAccountSha256": account.canonical_account_sha256,
            "connectorId": account.connector_id,
            "intent": intent.canonical_wire(),
            "policyEpoch": policy_epoch,
        }
        intent_sha256 = _sha256_text(_canonical_json(intent_body))
        existing = self.connection.execute(
            """
            SELECT *
            FROM shadow_order
            WHERE idempotency_sha256 = ?
            """,
            (idempotency_sha256,),
        ).fetchone()
        if existing is not None:
            record = self._record(existing)
            if (
                record.intent_sha256 != intent_sha256
                or record.account_handle_sha256 != _sha256_text(account_ref)
                or record.canonical_account_sha256
                != account.canonical_account_sha256
            ):
                raise broker_error(
                    "LIVE_SHADOW_IDEMPOTENCY_CONFLICT",
                    "shadow idempotency key is bound to another intent",
                )
            return shadow_ref, record
        count = self.connection.execute(
            "SELECT COUNT(*) FROM shadow_order"
        ).fetchone()[0]
        if count >= MAX_SHADOW_ORDERS:
            raise broker_error(
                "LIVE_SHADOW_ORDER_LIMIT",
                "shadow journal order limit has been reached",
            )
        record_id = _hmac_digest(
            self.broker_id,
            b"shadow-record-v1",
            intent.idempotency_key,
        ).hex()[:32]
        occurred_at = _utc_now()
        with self._transaction():
            self.connection.execute(
                """
                INSERT INTO shadow_order(
                    record_id, handle_sha256, idempotency_sha256,
                    account_handle_sha256, canonical_account_sha256,
                    credential_handle_sha256, plugin_id, connector_id,
                    publisher_identity, version, client_order_id,
                    intent_sha256, instrument_id, side, order_type, quantity,
                    limit_price, state, venue_order_id, accumulated_fill_size,
                    average_price, reconcile_attempt_count, created_at,
                    updated_at, created_policy_epoch
                ) VALUES(
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'prepared', NULL, '0', NULL, 0, ?, ?, ?
                )
                """,
                (
                    record_id,
                    _sha256_text(shadow_ref),
                    idempotency_sha256,
                    _sha256_text(account_ref),
                    account.canonical_account_sha256,
                    account.credential_handle_sha256,
                    account.plugin_id,
                    account.connector_id,
                    account.publisher_identity,
                    account.version,
                    client_order_id,
                    intent_sha256,
                    intent.instrument_id,
                    intent.side,
                    intent.order_type,
                    intent.quantity,
                    intent.limit_price,
                    occurred_at,
                    occurred_at,
                    policy_epoch,
                ),
            )
            self._append_event(
                record_id,
                "prepared",
                {
                    "clientOrderId": client_order_id,
                    "intentSha256": intent_sha256,
                    "state": "prepared",
                },
                occurred_at,
            )
        record = self._find(shadow_ref)
        assert record is not None
        return shadow_ref, record

    def describe(self, shadow_ref: str) -> ShadowOrderRecord:
        record = self._find(shadow_ref)
        if record is None:
            raise broker_error(
                "LIVE_SHADOW_NOT_FOUND",
                "shadow order reference is unavailable",
            )
        return record

    def begin_reconcile(
        self,
        shadow_ref: str,
        *,
        account_ref: str,
        account: AccountBinding,
    ) -> ShadowOrderRecord:
        record = self.describe(shadow_ref)
        if (
            record.state not in _NONTERMINAL_RECONCILE_STATES
            or record.reconcile_attempt_count >= MAX_RECONCILE_ATTEMPTS
        ):
            raise broker_error(
                "LIVE_SHADOW_RECONCILE_REJECTED",
                "shadow order cannot enter another reconciliation query",
            )
        if (
            record.account_handle_sha256 != _sha256_text(account_ref)
            or record.canonical_account_sha256
            != account.canonical_account_sha256
            or record.plugin_id != account.plugin_id
            or record.connector_id != account.connector_id
            or record.publisher_identity != account.publisher_identity
        ):
            raise broker_error(
                "LIVE_SHADOW_ACCOUNT_MISMATCH",
                "shadow order is not bound to this canonical account",
            )
        occurred_at = _utc_now()
        attempt = record.reconcile_attempt_count + 1
        with self._transaction():
            self.connection.execute(
                """
                UPDATE shadow_order
                SET state = 'querying',
                    credential_handle_sha256 = ?,
                    version = ?,
                    reconcile_attempt_count = ?,
                    updated_at = ?
                WHERE record_id = ?
                """,
                (
                    account.credential_handle_sha256,
                    account.version,
                    attempt,
                    occurred_at,
                    record.record_id,
                ),
            )
            self._append_event(
                record.record_id,
                "reconcile-started",
                {"attempt": attempt, "state": "querying"},
                occurred_at,
            )
        return self.describe(shadow_ref)

    def complete_reconcile(
        self,
        shadow_ref: str,
        proof: OrderQueryProof,
    ) -> ShadowOrderRecord:
        record = self.describe(shadow_ref)
        if record.state != "querying":
            raise broker_error(
                "LIVE_SHADOW_RECONCILE_REJECTED",
                "shadow order is not awaiting a query result",
                fatal=True,
            )
        if (
            proof.connector_id != record.connector_id
            or proof.instrument_id != record.instrument_id
            or proof.client_order_id != record.client_order_id
            or (
                record.venue_order_id is not None
                and proof.venue_order_id != record.venue_order_id
            )
            or Decimal(proof.accumulated_fill_size)
            < Decimal(record.accumulated_fill_size)
            or Decimal(proof.accumulated_fill_size)
            > Decimal(record.quantity)
            or (
                record.state == "partially_filled"
                and proof.state == "live"
            )
        ):
            self.fail_reconcile(
                shadow_ref,
                error_code="LIVE_SHADOW_QUERY_MISMATCH",
            )
            raise broker_error(
                "LIVE_SHADOW_QUERY_MISMATCH",
                "query result does not match the durable shadow identity",
                fatal=True,
            )
        with self._transaction():
            self.connection.execute(
                """
                UPDATE shadow_order
                SET state = ?,
                    venue_order_id = ?,
                    accumulated_fill_size = ?,
                    average_price = ?,
                    updated_at = ?
                WHERE record_id = ?
                """,
                (
                    proof.state,
                    proof.venue_order_id,
                    proof.accumulated_fill_size,
                    proof.average_price,
                    proof.observed_at,
                    record.record_id,
                ),
            )
            self._append_event(
                record.record_id,
                "reconcile-observed",
                {
                    "attempt": record.reconcile_attempt_count,
                    "state": proof.state,
                    "venueOrderIdSha256": _sha256_text(
                        proof.venue_order_id
                    ),
                },
                proof.observed_at,
            )
        return self.describe(shadow_ref)

    def fail_reconcile(
        self,
        shadow_ref: str,
        *,
        error_code: str,
    ) -> ShadowOrderRecord:
        record = self.describe(shadow_ref)
        if record.state != "querying":
            return record
        if (
            not isinstance(error_code, str)
            or _ERROR_CODE.fullmatch(error_code) is None
        ):
            error_code = "LIVE_SHADOW_QUERY_FAILED"
        occurred_at = _utc_now()
        with self._transaction():
            self.connection.execute(
                """
                UPDATE shadow_order
                SET state = 'unknown', updated_at = ?
                WHERE record_id = ?
                """,
                (occurred_at, record.record_id),
            )
            self._append_event(
                record.record_id,
                "reconcile-failed",
                {
                    "attempt": record.reconcile_attempt_count,
                    "errorCode": error_code,
                    "state": "unknown",
                },
                occurred_at,
            )
        return self.describe(shadow_ref)

    def _recover_interrupted_queries(self) -> None:
        rows = tuple(
            self.connection.execute(
                """
                SELECT record_id, reconcile_attempt_count
                FROM shadow_order
                WHERE state = 'querying'
                ORDER BY record_id
                """
            )
        )
        for row in rows:
            occurred_at = _utc_now()
            with self._transaction():
                self.connection.execute(
                    """
                    UPDATE shadow_order
                    SET state = 'unknown', updated_at = ?
                    WHERE record_id = ? AND state = 'querying'
                    """,
                    (occurred_at, row["record_id"]),
                )
                self._append_event(
                    row["record_id"],
                    "reconcile-recovered-unknown",
                    {
                        "attempt": row["reconcile_attempt_count"],
                        "state": "unknown",
                    },
                    occurred_at,
                )

    def summary(self) -> dict[str, int]:
        row = self.connection.execute(
            """
            SELECT
                COUNT(*) AS journal_count,
                SUM(
                    CASE
                        WHEN state IN ('prepared', 'querying', 'unknown',
                                       'live', 'partially_filled')
                        THEN 1 ELSE 0
                    END
                ) AS unresolved_count
            FROM shadow_order
            """
        ).fetchone()
        return {
            "journalCount": int(row["journal_count"]),
            "unresolvedCount": int(row["unresolved_count"] or 0),
        }

    def close(self) -> None:
        try:
            self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            self.connection.close()
