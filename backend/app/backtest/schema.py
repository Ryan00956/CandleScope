from __future__ import annotations

import sqlite3

SCHEMA_VERSION = 1

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

CREATE TABLE IF NOT EXISTS backtest_reports (
    run_id TEXT PRIMARY KEY,
    report_schema TEXT NOT NULL,
    report_json TEXT NOT NULL,
    report_hash TEXT,
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
