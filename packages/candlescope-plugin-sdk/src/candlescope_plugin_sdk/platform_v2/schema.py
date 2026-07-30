"""Access to the manifest schema shipped inside the SDK wheel."""

from __future__ import annotations

from importlib.resources import files
from typing import Any

from .json_codec import loads_strict


def manifest_schema() -> dict[str, Any]:
    resource = files(__package__).joinpath("schemas", "manifest-v2.schema.json")
    value = loads_strict(resource.read_bytes())
    if not isinstance(value, dict):
        raise RuntimeError("packaged manifest schema must be a JSON object")
    return value
