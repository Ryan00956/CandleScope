"""Additive replay training schema that old replay.v1 builds safely ignore."""

from __future__ import annotations

import sqlite3


TRAINING_SCHEMA_VERSION = 5
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


TRAINING_SCHEMA_V4 = """
CREATE TABLE IF NOT EXISTS replay_training_market_track (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    stable_ordinal INTEGER NOT NULL CHECK (stable_ordinal >= 1),
    adapter_session_id TEXT UNIQUE
        REFERENCES replay_session(session_id) ON DELETE SET NULL,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    settlement_asset TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('BAR', 'AGG_TRADE')),
    state TEXT NOT NULL
        CHECK (state IN ('DORMANT', 'PREPARING', 'READY', 'DEGRADED', 'ERROR')),
    subscription_tier TEXT NOT NULL
        CHECK (subscription_tier IN ('NONE', 'WARM', 'FULL')),
    dataset_epoch TEXT,
    virtual_time_ms INTEGER CHECK (virtual_time_ms IS NULL OR virtual_time_ms >= 0),
    source_sequence INTEGER CHECK (source_sequence IS NULL OR source_sequence >= 0),
    revision INTEGER CHECK (revision IS NULL OR revision >= 0),
    forced_full_reasons_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    public_price TEXT,
    position_json TEXT NOT NULL,
    account_json TEXT NOT NULL,
    open_orders_json TEXT NOT NULL,
    degraded_reason TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, track_id),
    UNIQUE (run_id, stable_ordinal),
    UNIQUE (run_id, exchange, market_type, symbol)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_market_track_tier
ON replay_training_market_track(run_id, subscription_tier, stable_ordinal);

CREATE TABLE IF NOT EXISTS replay_training_global_event (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    global_sequence INTEGER NOT NULL CHECK (global_sequence >= 1),
    ordering_version TEXT NOT NULL,
    actual_event_time_ms INTEGER NOT NULL CHECK (actual_event_time_ms >= 0),
    event_phase INTEGER NOT NULL CHECK (event_phase >= 0),
    track_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
    ordering_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, global_sequence),
    UNIQUE (run_id, track_id, source_sequence)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_global_event_order
ON replay_training_global_event(
    run_id, actual_event_time_ms, event_phase, track_id, source_sequence
);

CREATE TABLE IF NOT EXISTS replay_training_global_checkpoint (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    checkpoint_sequence INTEGER NOT NULL CHECK (checkpoint_sequence >= 1),
    ordering_version TEXT NOT NULL,
    global_virtual_time_ms INTEGER NOT NULL CHECK (global_virtual_time_ms >= 0),
    global_state_hash TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, checkpoint_sequence)
);
"""


TRAINING_SCHEMA_V5 = """
CREATE TABLE IF NOT EXISTS replay_training_contract_account (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    account_model TEXT NOT NULL
        CHECK (account_model IN ('PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER', 'TOUCH_OR_TAPE_V2')),
    margin_mode TEXT NOT NULL CHECK (margin_mode IN ('CROSS', 'ISOLATED')),
    funding_mode TEXT NOT NULL
        CHECK (funding_mode IN ('OFF', 'HISTORICAL_EXACT', 'SANDBOX_FIXED')),
    fixed_funding_rate TEXT,
    funding_interval_ms INTEGER
        CHECK (funding_interval_ms IS NULL OR funding_interval_ms > 0),
    next_funding_time_ms INTEGER
        CHECK (next_funding_time_ms IS NULL OR next_funding_time_ms >= 0),
    overlay_cash TEXT NOT NULL,
    isolated_margin_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'LIQUIDATING', 'BANKRUPT')),
    fidelity TEXT NOT NULL,
    ledger_tail_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS replay_training_instrument_rule (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    effective_virtual_time_ms INTEGER NOT NULL CHECK (effective_virtual_time_ms >= 0),
    rule_json TEXT NOT NULL,
    rule_hash TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_instrument_rule_effective
ON replay_training_instrument_rule(run_id, track_id, effective_virtual_time_ms DESC, revision DESC);

CREATE TABLE IF NOT EXISTS replay_training_fee_policy (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    effective_virtual_time_ms INTEGER NOT NULL CHECK (effective_virtual_time_ms >= 0),
    maker_fee_bps TEXT NOT NULL,
    taker_fee_bps TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, revision)
);

CREATE TABLE IF NOT EXISTS replay_training_contract_order (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    order_json TEXT NOT NULL,
    rule_revision INTEGER NOT NULL CHECK (rule_revision >= 1),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, order_id)
);

CREATE TABLE IF NOT EXISTS replay_training_contract_fill (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    fill_json TEXT NOT NULL,
    rule_revision INTEGER NOT NULL CHECK (rule_revision >= 1),
    fee_policy_revision INTEGER NOT NULL CHECK (fee_policy_revision >= 1),
    configured_fee TEXT NOT NULL,
    fee_fidelity TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, fill_id)
);

CREATE TABLE IF NOT EXISTS replay_training_contract_ledger (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    ledger_sequence INTEGER NOT NULL CHECK (ledger_sequence >= 1),
    posting_id TEXT NOT NULL,
    track_id TEXT,
    kind TEXT NOT NULL,
    cash_delta TEXT NOT NULL,
    asset TEXT NOT NULL,
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    fidelity TEXT NOT NULL,
    rule_revision INTEGER NOT NULL CHECK (rule_revision >= 1),
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, ledger_sequence),
    UNIQUE (run_id, posting_id),
    UNIQUE (run_id, entry_hash)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_contract_ledger_kind
ON replay_training_contract_ledger(run_id, kind, ledger_sequence DESC);

CREATE TABLE IF NOT EXISTS replay_training_funding_settlement (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    settlement_time_ms INTEGER NOT NULL CHECK (settlement_time_ms >= 0),
    position_quantity TEXT NOT NULL,
    mark_price TEXT NOT NULL,
    funding_rate TEXT NOT NULL,
    cash_delta TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    ledger_sequence INTEGER NOT NULL CHECK (ledger_sequence >= 1),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, settlement_time_ms)
);

CREATE TABLE IF NOT EXISTS replay_training_liquidation_event (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    liquidation_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'COMPLETED', 'FAILED')),
    trigger_virtual_time_ms INTEGER NOT NULL CHECK (trigger_virtual_time_ms >= 0),
    trigger_source_sequence INTEGER NOT NULL CHECK (trigger_source_sequence >= 0),
    mark_price TEXT NOT NULL,
    position_quantity TEXT NOT NULL,
    position_notional TEXT NOT NULL,
    maintenance_margin TEXT NOT NULL,
    account_equity_before TEXT NOT NULL,
    bankruptcy_price TEXT,
    liquidation_fee TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    canceled_order_ids_json TEXT NOT NULL,
    close_order_id TEXT,
    account_equity_after TEXT,
    reason TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, liquidation_id),
    UNIQUE (run_id, track_id, trigger_source_sequence)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_liquidation_pending
ON replay_training_liquidation_event(run_id, state, created_at_ms);
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
    if current == 3:
        _execute_script(connection, TRAINING_SCHEMA_V4)
        connection.execute(
            """
            INSERT OR IGNORE INTO replay_training_market_track(
                run_id, track_id, stable_ordinal, adapter_session_id,
                exchange, market_type, symbol, settlement_asset, source_kind,
                state, subscription_tier, dataset_epoch, virtual_time_ms,
                source_sequence, revision, forced_full_reasons_json,
                capabilities_json, public_price, position_json, account_json,
                open_orders_json, degraded_reason, created_at_ms, updated_at_ms
            )
            SELECT t.run_id, t.track_id, 1, t.adapter_session_id,
                   t.exchange, t.market_type, t.symbol, r.settlement_asset,
                   t.source_kind, t.state, t.subscription_tier, t.dataset_epoch,
                   t.virtual_time_ms, t.source_sequence, t.revision,
                   '["VIEWED"]', t.capabilities_json, NULL, '{}', '{}', '[]',
                   NULL, t.created_at_ms, t.updated_at_ms
            FROM replay_training_track AS t
            JOIN replay_training_run AS r USING(run_id)
            """
        )
        current = 4
    if current == 4:
        _execute_script(connection, TRAINING_SCHEMA_V5)
        connection.execute(
            """
            INSERT OR IGNORE INTO replay_training_contract_account(
                run_id, account_model, margin_mode, funding_mode,
                fixed_funding_rate, funding_interval_ms, next_funding_time_ms,
                overlay_cash, isolated_margin_json, status, fidelity,
                ledger_tail_hash, created_at_ms, updated_at_ms
            )
            SELECT run_id, 'PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER', margin_mode,
                   funding_mode, NULL, NULL, NULL, '0', '{}', 'ACTIVE',
                   'LEGACY_MIGRATION_NO_REINTERPRETATION',
                   'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                   ?, ?
            FROM replay_training_run
            """,
            (now_ms, now_ms),
        )
        current = 5
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
