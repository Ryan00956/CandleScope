"""Bounded strict JSON parsing and deterministic canonical JSON encoding."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from .constants import (
    DEFAULT_MAX_CONTAINER_ITEMS,
    DEFAULT_MAX_CONTROL_MESSAGE_BYTES,
    DEFAULT_MAX_JSON_DEPTH,
    DEFAULT_MAX_STRING_BYTES,
    MAX_SAFE_INTEGER,
)
from .errors import PlatformContractError


@dataclass(frozen=True, slots=True)
class JsonLimits:
    max_message_bytes: int = DEFAULT_MAX_CONTROL_MESSAGE_BYTES
    max_depth: int = DEFAULT_MAX_JSON_DEPTH
    max_container_items: int = DEFAULT_MAX_CONTAINER_ITEMS
    max_string_bytes: int = DEFAULT_MAX_STRING_BYTES

    def __post_init__(self) -> None:
        for name in (
            "max_message_bytes",
            "max_depth",
            "max_container_items",
            "max_string_bytes",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise PlatformContractError(
                    "INVALID_JSON_LIMIT",
                    f"{name} must be a positive integer",
                    name,
                )


DEFAULT_JSON_LIMITS = JsonLimits()


def _reject_constant(value: str) -> None:
    raise PlatformContractError(
        "NON_FINITE_NUMBER",
        f"non-standard JSON number is not allowed: {value}",
    )


def _parse_int(value: str) -> int:
    parsed = int(value)
    if abs(parsed) > MAX_SAFE_INTEGER:
        raise PlatformContractError(
            "UNSAFE_INTEGER",
            "JSON integers must stay within the interoperable 53-bit range",
        )
    return parsed


def _parse_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise PlatformContractError(
            "NON_FINITE_NUMBER",
            "JSON numbers must be finite",
        )
    return parsed


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in pairs:
        if key in output:
            raise PlatformContractError(
                "DUPLICATE_JSON_KEY",
                f"duplicate JSON object key: {key}",
                key,
            )
        output[key] = value
    return output


def _string_bytes(value: str, path: str, limits: JsonLimits) -> str:
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise PlatformContractError(
            "INVALID_UNICODE",
            "JSON strings must contain valid Unicode scalar values",
            path,
        ) from exc
    if len(encoded) > limits.max_string_bytes:
        raise PlatformContractError(
            "STRING_TOO_LARGE",
            f"JSON string exceeds {limits.max_string_bytes} UTF-8 bytes",
            path,
        )
    return value


def normalize_json(
    value: Any,
    *,
    limits: JsonLimits = DEFAULT_JSON_LIMITS,
    path: str = "$",
    _depth: int = 0,
) -> Any:
    """Return a detached JSON value after enforcing language-neutral bounds."""

    if _depth > limits.max_depth:
        raise PlatformContractError(
            "JSON_TOO_DEEP",
            f"JSON nesting exceeds depth {limits.max_depth}",
            path,
        )
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return _string_bytes(value, path, limits)
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAX_SAFE_INTEGER:
            raise PlatformContractError(
                "UNSAFE_INTEGER",
                "JSON integers must stay within the interoperable 53-bit range",
                path,
            )
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PlatformContractError(
                "NON_FINITE_NUMBER",
                "JSON numbers must be finite",
                path,
            )
        if value.is_integer() and abs(value) > MAX_SAFE_INTEGER:
            raise PlatformContractError(
                "UNSAFE_INTEGER",
                "integral JSON numbers must stay within the interoperable 53-bit range",
                path,
            )
        return value
    if isinstance(value, Mapping):
        if len(value) > limits.max_container_items:
            raise PlatformContractError(
                "CONTAINER_TOO_LARGE",
                f"JSON object exceeds {limits.max_container_items} members",
                path,
            )
        output: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise PlatformContractError(
                    "NON_STRING_JSON_KEY",
                    "JSON object keys must be strings",
                    path,
                )
            normalized_key = _string_bytes(key, f"{path}.<key>", limits)
            output[normalized_key] = normalize_json(
                item,
                limits=limits,
                path=f"{path}.{normalized_key}",
                _depth=_depth + 1,
            )
        return output
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        if len(value) > limits.max_container_items:
            raise PlatformContractError(
                "CONTAINER_TOO_LARGE",
                f"JSON array exceeds {limits.max_container_items} items",
                path,
            )
        return [
            normalize_json(
                item,
                limits=limits,
                path=f"{path}[{index}]",
                _depth=_depth + 1,
            )
            for index, item in enumerate(value)
        ]
    raise PlatformContractError(
        "NOT_JSON",
        f"unsupported JSON value type: {type(value).__name__}",
        path,
    )


def loads_strict(
    payload: str | bytes,
    *,
    limits: JsonLimits = DEFAULT_JSON_LIMITS,
) -> Any:
    """Parse one bounded UTF-8 JSON value and reject ambiguous encodings."""

    if isinstance(payload, bytes):
        raw = payload
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeError as exc:
            raise PlatformContractError(
                "INVALID_UTF8",
                "control messages must be valid UTF-8",
            ) from exc
    elif isinstance(payload, str):
        text = payload
        try:
            raw = text.encode("utf-8", errors="strict")
        except UnicodeError as exc:
            raise PlatformContractError(
                "INVALID_UNICODE",
                "control messages must contain valid Unicode scalar values",
            ) from exc
    else:
        raise PlatformContractError(
            "INVALID_JSON_INPUT",
            "JSON input must be text or UTF-8 bytes",
        )
    if len(raw) > limits.max_message_bytes:
        raise PlatformContractError(
            "MESSAGE_TOO_LARGE",
            f"control message exceeds {limits.max_message_bytes} bytes",
        )
    try:
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
            parse_int=_parse_int,
            parse_float=_parse_float,
        )
    except PlatformContractError:
        raise
    except (json.JSONDecodeError, UnicodeError, ValueError) as exc:
        raise PlatformContractError("INVALID_JSON", "invalid JSON document") from exc
    return normalize_json(value, limits=limits)


def _canonical_number(value: int | float) -> str:
    if isinstance(value, int):
        return str(value)
    if value == 0:
        return "0"
    raw = repr(value).lower()
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        fixed = format(Decimal(raw), "f")
        if "." in fixed:
            fixed = fixed.rstrip("0").rstrip(".")
        return fixed
    if "e" not in raw:
        raw = format(Decimal(raw), "e")
    mantissa, exponent = raw.split("e", 1)
    mantissa = mantissa.rstrip("0").rstrip(".")
    exponent_value = int(exponent)
    sign = "+" if exponent_value >= 0 else "-"
    return f"{mantissa}e{sign}{abs(exponent_value)}"


def _canonical_encode(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _canonical_number(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_encode(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                _canonical_encode(key) + ":" + _canonical_encode(value[key])
                for key in sorted(value)
            )
            + "}"
        )
    raise AssertionError(f"normalize_json returned an unsupported type: {type(value)!r}")


def canonical_dumps(
    value: Any,
    *,
    limits: JsonLimits = DEFAULT_JSON_LIMITS,
) -> str:
    """Encode the bounded CandleScope canonical JSON representation."""

    normalized = normalize_json(value, limits=limits)
    encoded = _canonical_encode(normalized)
    if len(encoded.encode("utf-8")) > limits.max_message_bytes:
        raise PlatformContractError(
            "MESSAGE_TOO_LARGE",
            f"canonical JSON exceeds {limits.max_message_bytes} bytes",
        )
    return encoded


def canonical_sha256(
    value: Any,
    *,
    limits: JsonLimits = DEFAULT_JSON_LIMITS,
) -> str:
    encoded = canonical_dumps(value, limits=limits).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"
