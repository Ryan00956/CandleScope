"""Fail-closed permission scope comparison and redaction rules."""

from __future__ import annotations

import hmac
from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any

from candlescope_plugin_sdk.platform_v2 import canonical_dumps, normalize_json

from .errors import security_error


_UPPER_BOUND_KEYS = frozenset(
    {
        "maxConcurrent",
        "maxBytes",
        "maxDepthLevels",
        "maxFileBytes",
        "maxHistoryBars",
        "maxItems",
        "maxNotional",
        "maxOpenOrders",
        "maxOrdersPerMinute",
        "maxRedirects",
        "maxRequestBytes",
        "maxRequests",
        "maxResponseBytes",
        "maxRuntimeSeconds",
        "maxSymbolsPerCall",
        "maxTrades",
        "ratePerMinute",
        "storageBytes",
        "ttlSeconds",
    }
)
_DECIMAL_UPPER_BOUND_KEYS = frozenset(
    {"maxOrderQuantity", "maxOrderNotional", "maxPositionNotional"}
)
_BOOLEAN_AUTHORITY_KEYS = frozenset({"allowShort"})
_SENSITIVE_KEYS = frozenset(
    {
        "apiKey",
        "credential",
        "password",
        "privateKey",
        "rawSecret",
        "secret",
        "token",
    }
)


def normalize_scope(value: Any, *, path: str = "scope") -> dict[str, Any]:
    normalized = normalize_json(value, path=path)
    if not isinstance(normalized, dict):
        raise security_error(
            "PLUGIN_PERMISSION_SCOPE_INVALID",
            "permission scope must be a JSON object",
            details={"path": path},
        )
    _reject_sensitive_values(normalized, path)
    return normalized


def _reject_sensitive_values(value: Any, path: str) -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in _SENSITIVE_KEYS:
                raise security_error(
                    "PLUGIN_PERMISSION_SCOPE_SENSITIVE",
                    "permission scope must contain identifiers, never raw credentials",
                    details={"path": f"{path}.{key}"},
                )
            _reject_sensitive_values(item, f"{path}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, item in enumerate(value):
            _reject_sensitive_values(item, f"{path}[{index}]")


def _json_equal(left: Any, right: Any) -> bool:
    return hmac.compare_digest(canonical_dumps(left), canonical_dumps(right))


def scope_contains(container: Any, candidate: Any, *, key: str | None = None) -> bool:
    """Return whether ``candidate`` cannot exceed ``container`` authority."""

    if isinstance(container, Mapping) and isinstance(candidate, Mapping):
        return all(
            item_key in container
            and scope_contains(container[item_key], item, key=item_key)
            for item_key, item in candidate.items()
        )
    if (
        isinstance(container, Sequence)
        and not isinstance(container, (str, bytes, bytearray))
        and isinstance(candidate, Sequence)
        and not isinstance(candidate, (str, bytes, bytearray))
    ):
        container_values = {canonical_dumps(item) for item in container}
        return all(canonical_dumps(item) in container_values for item in candidate)
    if (
        key in _UPPER_BOUND_KEYS
        and not isinstance(container, bool)
        and not isinstance(candidate, bool)
        and isinstance(container, (int, float))
        and isinstance(candidate, (int, float))
    ):
        return candidate <= container
    if (
        key in _DECIMAL_UPPER_BOUND_KEYS
        and isinstance(container, str)
        and isinstance(candidate, str)
    ):
        try:
            container_decimal = Decimal(container)
            candidate_decimal = Decimal(candidate)
        except InvalidOperation:
            return False
        return (
            container_decimal.is_finite()
            and candidate_decimal.is_finite()
            and candidate_decimal <= container_decimal
        )
    if (
        key in _BOOLEAN_AUTHORITY_KEYS
        and isinstance(container, bool)
        and isinstance(candidate, bool)
    ):
        return not candidate or container
    return _json_equal(container, candidate)


def classify_scope_change(previous: dict[str, Any], current: dict[str, Any]) -> str:
    if _json_equal(previous, current):
        return "unchanged"
    if scope_contains(previous, current):
        return "narrowed"
    if scope_contains(current, previous):
        return "expanded"
    return "changed"


def assert_grant_within_request(
    requested_scope: dict[str, Any],
    granted_scope: dict[str, Any],
) -> None:
    if not scope_contains(requested_scope, granted_scope):
        raise security_error(
            "PLUGIN_PERMISSION_SCOPE_ESCALATION",
            "granted scope exceeds or is incomparable with the manifest request",
        )
