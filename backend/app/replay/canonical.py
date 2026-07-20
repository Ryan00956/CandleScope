"""Canonical JSON and hashing used by replay deterministic state."""

from __future__ import annotations

import hashlib
import json
from dataclasses import fields, is_dataclass
from decimal import Decimal
from enum import Enum
from typing import Mapping

from .models import normalize_decimal_string


def _canonical_value(value: object, *, path: str = "$") -> object:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        raise TypeError(f"{path} contains forbidden binary float")
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"{path} contains non-finite Decimal")
        return normalize_decimal_string(format(value, "f"), field_name=path)
    if isinstance(value, Enum):
        return _canonical_value(value.value, path=path)
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _canonical_value(
                getattr(value, field.name),
                path=f"{path}.{field.name}",
            )
            for field in fields(value)
        }
    if isinstance(value, Mapping):
        result: dict[str, object] = {}
        for key, child in value.items():
            if not isinstance(key, str):
                raise TypeError(f"{path} contains a non-string object key")
            result[key] = _canonical_value(child, path=f"{path}.{key}")
        return result
    if isinstance(value, (list, tuple)):
        return [
            _canonical_value(child, path=f"{path}[{index}]")
            for index, child in enumerate(value)
        ]
    raise TypeError(f"{path} contains unsupported value {type(value).__name__}")


def canonical_json(value: object) -> str:
    return json.dumps(
        _canonical_value(value),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def canonical_json_bytes(value: object) -> bytes:
    return canonical_json(value).encode("utf-8")


def canonical_sha256(value: object) -> str:
    digest = hashlib.sha256(canonical_json_bytes(value)).hexdigest()
    return f"sha256:{digest}"
