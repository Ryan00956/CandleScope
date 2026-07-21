"""Additive replay training schema that old replay.v1 builds safely ignore."""

from __future__ import annotations

import sqlite3


TRAINING_SCHEMA_VERSION = 1
TRAINING_SCHEMA_ID = "replay.training.v1"


TRAINING_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS replay_training_run (
    run_id TEXT PRIMARY KEY,
    adapter_session_id TEXT NOT NULL UNIQUE
        REFERENCES replay_session(session_id) ON DELETE CASCADE,
    parent_legacy_session_id TEXT
        REFERENCES replay_session(session_id) ON DELETE RESTRICT,
    protocol TEXT NOT NULL CHECK (protocol = 'replay.v2'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'replay.training.v1'),
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('BAR', 'AGG_TRADE')),
    start_mode TEXT NOT NULL CHECK (start_mode IN ('MANUAL', 'RANDOM')),
    integrity_mode TEXT NOT NULL,
    time_disclosure_policy TEXT NOT NULL,
    book_mode TEXT NOT NULL,
    margin_mode TEXT NOT NULL,
    funding_mode TEXT NOT NULL,
    execution_model TEXT NOT NULL,
    allow_rule_changes INTEGER NOT NULL CHECK (allow_rule_changes IN (0, 1)),
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    last_symbol TEXT NOT NULL,
    settlement_asset TEXT NOT NULL,
    base_interval TEXT NOT NULL,
    display_interval TEXT NOT NULL,
    initial_equity TEXT NOT NULL,
    current_equity TEXT,
    summary_revision INTEGER CHECK (summary_revision IS NULL OR summary_revision >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    active_rule_revision INTEGER NOT NULL CHECK (active_rule_revision >= 1),
    catalog_epoch TEXT NOT NULL,
    dataset_epoch TEXT NOT NULL,
    compatibility TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    saved_at_ms INTEGER NOT NULL CHECK (saved_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_run_updated
ON replay_training_run(updated_at_ms DESC, run_id DESC);

CREATE INDEX IF NOT EXISTS idx_replay_training_run_state_source
ON replay_training_run(state, source_kind, updated_at_ms DESC, run_id DESC);

CREATE TABLE IF NOT EXISTS replay_training_track (
    run_id TEXT NOT NULL REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    adapter_session_id TEXT NOT NULL
        REFERENCES replay_session(session_id) ON DELETE CASCADE,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    state TEXT NOT NULL,
    subscription_tier TEXT NOT NULL,
    dataset_epoch TEXT NOT NULL,
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    forced_full_reasons_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_track_session
ON replay_training_track(adapter_session_id);

CREATE TABLE IF NOT EXISTS replay_training_rule (
    run_id TEXT NOT NULL REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    rule_json TEXT NOT NULL,
    rule_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, revision)
);

CREATE TABLE IF NOT EXISTS replay_training_action (
    run_id TEXT NOT NULL REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    action_sequence INTEGER NOT NULL CHECK (action_sequence >= 1),
    action_type TEXT NOT NULL,
    action_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, action_sequence)
);

CREATE TABLE IF NOT EXISTS replay_training_pin (
    run_id TEXT NOT NULL REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    pin_id TEXT NOT NULL,
    dataset_epoch TEXT NOT NULL,
    pin_kind TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, pin_id)
);
"""


def migrate_training_schema(connection: sqlite3.Connection, *, now_ms: int) -> None:
    """Create only v2-owned tables; never advance the replay.v1 schema row."""

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS replay_training_schema_version (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            version INTEGER NOT NULL CHECK (version >= 0),
            applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
        )
        """
    )
    row = connection.execute(
        "SELECT version FROM replay_training_schema_version WHERE singleton = 1"
    ).fetchone()
    current = 0 if row is None else int(row[0])
    if current > TRAINING_SCHEMA_VERSION:
        raise RuntimeError(
            f"replay training schema {current} is newer than supported "
            f"{TRAINING_SCHEMA_VERSION}"
        )
    if current == TRAINING_SCHEMA_VERSION:
        return
    if current != 0:
        raise RuntimeError(f"no replay training schema migration path from {current}")
    for statement in TRAINING_SCHEMA_V1.split(";"):
        sql = statement.strip()
        if sql:
            connection.execute(sql)
    connection.execute(
        """
        INSERT INTO replay_training_schema_version(singleton, version, applied_at_ms)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
            version = excluded.version,
            applied_at_ms = excluded.applied_at_ms
        """,
        (TRAINING_SCHEMA_VERSION, now_ms),
    )


__all__ = [
    "TRAINING_SCHEMA_ID",
    "TRAINING_SCHEMA_VERSION",
    "migrate_training_schema",
]
