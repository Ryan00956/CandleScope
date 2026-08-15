"""Host copy of candlescope.python-strategy/1. No user-code execution."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

AUTHOR_CONTRACT = "candlescope.python-strategy/1"
PROVIDER_PROTOCOL = "strategy-provider/1"
BUNDLE_SCHEMA = "candlescope.python-strategy-bundle/1"
RUNTIME_PROFILE = "python-strategy-runtime/1"
WIRE_TRANSPORT = "strict-jsonl/1"
OBSERVATION_SCHEMA = "candlescope.python-strategy-observation/1"
OUTPUT_SCHEMA = "candlescope.python-strategy-output/1"
SIGNAL_CLOCKS = frozenset({"BAR_CLOSE"})
OUTPUT_KINDS = frozenset({"SIGNAL", "TARGET_POSITION", "ORDER_INTENT"})
SIGNAL_DIRECTIONS = frozenset({"LONG", "SHORT", "FLAT"})
ORDER_SIDES = frozenset({"BUY", "SELL"})
ORDER_TYPES = frozenset({"MARKET", "LIMIT", "STOP", "STOP_LIMIT"})
TIME_IN_FORCE = frozenset({"GTC", "IOC", "FOK"})
REPRODUCIBILITY_CLASSES = frozenset(
    {
        "DETERMINISTIC_CPU_LOCKED",
        "SEEDED_CPU_LOCKED",
        "BEST_EFFORT_LOCAL",
        "RECORDED_OUTPUT_ONLY",
    }
)
SCHEMA_DIRECTORY = Path(__file__).with_name("python_author_schemas")


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def load_schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMA_DIRECTORY / name).read_text(encoding="utf-8"))


def contract_identity() -> dict[str, str]:
    return {
        "authorContract": AUTHOR_CONTRACT,
        "providerProtocol": PROVIDER_PROTOCOL,
        "bundleSchema": BUNDLE_SCHEMA,
        "runtimeProfile": RUNTIME_PROFILE,
        "wireTransport": WIRE_TRANSPORT,
        "observationSchema": OBSERVATION_SCHEMA,
        "outputSchema": OUTPUT_SCHEMA,
        "bundleSchemaHash": canonical_sha256(load_schema("python-strategy-bundle-v1.json")),
        "parameterSchemaHash": canonical_sha256(
            load_schema("python-strategy-parameters-v1.json")
        ),
    }
