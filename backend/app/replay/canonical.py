"""Canonical JSON and hashing used by replay deterministic state."""

from __future__ import annotations

import hashlib
import json
from dataclasses import fields, is_dataclass
from decimal import Decimal
from enum import Enum
from typing import Mapping

from .models import normalize_decimal_string


def _is_native_canonical_json(value: object) -> bool:
    """Return whether ``json.dumps`` can encode the value without coercion.

    Replay snapshots are overwhelmingly composed of exact JSON primitives.
    Rebuilding those large trees merely to prove that fact made every nested
    state hash walk the retained candle window twice and allocate another full
    object graph.  Keep the strict fallback for Decimal, Enum, dataclass,
    generic Mapping, floats, and malformed keys, but let already-canonical
    dict/list/tuple trees go directly to the deterministic JSON encoder.
    """

    pending = [value]
    while pending:
        candidate = pending.pop()
        candidate_type = type(candidate)
        if candidate is None or candidate_type in {str, bool, int}:
            continue
        if candidate_type is dict:
            for key, child in candidate.items():
                if type(key) is not str:
                    return False
                pending.append(child)
            continue
        if candidate_type in {list, tuple}:
            pending.extend(candidate)
            continue
        return False
    return True


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
    normalized = value if _is_native_canonical_json(value) else _canonical_value(value)
    return json.dumps(
        normalized,
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
