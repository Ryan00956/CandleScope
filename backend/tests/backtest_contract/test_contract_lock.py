from __future__ import annotations

from pathlib import Path

from tests.backtest_contract.spec import (
    GOLDEN_PATH,
    PRODUCT_CONTRACT_PATH,
    load_golden,
)


def test_golden_fixture_is_internally_consistent() -> None:
    golden = load_golden()
    assert golden["schema_version"] == "backtest.product.v1.phase0"
    assert golden["account_model"] == "LINEAR_PERP_ONE_WAY_V1"
    assert golden["bar_fill_policy"] == "BAR_NEXT_BAR_WORST_CASE_V1"
    assert golden["provider_protocol"] == "strategy-provider/1"
    assert golden["script_runtime_unchanged"] == "candlescope.script-runtime/1"
    enums = golden["enums"]
    assert "TrainingRun" in enums["product_object"]
    assert "BacktestRun" in enums["product_object"]
    assert enums["position_mode"] == ["ONE_WAY"]
    assert enums["funding_mode"] == ["OFF"]
    matrix = golden["fidelity_matrix"]
    assert set(matrix) == set(enums["fidelity_mode"])
    assert matrix["AGG_TRADE_TAPE"]["report_label"] == "AGGREGATED_TRADE_SEQUENCE"
    assert matrix["QUEUE_EXACT"]["required_roles"] == [
        "ORDER_EVENTS",
        "TRADES",
        "INSTRUMENT_RULES",
    ]
    for flag_value in golden["flags"].values():
        assert flag_value == "0"


def test_product_contract_mentions_every_frozen_enum_value() -> None:
    text = PRODUCT_CONTRACT_PATH.read_text(encoding="utf-8")
    golden = load_golden()
    required_tokens = [
        golden["account_model"],
        golden["bar_fill_policy"],
        golden["provider_protocol"],
        *golden["enums"]["fidelity_mode"],
        *golden["enums"]["report_label"],
        *golden["enums"]["error_code"],
        *golden["flags"],
    ]
    missing = [token for token in required_tokens if token not in text]
    assert missing == []


def test_phase1_dataset_fields_are_locked() -> None:
    golden = load_golden()
    assert "snapshot_hash" in golden["dataset_ref_fields"]
    assert "roles" in golden["dataset_ref_fields"]
    assert "role_hashes" in golden["snapshot_required_fields"]
    assert "fidelity_capabilities" in golden["snapshot_required_fields"]
    assert GOLDEN_PATH.is_file()


def test_adr_set_exists() -> None:
    adr_dir = Path(__file__).resolve().parents[3] / "docs" / "adr"
    expected = {
        "ADR-BACKTEST-001-product-split.md",
        "ADR-BACKTEST-002-host-owned-execution.md",
        "ADR-BACKTEST-003-fidelity-taxonomy.md",
        "ADR-BACKTEST-004-local-data-foundation.md",
        "ADR-BACKTEST-005-account-model-v1.md",
        "ADR-BACKTEST-006-phase0-baseline.md",
    }
    assert expected <= {path.name for path in adr_dir.glob("ADR-BACKTEST-*.md")}
