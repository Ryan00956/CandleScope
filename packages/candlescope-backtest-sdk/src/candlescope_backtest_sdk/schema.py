"""Load frozen author JSON Schema documents shipped with the SDK."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SCHEMA_DIRECTORY = Path(__file__).with_name("schemas")
BUNDLE_SCHEMA_NAME = "python-strategy-bundle-v1.json"
PARAMETER_SCHEMA_NAME = "python-strategy-parameters-v1.json"


def load_schema(name: str) -> dict[str, Any]:
    path = SCHEMA_DIRECTORY / name
    return json.loads(path.read_text(encoding="utf-8"))


def bundle_schema() -> dict[str, Any]:
    return load_schema(BUNDLE_SCHEMA_NAME)


def parameter_schema() -> dict[str, Any]:
    return load_schema(PARAMETER_SCHEMA_NAME)
