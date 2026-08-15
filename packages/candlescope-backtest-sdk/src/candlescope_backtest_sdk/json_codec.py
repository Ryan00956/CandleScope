"""Strict JSON for the author contract. Duplicate keys and NaN/Infinity fail closed."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from .contract import (
    DEFAULT_MAX_CONTAINER_ITEMS,
    DEFAULT_MAX_JSON_DEPTH,
    DEFAULT_MAX_MESSAGE_BYTES,
    DEFAULT_MAX_STRING_BYTES,
    MAX_SAFE_INTEGER,
)
from .errors import PythonStrategyContractError


def _reject_constant(value: str) -> None:
    raise PythonStrategyContractError(
        "NON_FINITE_NUMBER",
        f"non-standard JSON number is not allowed: {value}",
    )


def _parse_int(value: str) -> int:
    parsed = int(value)
    if abs(parsed) > MAX_SAFE_INTEGER:
        raise PythonStrategyContractError(
            "UNSAFE_INTEGER",
            "JSON integers must stay within the interoperable 53-bit range",
        )
    return parsed


def _parse_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise PythonStrategyContractError(
            "NON_FINITE_NUMBER",
            "JSON numbers must be finite",
        )
    return parsed


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in pairs:
        if key in output:
            raise PythonStrategyContractError(
                "DUPLICATE_KEY",
                f"duplicate object key {key!r}",
            )
        output[key] = value
    if len(output) > DEFAULT_MAX_CONTAINER_ITEMS:
        raise PythonStrategyContractError(
            "CONTAINER_TOO_LARGE",
            "JSON object exceeds the frozen item budget",
        )
    return output


def _scan_value(value: Any, *, depth: int) -> None:
    if depth > DEFAULT_MAX_JSON_DEPTH:
        raise PythonStrategyContractError("JSON_TOO_DEEP", "JSON nesting exceeds budget")
    if isinstance(value, str) and len(value.encode("utf-8")) > DEFAULT_MAX_STRING_BYTES:
        raise PythonStrategyContractError("STRING_TOO_LONG", "JSON string exceeds budget")
    if isinstance(value, list):
        if len(value) > DEFAULT_MAX_CONTAINER_ITEMS:
            raise PythonStrategyContractError(
                "CONTAINER_TOO_LARGE",
                "JSON array exceeds the frozen item budget",
            )
        for item in value:
            _scan_value(item, depth=depth + 1)
    elif isinstance(value, dict):
        for item in value.values():
            _scan_value(item, depth=depth + 1)
    elif isinstance(value, float) and not math.isfinite(value):
        raise PythonStrategyContractError(
            "NON_FINITE_NUMBER",
            "JSON numbers must be finite",
        )


def loads_strict(raw: bytes | str) -> Any:
    if isinstance(raw, str):
        payload = raw.encode("utf-8")
    else:
        payload = raw
    if len(payload) > DEFAULT_MAX_MESSAGE_BYTES:
        raise PythonStrategyContractError(
            "MESSAGE_TOO_LARGE",
            "JSON payload exceeds the frozen message budget",
        )
    decoder = json.JSONDecoder(
        object_pairs_hook=_unique_object,
        parse_int=_parse_int,
        parse_float=_parse_float,
        parse_constant=_reject_constant,
        strict=True,
    )
    value, index = decoder.raw_decode(payload.decode("utf-8"))
    if payload.decode("utf-8")[index:].strip():
        raise PythonStrategyContractError(
            "TRAILING_JSON",
            "strict JSON does not allow trailing content",
        )
    _scan_value(value, depth=1)
    return value


def dumps_canonical(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except ValueError as exc:
        raise PythonStrategyContractError(
            "NON_FINITE_NUMBER",
            "JSON numbers must be finite",
        ) from exc


def canonical_sha256(value: Any) -> str:
    encoded = dumps_canonical(value).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()
