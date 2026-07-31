"""Versioned schema owned exclusively by ``REPLAY_DB_PATH``."""

from __future__ import annotations

import sqlite3


REPLAY_SCHEMA_VERSION = 3


SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS replay_session (
    session_id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    broker_config_json TEXT NOT NULL,
    state TEXT NOT NULL,
    status_reason TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    command_log_offset INTEGER NOT NULL CHECK (command_log_offset >= 0),
    state_hash TEXT NOT NULL,
    data_epoch TEXT NOT NULL,
    revealed INTEGER NOT NULL DEFAULT 0 CHECK (revealed IN (0, 1)),
    accepting INTEGER NOT NULL DEFAULT 1 CHECK (accepting IN (0, 1)),
    degraded_reason TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS replay_dataset_ref (
    session_id TEXT PRIMARY KEY REFERENCES replay_session(session_id) ON DELETE CASCADE,
    data_epoch TEXT NOT NULL,
    snapshot_ref_json TEXT NOT NULL,
    snapshot_blob BLOB NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    snapshot_object_id TEXT,
    snapshot_size_bytes INTEGER CHECK (
        snapshot_size_bytes IS NULL OR snapshot_size_bytes >= 0
    ),
    actual_replay_start_ms INTEGER NOT NULL CHECK (actual_replay_start_ms >= 0),
    actual_replay_end_ms INTEGER NOT NULL CHECK (actual_replay_end_ms >= 0),
    synthetic_origin_ms INTEGER CHECK (synthetic_origin_ms IS NULL OR synthetic_origin_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS replay_command_log (
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    command_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    command_json TEXT NOT NULL,
    accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
    error_code TEXT,
    error_message TEXT,
    error_details_json TEXT,
    result_json TEXT,
    cursor_json TEXT NOT NULL,
    result_sequence INTEGER NOT NULL CHECK (result_sequence >= 0),
    result_state_hash TEXT NOT NULL,
    log_offset INTEGER NOT NULL CHECK (log_offset >= 1),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (session_id, command_id),
    UNIQUE (session_id, log_offset)
);

CREATE TABLE IF NOT EXISTS replay_source_event (
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
    event_json TEXT NOT NULL,
    result_sequence INTEGER NOT NULL CHECK (result_sequence >= 0),
    state_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (session_id, source_sequence)
);

CREATE TABLE IF NOT EXISTS replay_checkpoint (
    checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    mutation_id INTEGER CHECK (mutation_id IS NULL OR mutation_id >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    command_log_offset INTEGER NOT NULL CHECK (command_log_offset >= 0),
    event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
    state_hash TEXT NOT NULL,
    payload BLOB NOT NULL,
    payload_sha256 TEXT NOT NULL,
    is_initial INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_checkpoint_latest
ON replay_checkpoint(session_id, active, checkpoint_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_checkpoint_initial
ON replay_checkpoint(session_id) WHERE is_initial = 1;

CREATE TABLE IF NOT EXISTS replay_mutation_log (
    mutation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_sequence INTEGER,
    command_id TEXT,
    payload_json TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_mutation_session
ON replay_mutation_log(session_id, mutation_id);

CREATE TABLE IF NOT EXISTS replay_order (
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, order_id)
);

CREATE TABLE IF NOT EXISTS replay_fill (
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    fill_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, fill_id)
);

CREATE TABLE IF NOT EXISTS replay_ledger_entry (
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_id)
);

CREATE TABLE IF NOT EXISTS replay_journal_entry (
    session_id TEXT NOT NULL REFERENCES replay_session(session_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_id)
);

CREATE TABLE IF NOT EXISTS replay_report (
    session_id TEXT PRIMARY KEY REFERENCES replay_session(session_id) ON DELETE CASCADE,
    report_json TEXT NOT NULL,
    report_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
"""


def migrate_replay_schema(connection: sqlite3.Connection, *, now_ms: int) -> None:
    """Migrate only the already-open replay connection, fail-closed on drift."""

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS replay_schema_version (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            version INTEGER NOT NULL CHECK (version >= 0),
            applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
        )
        """
    )
    row = connection.execute(
        "SELECT version FROM replay_schema_version WHERE singleton = 1"
    ).fetchone()
    current = 0 if row is None else int(row[0])
    if current > REPLAY_SCHEMA_VERSION:
        raise RuntimeError(
            f"replay schema {current} is newer than supported {REPLAY_SCHEMA_VERSION}"
        )
    if current == REPLAY_SCHEMA_VERSION:
        return
    if current == 0:
        for statement in SCHEMA_V2.split(";"):
            sql = statement.strip()
            if sql:
                connection.execute(sql)
        current = REPLAY_SCHEMA_VERSION
    elif current == 1:
        connection.execute(
            "ALTER TABLE replay_checkpoint "
            "ADD COLUMN mutation_id INTEGER "
            "CHECK (mutation_id IS NULL OR mutation_id >= 0)"
        )
        # V1 did not persist a cross-table mutation watermark.  It cannot be
        # reconstructed from state_hash/timestamps: controller, speed, and
        # status-only mutations can share both values (and the configured
        # clock may return the same millisecond for every transaction).  NULL
        # therefore explicitly marks a legacy checkpoint.  Recovery may use
        # only the latest intact legacy checkpoint when it exactly represents
        # the durable session row; older/corrupt fallbacks fail closed instead
        # of silently skipping an ambiguous mutation tail.
        current = 2
    if current == 2:
        columns = {
            str(row[1])
            for row in connection.execute(
                "PRAGMA table_info(replay_dataset_ref)"
            ).fetchall()
        }
        if "snapshot_object_id" not in columns:
            connection.execute(
                "ALTER TABLE replay_dataset_ref "
                "ADD COLUMN snapshot_object_id TEXT"
            )
        if "snapshot_size_bytes" not in columns:
            connection.execute(
                "ALTER TABLE replay_dataset_ref "
                "ADD COLUMN snapshot_size_bytes INTEGER "
                "CHECK (snapshot_size_bytes IS NULL OR snapshot_size_bytes >= 0)"
            )
        current = 3
    if current != REPLAY_SCHEMA_VERSION:
        raise RuntimeError(f"no replay schema migration path from version {current}")
    connection.execute(
        """
        INSERT INTO replay_schema_version(singleton, version, applied_at_ms)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
            version = excluded.version,
            applied_at_ms = excluded.applied_at_ms
        """,
        (REPLAY_SCHEMA_VERSION, now_ms),
    )
