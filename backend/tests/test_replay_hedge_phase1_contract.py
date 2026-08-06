from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.replay.canonical import canonical_sha256
from app.replay.storage.sqlite_store import ReplaySQLiteStore
from app.replay.training.models import (
    HEDGE_ACCOUNT_FIDELITY,
    HEDGE_INSURANCE_ADL_FIDELITY,
    TrainingRunCreateRequest,
    TrainingRunSetupRequest,
    hedge_run_binding,
)
from app.replay.training.schema import TRAINING_SCHEMA_VERSION
from app.replay.training.storage import TrainingRunStore


FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "replay"
    / "hedge_protocol_phase1_golden.json"
)
NOW_MS = 1_720_000_000_000


def _golden() -> dict[str, object]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _create_payload() -> dict[str, object]:
    binding = _golden()["canonical_payload"]
    assert isinstance(binding, dict)
    return {
        "protocol": binding["protocol"],
        "catalog_epoch": "sha256:" + "4" * 64,
        "name": "Phase 1 HEDGE",
        "source_kind": "AGG_TRADE",
        "start_mode": "MANUAL",
        "exchange": "binance",
        "market_type": "linear_perpetual",
        "symbol": "BTCUSDT",
        "settlement_asset": "USDT",
        "base_interval": "1m",
        "display_interval": "5m",
        "requested_start_ms": NOW_MS,
        "indicator_warmup_bars": 100,
        "visible_history_lookback": {
            "mode": "DURATION",
            "duration_ms": 6_000_000,
        },
        "forward_cache_ms": 86_400_000,
        "random_seed": None,
        "initial_equity": "10000",
        "max_leverage": "20",
        "maker_fee_bps": "2",
        "taker_fee_bps": "5",
        "market_slippage_bps": "1",
        "integrity_mode": "CHALLENGE",
        "time_disclosure_policy": "NONE",
        "book_mode": binding["book_mode"],
        "margin_mode": binding["margin_mode"],
        "position_mode": binding["position_mode"],
        "funding_mode": binding["funding_mode"],
        "account_data_mode": binding["account_data_mode"],
        "account_history_ref": None,
        "hedge_public_history_ref": binding["hedge_public_history_ref"],
        "simulation_manifest_ref": binding["simulation_manifest_ref"],
        "account_fidelity": binding["account_fidelity"],
        "insurance_adl_fidelity": binding["insurance_adl_fidelity"],
        "fixed_funding_rate": None,
        "funding_interval_ms": None,
        "allow_rule_changes": False,
        "allowed_mutations": [],
    }


def test_python_hedge_binding_matches_phase1_canonical_golden() -> None:
    fixture = _golden()
    request = TrainingRunCreateRequest.from_dict(_create_payload())
    binding = hedge_run_binding(request)
    assert binding == fixture["canonical_payload"]
    assert canonical_sha256(binding) == fixture["canonical_hash"]


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ({"protocol": "replay.v2"}, "protocol must be replay.v3"),
        (
            {"account_data_mode": "APPROX_PROXY"},
            "legacy HEDGE account modes are not compatible",
        ),
        ({"hedge_public_history_ref": None}, "hedge_public_history_ref"),
        ({"simulation_manifest_ref": None}, "simulation_manifest_ref"),
        ({"account_fidelity": None}, "account_fidelity"),
    ],
)
def test_old_or_unpinned_hedge_payloads_fail_closed(
    mutation: dict[str, object],
    message: str,
) -> None:
    payload = _create_payload()
    payload.update(mutation)
    with pytest.raises(ValueError, match=message):
        TrainingRunCreateRequest.from_dict(payload)


def _setup_request() -> TrainingRunSetupRequest:
    return TrainingRunSetupRequest.from_dict(
        {
            "protocol": "replay.v3",
            "name": "Phase 1 shell",
            "source_kind": "AGG_TRADE",
            "start_mode": "MANUAL",
            "settlement_asset": "USDT",
            "requested_start_ms": NOW_MS,
            "random_range_start_ms": None,
            "random_range_end_ms": None,
            "indicator_warmup_bars": 100,
            "visible_history_lookback": {
                "mode": "DURATION",
                "duration_ms": 6_000_000,
            },
            "forward_cache_ms": 86_400_000,
            "random_seed": None,
            "initial_equity": "10000",
            "max_leverage": "20",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "NONE",
            "book_mode": "BOOK_ASSISTED_REQUIRED",
            "margin_mode": "CROSS",
            "position_mode": "HEDGE",
            "funding_mode": "HISTORICAL_EXACT",
            "account_data_mode": "DETERMINISTIC_SIMULATION",
            "account_fidelity": HEDGE_ACCOUNT_FIDELITY,
            "insurance_adl_fidelity": HEDGE_INSURANCE_ADL_FIDELITY,
            "fixed_funding_rate": None,
            "funding_interval_ms": None,
            "allow_rule_changes": False,
            "allowed_mutations": [],
            "market_selection_hint": None,
        }
    )


async def _started_store(path: Path) -> tuple[ReplaySQLiteStore, TrainingRunStore]:
    base = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    training = TrainingRunStore(base)
    await training.start()
    return base, training


@pytest.mark.anyio
async def test_schema_v14_fk_unique_restart_and_no_flat_liquidation_table(
    tmp_path: Path,
) -> None:
    path = tmp_path / "phase1.db"
    base, training = await _started_store(path)
    await training.create_empty_run(
        run_id="run-phase1-shell",
        request=_setup_request(),
        committed_start_ms=NOW_MS,
        random_seed=None,
    )
    await base.close()

    base, _training = await _started_store(path)
    await base.close()
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        assert connection.execute(
            "SELECT version FROM replay_training_schema_version WHERE singleton = 1"
        ).fetchone()[0] == TRAINING_SCHEMA_VERSION
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert "replay_training_liquidation_event" not in tables
        required = {
            "replay_training_position_leg",
            "replay_training_margin_bucket",
            "replay_training_risk_snapshot",
            "replay_training_liquidation_case",
            "replay_training_liquidation_leg",
            "replay_training_liquidation_step",
            "replay_training_liquidation_order",
            "replay_training_liquidation_fill",
            "replay_training_insurance_fund",
            "replay_training_insurance_posting",
            "replay_training_adl_snapshot",
            "replay_training_adl_candidate",
            "replay_training_adl_event",
            "replay_training_adl_selection",
        }
        assert required <= tables
        assert all(
            connection.execute(f"PRAGMA foreign_key_list({table})").fetchall()
            for table in required
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO replay_training_risk_snapshot(
                    run_id, snapshot_id, snapshot_sequence, virtual_time_ms,
                    source_sequence, account_status, equity, available_balance,
                    total_initial_margin, total_maintenance_margin, risk_ratio,
                    active_rule_revision, public_input_hash, component_hash,
                    created_at_ms
                ) VALUES ('missing-run', 'risk-1', 1, 0, 0, 'ACTIVE', '1', '1',
                          '0', '0', NULL, 1, ?, ?, ?)
                """,
                ("sha256:" + "0" * 64, "sha256:" + "1" * 64, NOW_MS),
            )
        connection.execute(
            """
            INSERT INTO replay_training_risk_snapshot(
                run_id, snapshot_id, snapshot_sequence, virtual_time_ms,
                source_sequence, account_status, equity, available_balance,
                total_initial_margin, total_maintenance_margin, risk_ratio,
                active_rule_revision, public_input_hash, component_hash,
                created_at_ms
            ) VALUES ('run-phase1-shell', 'risk-unique-1', 1, 0, 0, 'ACTIVE',
                      '1', '1', '0', '0', NULL, 1, ?, ?, ?)
            """,
            ("sha256:" + "2" * 64, "sha256:" + "3" * 64, NOW_MS),
        )
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            connection.execute(
                """
                INSERT INTO replay_training_risk_snapshot(
                    run_id, snapshot_id, snapshot_sequence, virtual_time_ms,
                    source_sequence, account_status, equity, available_balance,
                    total_initial_margin, total_maintenance_margin, risk_ratio,
                    active_rule_revision, public_input_hash, component_hash,
                    created_at_ms
                ) VALUES ('run-phase1-shell', 'risk-unique-2', 1, 1, 1,
                          'ACTIVE', '1', '1', '0', '0', NULL, 1, ?, ?, ?)
                """,
                ("sha256:" + "4" * 64, "sha256:" + "5" * 64, NOW_MS),
            )
        row = connection.execute(
            "SELECT position_mode, account_data_mode, protocol, schema_version "
            "FROM replay_training_run WHERE run_id = 'run-phase1-shell'"
        ).fetchone()
        assert dict(row) == {
            "position_mode": "HEDGE",
            "account_data_mode": "DETERMINISTIC_SIMULATION",
            "protocol": "replay.v3",
            "schema_version": "replay.training.v2",
        }


@pytest.mark.anyio
async def test_schema_corruption_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "corrupt.db"
    base, _training = await _started_store(path)
    await base.close()
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE replay_training_schema_version SET version = 13 WHERE singleton = 1"
        )
        connection.commit()
    base = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    with pytest.raises(RuntimeError, match="schema 13 is obsolete"):
        await TrainingRunStore(base).start()
    await base.close()
