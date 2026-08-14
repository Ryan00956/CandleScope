from __future__ import annotations

import json
from pathlib import Path

from tests.backtest_contract.spec import MANIFEST_SCHEMA_PATH

FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "backtest"
    / "release_manifest_example.json"
)


def _validate(instance: dict, schema: dict) -> list[str]:
    errors: list[str] = []
    required = schema.get("required", [])
    for key in required:
        if key not in instance:
            errors.append(f"missing {key}")
    if schema.get("additionalProperties") is False:
        allowed = set(schema.get("properties", {}))
        extra = set(instance) - allowed
        if extra:
            errors.append(f"extra {sorted(extra)}")
    flags = instance.get("flags", {})
    if flags.get("BACKTEST_ENABLED") != "0":
        errors.append("production manifest must keep BACKTEST_ENABLED=0")
    if instance.get("providerProtocol") != "strategy-provider/1":
        errors.append("providerProtocol mismatch")
    if instance.get("schemaVersion") != "candlescope.backtest-release/1":
        errors.append("schemaVersion mismatch")
    evidence = instance.get("evidence", [])
    if not evidence:
        errors.append("evidence empty")
    for item in evidence:
        digest = item.get("sha256", "")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            errors.append(f"bad digest {digest}")
    return errors


def test_example_manifest_matches_frozen_schema() -> None:
    schema = json.loads(MANIFEST_SCHEMA_PATH.read_text(encoding="utf-8"))
    example = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert _validate(example, schema) == []


def test_manifest_rejects_enabled_production_flag() -> None:
    schema = json.loads(MANIFEST_SCHEMA_PATH.read_text(encoding="utf-8"))
    example = json.loads(FIXTURE.read_text(encoding="utf-8"))
    example["flags"]["BACKTEST_ENABLED"] = "1"
    assert "BACKTEST_ENABLED=0" in " ".join(_validate(example, schema))
