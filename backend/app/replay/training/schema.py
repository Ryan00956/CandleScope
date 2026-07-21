"""Additive replay training schema that old replay.v1 builds safely ignore."""

from __future__ import annotations

import sqlite3


TRAINING_SCHEMA_VERSION = 3
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


TRAINING_SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS replay_training_viewer_state (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    selected_track_id TEXT NOT NULL,
    display_interval TEXT NOT NULL,
    chart_type TEXT NOT NULL,
    visible_range_json TEXT,
    pane_layout_json TEXT NOT NULL,
    rail_layout_json TEXT NOT NULL,
    semantic_view_revision INTEGER NOT NULL CHECK (semantic_view_revision >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS replay_training_viewer_event (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    semantic_view_revision INTEGER NOT NULL CHECK (semantic_view_revision >= 0),
    command_id TEXT,
    event_type TEXT NOT NULL,
    request_json TEXT NOT NULL,
    viewer_state_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, semantic_view_revision),
    UNIQUE (run_id, command_id)
);

CREATE TABLE IF NOT EXISTS replay_training_command (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    command_id TEXT NOT NULL,
    command_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, command_id)
);
"""


TRAINING_SCHEMA_V3 = """
CREATE TABLE IF NOT EXISTS replay_training_integrity (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    strict_eligible INTEGER NOT NULL CHECK (strict_eligible IN (0, 1)),
    start_time_known INTEGER NOT NULL CHECK (start_time_known IN (0, 1)),
    revealed INTEGER NOT NULL CHECK (revealed IN (0, 1)),
    allowed_mutations_json TEXT NOT NULL,
    result_label TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS replay_run_action_event (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    action_sequence INTEGER NOT NULL CHECK (action_sequence >= 1),
    event_id TEXT NOT NULL,
    command_id TEXT,
    event_type TEXT NOT NULL,
    rule_revision INTEGER NOT NULL CHECK (rule_revision >= 1),
    public_time_json TEXT NOT NULL,
    old_value_json TEXT NOT NULL,
    new_value_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    state_hash_before TEXT,
    state_hash_after TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, action_sequence),
    UNIQUE (run_id, event_id),
    UNIQUE (run_id, command_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_run_action_event_type
ON replay_run_action_event(run_id, event_type, action_sequence);

CREATE TABLE IF NOT EXISTS replay_run_view_event (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    view_sequence INTEGER NOT NULL CHECK (view_sequence >= 1),
    command_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    semantic_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count >= 1),
    first_public_time_json TEXT NOT NULL,
    last_public_time_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, view_sequence),
    UNIQUE (run_id, command_id),
    UNIQUE (run_id, semantic_key)
);

CREATE INDEX IF NOT EXISTS idx_replay_run_view_event_updated
ON replay_run_view_event(run_id, updated_at_ms DESC, view_sequence DESC);

CREATE TABLE IF NOT EXISTS replay_equity_sample (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    resolution TEXT NOT NULL,
    bucket_id INTEGER NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    public_time_json TEXT NOT NULL,
    equity TEXT NOT NULL,
    cash_balance TEXT NOT NULL,
    unrealized_pnl TEXT NOT NULL,
    ledger_tail_hash TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, resolution, bucket_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_equity_sample_sequence
ON replay_equity_sample(run_id, resolution, source_sequence, bucket_id);

CREATE TABLE IF NOT EXISTS replay_review_session (
    review_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    checkpoint_id INTEGER NOT NULL CHECK (checkpoint_id >= 1),
    selected_state_hash TEXT NOT NULL,
    original_state_hash TEXT NOT NULL,
    original_cursor_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_review_session_run
ON replay_review_session(run_id, updated_at_ms DESC, review_id DESC);

CREATE TABLE IF NOT EXISTS replay_run_lineage (
    child_run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    parent_run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE RESTRICT,
    parent_event_id TEXT NOT NULL,
    parent_checkpoint_id INTEGER NOT NULL CHECK (parent_checkpoint_id >= 1),
    dataset_epoch TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_run_lineage_parent
ON replay_run_lineage(parent_run_id, parent_event_id);
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
    if current == 0:
        _execute_script(connection, TRAINING_SCHEMA_V1)
        current = 1
    if current == 1:
        _execute_script(connection, TRAINING_SCHEMA_V2)
        connection.execute(
            """
            INSERT OR IGNORE INTO replay_training_viewer_state(
                run_id, selected_track_id, display_interval, chart_type,
                visible_range_json, pane_layout_json, rail_layout_json,
                semantic_view_revision, updated_at_ms
            )
            SELECT run_id, 'track-1', display_interval, 'candles',
                   NULL, '{}', '{}', 0, ?
            FROM replay_training_run
            """,
            (now_ms,),
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO replay_training_viewer_event(
                run_id, semantic_view_revision, command_id, event_type,
                request_json, viewer_state_json, created_at_ms
            )
            SELECT run_id, 0, NULL, 'INITIAL_VIEWER_STATE', '{}',
                   json_object(
                       'run_id', run_id,
                       'selected_track_id', 'track-1',
                       'display_interval', display_interval,
                       'chart_type', 'candles',
                       'visible_range', NULL,
                       'pane_layout', json('{}'),
                       'rail_layout', json('{}'),
                       'semantic_view_revision', 0
                   ), ?
            FROM replay_training_run
            """,
            (now_ms,),
        )
        current = 2
    if current == 2:
        _execute_script(connection, TRAINING_SCHEMA_V3)
        connection.execute(
            """
            INSERT OR IGNORE INTO replay_training_integrity(
                run_id, strict_eligible, start_time_known, revealed,
                allowed_mutations_json, result_label, updated_at_ms
            )
            SELECT run_id,
                   CASE WHEN integrity_mode = 'CHALLENGE' AND start_mode = 'RANDOM'
                        THEN 1 ELSE 0 END,
                   CASE WHEN start_mode = 'MANUAL' THEN 1 ELSE 0 END,
                   0,
                   '[]',
                   CASE WHEN start_mode = 'MANUAL' THEN 'START_TIME_KNOWN'
                        ELSE integrity_mode END,
                   ?
            FROM replay_training_run
            """,
            (now_ms,),
        )
        current = 3
    if current != TRAINING_SCHEMA_VERSION:
        raise RuntimeError(f"no replay training schema migration path from {current}")
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


def _execute_script(connection: sqlite3.Connection, script: str) -> None:
    for statement in script.split(";"):
        sql = statement.strip()
        if sql:
            connection.execute(sql)


__all__ = [
    "TRAINING_SCHEMA_ID",
    "TRAINING_SCHEMA_VERSION",
    "migrate_training_schema",
]
