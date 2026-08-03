"""Access to the manifest schema shipped inside the SDK wheel."""

from __future__ import annotations

from importlib.resources import files
from typing import Any

from .json_codec import loads_strict
from .constants import MANIFEST_SCHEMA_VERSION_V2, MANIFEST_SCHEMA_VERSION_V3


def manifest_schema(version: int = MANIFEST_SCHEMA_VERSION_V2) -> dict[str, Any]:
    """Return one packaged manifest schema without changing the v2 default."""

    schema_names = {
        MANIFEST_SCHEMA_VERSION_V2: "manifest-v2.schema.json",
        MANIFEST_SCHEMA_VERSION_V3: "manifest-v3.schema.json",
    }
    try:
        schema_name = schema_names[version]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"unsupported manifest schema version: {version!r}") from exc
    resource = files(__package__).joinpath("schemas", schema_name)
    value = loads_strict(resource.read_bytes())
    if not isinstance(value, dict):
        raise RuntimeError("packaged manifest schema must be a JSON object")
    return value


def manifest_schema_v3() -> dict[str, Any]:
    """Return the additive multi-runtime schema explicitly."""

    return manifest_schema(MANIFEST_SCHEMA_VERSION_V3)
