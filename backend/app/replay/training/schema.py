"""Replay training schema used by the v2 product and its internal adapter."""

from __future__ import annotations

import sqlite3

from app.replay.canonical import canonical_sha256


TRAINING_SCHEMA_VERSION = 15
TRAINING_SCHEMA_ID = "replay.training.v2"
TIME_COMMITMENT_SCHEMA_VERSION = "replay.time-commitment.v1"
START_SELECTION_SCHEMA_VERSION = "replay.start-selection.v1"
SELECTION_PREPARATION_SCHEMA_VERSION = "replay.selection-preparation.v1"
DATA_POLICY_SCHEMA_VERSION = "replay.data-policy.v1"
PERIOD_SUMMARY_SET_SCHEMA_VERSION = "replay.period-summary-set.v1"
ADVANCE_INTENT_SCHEMA_VERSION = "replay.advance-intent.v1"
RUN_RULES_SCHEMA_VERSION = "replay.run-rules.v1"
REVIEW_TIMELINE_SCHEMA_VERSION = "replay.review.timeline.v1"


TRAINING_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS replay_training_run (
    run_id TEXT PRIMARY KEY,
    adapter_session_id TEXT UNIQUE
        REFERENCES replay_session(session_id) ON DELETE SET NULL,
    protocol TEXT NOT NULL CHECK (protocol = 'replay.v3'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'replay.training.v2'),
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('BAR', 'AGG_TRADE')),
    start_mode TEXT NOT NULL CHECK (start_mode IN ('MANUAL', 'RANDOM')),
    integrity_mode TEXT NOT NULL,
    time_disclosure_policy TEXT NOT NULL,
    book_mode TEXT NOT NULL,
    margin_mode TEXT NOT NULL,
    position_mode TEXT NOT NULL CHECK (position_mode IN ('ONE_WAY', 'HEDGE')),
    funding_mode TEXT NOT NULL,
    account_data_mode TEXT NOT NULL CHECK (
        account_data_mode IN (
            'APPROX_PROXY', 'HISTORICAL_EXACT', 'DETERMINISTIC_SIMULATION'
        )
    ),
    hedge_public_history_ref_json TEXT,
    simulation_manifest_ref_json TEXT,
    simulation_contract_hash TEXT,
    simulation_model_version TEXT,
    account_fidelity TEXT,
    insurance_adl_fidelity TEXT,
    execution_model TEXT NOT NULL,
    allow_rule_changes INTEGER NOT NULL CHECK (allow_rule_changes IN (0, 1)),
    exchange TEXT,
    market_type TEXT,
    last_symbol TEXT,
    settlement_asset TEXT NOT NULL,
    base_interval TEXT,
    display_interval TEXT,
    initial_equity TEXT NOT NULL,
    current_equity TEXT,
    summary_revision INTEGER CHECK (summary_revision IS NULL OR summary_revision >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    virtual_time_ms INTEGER CHECK (virtual_time_ms IS NULL OR virtual_time_ms >= 0),
    active_rule_revision INTEGER NOT NULL CHECK (active_rule_revision >= 0),
    catalog_epoch TEXT,
    dataset_epoch TEXT,
    compatibility TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    saved_at_ms INTEGER NOT NULL CHECK (saved_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_run_updated
ON replay_training_run(updated_at_ms DESC, run_id DESC);

CREATE INDEX IF NOT EXISTS idx_replay_training_run_state_source
ON replay_training_run(state, source_kind, updated_at_ms DESC, run_id DESC);

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
    selected_track_id TEXT,
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

"""


TRAINING_SCHEMA_V6 = """
CREATE TABLE IF NOT EXISTS replay_data_segment (
    segment_id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE,
    protocol TEXT NOT NULL CHECK (protocol = 'replay.data.segment.v1'),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('BAR', 'AGG_TRADE', 'FUTURE')),
    adapter_kind TEXT NOT NULL,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    base_interval TEXT,
    range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
    range_end_ms INTEGER NOT NULL CHECK (range_end_ms >= range_start_ms),
    schema_version TEXT NOT NULL,
    dataset_epoch TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    coverage_state TEXT NOT NULL
        CHECK (coverage_state IN ('EXACT', 'PARTIAL', 'UNKNOWN')),
    continuity_state TEXT NOT NULL
        CHECK (continuity_state IN ('CONTIGUOUS', 'GAPPED', 'UNKNOWN')),
    health TEXT NOT NULL
        CHECK (health IN (
            'LOADING', 'READY', 'QUARANTINED', 'EVICTED',
            'RECLAIMING', 'ERROR', 'CANCELED'
        )),
    storage_kind TEXT NOT NULL
        CHECK (storage_kind IN (
            'EMBEDDED_ARCHIVE', 'EXTERNAL_REPLAY_OWNED', 'EXTERNAL_READ_ONLY'
        )),
    local_path TEXT,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    rebuildable INTEGER NOT NULL CHECK (rebuildable IN (0, 1)),
    trusted_origin TEXT NOT NULL,
    rehydration_manifest_json TEXT NOT NULL,
    quarantine_reason TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    reclaim_token TEXT,
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_data_segment_lru
ON replay_data_segment(health, storage_kind, rebuildable, last_used_at_ms, segment_id);

CREATE INDEX IF NOT EXISTS idx_replay_data_segment_identity
ON replay_data_segment(source_kind, exchange, market_type, symbol, range_start_ms, range_end_ms);

CREATE TABLE IF NOT EXISTS replay_data_segment_ref (
    segment_id TEXT NOT NULL
        REFERENCES replay_data_segment(segment_id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT,
    owner_kind TEXT NOT NULL
        CHECK (owner_kind IN (
            'RUN_ARCHIVE', 'ACTOR', 'CHECKPOINT', 'REVIEW', 'RECOVERY'
        )),
    owner_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    released_at_ms INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= created_at_ms),
    PRIMARY KEY (segment_id, run_id, owner_kind, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_data_segment_ref_run
ON replay_data_segment_ref(run_id, active, owner_kind, segment_id);

CREATE TABLE IF NOT EXISTS replay_data_prepare_job (
    job_id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL
        CHECK (state IN (
            'PLANNED', 'LOADING', 'VALIDATING', 'PUBLISHING',
            'READY', 'QUARANTINED', 'CANCELED', 'ERROR'
        )),
    progress_numerator INTEGER NOT NULL CHECK (progress_numerator >= 0),
    progress_denominator INTEGER NOT NULL CHECK (progress_denominator >= 1),
    segment_id TEXT REFERENCES replay_data_segment(segment_id) ON DELETE SET NULL,
    run_id TEXT REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT,
    failure_reason TEXT,
    cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
    temp_path TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_data_prepare_job_identity
ON replay_data_prepare_job(identity_key, state, updated_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_data_prepare_singleflight
ON replay_data_prepare_job(identity_key)
WHERE state IN ('PLANNED', 'LOADING', 'VALIDATING', 'PUBLISHING');

CREATE TABLE IF NOT EXISTS replay_data_gc_audit (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('DRY_RUN', 'RUN', 'RECOVERY')),
    plan_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_data_gc_audit_created
ON replay_data_gc_audit(created_at_ms DESC, audit_id DESC);
"""


TRAINING_SCHEMA_V7 = """
CREATE TABLE IF NOT EXISTS replay_historical_book_archive (
    archive_id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE,
    protocol TEXT NOT NULL
        CHECK (protocol = 'replay.historical-book.archive.v1'),
    adapter_kind TEXT NOT NULL
        CHECK (adapter_kind = 'BINANCE_USDM_DIFF_DEPTH_CAPTURE_V1'),
    exchange TEXT NOT NULL CHECK (exchange = 'binance'),
    market_type TEXT NOT NULL CHECK (market_type = 'futures'),
    symbol TEXT NOT NULL,
    range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
    range_end_ms INTEGER NOT NULL CHECK (range_end_ms >= range_start_ms),
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.historical-book.binance-usdm.v1'),
    dataset_epoch TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    snapshot_count INTEGER NOT NULL CHECK (snapshot_count = 1),
    delta_count INTEGER NOT NULL CHECK (delta_count >= 0),
    max_depth_levels INTEGER NOT NULL CHECK (max_depth_levels BETWEEN 1 AND 5000),
    coverage_state TEXT NOT NULL CHECK (coverage_state = 'EXACT'),
    continuity_state TEXT NOT NULL CHECK (continuity_state = 'CONTIGUOUS'),
    health TEXT NOT NULL
        CHECK (health IN ('READY', 'QUARANTINED', 'EVICTED', 'ERROR')),
    local_path TEXT,
    trusted_source_path TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    trusted_origin TEXT NOT NULL,
    source_contract_url TEXT NOT NULL,
    quarantine_reason TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_historical_book_lookup
ON replay_historical_book_archive(
    exchange, market_type, symbol, health, range_start_ms, range_end_ms
);

CREATE INDEX IF NOT EXISTS idx_replay_historical_book_lru
ON replay_historical_book_archive(health, last_used_at_ms, archive_id);

CREATE TABLE IF NOT EXISTS replay_historical_book_ref (
    archive_id TEXT NOT NULL
        REFERENCES replay_historical_book_archive(archive_id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    bound_range_start_ms INTEGER NOT NULL CHECK (bound_range_start_ms >= 0),
    bound_range_end_ms INTEGER NOT NULL
        CHECK (bound_range_end_ms >= bound_range_start_ms),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    released_at_ms INTEGER
        CHECK (released_at_ms IS NULL OR released_at_ms >= created_at_ms),
    PRIMARY KEY (archive_id, run_id, track_id, binding_generation),
    FOREIGN KEY (run_id, track_id)
        REFERENCES replay_training_market_track(run_id, track_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_replay_historical_book_ref_run
ON replay_historical_book_ref(run_id, track_id, active, binding_generation DESC);

CREATE TABLE IF NOT EXISTS replay_historical_book_projection (
    run_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    archive_id TEXT NOT NULL
        REFERENCES replay_historical_book_archive(archive_id) ON DELETE RESTRICT,
    capability_state TEXT NOT NULL
        CHECK (capability_state IN ('AVAILABLE_EXACT', 'DEGRADED')),
    status TEXT NOT NULL CHECK (status IN ('READY', 'CLEARED', 'DISABLED')),
    execution_fidelity TEXT NOT NULL
        CHECK (execution_fidelity = 'BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE'),
    queue_exact INTEGER NOT NULL CHECK (queue_exact = 0),
    as_of_actual_ms INTEGER CHECK (as_of_actual_ms IS NULL OR as_of_actual_ms >= 0),
    as_of_virtual_ms INTEGER CHECK (as_of_virtual_ms IS NULL OR as_of_virtual_ms >= 0),
    last_update_id INTEGER CHECK (last_update_id IS NULL OR last_update_id >= 0),
    bids_json TEXT NOT NULL,
    asks_json TEXT NOT NULL,
    book_hash TEXT,
    message TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, track_id),
    FOREIGN KEY (run_id, track_id)
        REFERENCES replay_training_market_track(run_id, track_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_historical_book_event (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    archive_id TEXT
        REFERENCES replay_historical_book_archive(archive_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('BOUND', 'READY', 'GAP', 'CLEARED', 'RESYNC', 'FEATURE_DISABLED')),
    at_virtual_time_ms INTEGER CHECK (at_virtual_time_ms IS NULL OR at_virtual_time_ms >= 0),
    expected_previous_u INTEGER CHECK (expected_previous_u IS NULL OR expected_previous_u >= 0),
    observed_pu INTEGER CHECK (observed_pu IS NULL OR observed_pu >= 0),
    reason TEXT,
    details_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    FOREIGN KEY (run_id, track_id)
        REFERENCES replay_training_market_track(run_id, track_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_replay_historical_book_event_run
ON replay_historical_book_event(run_id, track_id, event_id);

CREATE TABLE IF NOT EXISTS replay_historical_book_gc_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN ('DRY_RUN', 'RUN', 'REHYDRATE')),
    plan_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_historical_book_gc_audit_created
ON replay_historical_book_gc_audit(created_at_ms DESC, audit_id DESC);
"""


TRAINING_SCHEMA_V8 = """
CREATE TABLE IF NOT EXISTS replay_training_launch_context (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.launch-context.v1'),
    source TEXT NOT NULL CHECK (source IN ('LIVE_PAGE', 'DIRECT_HUB')),
    context_json TEXT NOT NULL,
    context_hash TEXT NOT NULL
        CHECK (
            length(context_hash) = 71
            AND substr(context_hash, 1, 7) = 'sha256:'
        ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);
"""


TRAINING_SCHEMA_V9 = """
CREATE TABLE IF NOT EXISTS replay_training_start_selection (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.start-selection.v1'),
    start_mode TEXT NOT NULL CHECK (start_mode IN ('MANUAL', 'RANDOM')),
    seed_source TEXT NOT NULL
        CHECK (seed_source IN ('SERVER', 'MANUAL', 'FORK')),
    random_seed INTEGER
        CHECK (
            random_seed IS NULL
            OR (random_seed >= 0 AND random_seed <= 9007199254740991)
        ),
    actual_start_ms INTEGER NOT NULL CHECK (actual_start_ms >= 0),
    actual_end_ms INTEGER NOT NULL
        CHECK (actual_end_ms >= actual_start_ms),
    dataset_epoch TEXT NOT NULL,
    parent_selection_hash TEXT
        CHECK (
            parent_selection_hash IS NULL
            OR (
                length(parent_selection_hash) = 71
                AND substr(parent_selection_hash, 1, 7) = 'sha256:'
            )
        ),
    selection_hash TEXT NOT NULL
        CHECK (
            length(selection_hash) = 71
            AND substr(selection_hash, 1, 7) = 'sha256:'
        ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);
"""


TRAINING_SCHEMA_PHASE14_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_training_data_policy (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.data-policy.v1'),
    indicator_warmup_bars INTEGER NOT NULL
        CHECK (indicator_warmup_bars >= 1),
    visible_history_mode TEXT NOT NULL
        CHECK (visible_history_mode IN ('DURATION', 'ALL_AVAILABLE')),
    visible_history_lookback_ms INTEGER
        CHECK (
            visible_history_lookback_ms IS NULL
            OR visible_history_lookback_ms >= 1
        ),
    visible_history_rows INTEGER NOT NULL
        CHECK (visible_history_rows >= 0),
    actual_visible_history_start_ms INTEGER NOT NULL
        CHECK (actual_visible_history_start_ms >= 0),
    actual_replay_start_ms INTEGER NOT NULL
        CHECK (
            actual_replay_start_ms >= actual_visible_history_start_ms
        ),
    effective_warmup_bars INTEGER NOT NULL
        CHECK (effective_warmup_bars >= indicator_warmup_bars),
    forward_cache_ms INTEGER NOT NULL CHECK (forward_cache_ms >= 1),
    interval_ms INTEGER NOT NULL CHECK (interval_ms >= 1),
    policy_hash TEXT NOT NULL
        CHECK (
            length(policy_hash) = 71
            AND substr(policy_hash, 1, 7) = 'sha256:'
        ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);
"""


TRAINING_SCHEMA_PHASE15_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_training_fast_forward_summary_set (
    set_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.period-summary-set.v1'),
    algorithm_version TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('PREPARING', 'READY', 'FAILED', 'CANCELLED')),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    metadata_json TEXT NOT NULL,
    build_proof_hash TEXT
        CHECK (
            build_proof_hash IS NULL
            OR (
                length(build_proof_hash) = 71
                AND substr(build_proof_hash, 1, 7) = 'sha256:'
            )
        ),
    candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    source_event_count INTEGER NOT NULL DEFAULT 0 CHECK (source_event_count >= 0),
    raw_state_bytes INTEGER NOT NULL DEFAULT 0 CHECK (raw_state_bytes >= 0),
    compressed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (compressed_bytes >= 0),
    build_wall_ms INTEGER NOT NULL DEFAULT 0 CHECK (build_wall_ms >= 0),
    build_cpu_ms INTEGER NOT NULL DEFAULT 0 CHECK (build_cpu_ms >= 0),
    error_code TEXT,
    error_message TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (
        (status = 'READY' AND active IN (0, 1)
         AND build_proof_hash IS NOT NULL AND candidate_count > 0)
        OR
        (status != 'READY' AND active = 0)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_training_summary_active
ON replay_training_fast_forward_summary_set(run_id)
WHERE active = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_training_summary_preparing
ON replay_training_fast_forward_summary_set(run_id)
WHERE status = 'PREPARING';

CREATE INDEX IF NOT EXISTS idx_replay_training_summary_status
ON replay_training_fast_forward_summary_set(run_id, updated_at_ms DESC, set_id DESC);

CREATE TABLE IF NOT EXISTS replay_training_fast_forward_summary (
    set_id TEXT NOT NULL
        REFERENCES replay_training_fast_forward_summary_set(set_id)
        ON DELETE CASCADE,
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    summary_id TEXT NOT NULL,
    end_source_sequence INTEGER NOT NULL CHECK (end_source_sequence >= 1),
    end_virtual_time_ms INTEGER NOT NULL CHECK (end_virtual_time_ms >= 0),
    event_count INTEGER NOT NULL CHECK (event_count >= 1),
    summary_hash TEXT NOT NULL
        CHECK (
            length(summary_hash) = 71
            AND substr(summary_hash, 1, 7) = 'sha256:'
        ),
    metadata_json TEXT NOT NULL,
    component_blob BLOB NOT NULL CHECK (length(component_blob) >= 1),
    component_raw_bytes INTEGER NOT NULL CHECK (component_raw_bytes >= 1),
    component_blob_hash TEXT NOT NULL
        CHECK (
            length(component_blob_hash) = 71
            AND substr(component_blob_hash, 1, 7) = 'sha256:'
        ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY(set_id, summary_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_summary_candidate
ON replay_training_fast_forward_summary(
    run_id, end_virtual_time_ms DESC, end_source_sequence DESC
);

CREATE TABLE IF NOT EXISTS replay_training_advance_intent (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    command_id TEXT NOT NULL,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.advance-intent.v1'),
    command_json TEXT NOT NULL,
    command_hash TEXT NOT NULL
        CHECK (
            length(command_hash) = 71
            AND substr(command_hash, 1, 7) = 'sha256:'
        ),
    session_id TEXT NOT NULL,
    initial_cursor_json TEXT NOT NULL,
    target_virtual_time_ms INTEGER NOT NULL
        CHECK (target_virtual_time_ms >= 0),
    plan_json TEXT NOT NULL,
    summary_id TEXT,
    summary_hash TEXT
        CHECK (
            summary_hash IS NULL
            OR (
                length(summary_hash) = 71
                AND substr(summary_hash, 1, 7) = 'sha256:'
            )
        ),
    status TEXT NOT NULL
        CHECK (status IN ('RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED')),
    latest_cursor_json TEXT NOT NULL,
    result_json TEXT,
    failure_json TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY(run_id, command_id),
    CHECK (
        (status IN ('COMPLETED', 'CANCELLED') AND result_json IS NOT NULL)
        OR
        (status NOT IN ('COMPLETED', 'CANCELLED'))
    )
);

CREATE INDEX IF NOT EXISTS idx_replay_training_advance_intent_status
ON replay_training_advance_intent(run_id, status, updated_at_ms DESC);
"""


TRAINING_SCHEMA_PHASE16_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_account_history_archive (
    archive_id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE,
    protocol TEXT NOT NULL
        CHECK (protocol = 'replay.account-history.archive.v1'),
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.account-history.linear.v1'),
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    settlement_asset TEXT NOT NULL,
    range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
    range_end_ms INTEGER NOT NULL CHECK (range_end_ms >= range_start_ms),
    dataset_epoch TEXT NOT NULL
        CHECK (
            length(dataset_epoch) = 71
            AND substr(dataset_epoch, 1, 7) = 'sha256:'
        ),
    checksum_sha256 TEXT NOT NULL
        CHECK (
            length(checksum_sha256) = 71
            AND substr(checksum_sha256, 1, 7) = 'sha256:'
        ),
    proof_hash TEXT NOT NULL
        CHECK (
            length(proof_hash) = 71
            AND substr(proof_hash, 1, 7) = 'sha256:'
        ),
    event_chain_tail TEXT NOT NULL
        CHECK (
            length(event_chain_tail) = 71
            AND substr(event_chain_tail, 1, 7) = 'sha256:'
        ),
    rule_count INTEGER NOT NULL CHECK (rule_count >= 1),
    mark_count INTEGER NOT NULL CHECK (mark_count >= 2),
    funding_count INTEGER NOT NULL CHECK (funding_count >= 0),
    event_count INTEGER NOT NULL CHECK (event_count >= rule_count + mark_count),
    max_mark_gap_ms INTEGER NOT NULL CHECK (max_mark_gap_ms >= 1),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 1),
    health TEXT NOT NULL
        CHECK (health IN ('READY', 'QUARANTINED', 'EVICTED')),
    local_path TEXT,
    trusted_source_path TEXT NOT NULL,
    trusted_origin TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    quarantine_reason TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (
        (health = 'EVICTED' AND local_path IS NULL)
        OR
        (health != 'EVICTED' AND local_path IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_replay_account_history_archive_lookup
ON replay_account_history_archive(
    exchange, market_type, symbol, settlement_asset,
    health, range_start_ms, range_end_ms
);

CREATE TABLE IF NOT EXISTS replay_training_account_history (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    account_data_mode TEXT NOT NULL
        CHECK (account_data_mode IN (
            'APPROX_PROXY', 'HISTORICAL_EXACT', 'DETERMINISTIC_SIMULATION'
        )),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DEGRADED', 'PAUSED')),
    fidelity TEXT NOT NULL,
    archive_proof_hash TEXT
        CHECK (
            archive_proof_hash IS NULL
            OR (
                length(archive_proof_hash) = 71
                AND substr(archive_proof_hash, 1, 7) = 'sha256:'
            )
        ),
    degraded_reason TEXT,
    auditor_status TEXT NOT NULL
        CHECK (auditor_status IN ('NOT_RUN', 'PASS', 'FAIL')),
    auditor_proof_hash TEXT
        CHECK (
            auditor_proof_hash IS NULL
            OR (
                length(auditor_proof_hash) = 71
                AND substr(auditor_proof_hash, 1, 7) = 'sha256:'
            )
        ),
    auditor_differences_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (
        (account_data_mode IN ('APPROX_PROXY', 'DETERMINISTIC_SIMULATION')
            AND archive_proof_hash IS NULL)
        OR
        (account_data_mode = 'HISTORICAL_EXACT' AND archive_proof_hash IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS replay_account_history_ref (
    archive_id TEXT NOT NULL
        REFERENCES replay_account_history_archive(archive_id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    bound_range_start_ms INTEGER NOT NULL CHECK (bound_range_start_ms >= 0),
    bound_range_end_ms INTEGER NOT NULL
        CHECK (bound_range_end_ms >= bound_range_start_ms),
    dataset_epoch TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    archive_generation INTEGER NOT NULL CHECK (archive_generation >= 1),
    event_chain_tail TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    released_at_ms INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, binding_generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_account_history_ref_active
ON replay_account_history_ref(run_id, track_id)
WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_replay_account_history_ref_archive
ON replay_account_history_ref(archive_id, active);

CREATE TABLE IF NOT EXISTS replay_account_history_projection (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    archive_id TEXT NOT NULL
        REFERENCES replay_account_history_archive(archive_id) ON DELETE RESTRICT,
    archive_generation INTEGER NOT NULL CHECK (archive_generation >= 1),
    last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
    last_rule_sequence INTEGER NOT NULL CHECK (last_rule_sequence >= 0),
    last_mark_sequence INTEGER NOT NULL CHECK (last_mark_sequence >= 0),
    last_funding_sequence INTEGER NOT NULL CHECK (last_funding_sequence >= 0),
    as_of_actual_time_ms INTEGER NOT NULL CHECK (as_of_actual_time_ms >= 0),
    as_of_virtual_time_ms INTEGER NOT NULL CHECK (as_of_virtual_time_ms >= 0),
    current_rule_json TEXT,
    current_rule_hash TEXT,
    mark_price TEXT,
    index_price TEXT,
    input_chain_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('READY', 'DEGRADED')),
    degraded_reason TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, track_id)
);

CREATE TABLE IF NOT EXISTS replay_account_history_applied_event (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    archive_event_sequence INTEGER NOT NULL
        CHECK (archive_event_sequence >= 1),
    event_time_ms INTEGER NOT NULL CHECK (event_time_ms >= 0),
    event_phase INTEGER NOT NULL CHECK (event_phase IN (10, 30, 40)),
    event_kind TEXT NOT NULL CHECK (event_kind IN ('RULE', 'MARK_INDEX', 'FUNDING')),
    component_sequence INTEGER NOT NULL CHECK (component_sequence >= 1),
    archive_event_hash TEXT NOT NULL,
    applied_payload_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, archive_event_sequence)
);

CREATE INDEX IF NOT EXISTS idx_replay_account_history_applied_order
ON replay_account_history_applied_event(
    run_id, event_time_ms, event_phase, track_id, archive_event_sequence
);

CREATE TABLE IF NOT EXISTS replay_account_history_audit (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    audit_sequence INTEGER NOT NULL CHECK (audit_sequence >= 1),
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.account-audit.v1'),
    status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
    proof_hash TEXT NOT NULL,
    differences_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, audit_sequence)
);
"""


TRAINING_SCHEMA_PHASE17_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_training_leverage_policy (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    effective_virtual_time_ms INTEGER NOT NULL CHECK (effective_virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    max_leverage TEXT NOT NULL,
    policy_hash TEXT NOT NULL
        CHECK (length(policy_hash) = 71 AND substr(policy_hash, 1, 7) = 'sha256:'),
    fidelity TEXT NOT NULL,
    reason TEXT NOT NULL,
    command_id TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, revision),
    UNIQUE (run_id, command_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_leverage_policy_effective
ON replay_training_leverage_policy(
    run_id, effective_virtual_time_ms DESC, source_sequence DESC, revision DESC
);

CREATE TABLE IF NOT EXISTS replay_training_funding_policy (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    effective_virtual_time_ms INTEGER NOT NULL CHECK (effective_virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    funding_mode TEXT NOT NULL
        CHECK (funding_mode IN ('OFF', 'HISTORICAL_EXACT', 'SANDBOX_FIXED')),
    fixed_funding_rate TEXT,
    funding_interval_ms INTEGER
        CHECK (funding_interval_ms IS NULL OR funding_interval_ms >= 60000),
    policy_hash TEXT NOT NULL
        CHECK (length(policy_hash) = 71 AND substr(policy_hash, 1, 7) = 'sha256:'),
    fidelity TEXT NOT NULL,
    reason TEXT NOT NULL,
    command_id TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, revision),
    UNIQUE (run_id, command_id),
    CHECK (
        (funding_mode = 'SANDBOX_FIXED'
            AND fixed_funding_rate IS NOT NULL
            AND funding_interval_ms IS NOT NULL)
        OR
        (funding_mode != 'SANDBOX_FIXED'
            AND fixed_funding_rate IS NULL
            AND funding_interval_ms IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_replay_training_funding_policy_effective
ON replay_training_funding_policy(
    run_id, effective_virtual_time_ms DESC, source_sequence DESC, revision DESC
);

CREATE TABLE IF NOT EXISTS replay_review_actor_anchor (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    anchor_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    adapter_session_id TEXT NOT NULL
        REFERENCES replay_session(session_id) ON DELETE RESTRICT,
    checkpoint_id INTEGER NOT NULL CHECK (checkpoint_id >= 1),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    state_hash TEXT NOT NULL,
    dataset_epoch TEXT NOT NULL,
    payload BLOB NOT NULL,
    payload_encoding TEXT NOT NULL DEFAULT 'RAW'
        CHECK (payload_encoding IN ('RAW', 'ZLIB_V1')),
    payload_sha256 TEXT NOT NULL
        CHECK (length(payload_sha256) = 71 AND substr(payload_sha256, 1, 7) = 'sha256:'),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 1),
    stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, anchor_id),
    UNIQUE (run_id, track_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_review_actor_anchor_cursor
ON replay_review_actor_anchor(
    run_id, virtual_time_ms, source_sequence, track_id, checkpoint_id
);

CREATE TABLE IF NOT EXISTS replay_review_marker (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    marker_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
    content_hash TEXT NOT NULL
        CHECK (length(content_hash) = 71 AND substr(content_hash, 1, 7) = 'sha256:'),
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, marker_id),
    UNIQUE (run_id, command_id)
);

CREATE TABLE IF NOT EXISTS replay_review_timeline_event (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    timeline_sequence INTEGER NOT NULL CHECK (timeline_sequence >= 1),
    event_id TEXT NOT NULL,
    category TEXT NOT NULL
        CHECK (category IN (
            'INITIAL', 'COMMAND', 'ORDER', 'FILL', 'POSITION',
            'FUNDING', 'LIQUIDATION', 'RULE', 'VIEWER',
            'DRAWING', 'MARKER', 'EQUITY', 'SYSTEM'
        )),
    event_type TEXT NOT NULL,
    command_id TEXT,
    track_id TEXT,
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
    state_hash TEXT NOT NULL,
    account_hash TEXT NOT NULL,
    ledger_tail_hash TEXT NOT NULL,
    viewer_revision INTEGER NOT NULL CHECK (viewer_revision >= 0),
    public_time_json TEXT NOT NULL,
    projection_json TEXT NOT NULL,
    anchor_set_hash TEXT NOT NULL
        CHECK (length(anchor_set_hash) = 71 AND substr(anchor_set_hash, 1, 7) = 'sha256:'),
    previous_event_hash TEXT NOT NULL
        CHECK (
            length(previous_event_hash) = 71
            AND substr(previous_event_hash, 1, 7) = 'sha256:'
        ),
    event_hash TEXT NOT NULL
        CHECK (length(event_hash) = 71 AND substr(event_hash, 1, 7) = 'sha256:'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, timeline_sequence),
    UNIQUE (run_id, event_id),
    UNIQUE (run_id, event_hash)
);

CREATE INDEX IF NOT EXISTS idx_replay_review_timeline_jump
ON replay_review_timeline_event(
    run_id, category, virtual_time_ms, source_sequence, timeline_sequence
);

CREATE TABLE IF NOT EXISTS replay_review_event_anchor (
    run_id TEXT NOT NULL,
    timeline_sequence INTEGER NOT NULL CHECK (timeline_sequence >= 1),
    track_id TEXT NOT NULL,
    anchor_id TEXT NOT NULL,
    PRIMARY KEY (run_id, timeline_sequence, track_id),
    FOREIGN KEY (run_id, timeline_sequence)
        REFERENCES replay_review_timeline_event(run_id, timeline_sequence)
        ON DELETE CASCADE,
    FOREIGN KEY (run_id, anchor_id)
        REFERENCES replay_review_actor_anchor(run_id, anchor_id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS replay_review_viewport_sample (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    bucket_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    value_json TEXT NOT NULL,
    content_hash TEXT NOT NULL
        CHECK (length(content_hash) = 71 AND substr(content_hash, 1, 7) = 'sha256:'),
    sample_count INTEGER NOT NULL CHECK (sample_count >= 1),
    first_public_time_json TEXT NOT NULL,
    last_public_time_json TEXT NOT NULL,
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, bucket_key)
);

CREATE INDEX IF NOT EXISTS idx_replay_review_viewport_lru
ON replay_review_viewport_sample(run_id, last_used_at_ms, bucket_key);

CREATE TABLE IF NOT EXISTS replay_review_drawing_document (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    document_hash TEXT NOT NULL
        CHECK (length(document_hash) = 71 AND substr(document_hash, 1, 7) = 'sha256:'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    command_id TEXT NOT NULL,
    document_json TEXT NOT NULL,
    document_bytes INTEGER NOT NULL CHECK (document_bytes >= 2),
    entity_count INTEGER NOT NULL CHECK (entity_count >= 0),
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, document_hash),
    UNIQUE (run_id, revision),
    UNIQUE (run_id, command_id)
);

CREATE TABLE IF NOT EXISTS replay_review_cursor (
    review_id TEXT PRIMARY KEY
        REFERENCES replay_review_session(review_id) ON DELETE CASCADE,
    timeline_sequence INTEGER NOT NULL CHECK (timeline_sequence >= 1),
    playback_state TEXT NOT NULL CHECK (playback_state IN ('PAUSED', 'PLAYING')),
    playback_rate TEXT NOT NULL,
    original_account_hash TEXT NOT NULL,
    original_ledger_tail_hash TEXT NOT NULL,
    original_viewer_revision INTEGER NOT NULL CHECK (original_viewer_revision >= 0),
    original_viewer_hash TEXT NOT NULL,
    cursor_revision INTEGER NOT NULL CHECK (cursor_revision >= 1),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS replay_review_fork_lineage (
    child_run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    parent_run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE RESTRICT,
    parent_event_id TEXT NOT NULL,
    parent_timeline_sequence INTEGER NOT NULL CHECK (parent_timeline_sequence >= 1),
    anchor_set_hash TEXT NOT NULL
        CHECK (length(anchor_set_hash) = 71 AND substr(anchor_set_hash, 1, 7) = 'sha256:'),
    parent_projection_hash TEXT NOT NULL
        CHECK (
            length(parent_projection_hash) = 71
            AND substr(parent_projection_hash, 1, 7) = 'sha256:'
        ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);
"""


TRAINING_SCHEMA_PHASE18_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_account_history_gc_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL
        CHECK (action IN ('DRY_RUN', 'RUN', 'REHYDRATE')),
    plan_hash TEXT NOT NULL
        CHECK (
            length(plan_hash) = 71
            AND substr(plan_hash, 1, 7) = 'sha256:'
        ),
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_account_history_gc_audit_created
ON replay_account_history_gc_audit(created_at_ms DESC, audit_id DESC);
"""


TRAINING_SCHEMA_TIME_COMMITMENT_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_training_time_commitment (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.time-commitment.v1'),
    start_mode TEXT NOT NULL CHECK (start_mode IN ('MANUAL', 'RANDOM')),
    seed_source TEXT NOT NULL CHECK (seed_source IN ('MANUAL', 'SERVER')),
    random_seed INTEGER
        CHECK (
            random_seed IS NULL
            OR (random_seed >= 0 AND random_seed <= 9007199254740991)
        ),
    random_range_start_ms INTEGER
        CHECK (random_range_start_ms IS NULL OR random_range_start_ms >= 0),
    random_range_end_ms INTEGER
        CHECK (random_range_end_ms IS NULL OR random_range_end_ms >= 0),
    committed_start_ms INTEGER NOT NULL CHECK (committed_start_ms >= 0),
    commitment_hash TEXT NOT NULL
        CHECK (
            length(commitment_hash) = 71
            AND substr(commitment_hash, 1, 7) = 'sha256:'
        ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK (
        (start_mode = 'MANUAL'
         AND seed_source = 'MANUAL'
         AND random_seed IS NULL
         AND random_range_start_ms IS NULL
         AND random_range_end_ms IS NULL)
        OR
        (start_mode = 'RANDOM'
         AND seed_source = 'SERVER'
         AND random_seed IS NOT NULL
         AND random_range_start_ms IS NOT NULL
         AND random_range_end_ms IS NOT NULL
         AND random_range_end_ms >= random_range_start_ms
         AND committed_start_ms >= random_range_start_ms
         AND committed_start_ms <= random_range_end_ms)
    )
);
"""

TRAINING_SCHEMA_ARCHIVE_PIN_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_archive_pin (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    source_revision TEXT NOT NULL
        CHECK (
            length(source_revision) = 71
            AND substr(source_revision, 1, 7) = 'sha256:'
        ),
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    base_interval TEXT NOT NULL,
    range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
    range_end_ms INTEGER NOT NULL CHECK (range_end_ms >= range_start_ms),
    dataset_epoch TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, source_revision)
);

CREATE TABLE IF NOT EXISTS replay_training_run_setup (
    run_id TEXT PRIMARY KEY
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    setup_json TEXT NOT NULL,
    setup_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_replay_archive_pin_revision
ON replay_archive_pin(source_revision, exchange, market_type, symbol, base_interval);
"""


TRAINING_SCHEMA_SELECTION_PREPARATION_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_training_selection_preparation (
    preparation_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL
        CHECK (schema_version = 'replay.selection-preparation.v1'),
    status TEXT NOT NULL
        CHECK (status IN ('PREPARING_DATA', 'READY', 'FAILED')),
    start_mode TEXT NOT NULL CHECK (start_mode IN ('MANUAL', 'RANDOM')),
    seed_source TEXT NOT NULL CHECK (seed_source IN ('SERVER', 'MANUAL')),
    random_seed INTEGER
        CHECK (
            random_seed IS NULL
            OR (random_seed >= 0 AND random_seed <= 9007199254740991)
        ),
    catalog_epoch TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    selected_start_ms INTEGER NOT NULL CHECK (selected_start_ms >= 0),
    required_start_ms INTEGER NOT NULL CHECK (required_start_ms >= 0),
    required_end_ms INTEGER NOT NULL CHECK (required_end_ms >= selected_start_ms),
    interval_ms INTEGER NOT NULL CHECK (interval_ms >= 1),
    selection_hash TEXT NOT NULL
        CHECK (
            length(selection_hash) = 71
            AND substr(selection_hash, 1, 7) = 'sha256:'
        ),
    request_json TEXT NOT NULL,
    request_hash TEXT NOT NULL
        CHECK (
            length(request_hash) = 71
            AND substr(request_hash, 1, 7) = 'sha256:'
        ),
    selection_json TEXT NOT NULL,
    selection_json_hash TEXT NOT NULL
        CHECK (
            length(selection_json_hash) = 71
            AND substr(selection_json_hash, 1, 7) = 'sha256:'
        ),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    dataset_epoch TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (required_start_ms <= selected_start_ms),
    CHECK (
        (status = 'READY' AND dataset_epoch IS NOT NULL AND error_code IS NULL)
        OR (status = 'FAILED' AND dataset_epoch IS NULL AND error_code IS NOT NULL)
        OR (status = 'PREPARING_DATA' AND dataset_epoch IS NULL AND error_code IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_replay_training_selection_preparation_status
ON replay_training_selection_preparation(status, updated_at_ms DESC);
"""


TRAINING_SCHEMA_P2_TRAINING_RESULTS_ADDITIVE = """
CREATE TABLE IF NOT EXISTS replay_training_trade_plan (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    plan_sequence INTEGER NOT NULL CHECK (plan_sequence >= 1),
    plan_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    client_order_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
    sizing_mode TEXT NOT NULL
        CHECK (sizing_mode IN ('RISK_AMOUNT', 'ACCOUNT_RISK_PERCENT')),
    risk_amount TEXT NOT NULL,
    risk_percent TEXT,
    account_equity TEXT NOT NULL,
    entry_price TEXT NOT NULL,
    invalidation_price TEXT NOT NULL,
    target_price TEXT NOT NULL,
    risk_per_unit TEXT NOT NULL,
    reward_risk_ratio TEXT NOT NULL,
    quantity TEXT NOT NULL,
    reason TEXT NOT NULL,
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    state_hash TEXT NOT NULL,
    previous_plan_hash TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, plan_sequence),
    UNIQUE (run_id, plan_id),
    UNIQUE (run_id, command_id),
    UNIQUE (run_id, track_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_trade_plan_order
ON replay_training_trade_plan(run_id, track_id, order_id);

CREATE TABLE IF NOT EXISTS replay_training_trade_projection (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    last_fill_ordinal INTEGER NOT NULL CHECK (last_fill_ordinal >= 0),
    episode_sequence INTEGER NOT NULL CHECK (episode_sequence >= 0),
    episode_id TEXT,
    position_side TEXT CHECK (position_side IS NULL OR position_side IN ('BUY', 'SELL')),
    net_quantity TEXT NOT NULL,
    entry_price TEXT,
    entry_time_ms INTEGER CHECK (entry_time_ms IS NULL OR entry_time_ms >= 0),
    entry_source_sequence INTEGER
        CHECK (entry_source_sequence IS NULL OR entry_source_sequence >= 0),
    highest_mark TEXT,
    lowest_mark TEXT,
    plan_allocations_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, track_id)
);

CREATE TABLE IF NOT EXISTS replay_training_trade_result (
    run_id TEXT NOT NULL
        REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    trade_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    closing_order_id TEXT NOT NULL,
    position_side TEXT NOT NULL CHECK (position_side IN ('BUY', 'SELL')),
    quantity TEXT NOT NULL,
    entry_price TEXT NOT NULL,
    exit_price TEXT NOT NULL,
    gross_realized_pnl TEXT NOT NULL,
    mae TEXT NOT NULL,
    mfe TEXT NOT NULL,
    initial_risk_amount TEXT,
    r_multiple TEXT,
    holding_duration_ms INTEGER NOT NULL CHECK (holding_duration_ms >= 0),
    entry_time_ms INTEGER NOT NULL CHECK (entry_time_ms >= 0),
    exit_time_ms INTEGER NOT NULL CHECK (exit_time_ms >= entry_time_ms),
    entry_source_sequence INTEGER NOT NULL CHECK (entry_source_sequence >= 0),
    exit_source_sequence INTEGER NOT NULL CHECK (exit_source_sequence >= 0),
    plan_ids_json TEXT NOT NULL,
    excursion_fidelity TEXT NOT NULL,
    pnl_basis TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, trade_id),
    UNIQUE (run_id, track_id, fill_id)
);

CREATE INDEX IF NOT EXISTS idx_replay_training_trade_result_exit
ON replay_training_trade_result(run_id, exit_time_ms DESC, track_id, trade_id);
"""


TRAINING_SCHEMA_V14_HEDGE = """
CREATE TABLE IF NOT EXISTS replay_training_position_leg (
    run_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    position_side TEXT NOT NULL CHECK (position_side IN ('LONG', 'SHORT')),
    signed_quantity TEXT NOT NULL,
    absolute_quantity TEXT NOT NULL,
    entry_price TEXT,
    mark_price TEXT,
    notional TEXT NOT NULL,
    realized_pnl TEXT NOT NULL,
    unrealized_pnl TEXT NOT NULL,
    initial_margin TEXT NOT NULL,
    maintenance_margin TEXT NOT NULL,
    leverage TEXT NOT NULL,
    margin_mode TEXT NOT NULL CHECK (margin_mode IN ('CROSS', 'ISOLATED')),
    isolated_wallet TEXT NOT NULL,
    liquidation_price TEXT,
    bankruptcy_price TEXT,
    accumulated_funding TEXT NOT NULL,
    trading_fees TEXT NOT NULL,
    liquidation_fees TEXT NOT NULL,
    risk_tier INTEGER NOT NULL CHECK (risk_tier >= 1),
    rule_revision INTEGER NOT NULL CHECK (rule_revision >= 1),
    protection_json TEXT NOT NULL,
    component_revision INTEGER NOT NULL CHECK (component_revision >= 0),
    component_hash TEXT NOT NULL CHECK (
        length(component_hash) = 71 AND component_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, track_id, position_side),
    FOREIGN KEY (run_id, track_id)
        REFERENCES replay_training_market_track(run_id, track_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_training_margin_bucket (
    run_id TEXT NOT NULL,
    bucket_id TEXT NOT NULL,
    bucket_kind TEXT NOT NULL CHECK (
        bucket_kind IN ('CROSS', 'ISOLATED_LEG', 'OPEN_ORDER', 'POSITION')
    ),
    track_id TEXT,
    position_side TEXT CHECK (position_side IS NULL OR position_side IN ('LONG', 'SHORT')),
    asset TEXT NOT NULL,
    wallet_balance TEXT NOT NULL,
    initial_margin TEXT NOT NULL,
    maintenance_margin TEXT NOT NULL,
    reserved_margin TEXT NOT NULL,
    available_balance TEXT NOT NULL,
    component_revision INTEGER NOT NULL CHECK (component_revision >= 0),
    component_hash TEXT NOT NULL CHECK (
        length(component_hash) = 71 AND component_hash GLOB 'sha256:[0-9a-f]*'
    ),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, bucket_id),
    UNIQUE (run_id, bucket_kind, track_id, position_side, asset),
    FOREIGN KEY (run_id) REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, track_id, position_side)
        REFERENCES replay_training_position_leg(run_id, track_id, position_side)
        ON DELETE CASCADE,
    CHECK (
        (bucket_kind = 'CROSS' AND track_id IS NULL AND position_side IS NULL)
        OR (bucket_kind != 'CROSS' AND track_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS replay_training_risk_snapshot (
    run_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    snapshot_sequence INTEGER NOT NULL CHECK (snapshot_sequence >= 1),
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    account_status TEXT NOT NULL CHECK (
        account_status IN ('ACTIVE', 'RISK_BREACH_DETECTED', 'LIQUIDATING', 'BANKRUPT', 'FAILED_CLOSED')
    ),
    equity TEXT NOT NULL,
    available_balance TEXT NOT NULL,
    total_initial_margin TEXT NOT NULL,
    total_maintenance_margin TEXT NOT NULL,
    risk_ratio TEXT,
    active_rule_revision INTEGER NOT NULL CHECK (active_rule_revision >= 1),
    public_input_hash TEXT NOT NULL CHECK (
        length(public_input_hash) = 71 AND public_input_hash GLOB 'sha256:[0-9a-f]*'
    ),
    component_hash TEXT NOT NULL CHECK (
        length(component_hash) = 71 AND component_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, snapshot_id),
    UNIQUE (run_id, snapshot_sequence),
    UNIQUE (run_id, virtual_time_ms, source_sequence, component_hash),
    FOREIGN KEY (run_id) REFERENCES replay_training_run(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_training_liquidation_case (
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    case_sequence INTEGER NOT NULL CHECK (case_sequence >= 1),
    state TEXT NOT NULL CHECK (
        state IN (
            'RISK_BREACH_DETECTED', 'CANCELING_ORDERS', 'RISK_RECHECK',
            'PARTIAL_LIQUIDATION', 'FULL_LIQUIDATION', 'BANKRUPTCY_TRANSFER',
            'INSURANCE_FUND_SETTLEMENT', 'ADL', 'RECOVERED_AFTER_CANCEL',
            'COMPLETED', 'BANKRUPT', 'FAILED_CLOSED'
        )
    ),
    trigger_snapshot_id TEXT NOT NULL,
    final_snapshot_id TEXT,
    trigger_virtual_time_ms INTEGER NOT NULL CHECK (trigger_virtual_time_ms >= 0),
    trigger_source_sequence INTEGER NOT NULL CHECK (trigger_source_sequence >= 0),
    reason TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    component_hash TEXT NOT NULL CHECK (
        length(component_hash) = 71 AND component_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, case_id),
    UNIQUE (run_id, case_sequence),
    UNIQUE (run_id, trigger_snapshot_id),
    FOREIGN KEY (run_id, trigger_snapshot_id)
        REFERENCES replay_training_risk_snapshot(run_id, snapshot_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, final_snapshot_id)
        REFERENCES replay_training_risk_snapshot(run_id, snapshot_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_replay_training_liquidation_case_state
ON replay_training_liquidation_case(run_id, state, case_sequence);

CREATE TABLE IF NOT EXISTS replay_training_liquidation_leg (
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    liquidation_leg_id TEXT NOT NULL,
    leg_sequence INTEGER NOT NULL CHECK (leg_sequence >= 1),
    track_id TEXT NOT NULL,
    position_side TEXT NOT NULL CHECK (position_side IN ('LONG', 'SHORT')),
    trigger_quantity TEXT NOT NULL,
    trigger_notional TEXT NOT NULL,
    maintenance_margin TEXT NOT NULL,
    bankruptcy_price TEXT,
    takeover_price TEXT,
    liquidation_fee TEXT NOT NULL,
    target_quantity TEXT NOT NULL,
    completed_quantity TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'PARTIAL', 'CLOSED', 'TRANSFERRED', 'FAILED_CLOSED')),
    component_hash TEXT NOT NULL CHECK (
        length(component_hash) = 71 AND component_hash GLOB 'sha256:[0-9a-f]*'
    ),
    PRIMARY KEY (run_id, case_id, liquidation_leg_id),
    UNIQUE (run_id, case_id, leg_sequence),
    UNIQUE (run_id, case_id, track_id, position_side),
    FOREIGN KEY (run_id, case_id)
        REFERENCES replay_training_liquidation_case(run_id, case_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_training_liquidation_step (
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    step_sequence INTEGER NOT NULL CHECK (step_sequence >= 1),
    step_type TEXT NOT NULL CHECK (
        step_type IN (
            'CANCEL_ORDERS', 'RISK_RECHECK', 'PARTIAL_LIQUIDATION',
            'FULL_LIQUIDATION', 'BANKRUPTCY_TRANSFER',
            'INSURANCE_FUND_SETTLEMENT', 'ADL', 'COMPLETE', 'FAILED_CLOSED'
        )
    ),
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'APPLIED', 'FAILED_CLOSED')),
    before_snapshot_id TEXT NOT NULL,
    after_snapshot_id TEXT,
    reason TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    step_hash TEXT NOT NULL CHECK (
        length(step_hash) = 71 AND step_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    committed_at_ms INTEGER CHECK (committed_at_ms IS NULL OR committed_at_ms >= 0),
    PRIMARY KEY (run_id, case_id, step_sequence),
    UNIQUE (run_id, idempotency_key),
    UNIQUE (run_id, case_id, step_hash),
    FOREIGN KEY (run_id, case_id)
        REFERENCES replay_training_liquidation_case(run_id, case_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, before_snapshot_id)
        REFERENCES replay_training_risk_snapshot(run_id, snapshot_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, after_snapshot_id)
        REFERENCES replay_training_risk_snapshot(run_id, snapshot_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS replay_training_liquidation_order (
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    step_sequence INTEGER NOT NULL,
    order_id TEXT NOT NULL,
    liquidation_leg_id TEXT NOT NULL,
    order_sequence INTEGER NOT NULL CHECK (order_sequence >= 1),
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
    requested_quantity TEXT NOT NULL,
    filled_quantity TEXT NOT NULL,
    remaining_quantity TEXT NOT NULL,
    average_price TEXT,
    state TEXT NOT NULL CHECK (state IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'FAILED_CLOSED')),
    order_hash TEXT NOT NULL CHECK (
        length(order_hash) = 71 AND order_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, case_id, order_id),
    UNIQUE (run_id, case_id, step_sequence, order_sequence),
    FOREIGN KEY (run_id, case_id, step_sequence)
        REFERENCES replay_training_liquidation_step(run_id, case_id, step_sequence)
        ON DELETE CASCADE,
    FOREIGN KEY (run_id, case_id, liquidation_leg_id)
        REFERENCES replay_training_liquidation_leg(run_id, case_id, liquidation_leg_id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS replay_training_liquidation_fill (
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    fill_sequence INTEGER NOT NULL CHECK (fill_sequence >= 1),
    price TEXT NOT NULL,
    quantity TEXT NOT NULL,
    notional TEXT NOT NULL,
    trading_fee TEXT NOT NULL,
    liquidation_fee TEXT NOT NULL,
    book_level INTEGER CHECK (book_level IS NULL OR book_level >= 0),
    virtual_time_ms INTEGER NOT NULL CHECK (virtual_time_ms >= 0),
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
    fill_hash TEXT NOT NULL CHECK (
        length(fill_hash) = 71 AND fill_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, case_id, order_id, fill_id),
    UNIQUE (run_id, case_id, order_id, fill_sequence),
    UNIQUE (run_id, fill_hash),
    FOREIGN KEY (run_id, case_id, order_id)
        REFERENCES replay_training_liquidation_order(run_id, case_id, order_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_training_insurance_fund (
    run_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    model_version TEXT NOT NULL,
    opening_balance TEXT NOT NULL,
    current_balance TEXT NOT NULL,
    ledger_tail_hash TEXT NOT NULL CHECK (
        length(ledger_tail_hash) = 71 AND ledger_tail_hash GLOB 'sha256:[0-9a-f]*'
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, asset),
    FOREIGN KEY (run_id) REFERENCES replay_training_run(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_training_insurance_posting (
    run_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    posting_sequence INTEGER NOT NULL CHECK (posting_sequence >= 1),
    posting_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    step_sequence INTEGER NOT NULL,
    cash_delta TEXT NOT NULL,
    balance_after TEXT NOT NULL,
    reason TEXT NOT NULL,
    previous_hash TEXT NOT NULL CHECK (
        length(previous_hash) = 71 AND previous_hash GLOB 'sha256:[0-9a-f]*'
    ),
    posting_hash TEXT NOT NULL CHECK (
        length(posting_hash) = 71 AND posting_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, asset, posting_sequence),
    UNIQUE (run_id, posting_id),
    UNIQUE (run_id, posting_hash),
    FOREIGN KEY (run_id, asset)
        REFERENCES replay_training_insurance_fund(run_id, asset) ON DELETE CASCADE,
    FOREIGN KEY (run_id, case_id, step_sequence)
        REFERENCES replay_training_liquidation_step(run_id, case_id, step_sequence)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS replay_training_adl_snapshot (
    run_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    step_sequence INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    cohort_sequence INTEGER NOT NULL CHECK (cohort_sequence >= 1),
    model_version TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (
        length(input_hash) = 71 AND input_hash GLOB 'sha256:[0-9a-f]*'
    ),
    snapshot_hash TEXT NOT NULL CHECK (
        length(snapshot_hash) = 71 AND snapshot_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, snapshot_id),
    UNIQUE (run_id, case_id, cohort_sequence),
    UNIQUE (run_id, snapshot_hash),
    FOREIGN KEY (run_id, case_id, step_sequence)
        REFERENCES replay_training_liquidation_step(run_id, case_id, step_sequence)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_training_adl_candidate (
    run_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    rank INTEGER NOT NULL CHECK (rank >= 1),
    position_side TEXT NOT NULL CHECK (position_side IN ('LONG', 'SHORT')),
    quantity TEXT NOT NULL,
    entry_price TEXT NOT NULL,
    mark_price TEXT NOT NULL,
    profit_ratio TEXT NOT NULL,
    effective_leverage TEXT NOT NULL,
    score TEXT NOT NULL,
    candidate_hash TEXT NOT NULL CHECK (
        length(candidate_hash) = 71 AND candidate_hash GLOB 'sha256:[0-9a-f]*'
    ),
    PRIMARY KEY (run_id, snapshot_id, candidate_id),
    UNIQUE (run_id, snapshot_id, rank),
    UNIQUE (run_id, snapshot_id, candidate_hash),
    FOREIGN KEY (run_id, snapshot_id)
        REFERENCES replay_training_adl_snapshot(run_id, snapshot_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replay_training_adl_event (
    run_id TEXT NOT NULL,
    adl_event_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    step_sequence INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL,
    required_notional TEXT NOT NULL,
    completed_notional TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'COMPLETED', 'FAILED_CLOSED')),
    event_hash TEXT NOT NULL CHECK (
        length(event_hash) = 71 AND event_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, adl_event_id),
    UNIQUE (run_id, case_id, step_sequence),
    UNIQUE (run_id, event_hash),
    FOREIGN KEY (run_id, case_id, step_sequence)
        REFERENCES replay_training_liquidation_step(run_id, case_id, step_sequence)
        ON DELETE CASCADE,
    FOREIGN KEY (run_id, snapshot_id)
        REFERENCES replay_training_adl_snapshot(run_id, snapshot_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS replay_training_adl_selection (
    run_id TEXT NOT NULL,
    adl_event_id TEXT NOT NULL,
    selection_sequence INTEGER NOT NULL CHECK (selection_sequence >= 1),
    candidate_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    quantity TEXT NOT NULL,
    price TEXT NOT NULL,
    notional TEXT NOT NULL,
    cash_delta TEXT NOT NULL,
    selection_hash TEXT NOT NULL CHECK (
        length(selection_hash) = 71 AND selection_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, adl_event_id, selection_sequence),
    UNIQUE (run_id, adl_event_id, candidate_id),
    UNIQUE (run_id, selection_hash),
    FOREIGN KEY (run_id, adl_event_id)
        REFERENCES replay_training_adl_event(run_id, adl_event_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, snapshot_id, candidate_id)
        REFERENCES replay_training_adl_candidate(run_id, snapshot_id, candidate_id)
        ON DELETE RESTRICT
);
"""


TRAINING_SCHEMA_V15_HEDGE_INPUTS = """
CREATE TABLE IF NOT EXISTS replay_hedge_public_archive (
    archive_id TEXT PRIMARY KEY,
    protocol TEXT NOT NULL CHECK (protocol = 'replay.hedge-public-history.archive.v1'),
    schema_version TEXT NOT NULL CHECK (schema_version = 'replay.hedge-public-history.v1'),
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    settlement_asset TEXT NOT NULL,
    range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
    range_end_ms INTEGER NOT NULL CHECK (range_end_ms >= range_start_ms),
    dataset_epoch TEXT NOT NULL UNIQUE CHECK (
        length(dataset_epoch) = 71 AND dataset_epoch GLOB 'sha256:[0-9a-f]*'
    ),
    checksum_sha256 TEXT NOT NULL CHECK (
        length(checksum_sha256) = 71 AND checksum_sha256 GLOB 'sha256:[0-9a-f]*'
    ),
    event_chain_tail TEXT NOT NULL CHECK (
        length(event_chain_tail) = 71 AND event_chain_tail GLOB 'sha256:[0-9a-f]*'
    ),
    proof_hash TEXT NOT NULL CHECK (
        length(proof_hash) = 71 AND proof_hash GLOB 'sha256:[0-9a-f]*'
    ),
    l2_archive_id TEXT NOT NULL,
    l2_dataset_epoch TEXT NOT NULL,
    l2_checksum_sha256 TEXT NOT NULL,
    event_count INTEGER NOT NULL CHECK (event_count >= 1),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 1),
    health TEXT NOT NULL CHECK (health IN ('READY', 'EVICTED', 'QUARANTINED')),
    local_path TEXT,
    trusted_source_path TEXT NOT NULL,
    trusted_origin TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    quarantine_reason TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK ((health = 'READY' AND local_path IS NOT NULL AND quarantine_reason IS NULL)
        OR (health = 'EVICTED' AND local_path IS NULL)
        OR (health = 'QUARANTINED' AND local_path IS NULL AND quarantine_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_replay_hedge_public_archive_lookup
ON replay_hedge_public_archive(
    exchange, market_type, symbol, settlement_asset,
    range_start_ms, range_end_ms, health
);

CREATE TABLE IF NOT EXISTS replay_hedge_simulation_manifest (
    manifest_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = 'replay.hedge-simulation-manifest.v1'),
    model_version TEXT NOT NULL,
    contract_hash TEXT NOT NULL CHECK (
        length(contract_hash) = 71 AND contract_hash GLOB 'sha256:[0-9a-f]*'
    ),
    settlement_asset TEXT NOT NULL,
    required_symbols_json TEXT NOT NULL,
    range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
    range_end_ms INTEGER NOT NULL CHECK (range_end_ms >= range_start_ms),
    dataset_epoch TEXT NOT NULL UNIQUE CHECK (
        length(dataset_epoch) = 71 AND dataset_epoch GLOB 'sha256:[0-9a-f]*'
    ),
    checksum_sha256 TEXT NOT NULL CHECK (
        length(checksum_sha256) = 71 AND checksum_sha256 GLOB 'sha256:[0-9a-f]*'
    ),
    proof_hash TEXT NOT NULL CHECK (
        length(proof_hash) = 71 AND proof_hash GLOB 'sha256:[0-9a-f]*'
    ),
    event_count INTEGER NOT NULL CHECK (event_count >= 1),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 1),
    health TEXT NOT NULL CHECK (health IN ('READY', 'EVICTED', 'QUARANTINED')),
    local_path TEXT,
    trusted_source_path TEXT NOT NULL,
    trusted_origin TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    quarantine_reason TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK ((health = 'READY' AND local_path IS NOT NULL AND quarantine_reason IS NULL)
        OR (health = 'EVICTED' AND local_path IS NULL)
        OR (health = 'QUARANTINED' AND local_path IS NULL AND quarantine_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_replay_hedge_simulation_manifest_lookup
ON replay_hedge_simulation_manifest(
    settlement_asset, range_start_ms, range_end_ms, health
);

CREATE TABLE IF NOT EXISTS replay_hedge_input_binding (
    run_id TEXT PRIMARY KEY REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    public_archive_id TEXT NOT NULL
        REFERENCES replay_hedge_public_archive(archive_id) ON DELETE RESTRICT,
    public_generation INTEGER NOT NULL CHECK (public_generation >= 1),
    public_dataset_epoch TEXT NOT NULL,
    public_checksum_sha256 TEXT NOT NULL,
    public_event_chain_tail TEXT NOT NULL,
    simulation_manifest_id TEXT NOT NULL
        REFERENCES replay_hedge_simulation_manifest(manifest_id) ON DELETE RESTRICT,
    simulation_generation INTEGER NOT NULL CHECK (simulation_generation >= 1),
    simulation_dataset_epoch TEXT NOT NULL,
    simulation_checksum_sha256 TEXT NOT NULL,
    simulation_contract_hash TEXT NOT NULL,
    bound_range_start_ms INTEGER NOT NULL CHECK (bound_range_start_ms >= 0),
    bound_range_end_ms INTEGER NOT NULL CHECK (bound_range_end_ms >= bound_range_start_ms),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'QUARANTINED')),
    degraded_reason TEXT,
    input_proof_hash TEXT NOT NULL CHECK (
        length(input_proof_hash) = 71 AND input_proof_hash GLOB 'sha256:[0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    CHECK ((status = 'ACTIVE' AND degraded_reason IS NULL)
        OR (status != 'ACTIVE' AND degraded_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS replay_hedge_input_projection (
    run_id TEXT NOT NULL REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('PUBLIC', 'SIMULATION')),
    last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
    as_of_actual_time_ms INTEGER NOT NULL CHECK (as_of_actual_time_ms >= 0),
    as_of_virtual_time_ms INTEGER NOT NULL CHECK (as_of_virtual_time_ms >= 0),
    state_json TEXT NOT NULL,
    input_chain_hash TEXT NOT NULL CHECK (
        length(input_chain_hash) = 71 AND input_chain_hash GLOB 'sha256:[0-9a-f]*'
    ),
    component_hash TEXT NOT NULL CHECK (
        length(component_hash) = 71 AND component_hash GLOB 'sha256:[0-9a-f]*'
    ),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (run_id, source_kind)
);

CREATE TABLE IF NOT EXISTS replay_hedge_input_applied_event (
    run_id TEXT NOT NULL REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('PUBLIC', 'SIMULATION')),
    event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
    event_time_ms INTEGER NOT NULL CHECK (event_time_ms >= 0),
    event_phase INTEGER NOT NULL CHECK (event_phase IN (10, 30, 40, 70)),
    event_kind TEXT NOT NULL CHECK (
        event_kind IN (
            'RULE', 'FEE_POLICY', 'MARK_INDEX', 'FUNDING',
            'INSURANCE_INPUT', 'ADL_COHORT_INPUT'
        )
    ),
    component_sequence INTEGER NOT NULL CHECK (component_sequence >= 1),
    applied_virtual_time_ms INTEGER NOT NULL CHECK (applied_virtual_time_ms >= 0),
    source_event_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    applied_payload_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, source_kind, event_sequence),
    UNIQUE (run_id, source_kind, source_event_hash)
);

CREATE INDEX IF NOT EXISTS idx_replay_hedge_input_applied_order
ON replay_hedge_input_applied_event(
    run_id, event_time_ms, event_phase, source_kind, event_sequence
);

CREATE TABLE IF NOT EXISTS replay_hedge_input_audit (
    run_id TEXT NOT NULL REFERENCES replay_training_run(run_id) ON DELETE CASCADE,
    audit_sequence INTEGER NOT NULL CHECK (audit_sequence >= 1),
    schema_version TEXT NOT NULL CHECK (
        schema_version = 'replay.hedge-input-audit.v1'
    ),
    status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
    proof_hash TEXT NOT NULL CHECK (
        length(proof_hash) = 71 AND proof_hash GLOB 'sha256:[0-9a-f]*'
    ),
    differences_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (run_id, audit_sequence)
);
"""


def data_policy_hash(
    *,
    indicator_warmup_bars: int,
    visible_history_mode: str,
    visible_history_lookback_ms: int | None,
    visible_history_rows: int,
    actual_visible_history_start_ms: int,
    actual_replay_start_ms: int,
    effective_warmup_bars: int,
    forward_cache_ms: int,
    interval_ms: int,
) -> str:
    return canonical_sha256(
        {
            "schema_version": DATA_POLICY_SCHEMA_VERSION,
            "indicator_warmup_bars": indicator_warmup_bars,
            "visible_history_lookback": {
                "mode": visible_history_mode,
                "duration_ms": visible_history_lookback_ms,
            },
            "visible_history_rows": visible_history_rows,
            "actual_visible_history_start_ms": actual_visible_history_start_ms,
            "actual_replay_start_ms": actual_replay_start_ms,
            "effective_warmup_bars": effective_warmup_bars,
            "forward_cache_ms": forward_cache_ms,
            "interval_ms": interval_ms,
        }
    )


def start_selection_hash(
    *,
    run_id: str,
    start_mode: str,
    seed_source: str,
    random_seed: int | None,
    actual_start_ms: int,
    actual_end_ms: int,
    dataset_epoch: str,
    parent_selection_hash: str | None,
) -> str:
    return canonical_sha256(
        {
            "schema_version": START_SELECTION_SCHEMA_VERSION,
            "run_id": run_id,
            "start_mode": start_mode,
            "seed_source": seed_source,
            "random_seed": random_seed,
            "actual_start_ms": actual_start_ms,
            "actual_end_ms": actual_end_ms,
            "dataset_epoch": dataset_epoch,
            "parent_selection_hash": parent_selection_hash,
        }
    )


def time_commitment_hash(
    *,
    run_id: str,
    start_mode: str,
    seed_source: str,
    random_seed: int | None,
    random_range_start_ms: int | None,
    random_range_end_ms: int | None,
    committed_start_ms: int,
) -> str:
    return canonical_sha256(
        {
            "schema_version": TIME_COMMITMENT_SCHEMA_VERSION,
            "run_id": run_id,
            "start_mode": start_mode,
            "seed_source": seed_source,
            "random_seed": random_seed,
            "random_range_start_ms": random_range_start_ms,
            "random_range_end_ms": random_range_end_ms,
            "committed_start_ms": committed_start_ms,
        }
    )


def selection_preparation_hash(
    *,
    preparation_id: str,
    start_mode: str,
    seed_source: str,
    random_seed: int | None,
    catalog_epoch: str,
    source_fingerprint: str,
    selected_start_ms: int,
    required_start_ms: int,
    required_end_ms: int,
    interval_ms: int,
) -> str:
    return canonical_sha256(
        {
            "schema_version": SELECTION_PREPARATION_SCHEMA_VERSION,
            "preparation_id": preparation_id,
            "start_mode": start_mode,
            "seed_source": seed_source,
            "random_seed": random_seed,
            "catalog_epoch": catalog_epoch,
            "source_fingerprint": source_fingerprint,
            "selected_start_ms": selected_start_ms,
            "required_start_ms": required_start_ms,
            "required_end_ms": required_end_ms,
            "interval_ms": interval_ms,
        }
    )


def migrate_training_schema(connection: sqlite3.Connection, *, now_ms: int) -> None:
    """Create v2-owned tables without changing the adapter schema row."""

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
    if current == TRAINING_SCHEMA_VERSION:
        return
    if current != 0:
        raise RuntimeError(
            f"replay training schema {current} is obsolete; "
            "clear replay training data and create a fresh database"
        )
    for script in (
        TRAINING_SCHEMA_V1,
        TRAINING_SCHEMA_V2,
        TRAINING_SCHEMA_V3,
        TRAINING_SCHEMA_V4,
        TRAINING_SCHEMA_V5,
        TRAINING_SCHEMA_V6,
        TRAINING_SCHEMA_V7,
        TRAINING_SCHEMA_V8,
        TRAINING_SCHEMA_V9,
        TRAINING_SCHEMA_TIME_COMMITMENT_ADDITIVE,
        TRAINING_SCHEMA_PHASE14_ADDITIVE,
        TRAINING_SCHEMA_PHASE15_ADDITIVE,
        TRAINING_SCHEMA_PHASE16_ADDITIVE,
        TRAINING_SCHEMA_PHASE17_ADDITIVE,
        TRAINING_SCHEMA_PHASE18_ADDITIVE,
        TRAINING_SCHEMA_ARCHIVE_PIN_ADDITIVE,
        TRAINING_SCHEMA_SELECTION_PREPARATION_ADDITIVE,
        TRAINING_SCHEMA_P2_TRAINING_RESULTS_ADDITIVE,
        TRAINING_SCHEMA_V14_HEDGE,
        TRAINING_SCHEMA_V15_HEDGE_INPUTS,
    ):
        _execute_script(connection, script)
    connection.execute(
        """
        INSERT INTO replay_training_schema_version(singleton, version, applied_at_ms)
        VALUES (1, ?, ?)
        """,
        (TRAINING_SCHEMA_VERSION, now_ms),
    )


def _execute_script(connection: sqlite3.Connection, script: str) -> None:
    for statement in script.split(";"):
        sql = statement.strip()
        if sql:
            connection.execute(sql)


__all__ = [
    "ADVANCE_INTENT_SCHEMA_VERSION",
    "DATA_POLICY_SCHEMA_VERSION",
    "PERIOD_SUMMARY_SET_SCHEMA_VERSION",
    "REVIEW_TIMELINE_SCHEMA_VERSION",
    "RUN_RULES_SCHEMA_VERSION",
    "SELECTION_PREPARATION_SCHEMA_VERSION",
    "START_SELECTION_SCHEMA_VERSION",
    "TIME_COMMITMENT_SCHEMA_VERSION",
    "TRAINING_SCHEMA_ID",
    "TRAINING_SCHEMA_VERSION",
    "data_policy_hash",
    "migrate_training_schema",
    "selection_preparation_hash",
    "start_selection_hash",
    "time_commitment_hash",
]
