"""Python First N10 release identities and fail-closed gate helpers."""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Mapping

from app.backtest.strategy.python_author_v1 import (
    AUTHOR_CONTRACT,
    BUNDLE_SCHEMA,
    OUTPUT_KINDS,
    PROVIDER_PROTOCOL,
    RUNTIME_PROFILE,
    SIGNAL_CLOCKS,
    WIRE_TRANSPORT,
)
from app.backtest.strategy.python_scale import (
    AGG_TRADE_PRODUCT_CAPACITY,
    DEFAULT_BAR_CAPACITY,
    OFFICIAL_BAR_CAPACITY,
)

RELEASE_SCHEMA = "candlescope.python-first-release/2"
VALIDATED_STATUS = "VALIDATED_CLEAN_SHA_UNMERGED"
PRODUCTION_FLAGS = (
    "BACKTEST_ENABLED",
    "BACKTEST_BAR_ENABLED",
    "BACKTEST_TRADE_TAPE_ENABLED",
    "BACKTEST_STUDY_ENABLED",
    "BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED",
    "BACKTEST_EXTERNAL_PROVIDER_ENABLED",
    "BACKTEST_BOOK_ASSISTED_ENABLED",
    "BACKTEST_MULTI_MARKET_ENABLED",
    "BACKTEST_ONLINE_LEARNING_ENABLED",
    "BACKTEST_PYTHON_STRATEGY_ENABLED",
    "BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED",
    "BACKTEST_PYTHON_SCALE_V1_ENABLED",
)
FRONTEND_FLAGS = (
    "VITE_BACKTEST_ENTRY_ENABLED",
    "VITE_BACKTEST_PYTHON_STRATEGY_ENABLED",
    "VITE_BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED",
)
REQUIRED_GATES = (
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
FORBIDDEN_RUNNER_IMPORTS = frozenset(
    {"app.backtest.service", "app.backtest.repository", "sqlite3"}
)


def python_identities() -> dict[str, str]:
    return {
        "authorContract": AUTHOR_CONTRACT,
        "providerProtocol": PROVIDER_PROTOCOL,
        "bundleSchema": BUNDLE_SCHEMA,
        "runtimeProfile": RUNTIME_PROFILE,
        "wireTransport": WIRE_TRANSPORT,
        "signalClock": next(iter(SIGNAL_CLOCKS)),
        "outputKinds": ",".join(sorted(OUTPUT_KINDS)),
    }


def default_flag_values(environment: Mapping[str, str] | None = None) -> dict[str, str]:
    source = dict(environment or {})
    return {
        name: str(source.get(name, "0")).strip() or "0" for name in PRODUCTION_FLAGS
    }


def enabled_production_flags(environment: Mapping[str, str] | None = None) -> list[str]:
    return sorted(
        name
        for name, value in default_flag_values(environment).items()
        if value not in {"0", "false", "off", "no"}
    )


def python_runner_forbidden_imports(source: str) -> list[str]:
    tree = ast.parse(source)
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if (
                    alias.name.split(".", 1)[0] in FORBIDDEN_RUNNER_IMPORTS
                    or alias.name in FORBIDDEN_RUNNER_IMPORTS
                ):
                    found.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module:
            if (
                node.module in FORBIDDEN_RUNNER_IMPORTS
                or node.module.startswith("app.backtest.service")
                or node.module.startswith("app.backtest.repository")
            ):
                found.add(node.module)
    return sorted(found)


def default_app_exposes_backtest(routes: list[str]) -> bool:
    return any(path.startswith("/api/v1/backtests") for path in routes)


def scale_defaults() -> dict[str, int]:
    return {
        "defaultBarRows": DEFAULT_BAR_CAPACITY,
        "officialBarRows": OFFICIAL_BAR_CAPACITY,
        "aggTradeEvents": AGG_TRADE_PRODUCT_CAPACITY,
    }


def n10_status(gates: Mapping[str, str]) -> str:
    missing = [name for name in REQUIRED_GATES if name not in gates]
    if missing:
        return "RELEASE_GATES_INCOMPLETE"
    failed = [name for name, value in gates.items() if value != "PASS"]
    if failed:
        return "RELEASE_GATES_OPEN"
    return VALIDATED_STATUS


def publication_locks() -> dict[str, bool]:
    return {"merged": False, "pushed": False, "productionEnabled": False}


def frontend_flag_defaults_match_policy(text: str) -> bool:
    return (
        'VITE_BACKTEST_ENTRY_ENABLED ?? "1"' in text
        and 'VITE_BACKTEST_PYTHON_STRATEGY_ENABLED ?? "0"' in text
        and 'VITE_BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED ?? "0"' in text
    )


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]
