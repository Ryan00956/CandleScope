from __future__ import annotations

import json
from pathlib import Path

from app.backtest.python_bundle_rollback import rollback_python_bundles
from app.backtest.python_first_lifecycle import run_python_host_lifecycle
from app.backtest.python_first_n10 import (
    FRONTEND_FLAGS,
    PRODUCTION_FLAGS,
    VALIDATED_STATUS,
    default_app_exposes_backtest,
    default_flag_values,
    enabled_production_flags,
    frontend_flag_defaults_off,
    n10_status,
    publication_locks,
    python_identities,
    python_runner_forbidden_imports,
    scale_defaults,
)
from app.backtest.schema import SCHEMA_VERSION, apply_schema
from app.backtest.strategy.python_author_v1 import AUTHOR_CONTRACT, PROVIDER_PROTOCOL
from app.backtest.strategy.python_basket import official_frozen_basket
from app.backtest.strategy.python_scale import DEFAULT_BAR_CAPACITY
from app.core.config import load_backtest_settings
from app.main import app
from candlescope_backtest_sdk.contract import (
    AUTHOR_CONTRACT as SDK_AUTHOR,
    PROVIDER_PROTOCOL as SDK_PROTOCOL,
)

ROOT = Path(__file__).resolve().parents[2]


def test_production_and_python_flags_default_off(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "k.db",
        replay_db_path=tmp_path / "r.db",
    )
    assert settings.enabled is False
    assert settings.bar_enabled is False
    assert settings.trade_tape_enabled is False
    assert settings.study_enabled is False
    assert settings.multi_market_enabled is False
    flags = default_flag_values({})
    assert set(flags) == set(PRODUCTION_FLAGS)
    assert enabled_production_flags({}) == []
    assert all(value == "0" for value in flags.values())
    frontend = (
        ROOT / "frontend" / "src" / "features" / "backtest" / "backtestFlags.ts"
    ).read_text(encoding="utf-8")
    assert frontend_flag_defaults_off(frontend)
    for name in FRONTEND_FLAGS:
        assert f'{name} ?? "0"' in frontend


def test_disabled_boot_has_no_python_or_backtest_routes() -> None:
    paths = [str(getattr(route, "path", "")) for route in app.routes]
    assert default_app_exposes_backtest(paths) is False
    assert not any("/python" in path.lower() for path in paths)
    assert not any(path.startswith("/api/v1/backtests") for path in paths)


def test_python_runner_does_not_import_host_or_database() -> None:
    source = (
        ROOT / "backend" / "app" / "backtest" / "strategy" / "python_runner.py"
    ).read_text(encoding="utf-8")
    assert python_runner_forbidden_imports(source) == []
    assert "Does not import service, repository, or database" in source.splitlines()[0]


def test_sdk_and_host_identities_stay_aligned() -> None:
    identities = python_identities()
    assert identities["authorContract"] == SDK_AUTHOR == AUTHOR_CONTRACT
    assert identities["providerProtocol"] == SDK_PROTOCOL == PROVIDER_PROTOCOL
    assert identities["signalClock"] == "BAR_CLOSE"


def test_scale_and_basket_contracts_remain_research_overlays(tmp_path: Path) -> None:
    defaults = scale_defaults()
    assert defaults["defaultBarRows"] == DEFAULT_BAR_CAPACITY == 200_000
    assert defaults["officialBarRows"] == 1_000_000
    assert defaults["aggTradeEvents"] == 2_000_000
    settings = load_backtest_settings(
        {},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "k.db",
        replay_db_path=tmp_path / "r.db",
    )
    assert settings.max_bar_rows == 200_000
    assert settings.max_trade_events == 2_000_000
    basket = official_frozen_basket()
    assert len(basket["members"]) == 10
    assert basket["portfolio_sum_forbidden"] is True


def test_schema_v6_rollback_is_fail_closed_then_forward_empty(tmp_path: Path) -> None:
    assert SCHEMA_VERSION == 7
    empty = tmp_path / "empty.db"
    connection = __import__("sqlite3").connect(empty)
    apply_schema(connection, now_ms=1)
    connection.commit()
    connection.close()
    result = rollback_python_bundles(empty)
    assert result["schemaVersion"] == 5
    assert result["bundleRows"] == 0


def test_host_bar_and_aggtrade_lifecycle_hashes_are_stable(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    first = run_python_host_lifecycle(tmp_path / "a", cycles=2)
    second = run_python_host_lifecycle(tmp_path / "b", cycles=2)
    assert first["ok"] is True
    assert first["runs"][0]["barState"] == "COMPLETED"
    assert first["runs"][0]["aggState"] == "COMPLETED"
    assert first["runs"][0]["barDecisionHash"] == first["runs"][0]["aggDecisionHash"]
    assert first["runs"][0]["barDecisionHash"] == first["runs"][1]["barDecisionHash"]
    assert first["runs"][0]["barDecisionHash"] == second["runs"][0]["barDecisionHash"]
    assert first["bundleHash"] == second["bundleHash"]


def test_n10_status_refuses_validated_when_any_gate_is_open() -> None:
    locks = publication_locks()
    assert locks == {"merged": False, "pushed": False, "productionEnabled": False}
    open_gates = {
        name: "PASS"
        for name in (
            "repositoryRegression",
            "pythonSecurityBoundary",
            "browserAcceptance",
            "performanceSoak",
            "disabledBoot",
            "defaultProductionFlagsOff",
            "publicApiSmoke",
            "checkpointFaultInjection",
            "exactRevertDetachedWorktree",
            "releaseManifestSha256",
        )
    }
    open_gates["performanceSoak"] = "NOT_RERUN"
    assert n10_status(open_gates) == "RELEASE_GATES_OPEN"
    assert n10_status(open_gates) != VALIDATED_STATUS
    all_pass = {name: "PASS" for name in open_gates}
    assert n10_status(all_pass) == VALIDATED_STATUS


def test_n10_manifest_schema_rejects_enabled_flags_and_validated_without_soaks() -> (
    None
):
    schema = json.loads(
        (
            ROOT
            / "docs"
            / "perf-baselines"
            / "backtest"
            / "python-first-n10-release.schema.json"
        ).read_text(encoding="utf-8")
    )
    assert schema["$id"] == "candlescope.python-first-release/2"
    assert "baseSha" in schema["required"]
    assert schema["properties"]["gitDirty"]["const"] is False
    assert schema["properties"]["merged"]["const"] is False
    assert schema["properties"]["pushed"]["const"] is False
    assert schema["properties"]["productionEnabled"]["const"] is False
