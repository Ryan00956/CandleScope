"""Extract immutable BAR archive pins from old and current replay records."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping


_SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_TRADE_SESSION_REF_SCHEMA_VERSION = "replay-trade-session-ref.v1"


def persisted_bar_archive_reference(
    snapshot_ref_json: object,
    snapshot_blob: object = None,
    *,
    strict: bool = False,
) -> dict[str, object] | None:
    """Return the BAR archive identity protected by one persisted session.

    Current records carry ``source_revision`` directly in their lightweight
    reference.  Records written before archive-pin support carry it only in the
    immutable inline snapshot body, so offline GC must understand both shapes.
    Legacy SQLite BAR records intentionally return ``None``.
    """

    try:
        reference = _decode_mapping(
            snapshot_ref_json,
            "snapshot reference",
            strict=True,
        )
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        if strict:
            raise ValueError(
                "persisted replay snapshot reference is invalid; GC refused"
            ) from None
        return None
    has_nested_bar_reference = "bar_snapshot_ref" in reference
    raw_bar_reference = reference.get("bar_snapshot_ref", reference)
    direct = _validated_reference(raw_bar_reference)
    if direct is not None:
        return direct

    repository_backend = (
        raw_bar_reference.get("repository_backend")
        if isinstance(raw_bar_reference, Mapping)
        else None
    )
    declares_archive_reference = (
        isinstance(repository_backend, str)
        and repository_backend.endswith(
            ".history_archive.ReplayHistoryRepository"
        )
    )
    if has_nested_bar_reference and not declares_archive_reference:
        if (
            isinstance(raw_bar_reference, Mapping)
            and "source_revision" in raw_bar_reference
        ):
            if strict:
                raise ValueError(
                    "persisted replay archive reference is invalid; GC refused"
                )
            return None
        if isinstance(repository_backend, str) and repository_backend:
            # Current AGG_TRADE rows always persist this nested BAR reference.
            # A non-archive backend therefore needs no replay-history pin and
            # does not require the external snapshot body to classify it.
            return None
        if strict:
            raise ValueError(
                "persisted replay BAR source classification is invalid; GC refused"
            )
        return None
    needs_snapshot_inspection = (
        declares_archive_reference
        or reference.get("schema_version") == _TRADE_SESSION_REF_SCHEMA_VERSION
    )
    if not needs_snapshot_inspection:
        return None

    try:
        bundle = _decode_mapping(snapshot_blob, "snapshot body", strict=True)
        raw_bar_dataset = bundle.get("bar_dataset", bundle)
        if not isinstance(raw_bar_dataset, Mapping):
            raise ValueError("persisted BAR snapshot body is not an object")
        provenance = raw_bar_dataset.get("provenance")
        rows = raw_bar_dataset.get("rows")
        if not isinstance(provenance, Mapping):
            raise ValueError("persisted BAR provenance is not an object")
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], Mapping):
            raise ValueError("persisted BAR rows are unavailable")
        recovered = _validated_reference(
            {
                "source_revision": provenance.get("source_revision"),
                "identity": raw_bar_dataset.get("identity"),
                "interval": raw_bar_dataset.get("interval"),
                "warmup_start_ms": rows[0].get("open_time_ms"),
                "replay_end_open_ms": raw_bar_dataset.get("replay_end_open_ms"),
            }
        )
        if recovered is None:
            body_backend = provenance.get("repository_backend")
            if (
                not declares_archive_reference
                and isinstance(body_backend, str)
                and not body_backend.endswith(
                    ".history_archive.ReplayHistoryRepository"
                )
            ):
                return None
            raise ValueError("persisted BAR archive reference is incomplete")
        return recovered
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        if strict:
            raise ValueError(
                "persisted replay archive reference is invalid; GC refused"
            ) from None
        return None


def _decode_mapping(
    value: object,
    field_name: str,
    *,
    strict: bool,
) -> Mapping[str, object]:
    try:
        if isinstance(value, Mapping):
            payload = value
        elif isinstance(value, str):
            payload = json.loads(value)
        elif isinstance(value, (bytes, bytearray, memoryview)):
            raw = bytes(value)
            if not raw:
                raise ValueError(f"{field_name} is empty")
            payload = json.loads(raw.decode("utf-8"))
        else:
            raise TypeError(f"{field_name} has an unsupported type")
        if not isinstance(payload, Mapping):
            raise TypeError(f"{field_name} must be an object")
        return payload
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        if strict:
            raise
        return {}


def _validated_reference(value: object) -> dict[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    revision = value.get("source_revision")
    identity = value.get("identity")
    interval = value.get("interval")
    if (
        not isinstance(revision, str)
        or _SHA256_PATTERN.fullmatch(revision) is None
        or not isinstance(identity, Mapping)
        or not isinstance(interval, str)
        or not interval
    ):
        return None
    normalized_identity: dict[str, str] = {}
    for name in ("exchange", "market_type", "symbol"):
        item = identity.get(name)
        if not isinstance(item, str) or not item:
            return None
        normalized_identity[name] = item
    try:
        range_start_ms = _non_negative_int(
            value.get("warmup_start_ms"),
            "warmup_start_ms",
        )
        range_end_ms = _non_negative_int(
            value.get("replay_end_open_ms"),
            "replay_end_open_ms",
        )
    except (TypeError, ValueError):
        return None
    if range_end_ms < range_start_ms:
        return None
    return {
        "source_revision": revision,
        "identity": normalized_identity,
        "interval": interval,
        "warmup_start_ms": range_start_ms,
        "replay_end_open_ms": range_end_ms,
    }


def _non_negative_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return value


__all__ = ["persisted_bar_archive_reference"]
