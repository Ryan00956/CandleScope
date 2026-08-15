from __future__ import annotations

import sqlite3

SCHEMA_VERSION = 5

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS backtest_schema_meta (
    schema_version INTEGER NOT NULL,
    migrated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_studies (
    study_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    strategy_revision_id TEXT NOT NULL,
    config_json TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_runs (
    run_id TEXT PRIMARY KEY,
    study_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    fidelity_mode TEXT NOT NULL,
    source_event_kind TEXT NOT NULL,
    strategy_revision_id TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    data_epoch TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    config_json TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    generation INTEGER NOT NULL,
    failure_code TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_job_leases (
    run_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_checkpoints (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS backtest_trials (
    trial_id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    split_id TEXT NOT NULL,
    params_json TEXT NOT NULL,
    params_hash TEXT NOT NULL,
    run_id TEXT,
    state TEXT NOT NULL,
    UNIQUE (study_id, ordinal)
);

CREATE TABLE IF NOT EXISTS backtest_study_folds (
    fold_id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    train_start_ms INTEGER NOT NULL,
    train_end_ms INTEGER NOT NULL,
    test_start_ms INTEGER NOT NULL,
    test_end_ms INTEGER NOT NULL,
    purge_ms INTEGER NOT NULL,
    embargo_ms INTEGER NOT NULL,
    state TEXT NOT NULL,
    selected_receipt_hash TEXT,
    test_run_id TEXT,
    UNIQUE (study_id, ordinal)
);

CREATE TABLE IF NOT EXISTS backtest_train_trials (
    train_trial_id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL,
    fold_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    candidate_ordinal INTEGER NOT NULL,
    params_json TEXT NOT NULL,
    params_hash TEXT NOT NULL,
    run_id TEXT,
    state TEXT NOT NULL,
    objective_value TEXT,
    eligible INTEGER,
    violations_json TEXT,
    warnings_json TEXT,
    UNIQUE (fold_id, candidate_ordinal),
    UNIQUE (study_id, ordinal)
);

CREATE TABLE IF NOT EXISTS backtest_selection_receipts (
    receipt_hash TEXT PRIMARY KEY,
    study_id TEXT NOT NULL,
    fold_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    selected_train_trial_id TEXT NOT NULL,
    selected_params_json TEXT NOT NULL,
    selected_params_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_study_holdouts (
    study_id TEXT PRIMARY KEY,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    state TEXT NOT NULL,
    reveal_receipt_hash TEXT,
    receipt_json TEXT,
    params_json TEXT,
    run_id TEXT,
    revealed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS backtest_study_oos_reports (
    study_id TEXT PRIMARY KEY,
    report_schema TEXT NOT NULL,
    report_json TEXT NOT NULL,
    report_hash TEXT NOT NULL,
    generated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backtest_folds_study_state
    ON backtest_study_folds(study_id, state, ordinal);
CREATE INDEX IF NOT EXISTS idx_backtest_train_trials_study_state
    ON backtest_train_trials(study_id, state, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backtest_train_trials_run
    ON backtest_train_trials(run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_backtest_folds_test_run
    ON backtest_study_folds(test_run_id) WHERE test_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS backtest_reports (
    run_id TEXT PRIMARY KEY,
    report_schema TEXT NOT NULL,
    report_json TEXT NOT NULL,
    report_hash TEXT,
    generated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_chart_cache (
    run_id TEXT PRIMARY KEY,
    cache_schema TEXT NOT NULL,
    interval TEXT NOT NULL,
    bars_json TEXT NOT NULL,
    bar_count INTEGER NOT NULL,
    bars_hash TEXT NOT NULL,
    generated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_audit (
    run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL,
    chain_hash TEXT NOT NULL,
    PRIMARY KEY (run_id, ordinal)
);

CREATE TABLE IF NOT EXISTS backtest_strategy_revisions (
    revision_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    name TEXT NOT NULL,
    language TEXT NOT NULL,
    base_revision_id TEXT NOT NULL,
    source_text TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    compiled_json TEXT NOT NULL,
    compiled_hash TEXT NOT NULL,
    dependency_hash TEXT NOT NULL,
    runtime_revision TEXT NOT NULL,
    parameter_schema_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    archived_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_strategy_smokes (
    receipt_hash TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    start_time_ms INTEGER NOT NULL,
    end_time_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backtest_strategy_smokes_revision
    ON backtest_strategy_smokes(revision_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS backtest_signal_trace (
    run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    event_time_ms INTEGER,
    payload_json TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    PRIMARY KEY (run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_backtest_signal_trace_run
    ON backtest_signal_trace(run_id, ordinal);

CREATE TABLE IF NOT EXISTS backtest_review_bridges (
    bridge_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    run_id TEXT NOT NULL,
    dataset_ref_json TEXT NOT NULL,
    window_json TEXT NOT NULL,
    strategy_projection_json TEXT NOT NULL,
    training_run_id TEXT,
    state TEXT NOT NULL,
    reveal_json TEXT,
    created_at_ms INTEGER NOT NULL
);
"""


def apply_schema(connection: sqlite3.Connection, *, now_ms: int) -> None:
    connection.executescript(SCHEMA_SQL)
    row = connection.execute(
        "SELECT schema_version FROM backtest_schema_meta LIMIT 1"
    ).fetchone()
    if row is None:
        connection.execute(
            "INSERT INTO backtest_schema_meta(schema_version, migrated_at_ms) VALUES (?, ?)",
            (SCHEMA_VERSION, now_ms),
        )
        return
    if int(row[0]) > SCHEMA_VERSION:
        raise RuntimeError("backtest database schema is newer than this binary")
    if int(row[0]) < SCHEMA_VERSION:
        connection.execute(
            "UPDATE backtest_schema_meta SET schema_version = ?, migrated_at_ms = ?",
            (SCHEMA_VERSION, now_ms),
        )
