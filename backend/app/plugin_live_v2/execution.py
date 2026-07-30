"""Crash-consistent WP-F Demo execution ledger and fixed risk envelope."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator, Protocol

from .accounts import OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
from .errors import LiveBrokerError, broker_error
from .shadow import (
    ORDER_QUERY_STATES,
    OrderQueryProof,
    ShadowOrderIntent,
    canonical_positive_decimal,
)


LIVE_EXECUTION_SCHEMA_VERSION = 1
LIVE_EXECUTION_FILENAME = "live-execution-v1.sqlite3"
LIVE_EXECUTION_STATUS_SCHEMA = "candlescope.live-execution-status/1"
LIVE_EXECUTION_RECORD_SCHEMA = "candlescope.live-execution-record/1"
MAX_EXECUTION_ORDERS = 10_000
MAX_EXECUTION_EVENTS = 100_000
MAX_CANCEL_ATTEMPTS = 10
DEMO_EXECUTION_INSTRUMENT = "BTC-USDT"
MAX_DEMO_ORDER_NOTIONAL = Decimal("100")
MAX_DEMO_UNRESOLVED_NOTIONAL = Decimal("200")
MAX_DEMO_UNRESOLVED_ORDERS = 2

EXECUTION_STATES = frozenset(
    {
        "submitting",
        "unknown",
        "rejected",
        "live",
        "partially_filled",
        "filled",
        "canceled",
        "mmp_canceled",
        "canceling",
        "cancel_unknown",
    }
)
TERMINAL_EXECUTION_STATES = frozenset(
    {"rejected", "filled", "canceled", "mmp_canceled"}
)
UNRESOLVED_EXECUTION_STATES = EXECUTION_STATES - TERMINAL_EXECUTION_STATES
_CANCEL_SOURCE_STATES = frozenset({"live", "partially_filled"})
_DISPATCH_STATES = frozenset({"submitting", "canceling"})
_HEX_32 = re.compile(r"^[0-9a-f]{32}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_HANDLE = re.compile(r"^shdw_[A-Za-z0-9_-]{43}$")
_CLIENT_ORDER_ID = re.compile(r"^[A-Za-z0-9]{32}$")
_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
_VENUE_CODE = re.compile(r"^[0-9A-Z_-]{1,32}$")
_EVENT_TYPES = frozenset(
    {
        "submit-started",
        "submit-acknowledged",
        "submit-rejected",
        "submit-failed",
        "submit-recovered-unknown",
        "query-observed",
        "query-failed",
        "cancel-started",
        "cancel-acknowledged",
        "cancel-rejected",
        "cancel-failed",
        "cancel-recovered-unknown",
    }
)
_EXPECTED_COLUMNS = {
    "execution_meta": (
        ("singleton", "INTEGER", 0, 1),
        ("schema_version", "INTEGER", 1, 0),
        ("broker_id", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "execution_order": (
        ("record_id", "TEXT", 1, 1),
        ("shadow_handle_sha256", "TEXT", 1, 0),
        ("account_handle_sha256", "TEXT", 1, 0),
        ("canonical_account_sha256", "TEXT", 1, 0),
        ("credential_handle_sha256", "TEXT", 1, 0),
        ("plugin_id", "TEXT", 1, 0),
        ("connector_id", "TEXT", 1, 0),
        ("publisher_identity", "TEXT", 1, 0),
        ("version", "TEXT", 1, 0),
        ("client_order_id", "TEXT", 1, 0),
        ("order_intent_sha256", "TEXT", 1, 0),
        ("instrument_id", "TEXT", 1, 0),
        ("side", "TEXT", 1, 0),
        ("order_type", "TEXT", 1, 0),
        ("quantity", "TEXT", 1, 0),
        ("limit_price", "TEXT", 1, 0),
        ("notional", "TEXT", 1, 0),
        ("state", "TEXT", 1, 0),
        ("prior_state", "TEXT", 0, 0),
        ("submit_attempt_count", "INTEGER", 1, 0),
        ("cancel_attempt_count", "INTEGER", 1, 0),
        ("venue_order_id_sha256", "TEXT", 0, 0),
        ("last_receipt_id", "TEXT", 1, 0),
        ("last_confirmation_sha256", "TEXT", 1, 0),
        ("last_risk_decision_sha256", "TEXT", 1, 0),
        ("last_error_code", "TEXT", 0, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
        ("policy_epoch", "INTEGER", 1, 0),
        ("control_generation", "INTEGER", 1, 0),
    ),
    "execution_event": (
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
    "execution_meta": set(),
    "execution_order": {
        ("record_id",),
        ("shadow_handle_sha256",),
        ("client_order_id",),
    },
    "execution_event": {("event_sha256",)},
}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError("execution timestamp is invalid")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("execution timestamp is invalid")
    return parsed.astimezone(UTC)


def _sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _canonical_decimal(value: Decimal) -> str:
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def _digest(value: str, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} is invalid")
    return value


def _error_code(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or _ERROR_CODE.fullmatch(value) is None:
        raise ValueError("execution error code is invalid")
    return value


@dataclass(frozen=True, slots=True)
class ExecutionMutationProof:
    """Transient, operation-specific acknowledgement; raw venue ID is not stored."""

    action: str
    accepted: bool
    instrument_id: str
    client_order_id: str
    venue_order_id: str | None
    venue_code: str
    observed_at: str

    def __post_init__(self) -> None:
        if (
            self.action not in {"submit", "cancel"}
            or not isinstance(self.accepted, bool)
            or self.instrument_id != DEMO_EXECUTION_INSTRUMENT
            or not isinstance(self.client_order_id, str)
            or _CLIENT_ORDER_ID.fullmatch(self.client_order_id) is None
            or not isinstance(self.venue_code, str)
            or _VENUE_CODE.fullmatch(self.venue_code) is None
        ):
            raise ValueError("execution mutation proof is invalid")
        if self.accepted:
            if (
                not isinstance(self.venue_order_id, str)
                or re.fullmatch(r"[0-9]{1,32}", self.venue_order_id) is None
                or self.venue_code != "0"
            ):
                raise ValueError("accepted execution proof is invalid")
        elif self.venue_order_id not in {None, ""}:
            raise ValueError("rejected execution proof contains venue identity")
        _parse_timestamp(self.observed_at)


class DemoSpotExecutionConnector(Protocol):
    connector_id: str
    network_method_count: int

    def submit(
        self,
        secret: bytearray,
        *,
        intent: ShadowOrderIntent,
        client_order_id: str,
    ) -> ExecutionMutationProof: ...

    def cancel(
        self,
        secret: bytearray,
        *,
        instrument_id: str,
        client_order_id: str,
    ) -> ExecutionMutationProof: ...


@dataclass(frozen=True, slots=True)
class LiveExecutionRecord:
    record_id: str
    shadow_handle_sha256: str
    account_handle_sha256: str
    canonical_account_sha256: str
    credential_handle_sha256: str
    plugin_id: str
    connector_id: str
    publisher_identity: str
    version: str
    client_order_id: str
    order_intent_sha256: str
    instrument_id: str
    side: str
    order_type: str
    quantity: str
    limit_price: str
    notional: str
    state: str
    prior_state: str | None
    submit_attempt_count: int
    cancel_attempt_count: int
    venue_order_id_sha256: str | None
    last_receipt_id: str
    last_confirmation_sha256: str
    last_risk_decision_sha256: str
    last_error_code: str | None
    created_at: str
    updated_at: str
    policy_epoch: int
    control_generation: int

    def __post_init__(self) -> None:
        digests = (
            self.shadow_handle_sha256,
            self.account_handle_sha256,
            self.canonical_account_sha256,
            self.credential_handle_sha256,
            self.order_intent_sha256,
            self.last_confirmation_sha256,
            self.last_risk_decision_sha256,
        )
        if (
            _HEX_32.fullmatch(self.record_id) is None
            or any(_SHA256.fullmatch(value) is None for value in digests)
            or _ID.fullmatch(self.plugin_id) is None
            or self.connector_id != OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
            or not self.publisher_identity
            or len(self.publisher_identity) > 256
            or not self.version
            or len(self.version) > 64
            or _CLIENT_ORDER_ID.fullmatch(self.client_order_id) is None
            or self.instrument_id != DEMO_EXECUTION_INSTRUMENT
            or self.side not in {"buy", "sell"}
            or self.order_type != "limit"
            or self.state not in EXECUTION_STATES
            or (
                self.prior_state is not None
                and self.prior_state not in _CANCEL_SOURCE_STATES
            )
            or isinstance(self.submit_attempt_count, bool)
            or self.submit_attempt_count != 1
            or isinstance(self.cancel_attempt_count, bool)
            or not 0 <= self.cancel_attempt_count <= MAX_CANCEL_ATTEMPTS
            or _HEX_32.fullmatch(self.last_receipt_id) is None
            or isinstance(self.policy_epoch, bool)
            or not isinstance(self.policy_epoch, int)
            or self.policy_epoch < 0
            or isinstance(self.control_generation, bool)
            or not isinstance(self.control_generation, int)
            or self.control_generation < 0
        ):
            raise ValueError("execution record metadata is invalid")
        canonical_positive_decimal(self.quantity, "execution quantity")
        canonical_positive_decimal(self.limit_price, "execution limit price")
        canonical_positive_decimal(self.notional, "execution notional")
        if (
            Decimal(self.quantity) * Decimal(self.limit_price) != Decimal(self.notional)
            or Decimal(self.notional) > MAX_DEMO_ORDER_NOTIONAL
        ):
            raise ValueError("execution notional is invalid")
        if self.venue_order_id_sha256 is not None:
            _digest(self.venue_order_id_sha256, "venue order digest")
        if self.state in ORDER_QUERY_STATES and self.venue_order_id_sha256 is None:
            raise ValueError("query-proven execution state lacks venue identity")
        if self.state in {"canceling", "cancel_unknown"} and (
            self.prior_state not in _CANCEL_SOURCE_STATES
            or self.venue_order_id_sha256 is None
        ):
            raise ValueError("cancel execution projection is invalid")
        if (
            self.state not in {"canceling", "cancel_unknown"}
            and self.prior_state is not None
        ):
            raise ValueError("execution prior state is unexpected")
        _error_code(self.last_error_code)
        _parse_timestamp(self.created_at)
        _parse_timestamp(self.updated_at)

    def public_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": LIVE_EXECUTION_RECORD_SCHEMA,
            "pluginId": self.plugin_id,
            "connectorId": self.connector_id,
            "publisherIdentity": self.publisher_identity,
            "version": self.version,
            "clientOrderId": self.client_order_id,
            "orderIntentSha256": self.order_intent_sha256,
            "instrumentId": self.instrument_id,
            "side": self.side,
            "orderType": self.order_type,
            "quantity": self.quantity,
            "limitPrice": self.limit_price,
            "notional": self.notional,
            "state": self.state,
            "priorState": self.prior_state,
            "submitAttemptCount": self.submit_attempt_count,
            "cancelAttemptCount": self.cancel_attempt_count,
            "venueOrderIdSha256": self.venue_order_id_sha256,
            "lastReceiptId": self.last_receipt_id,
            "lastConfirmationSha256": self.last_confirmation_sha256,
            "lastRiskDecisionSha256": self.last_risk_decision_sha256,
            "lastErrorCode": self.last_error_code,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "policyEpoch": self.policy_epoch,
            "controlGeneration": self.control_generation,
            "terminal": self.state in TERMINAL_EXECUTION_STATES,
            "reconciliationRequired": self.state in {"unknown", "cancel_unknown"},
        }


def execution_risk_decision(
    *,
    instrument_id: str,
    side: str,
    order_type: str,
    quantity: str,
    limit_price: str,
    unresolved_count: int,
    unresolved_notional: Decimal,
) -> tuple[str, str]:
    """Apply the fixed Demo risk envelope and return notional plus its digest."""

    if (
        instrument_id != DEMO_EXECUTION_INSTRUMENT
        or side not in {"buy", "sell"}
        or order_type != "limit"
    ):
        raise broker_error(
            "LIVE_EXECUTION_RISK_REJECTED",
            "Demo execution is outside the fixed Spot limit scope",
        )
    canonical_positive_decimal(quantity, "execution quantity")
    canonical_positive_decimal(limit_price, "execution limit price")
    notional_value = Decimal(quantity) * Decimal(limit_price)
    notional = _canonical_decimal(notional_value)
    if (
        notional_value <= 0
        or notional_value > MAX_DEMO_ORDER_NOTIONAL
        or isinstance(unresolved_count, bool)
        or not isinstance(unresolved_count, int)
        or unresolved_count >= MAX_DEMO_UNRESOLVED_ORDERS
        or unresolved_notional + notional_value > MAX_DEMO_UNRESOLVED_NOTIONAL
    ):
        raise broker_error(
            "LIVE_EXECUTION_RISK_REJECTED",
            "Demo execution exceeds the fixed risk envelope",
            details={
                "maxOrderNotional": _canonical_decimal(MAX_DEMO_ORDER_NOTIONAL),
                "maxUnresolvedOrders": MAX_DEMO_UNRESOLVED_ORDERS,
                "maxUnresolvedNotional": _canonical_decimal(
                    MAX_DEMO_UNRESOLVED_NOTIONAL
                ),
            },
        )
    decision = {
        "schemaVersion": "candlescope.live-demo-risk/1",
        "allow": True,
        "environment": "demo",
        "instrumentId": instrument_id,
        "tradeMode": "cash",
        "side": side,
        "orderType": order_type,
        "quantity": quantity,
        "limitPrice": limit_price,
        "notional": notional,
        "maxOrderNotional": _canonical_decimal(MAX_DEMO_ORDER_NOTIONAL),
        "maxUnresolvedOrders": MAX_DEMO_UNRESOLVED_ORDERS,
        "maxUnresolvedNotional": _canonical_decimal(MAX_DEMO_UNRESOLVED_NOTIONAL),
        "unresolvedCountBefore": unresolved_count,
        "unresolvedNotionalBefore": _canonical_decimal(unresolved_notional),
    }
    return notional, _sha256_text(_canonical_json(decision))


class LiveExecutionLedger:
    """Own the WP-F persist-before-send projection and event chain."""

    def __init__(self, root: Path | str, *, broker_id: str) -> None:
        if not isinstance(broker_id, str) or _HEX_32.fullmatch(broker_id) is None:
            raise ValueError("broker_id is invalid")
        self.root = Path(root).expanduser().resolve(strict=False)
        self.path = self.root / LIVE_EXECUTION_FILENAME
        self.broker_id = broker_id
        for path in (
            self.path,
            self.path.with_name(f"{self.path.name}-wal"),
            self.path.with_name(f"{self.path.name}-shm"),
        ):
            if path.is_symlink() or (path.exists() and not path.is_file()):
                raise broker_error(
                    "LIVE_EXECUTION_LEDGER_PATH_UNSAFE",
                    "execution ledger path is unsafe",
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
            mode = self.connection.execute("PRAGMA journal_mode=WAL").fetchone()
            if mode is None or str(mode[0]).casefold() != "wal":
                raise sqlite3.DatabaseError("WAL mode was not enabled")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA trusted_schema=OFF")
            self._initialize_or_validate()
            self._recover_interrupted_dispatch()
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
                "LIVE_EXECUTION_LEDGER_INVALID",
                "execution ledger failed validation",
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
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                """
            )
        }
        if not tables:
            self._create_schema()
        elif tables != {
            "execution_meta",
            "execution_order",
            "execution_event",
        }:
            raise ValueError("execution ledger tables are invalid")
        self._validate_schema()
        quick = self.connection.execute("PRAGMA quick_check").fetchone()
        if quick is None or quick[0] != "ok":
            raise ValueError("execution ledger quick_check failed")
        if tuple(self.connection.execute("PRAGMA foreign_key_check")):
            raise ValueError("execution ledger foreign keys are invalid")
        version = self.connection.execute("PRAGMA user_version").fetchone()
        if version is None or version[0] != LIVE_EXECUTION_SCHEMA_VERSION:
            raise ValueError("execution ledger version is unsupported")
        meta = self.connection.execute(
            """
            SELECT schema_version, broker_id FROM execution_meta
            WHERE singleton = 1
            """
        ).fetchone()
        if (
            meta is None
            or meta["schema_version"] != LIVE_EXECUTION_SCHEMA_VERSION
            or meta["broker_id"] != self.broker_id
            or self.connection.execute(
                "SELECT COUNT(*) FROM execution_meta"
            ).fetchone()[0]
            != 1
        ):
            raise ValueError("execution ledger broker metadata is invalid")
        if (
            self.connection.execute("SELECT COUNT(*) FROM execution_order").fetchone()[
                0
            ]
            > MAX_EXECUTION_ORDERS
            or self.connection.execute(
                "SELECT COUNT(*) FROM execution_event"
            ).fetchone()[0]
            > MAX_EXECUTION_EVENTS
        ):
            raise ValueError("execution ledger limits are exceeded")
        for row in self.connection.execute(
            "SELECT * FROM execution_order ORDER BY record_id"
        ):
            self._record(row)
        self._validate_event_chain()

    def _validate_schema(self) -> None:
        unexpected = tuple(
            self.connection.execute(
                """
                SELECT type, name FROM sqlite_master
                WHERE type IN ('view', 'trigger')
                   OR (type = 'index' AND sql IS NOT NULL)
                """
            )
        )
        if unexpected:
            raise ValueError("execution ledger schema objects are invalid")
        for table, expected in _EXPECTED_COLUMNS.items():
            metadata = self.connection.execute(
                """
                SELECT ncol, wr, strict FROM pragma_table_list
                WHERE schema = 'main' AND name = ?
                """,
                (table,),
            ).fetchone()
            if (
                metadata is None
                or metadata["ncol"] != len(expected)
                or metadata["wr"] != 0
                or metadata["strict"] != 1
            ):
                raise ValueError("execution ledger table mode is invalid")
            actual = tuple(
                (
                    row["name"],
                    row["type"],
                    row["notnull"],
                    row["pk"],
                )
                for row in self.connection.execute(f"PRAGMA table_info({table})")
            )
            if actual != expected:
                raise ValueError("execution ledger columns are invalid")
            unique_columns: set[tuple[str, ...]] = set()
            for index in self.connection.execute(f"PRAGMA index_list({table})"):
                if index["unique"] != 1 or index["partial"] != 0:
                    raise ValueError("execution ledger indexes are invalid")
                unique_columns.add(
                    tuple(
                        item["name"]
                        for item in self.connection.execute(
                            """
                            SELECT name FROM pragma_index_info(?)
                            ORDER BY seqno
                            """,
                            (index["name"],),
                        )
                    )
                )
            if unique_columns != _EXPECTED_UNIQUE_INDEX_COLUMNS[table]:
                raise ValueError("execution ledger unique indexes are invalid")
        foreign_keys = tuple(
            tuple(row)
            for row in self.connection.execute(
                "PRAGMA foreign_key_list(execution_event)"
            )
        )
        if foreign_keys != (
            (
                0,
                0,
                "execution_order",
                "record_id",
                "record_id",
                "NO ACTION",
                "NO ACTION",
                "NONE",
            ),
        ):
            raise ValueError("execution ledger foreign key is invalid")

    def _create_schema(self) -> None:
        with self._transaction():
            for statement in (
                """
                CREATE TABLE execution_meta (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    schema_version INTEGER NOT NULL,
                    broker_id TEXT NOT NULL,
                    created_at TEXT NOT NULL
                ) STRICT
                """,
                """
                CREATE TABLE execution_order (
                    record_id TEXT PRIMARY KEY,
                    shadow_handle_sha256 TEXT NOT NULL UNIQUE,
                    account_handle_sha256 TEXT NOT NULL,
                    canonical_account_sha256 TEXT NOT NULL,
                    credential_handle_sha256 TEXT NOT NULL,
                    plugin_id TEXT NOT NULL,
                    connector_id TEXT NOT NULL,
                    publisher_identity TEXT NOT NULL,
                    version TEXT NOT NULL,
                    client_order_id TEXT NOT NULL UNIQUE,
                    order_intent_sha256 TEXT NOT NULL,
                    instrument_id TEXT NOT NULL,
                    side TEXT NOT NULL,
                    order_type TEXT NOT NULL,
                    quantity TEXT NOT NULL,
                    limit_price TEXT NOT NULL,
                    notional TEXT NOT NULL,
                    state TEXT NOT NULL,
                    prior_state TEXT,
                    submit_attempt_count INTEGER NOT NULL,
                    cancel_attempt_count INTEGER NOT NULL,
                    venue_order_id_sha256 TEXT,
                    last_receipt_id TEXT NOT NULL,
                    last_confirmation_sha256 TEXT NOT NULL,
                    last_risk_decision_sha256 TEXT NOT NULL,
                    last_error_code TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    policy_epoch INTEGER NOT NULL,
                    control_generation INTEGER NOT NULL
                ) STRICT
                """,
                """
                CREATE TABLE execution_event (
                    sequence INTEGER PRIMARY KEY,
                    record_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    previous_sha256 TEXT,
                    event_sha256 TEXT NOT NULL UNIQUE,
                    FOREIGN KEY(record_id) REFERENCES execution_order(record_id)
                ) STRICT
                """,
            ):
                self.connection.execute(statement)
            now = _utc_now()
            self.connection.execute(
                """
                INSERT INTO execution_meta(
                    singleton, schema_version, broker_id, created_at
                ) VALUES(1, ?, ?, ?)
                """,
                (LIVE_EXECUTION_SCHEMA_VERSION, self.broker_id, now),
            )
            self.connection.execute(
                f"PRAGMA user_version={LIVE_EXECUTION_SCHEMA_VERSION}"
            )

    @staticmethod
    def _record(row: sqlite3.Row) -> LiveExecutionRecord:
        return LiveExecutionRecord(
            record_id=row["record_id"],
            shadow_handle_sha256=row["shadow_handle_sha256"],
            account_handle_sha256=row["account_handle_sha256"],
            canonical_account_sha256=row["canonical_account_sha256"],
            credential_handle_sha256=row["credential_handle_sha256"],
            plugin_id=row["plugin_id"],
            connector_id=row["connector_id"],
            publisher_identity=row["publisher_identity"],
            version=row["version"],
            client_order_id=row["client_order_id"],
            order_intent_sha256=row["order_intent_sha256"],
            instrument_id=row["instrument_id"],
            side=row["side"],
            order_type=row["order_type"],
            quantity=row["quantity"],
            limit_price=row["limit_price"],
            notional=row["notional"],
            state=row["state"],
            prior_state=row["prior_state"],
            submit_attempt_count=row["submit_attempt_count"],
            cancel_attempt_count=row["cancel_attempt_count"],
            venue_order_id_sha256=row["venue_order_id_sha256"],
            last_receipt_id=row["last_receipt_id"],
            last_confirmation_sha256=row["last_confirmation_sha256"],
            last_risk_decision_sha256=row["last_risk_decision_sha256"],
            last_error_code=row["last_error_code"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            policy_epoch=row["policy_epoch"],
            control_generation=row["control_generation"],
        )

    def _validate_event_chain(self) -> None:
        records = {
            row["record_id"]: self._record(row)
            for row in self.connection.execute(
                "SELECT * FROM execution_order ORDER BY record_id"
            )
        }
        projected: dict[
            str,
            tuple[
                str,
                str | None,
                int,
                int,
                str | None,
                str,
                str,
                str,
                str | None,
            ],
        ] = {}
        previous: str | None = None
        expected_sequence = 1
        for row in self.connection.execute(
            "SELECT * FROM execution_event ORDER BY sequence"
        ):
            if (
                row["sequence"] != expected_sequence
                or row["event_type"] not in _EVENT_TYPES
                or row["previous_sha256"] != previous
                or row["record_id"] not in records
            ):
                raise ValueError("execution event sequence is invalid")
            try:
                payload = json.loads(row["payload_json"])
            except (json.JSONDecodeError, UnicodeError) as exc:
                raise ValueError("execution event payload is invalid") from exc
            if (
                not isinstance(payload, dict)
                or _canonical_json(payload) != row["payload_json"]
            ):
                raise ValueError("execution event payload is not canonical")
            current = projected.get(row["record_id"])
            next_projection = self._project_event(
                row["event_type"],
                payload,
                current,
            )
            body = {
                "schemaVersion": LIVE_EXECUTION_SCHEMA_VERSION,
                "sequence": row["sequence"],
                "recordId": row["record_id"],
                "eventType": row["event_type"],
                "payload": payload,
                "occurredAt": row["occurred_at"],
                "previousSha256": previous,
            }
            actual = _sha256_text(_canonical_json(body))
            if row["event_sha256"] != actual:
                raise ValueError("execution event hash is invalid")
            projected[row["record_id"]] = next_projection
            previous = actual
            expected_sequence += 1
        if set(projected) != set(records):
            raise ValueError("execution event projection is incomplete")
        for record_id, record in records.items():
            expected = (
                record.state,
                record.prior_state,
                record.submit_attempt_count,
                record.cancel_attempt_count,
                record.venue_order_id_sha256,
                record.last_receipt_id,
                record.last_confirmation_sha256,
                record.last_risk_decision_sha256,
                record.last_error_code,
            )
            if projected[record_id] != expected:
                raise ValueError("execution event projection is inconsistent")

    @staticmethod
    def _project_event(
        event_type: str,
        payload: dict[str, Any],
        current: tuple[
            str,
            str | None,
            int,
            int,
            str | None,
            str,
            str,
            str,
            str | None,
        ]
        | None,
    ) -> tuple[
        str,
        str | None,
        int,
        int,
        str | None,
        str,
        str,
        str,
        str | None,
    ]:
        if event_type == "submit-started":
            expected = {
                "attempt",
                "state",
                "receiptId",
                "confirmationSha256",
                "riskDecisionSha256",
            }
            if (
                set(payload) != expected
                or current is not None
                or payload["attempt"] != 1
                or payload["state"] != "submitting"
                or not isinstance(payload["receiptId"], str)
                or _HEX_32.fullmatch(payload["receiptId"]) is None
                or _SHA256.fullmatch(payload["confirmationSha256"]) is None
                or _SHA256.fullmatch(payload["riskDecisionSha256"]) is None
            ):
                raise ValueError("submit start event is invalid")
            return (
                "submitting",
                None,
                1,
                0,
                None,
                payload["receiptId"],
                payload["confirmationSha256"],
                payload["riskDecisionSha256"],
                None,
            )
        if current is None:
            raise ValueError("execution event lacks a start")
        (
            state,
            prior,
            submits,
            cancels,
            venue_digest,
            receipt_id,
            confirmation_digest,
            risk_digest,
            _last_error,
        ) = current
        if event_type == "submit-acknowledged":
            if (
                set(payload) != {"attempt", "state", "venueOrderIdSha256"}
                or state != "submitting"
                or payload["attempt"] != submits
                or payload["state"] != "unknown"
                or _SHA256.fullmatch(payload["venueOrderIdSha256"]) is None
            ):
                raise ValueError("submit acknowledgement event is invalid")
            return (
                "unknown",
                None,
                submits,
                cancels,
                payload["venueOrderIdSha256"],
                receipt_id,
                confirmation_digest,
                risk_digest,
                None,
            )
        if event_type == "submit-rejected":
            if (
                set(payload) != {"attempt", "state", "venueCode"}
                or state != "submitting"
                or payload["attempt"] != submits
                or payload["state"] != "rejected"
                or _VENUE_CODE.fullmatch(payload["venueCode"]) is None
            ):
                raise ValueError("submit rejection event is invalid")
            return (
                "rejected",
                None,
                submits,
                cancels,
                None,
                receipt_id,
                confirmation_digest,
                risk_digest,
                None,
            )
        if event_type in {"submit-failed", "submit-recovered-unknown"}:
            expected = (
                {"attempt", "state", "errorCode"}
                if event_type == "submit-failed"
                else {"attempt", "state"}
            )
            if (
                set(payload) != expected
                or state != "submitting"
                or payload["attempt"] != submits
                or payload["state"] != "unknown"
                or (
                    event_type == "submit-failed"
                    and _ERROR_CODE.fullmatch(payload["errorCode"]) is None
                )
            ):
                raise ValueError("submit failure/recovery event is invalid")
            return (
                "unknown",
                None,
                submits,
                cancels,
                venue_digest,
                receipt_id,
                confirmation_digest,
                risk_digest,
                (payload["errorCode"] if event_type == "submit-failed" else None),
            )
        if event_type == "query-observed":
            if (
                set(payload) != {"state", "venueOrderIdSha256"}
                or state in TERMINAL_EXECUTION_STATES
                or payload["state"] not in ORDER_QUERY_STATES
                or _SHA256.fullmatch(payload["venueOrderIdSha256"]) is None
            ):
                raise ValueError("execution query observation is invalid")
            return (
                payload["state"],
                None,
                submits,
                cancels,
                payload["venueOrderIdSha256"],
                receipt_id,
                confirmation_digest,
                risk_digest,
                None,
            )
        if event_type == "query-failed":
            if (
                set(payload) != {"state", "errorCode"}
                or state in TERMINAL_EXECUTION_STATES
                or payload["state"] not in {"unknown", "cancel_unknown"}
                or _ERROR_CODE.fullmatch(payload["errorCode"]) is None
            ):
                raise ValueError("execution query failure is invalid")
            next_prior = prior if payload["state"] == "cancel_unknown" else None
            return (
                payload["state"],
                next_prior,
                submits,
                cancels,
                venue_digest,
                receipt_id,
                confirmation_digest,
                risk_digest,
                payload["errorCode"],
            )
        if event_type == "cancel-started":
            if (
                set(payload)
                != {
                    "attempt",
                    "fromState",
                    "state",
                    "receiptId",
                    "confirmationSha256",
                    "riskDecisionSha256",
                }
                or state not in _CANCEL_SOURCE_STATES
                or payload["fromState"] != state
                or payload["attempt"] != cancels + 1
                or payload["state"] != "canceling"
                or _HEX_32.fullmatch(payload["receiptId"]) is None
                or _SHA256.fullmatch(payload["confirmationSha256"]) is None
                or _SHA256.fullmatch(payload["riskDecisionSha256"]) is None
            ):
                raise ValueError("cancel start event is invalid")
            return (
                "canceling",
                state,
                submits,
                cancels + 1,
                venue_digest,
                payload["receiptId"],
                payload["confirmationSha256"],
                payload["riskDecisionSha256"],
                None,
            )
        if event_type == "cancel-acknowledged":
            if (
                set(payload) != {"attempt", "state", "venueOrderIdSha256"}
                or state != "canceling"
                or payload["attempt"] != cancels
                or payload["state"] != "cancel_unknown"
                or _SHA256.fullmatch(payload["venueOrderIdSha256"]) is None
            ):
                raise ValueError("cancel acknowledgement event is invalid")
            return (
                "cancel_unknown",
                prior,
                submits,
                cancels,
                payload["venueOrderIdSha256"],
                receipt_id,
                confirmation_digest,
                risk_digest,
                None,
            )
        if event_type == "cancel-rejected":
            if (
                set(payload) != {"attempt", "state", "venueCode"}
                or state != "canceling"
                or payload["attempt"] != cancels
                or payload["state"] != prior
                or _VENUE_CODE.fullmatch(payload["venueCode"]) is None
            ):
                raise ValueError("cancel rejection event is invalid")
            assert prior is not None
            return (
                prior,
                None,
                submits,
                cancels,
                venue_digest,
                receipt_id,
                confirmation_digest,
                risk_digest,
                None,
            )
        if event_type in {"cancel-failed", "cancel-recovered-unknown"}:
            expected = (
                {"attempt", "state", "errorCode"}
                if event_type == "cancel-failed"
                else {"attempt", "state"}
            )
            if (
                set(payload) != expected
                or state != "canceling"
                or payload["attempt"] != cancels
                or payload["state"] != "cancel_unknown"
                or (
                    event_type == "cancel-failed"
                    and _ERROR_CODE.fullmatch(payload["errorCode"]) is None
                )
            ):
                raise ValueError("cancel failure/recovery event is invalid")
            return (
                "cancel_unknown",
                prior,
                submits,
                cancels,
                venue_digest,
                receipt_id,
                confirmation_digest,
                risk_digest,
                (payload["errorCode"] if event_type == "cancel-failed" else None),
            )
        raise ValueError("execution event type is invalid")

    def _append_event(
        self,
        record_id: str,
        event_type: str,
        payload: dict[str, Any],
        occurred_at: str,
    ) -> None:
        if event_type not in _EVENT_TYPES:
            raise ValueError("execution event type is invalid")
        if (
            self.connection.execute("SELECT COUNT(*) FROM execution_event").fetchone()[
                0
            ]
            >= MAX_EXECUTION_EVENTS
        ):
            raise broker_error(
                "LIVE_EXECUTION_EVENT_LIMIT",
                "execution event limit has been reached",
            )
        last = self.connection.execute(
            """
            SELECT sequence, event_sha256 FROM execution_event
            ORDER BY sequence DESC LIMIT 1
            """
        ).fetchone()
        sequence = 1 if last is None else last["sequence"] + 1
        previous = None if last is None else last["event_sha256"]
        body = {
            "schemaVersion": LIVE_EXECUTION_SCHEMA_VERSION,
            "sequence": sequence,
            "recordId": record_id,
            "eventType": event_type,
            "payload": payload,
            "occurredAt": occurred_at,
            "previousSha256": previous,
        }
        self.connection.execute(
            """
            INSERT INTO execution_event(
                sequence, record_id, event_type, payload_json, occurred_at,
                previous_sha256, event_sha256
            ) VALUES(?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sequence,
                record_id,
                event_type,
                _canonical_json(payload),
                occurred_at,
                previous,
                _sha256_text(_canonical_json(body)),
            ),
        )

    def _find(self, shadow_ref: str) -> LiveExecutionRecord | None:
        if not isinstance(shadow_ref, str) or _HANDLE.fullmatch(shadow_ref) is None:
            return None
        row = self.connection.execute(
            """
            SELECT * FROM execution_order
            WHERE shadow_handle_sha256 = ?
            """,
            (_sha256_text(shadow_ref),),
        ).fetchone()
        return None if row is None else self._record(row)

    def find(self, shadow_ref: str) -> LiveExecutionRecord | None:
        return self._find(shadow_ref)

    def describe(self, shadow_ref: str) -> LiveExecutionRecord:
        record = self._find(shadow_ref)
        if record is None:
            raise broker_error(
                "LIVE_EXECUTION_NOT_FOUND",
                "execution record is unavailable",
            )
        return record

    def unresolved_summary(self) -> tuple[int, Decimal]:
        rows = tuple(
            self.connection.execute(
                """
                SELECT notional FROM execution_order
                WHERE state NOT IN ('rejected', 'filled', 'canceled',
                                    'mmp_canceled')
                """
            )
        )
        return len(rows), sum(
            (Decimal(row["notional"]) for row in rows),
            Decimal(0),
        )

    def begin_submit(
        self,
        *,
        shadow_ref: str,
        account_ref: str,
        metadata: dict[str, Any],
        receipt_id: str,
        confirmation_sha256: str,
        risk_decision_sha256: str,
        notional: str,
    ) -> LiveExecutionRecord:
        required = {
            "canonicalAccountSha256",
            "credentialHandleSha256",
            "pluginId",
            "connectorId",
            "publisherIdentity",
            "version",
            "clientOrderId",
            "orderIntentSha256",
            "instrumentId",
            "side",
            "orderType",
            "quantity",
            "limitPrice",
            "policyEpoch",
            "controlGeneration",
        }
        if set(metadata) != required:
            raise ValueError("submit metadata shape is invalid")
        if self._find(shadow_ref) is not None:
            raise broker_error(
                "LIVE_EXECUTION_ALREADY_DISPATCHED",
                "this shadow already has a durable execution attempt",
            )
        if (
            self.connection.execute("SELECT COUNT(*) FROM execution_order").fetchone()[
                0
            ]
            >= MAX_EXECUTION_ORDERS
        ):
            raise broker_error(
                "LIVE_EXECUTION_ORDER_LIMIT",
                "execution order limit has been reached",
            )
        canonical_positive_decimal(notional, "execution notional")
        for value, label in (
            (confirmation_sha256, "confirmation"),
            (risk_decision_sha256, "risk decision"),
        ):
            _digest(value, label)
        if _HEX_32.fullmatch(receipt_id) is None:
            raise ValueError("execution receipt identity is invalid")
        record_id = hmac.digest(
            self.broker_id.encode("ascii"),
            b"execution-record-v1\0" + shadow_ref.encode("ascii"),
            hashlib.sha256,
        ).hex()[:32]
        occurred_at = _utc_now()
        with self._transaction():
            self.connection.execute(
                """
                INSERT INTO execution_order(
                    record_id, shadow_handle_sha256, account_handle_sha256,
                    canonical_account_sha256, credential_handle_sha256,
                    plugin_id, connector_id, publisher_identity, version,
                    client_order_id, order_intent_sha256, instrument_id,
                    side, order_type, quantity, limit_price, notional, state,
                    prior_state, submit_attempt_count, cancel_attempt_count,
                    venue_order_id_sha256, last_receipt_id,
                    last_confirmation_sha256, last_risk_decision_sha256,
                    last_error_code, created_at, updated_at, policy_epoch,
                    control_generation
                ) VALUES(
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'submitting', NULL, 1, 0, NULL, ?, ?, ?, NULL, ?, ?, ?, ?
                )
                """,
                (
                    record_id,
                    _sha256_text(shadow_ref),
                    _sha256_text(account_ref),
                    metadata["canonicalAccountSha256"],
                    metadata["credentialHandleSha256"],
                    metadata["pluginId"],
                    metadata["connectorId"],
                    metadata["publisherIdentity"],
                    metadata["version"],
                    metadata["clientOrderId"],
                    metadata["orderIntentSha256"],
                    metadata["instrumentId"],
                    metadata["side"],
                    metadata["orderType"],
                    metadata["quantity"],
                    metadata["limitPrice"],
                    notional,
                    receipt_id,
                    confirmation_sha256,
                    risk_decision_sha256,
                    occurred_at,
                    occurred_at,
                    metadata["policyEpoch"],
                    metadata["controlGeneration"],
                ),
            )
            self._append_event(
                record_id,
                "submit-started",
                {
                    "attempt": 1,
                    "state": "submitting",
                    "receiptId": receipt_id,
                    "confirmationSha256": confirmation_sha256,
                    "riskDecisionSha256": risk_decision_sha256,
                },
                occurred_at,
            )
        return self.describe(shadow_ref)

    def complete_submit(
        self,
        shadow_ref: str,
        proof: ExecutionMutationProof,
    ) -> LiveExecutionRecord:
        record = self.describe(shadow_ref)
        if (
            record.state != "submitting"
            or proof.action != "submit"
            or proof.instrument_id != record.instrument_id
            or proof.client_order_id != record.client_order_id
        ):
            raise broker_error(
                "LIVE_EXECUTION_SUBMIT_PROOF_REJECTED",
                "submit acknowledgement does not match the durable intent",
                fatal=True,
            )
        if proof.accepted:
            assert proof.venue_order_id is not None
            state = "unknown"
            venue_digest = _sha256_text(proof.venue_order_id)
            event_type = "submit-acknowledged"
            payload = {
                "attempt": record.submit_attempt_count,
                "state": state,
                "venueOrderIdSha256": venue_digest,
            }
        else:
            state = "rejected"
            venue_digest = None
            event_type = "submit-rejected"
            payload = {
                "attempt": record.submit_attempt_count,
                "state": state,
                "venueCode": proof.venue_code,
            }
        with self._transaction():
            self.connection.execute(
                """
                UPDATE execution_order
                SET state = ?, venue_order_id_sha256 = ?,
                    last_error_code = NULL, updated_at = ?
                WHERE record_id = ? AND state = 'submitting'
                """,
                (
                    state,
                    venue_digest,
                    proof.observed_at,
                    record.record_id,
                ),
            )
            self._append_event(
                record.record_id,
                event_type,
                payload,
                proof.observed_at,
            )
        return self.describe(shadow_ref)

    def fail_submit(
        self,
        shadow_ref: str,
        *,
        error_code: str,
    ) -> LiveExecutionRecord:
        record = self.describe(shadow_ref)
        if record.state != "submitting":
            return record
        if _ERROR_CODE.fullmatch(error_code) is None:
            error_code = "LIVE_EXECUTION_SUBMIT_FAILED"
        occurred_at = _utc_now()
        with self._transaction():
            self.connection.execute(
                """
                UPDATE execution_order
                SET state = 'unknown', prior_state = NULL,
                    last_error_code = ?, updated_at = ?
                WHERE record_id = ? AND state = 'submitting'
                """,
                (error_code, occurred_at, record.record_id),
            )
            self._append_event(
                record.record_id,
                "submit-failed",
                {
                    "attempt": record.submit_attempt_count,
                    "state": "unknown",
                    "errorCode": error_code,
                },
                occurred_at,
            )
        return self.describe(shadow_ref)

    def begin_cancel(
        self,
        shadow_ref: str,
        *,
        account_ref: str,
        credential_handle_sha256: str,
        version: str,
        receipt_id: str,
        confirmation_sha256: str,
        risk_decision_sha256: str,
        policy_epoch: int,
        control_generation: int,
    ) -> LiveExecutionRecord:
        record = self.describe(shadow_ref)
        if (
            record.state not in _CANCEL_SOURCE_STATES
            or record.cancel_attempt_count >= MAX_CANCEL_ATTEMPTS
            or record.account_handle_sha256 != _sha256_text(account_ref)
            or record.policy_epoch != policy_epoch
        ):
            raise broker_error(
                "LIVE_EXECUTION_CANCEL_REJECTED",
                "execution record cannot enter cancel dispatch",
            )
        _digest(credential_handle_sha256, "credential handle")
        _digest(confirmation_sha256, "confirmation")
        _digest(risk_decision_sha256, "risk decision")
        if (
            _HEX_32.fullmatch(receipt_id) is None
            or not isinstance(version, str)
            or not version
            or len(version) > 64
        ):
            raise ValueError("cancel metadata is invalid")
        occurred_at = _utc_now()
        attempt = record.cancel_attempt_count + 1
        with self._transaction():
            self.connection.execute(
                """
                UPDATE execution_order
                SET state = 'canceling', prior_state = ?,
                    credential_handle_sha256 = ?, version = ?,
                    cancel_attempt_count = ?, last_receipt_id = ?,
                    last_confirmation_sha256 = ?,
                    last_risk_decision_sha256 = ?,
                    last_error_code = NULL, updated_at = ?,
                    policy_epoch = ?, control_generation = ?
                WHERE record_id = ?
                """,
                (
                    record.state,
                    credential_handle_sha256,
                    version,
                    attempt,
                    receipt_id,
                    confirmation_sha256,
                    risk_decision_sha256,
                    occurred_at,
                    policy_epoch,
                    control_generation,
                    record.record_id,
                ),
            )
            self._append_event(
                record.record_id,
                "cancel-started",
                {
                    "attempt": attempt,
                    "fromState": record.state,
                    "state": "canceling",
                    "receiptId": receipt_id,
                    "confirmationSha256": confirmation_sha256,
                    "riskDecisionSha256": risk_decision_sha256,
                },
                occurred_at,
            )
        return self.describe(shadow_ref)

    def complete_cancel(
        self,
        shadow_ref: str,
        proof: ExecutionMutationProof,
    ) -> LiveExecutionRecord:
        record = self.describe(shadow_ref)
        if (
            record.state != "canceling"
            or record.prior_state not in _CANCEL_SOURCE_STATES
            or proof.action != "cancel"
            or proof.instrument_id != record.instrument_id
            or proof.client_order_id != record.client_order_id
        ):
            raise broker_error(
                "LIVE_EXECUTION_CANCEL_PROOF_REJECTED",
                "cancel acknowledgement does not match the durable order",
                fatal=True,
            )
        if proof.accepted:
            assert proof.venue_order_id is not None
            venue_digest = _sha256_text(proof.venue_order_id)
            if (
                record.venue_order_id_sha256 is not None
                and record.venue_order_id_sha256 != venue_digest
            ):
                raise broker_error(
                    "LIVE_EXECUTION_CANCEL_PROOF_REJECTED",
                    "cancel acknowledgement changed venue identity",
                    fatal=True,
                )
            state = "cancel_unknown"
            prior_state = record.prior_state
            event_type = "cancel-acknowledged"
            payload = {
                "attempt": record.cancel_attempt_count,
                "state": state,
                "venueOrderIdSha256": venue_digest,
            }
        else:
            venue_digest = record.venue_order_id_sha256
            state = record.prior_state
            prior_state = None
            event_type = "cancel-rejected"
            payload = {
                "attempt": record.cancel_attempt_count,
                "state": state,
                "venueCode": proof.venue_code,
            }
        with self._transaction():
            self.connection.execute(
                """
                UPDATE execution_order
                SET state = ?, prior_state = ?, venue_order_id_sha256 = ?,
                    last_error_code = NULL, updated_at = ?
                WHERE record_id = ? AND state = 'canceling'
                """,
                (
                    state,
                    prior_state,
                    venue_digest,
                    proof.observed_at,
                    record.record_id,
                ),
            )
            self._append_event(
                record.record_id,
                event_type,
                payload,
                proof.observed_at,
            )
        return self.describe(shadow_ref)

    def fail_cancel(
        self,
        shadow_ref: str,
        *,
        error_code: str,
    ) -> LiveExecutionRecord:
        record = self.describe(shadow_ref)
        if record.state != "canceling":
            return record
        if _ERROR_CODE.fullmatch(error_code) is None:
            error_code = "LIVE_EXECUTION_CANCEL_FAILED"
        occurred_at = _utc_now()
        with self._transaction():
            self.connection.execute(
                """
                UPDATE execution_order
                SET state = 'cancel_unknown', last_error_code = ?,
                    updated_at = ?
                WHERE record_id = ? AND state = 'canceling'
                """,
                (error_code, occurred_at, record.record_id),
            )
            self._append_event(
                record.record_id,
                "cancel-failed",
                {
                    "attempt": record.cancel_attempt_count,
                    "state": "cancel_unknown",
                    "errorCode": error_code,
                },
                occurred_at,
            )
        return self.describe(shadow_ref)

    def observe_query(
        self,
        shadow_ref: str,
        proof: OrderQueryProof,
    ) -> LiveExecutionRecord:
        record = self.describe(shadow_ref)
        if record.state in TERMINAL_EXECUTION_STATES:
            if (
                proof.state != record.state
                or record.venue_order_id_sha256 != _sha256_text(proof.venue_order_id)
            ):
                raise broker_error(
                    "LIVE_EXECUTION_QUERY_MISMATCH",
                    "terminal execution state changed during query",
                    fatal=True,
                )
            return record
        if (
            proof.connector_id != record.connector_id
            or proof.instrument_id != record.instrument_id
            or proof.client_order_id != record.client_order_id
            or (
                record.venue_order_id_sha256 is not None
                and record.venue_order_id_sha256 != _sha256_text(proof.venue_order_id)
            )
        ):
            raise broker_error(
                "LIVE_EXECUTION_QUERY_MISMATCH",
                "query result does not match the execution identity",
                fatal=True,
            )
        venue_digest = _sha256_text(proof.venue_order_id)
        with self._transaction():
            self.connection.execute(
                """
                UPDATE execution_order
                SET state = ?, prior_state = NULL,
                    venue_order_id_sha256 = ?, last_error_code = NULL,
                    updated_at = ?
                WHERE record_id = ?
                """,
                (
                    proof.state,
                    venue_digest,
                    proof.observed_at,
                    record.record_id,
                ),
            )
            self._append_event(
                record.record_id,
                "query-observed",
                {
                    "state": proof.state,
                    "venueOrderIdSha256": venue_digest,
                },
                proof.observed_at,
            )
        return self.describe(shadow_ref)

    def fail_query(
        self,
        shadow_ref: str,
        *,
        error_code: str,
    ) -> LiveExecutionRecord:
        record = self.describe(shadow_ref)
        if record.state in TERMINAL_EXECUTION_STATES:
            return record
        if _ERROR_CODE.fullmatch(error_code) is None:
            error_code = "LIVE_EXECUTION_QUERY_FAILED"
        state = (
            "cancel_unknown"
            if record.state in {"canceling", "cancel_unknown"}
            else "unknown"
        )
        prior = record.prior_state if state == "cancel_unknown" else None
        occurred_at = _utc_now()
        with self._transaction():
            self.connection.execute(
                """
                UPDATE execution_order
                SET state = ?, prior_state = ?, last_error_code = ?,
                    updated_at = ?
                WHERE record_id = ?
                """,
                (state, prior, error_code, occurred_at, record.record_id),
            )
            self._append_event(
                record.record_id,
                "query-failed",
                {"state": state, "errorCode": error_code},
                occurred_at,
            )
        return self.describe(shadow_ref)

    def _recover_interrupted_dispatch(self) -> None:
        rows = tuple(
            self.connection.execute(
                """
                SELECT record_id, state, submit_attempt_count,
                       cancel_attempt_count
                FROM execution_order
                WHERE state IN ('submitting', 'canceling')
                ORDER BY record_id
                """
            )
        )
        for row in rows:
            occurred_at = _utc_now()
            submit = row["state"] == "submitting"
            state = "unknown" if submit else "cancel_unknown"
            event_type = (
                "submit-recovered-unknown" if submit else "cancel-recovered-unknown"
            )
            attempt = (
                row["submit_attempt_count"] if submit else row["cancel_attempt_count"]
            )
            with self._transaction():
                self.connection.execute(
                    """
                    UPDATE execution_order
                    SET state = ?, updated_at = ?
                    WHERE record_id = ? AND state = ?
                    """,
                    (state, occurred_at, row["record_id"], row["state"]),
                )
                self._append_event(
                    row["record_id"],
                    event_type,
                    {"attempt": attempt, "state": state},
                    occurred_at,
                )

    def status(self) -> dict[str, Any]:
        count, notional = self.unresolved_summary()
        total = self.connection.execute(
            "SELECT COUNT(*) FROM execution_order"
        ).fetchone()[0]
        terminal = self.connection.execute(
            """
            SELECT COUNT(*) FROM execution_order
            WHERE state IN ('rejected', 'filled', 'canceled', 'mmp_canceled')
            """
        ).fetchone()[0]
        head = self.event_head()
        return {
            "schemaVersion": LIVE_EXECUTION_STATUS_SCHEMA,
            "available": True,
            "environment": "demo",
            "instrumentId": DEMO_EXECUTION_INSTRUMENT,
            "maxOrderNotional": _canonical_decimal(MAX_DEMO_ORDER_NOTIONAL),
            "maxUnresolvedOrders": MAX_DEMO_UNRESOLVED_ORDERS,
            "maxUnresolvedNotional": _canonical_decimal(MAX_DEMO_UNRESOLVED_NOTIONAL),
            "orderCount": int(total),
            "terminalCount": int(terminal),
            "unresolvedCount": count,
            "unresolvedNotional": _canonical_decimal(notional),
            "eventSequence": head["sequence"],
            "eventSha256": head["sha256"],
            "liveSubmitAvailable": True,
            "liveCancelAvailable": True,
            "liveTransferAvailable": False,
        }

    def event_head(self) -> dict[str, Any]:
        row = self.connection.execute(
            """
            SELECT sequence, event_sha256 FROM execution_event
            ORDER BY sequence DESC LIMIT 1
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
            or not 1 <= limit <= 100
        ):
            raise ValueError("execution audit cursor is invalid")
        rows = tuple(
            self.connection.execute(
                """
                SELECT * FROM execution_event
                WHERE sequence > ? AND sequence <= ?
                ORDER BY sequence LIMIT ?
                """,
                (after_sequence, through_sequence, limit),
            )
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            record = self.connection.execute(
                "SELECT * FROM execution_order WHERE record_id = ?",
                (row["record_id"],),
            ).fetchone()
            payload = json.loads(row["payload_json"])
            result.append(
                {
                    "event": {
                        "schemaVersion": LIVE_EXECUTION_SCHEMA_VERSION,
                        "sequence": row["sequence"],
                        "recordId": row["record_id"],
                        "eventType": row["event_type"],
                        "payload": payload,
                        "occurredAt": row["occurred_at"],
                        "previousSha256": row["previous_sha256"],
                        "eventSha256": row["event_sha256"],
                    },
                    "record": (
                        None if record is None else self._record(record).public_wire()
                    ),
                }
            )
        return result

    def close(self) -> None:
        self.connection.close()


__all__ = [
    "DEMO_EXECUTION_INSTRUMENT",
    "DemoSpotExecutionConnector",
    "ExecutionMutationProof",
    "LIVE_EXECUTION_FILENAME",
    "LIVE_EXECUTION_RECORD_SCHEMA",
    "LIVE_EXECUTION_SCHEMA_VERSION",
    "LIVE_EXECUTION_STATUS_SCHEMA",
    "LiveExecutionLedger",
    "LiveExecutionRecord",
    "MAX_DEMO_ORDER_NOTIONAL",
    "MAX_DEMO_UNRESOLVED_NOTIONAL",
    "MAX_DEMO_UNRESOLVED_ORDERS",
    "TERMINAL_EXECUTION_STATES",
    "UNRESOLVED_EXECUTION_STATES",
    "execution_risk_decision",
]
