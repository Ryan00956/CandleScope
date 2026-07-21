from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.indicator.runtime_routes import (
    INDICATOR_RUNTIME_ROUTES_ENV,
    IndicatorRuntimeRoutesError,
    default_indicator_runtime_routes_path,
    load_indicator_runtime_routes,
    load_indicator_runtime_routes_from_environment,
)
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.range_result_service import IndicatorRangeResultService


def _write(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def test_missing_default_routes_cut_pyne_over_to_the_managed_sidecar(
    tmp_path: Path,
) -> None:
    routes = load_indicator_runtime_routes_from_environment(
        {"LOCALAPPDATA": str(tmp_path)}
    )

    assert routes.source is None
    assert routes.for_language("pyne").mode == "sidecar"
    assert routes.for_language("pyne").runtime_id == "candlescope.pyne"
    assert routes.to_wire() == {
        "schemaVersion": 1,
        "routes": [
            {
                "language": "pyne",
                "mode": "sidecar",
                "runtimeId": "candlescope.pyne",
            }
        ],
    }
    assert (
        default_indicator_runtime_routes_path({"LOCALAPPDATA": str(tmp_path)}).name
        == "indicator-runtime-routes.json"
    )


def test_explicit_routes_support_independent_language_rollouts(
    tmp_path: Path,
) -> None:
    path = _write(
        tmp_path / "routes.json",
        {
            "schemaVersion": 1,
            "routes": [
                {"language": "pyne", "mode": "shadow", "runtimeId": "pyne.runtime"},
                {"language": "pine", "mode": "sidecar", "runtimeId": "pine.compat"},
            ],
        },
    )

    routes = load_indicator_runtime_routes_from_environment(
        {INDICATOR_RUNTIME_ROUTES_ENV: str(path)}
    )

    assert routes.source == path.resolve()
    assert routes.for_language("pyne").runtime_id == "pyne.runtime"
    assert routes.for_language("pine").mode == "sidecar"


@pytest.mark.parametrize(
    "value, message",
    [
        (
            {"schemaVersion": 2, "routes": []},
            "schemaVersion must be 1",
        ),
        (
            {
                "schemaVersion": 1,
                "routes": [{"language": "pyne", "mode": "legacy", "runtimeId": "bad"}],
            },
            "legacy routes must not declare runtimeId",
        ),
        (
            {
                "schemaVersion": 1,
                "routes": [
                    {"language": "pyne", "mode": "legacy"},
                    {"language": "pyne", "mode": "legacy"},
                ],
            },
            "duplicate languages",
        ),
        (
            {
                "schemaVersion": 1,
                "routes": [{"language": "pine", "mode": "legacy"}],
            },
            "current pyne language",
        ),
        (
            {
                "schemaVersion": 1,
                "routes": [{"language": "pyne", "mode": "automatic"}],
            },
            "legacy, shadow, or sidecar",
        ),
    ],
)
def test_invalid_routes_fail_closed(
    tmp_path: Path,
    value: object,
    message: str,
) -> None:
    path = _write(tmp_path / "routes.json", value)
    with pytest.raises(IndicatorRuntimeRoutesError, match=message):
        load_indicator_runtime_routes(path)


def test_explicit_missing_or_empty_override_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(IndicatorRuntimeRoutesError, match="does not exist"):
        load_indicator_runtime_routes_from_environment(
            {INDICATOR_RUNTIME_ROUTES_ENV: str(tmp_path / "missing.json")}
        )
    with pytest.raises(IndicatorRuntimeRoutesError, match="must not be empty"):
        load_indicator_runtime_routes_from_environment(
            {INDICATOR_RUNTIME_ROUTES_ENV: "  "}
        )


def test_duplicate_json_keys_and_unknown_fields_are_rejected(
    tmp_path: Path,
) -> None:
    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text(
        '{"schemaVersion":1,"schemaVersion":1,"routes":[]}',
        encoding="utf-8",
    )
    with pytest.raises(IndicatorRuntimeRoutesError, match="duplicate JSON object key"):
        load_indicator_runtime_routes(duplicate)

    unknown = _write(
        tmp_path / "unknown.json",
        {
            "schemaVersion": 1,
            "routes": [{"language": "pyne", "mode": "legacy", "command": "x"}],
        },
    )
    with pytest.raises(IndicatorRuntimeRoutesError, match="unsupported fields"):
        load_indicator_runtime_routes(unknown)


def test_custom_indicator_persists_non_default_language(tmp_path: Path) -> None:
    store = CustomIndicatorStore(tmp_path / "custom.json")
    record = store.upsert(
        {
            "name": "Community Script",
            "script": "community source",
            "language": "community-lang",
        }
    )

    assert record["language"] == "community-lang"
    assert store.get(record["id"])["language"] == "community-lang"
    with pytest.raises(ValueError, match="language"):
        store.upsert(
            {
                "name": "Invalid",
                "script": "source",
                "language": "bad language!",
            }
        )


def test_script_range_cache_identity_is_isolated_by_language() -> None:
    meta = {
        "kind": "script",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "Same Source",
        "scriptHash": "sha256:same-source",
        "params": {"length": 10},
    }

    pyne_identity = IndicatorRangeResultService.identity_from_meta(
        {
            **meta,
            "language": "pyne",
        }
    )
    community_identity = IndicatorRangeResultService.identity_from_meta(
        {
            **meta,
            "language": "community-lang",
        }
    )

    assert pyne_identity != community_identity
    assert pyne_identity == IndicatorRangeResultService.identity_from_meta(meta)
