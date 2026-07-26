"""Additive replay training schema that old replay.v1 builds safely ignore."""

from __future__ import annotations

import json
import sqlite3

from app.data_engine.interval_policy import parse_interval_ms
from app.replay.canonical import canonical_json, canonical_sha256


TRAINING_SCHEMA_VERSION = 9
TRAINING_SCHEMA_ID = "replay.training.v1"
START_SELECTION_SCHEMA_VERSION = "replay.start-selection.v1"
DATA_POLICY_SCHEMA_VERSION = "replay.data-policy.v1"
PERIOD_SUMMARY_SET_SCHEMA_VERSION = "replay.period-summary-set.v1"
ADVANCE_INTENT_SCHEMA_VERSION = "replay.advance-intent.v1"


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
        CHECK (seed_source IN ('SERVER', 'MANUAL', 'LEGACY_CLIENT', 'FORK')),
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
        CHECK (account_data_mode IN ('APPROX_PROXY', 'HISTORICAL_EXACT')),
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
        (account_data_mode = 'APPROX_PROXY' AND archive_proof_hash IS NULL)
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


def _backfill_start_selections(
    connection: sqlite3.Connection,
    *,
    now_ms: int,
) -> None:
    rows = connection.execute(
        """
        SELECT r.run_id, r.start_mode, r.dataset_epoch, s.config_json,
               d.actual_replay_start_ms, d.actual_replay_end_ms
        FROM replay_training_run AS r
        JOIN replay_session AS s ON s.session_id = r.adapter_session_id
        JOIN replay_dataset_ref AS d ON d.session_id = r.adapter_session_id
        ORDER BY r.run_id
        """
    ).fetchall()
    for (
        run_id,
        start_mode,
        dataset_epoch,
        config_json,
        actual_start_ms,
        actual_end_ms,
    ) in rows:
        mode = str(start_mode)
        config = json.loads(str(config_json))
        random_seed = (
            int(config["random_seed"])
            if mode == "RANDOM" and config.get("random_seed") is not None
            else None
        )
        seed_source = "LEGACY_CLIENT" if mode == "RANDOM" else "MANUAL"
        digest = start_selection_hash(
            run_id=str(run_id),
            start_mode=mode,
            seed_source=seed_source,
            random_seed=random_seed,
            actual_start_ms=int(actual_start_ms),
            actual_end_ms=int(actual_end_ms),
            dataset_epoch=str(dataset_epoch),
            parent_selection_hash=None,
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO replay_training_start_selection(
                run_id, schema_version, start_mode, seed_source, random_seed,
                actual_start_ms, actual_end_ms, dataset_epoch,
                parent_selection_hash, selection_hash, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                str(run_id),
                START_SELECTION_SCHEMA_VERSION,
                mode,
                seed_source,
                random_seed,
                int(actual_start_ms),
                int(actual_end_ms),
                str(dataset_epoch),
                digest,
                now_ms,
            ),
        )


def _backfill_launch_contexts(
    connection: sqlite3.Connection,
    *,
    now_ms: int,
) -> None:
    rows = connection.execute(
        """
        SELECT run_id, exchange, market_type, last_symbol, display_interval
        FROM replay_training_run
        ORDER BY run_id
        """
    ).fetchall()
    for run_id, exchange, market_type, symbol, display_interval in rows:
        context = {
            "schema_version": "replay.launch-context.v1",
            "source": "DIRECT_HUB",
            "exchange": str(exchange),
            "market_type": str(market_type),
            "symbol": str(symbol),
            "display_interval": str(display_interval),
            "watchlist_snapshot": {
                "schema_version": "replay.watchlist-snapshot.v1",
                "groups": [],
            },
        }
        connection.execute(
            """
            INSERT OR IGNORE INTO replay_training_launch_context(
                run_id, schema_version, source, context_json,
                context_hash, created_at_ms
            ) VALUES (?, 'replay.launch-context.v1', 'DIRECT_HUB', ?, ?, ?)
            """,
            (
                str(run_id),
                canonical_json(context),
                canonical_sha256(context),
                now_ms,
            ),
        )


def _backfill_data_policies(
    connection: sqlite3.Connection,
    *,
    now_ms: int,
) -> None:
    """Give pre-Phase-14 runs the exact legacy history semantics.

    Legacy ``warmup_bars`` simultaneously powered indicators and the visible
    pre-start chart.  Preserve that contract without opening or rewriting the
    immutable dataset blob.
    """

    rows = connection.execute(
        """
        SELECT r.run_id, s.config_json, d.actual_replay_start_ms
        FROM replay_training_run AS r
        JOIN replay_session AS s ON s.session_id = r.adapter_session_id
        JOIN replay_dataset_ref AS d ON d.session_id = r.adapter_session_id
        WHERE NOT EXISTS(
            SELECT 1 FROM replay_training_data_policy AS policy
            WHERE policy.run_id = r.run_id
        )
        ORDER BY r.run_id
        """
    ).fetchall()
    for run_id, config_json, actual_replay_start_ms in rows:
        config = json.loads(str(config_json))
        if not isinstance(config, dict):
            raise TypeError("legacy replay config must be an object")
        interval = str(config.get("base_interval", ""))
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None:
            raise ValueError("legacy replay base_interval must be fixed")
        warmup_bars = int(config["warmup_bars"])
        forward_cache_ms = int(config["horizon_ms"])
        actual_start = int(actual_replay_start_ms)
        visible_lookback_ms = warmup_bars * interval_ms
        visible_start = actual_start - visible_lookback_ms
        if (
            warmup_bars < 1
            or forward_cache_ms < 1
            or visible_start < 0
        ):
            raise ValueError("legacy replay history policy is invalid")
        digest = data_policy_hash(
            indicator_warmup_bars=warmup_bars,
            visible_history_mode="DURATION",
            visible_history_lookback_ms=visible_lookback_ms,
            visible_history_rows=warmup_bars,
            actual_visible_history_start_ms=visible_start,
            actual_replay_start_ms=actual_start,
            effective_warmup_bars=warmup_bars,
            forward_cache_ms=forward_cache_ms,
            interval_ms=interval_ms,
        )
        connection.execute(
            """
            INSERT INTO replay_training_data_policy(
                run_id, schema_version, indicator_warmup_bars,
                visible_history_mode, visible_history_lookback_ms,
                visible_history_rows, actual_visible_history_start_ms,
                actual_replay_start_ms, effective_warmup_bars,
                forward_cache_ms, interval_ms, policy_hash, created_at_ms
            ) VALUES (?, ?, ?, 'DURATION', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(run_id),
                DATA_POLICY_SCHEMA_VERSION,
                warmup_bars,
                visible_lookback_ms,
                warmup_bars,
                visible_start,
                actual_start,
                warmup_bars,
                forward_cache_ms,
                interval_ms,
                digest,
                now_ms,
            ),
        )


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
    if current == 5:
        _execute_script(connection, TRAINING_SCHEMA_V6)
        current = 6
    if current == 6:
        _execute_script(connection, TRAINING_SCHEMA_V7)
        current = 7
    if current == 7:
        _execute_script(connection, TRAINING_SCHEMA_V8)
        _backfill_launch_contexts(connection, now_ms=now_ms)
        current = 8
    if current == 8:
        _execute_script(connection, TRAINING_SCHEMA_V9)
        _backfill_start_selections(connection, now_ms=now_ms)
        current = 9
    if current != TRAINING_SCHEMA_VERSION:
        raise RuntimeError(f"no replay training schema migration path from {current}")
    # Phase 14 deliberately remains schema v9.  This additive table is ignored
    # safely by the Phase 13 binary, which keeps the documented rollback path
    # open while new binaries fail closed when a policy row is missing.
    _execute_script(connection, TRAINING_SCHEMA_PHASE14_ADDITIVE)
    _backfill_data_policies(connection, now_ms=now_ms)
    # Phase 15 remains additive at schema v9 so a Phase 14 binary can ignore
    # derived summaries and durable advance intents without rewriting them.
    _execute_script(connection, TRAINING_SCHEMA_PHASE15_ADDITIVE)
    # Phase 16 keeps schema v9 for a whole-commit rollback to Phase 15. Exact
    # account archives and their projections are additive and old binaries
    # cannot accidentally interpret them as proxy account data.
    _execute_script(connection, TRAINING_SCHEMA_PHASE16_ADDITIVE)
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
    "ADVANCE_INTENT_SCHEMA_VERSION",
    "DATA_POLICY_SCHEMA_VERSION",
    "PERIOD_SUMMARY_SET_SCHEMA_VERSION",
    "START_SELECTION_SCHEMA_VERSION",
    "TRAINING_SCHEMA_ID",
    "TRAINING_SCHEMA_VERSION",
    "data_policy_hash",
    "migrate_training_schema",
    "start_selection_hash",
]
