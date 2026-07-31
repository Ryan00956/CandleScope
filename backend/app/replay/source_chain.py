"""Canonical source-event chain shared by actors and derived replay proofs."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import fields, is_dataclass

from .canonical import canonical_sha256


SOURCE_CHAIN_SCHEMA_VERSION = "replay-source-chain.v1"


def source_event_payload(event: object) -> dict[str, object]:
    """Return the exact canonical event object committed by the replay actor."""

    to_dict = getattr(event, "to_dict", None)
    if callable(to_dict):
        payload = to_dict()
    elif is_dataclass(event) and not isinstance(event, type):
        payload = {
            field.name: getattr(event, field.name)
            for field in fields(event)
        }
    elif isinstance(event, Mapping):
        payload = dict(event)
    else:
        raise TypeError("replay source event must be a dataclass or object mapping")
    if not isinstance(payload, Mapping):
        raise TypeError("replay source event payload must be an object")
    return dict(payload)


def initial_source_chain_hash(data_epoch: str) -> str:
    return canonical_sha256(
        {
            "schema_version": SOURCE_CHAIN_SCHEMA_VERSION,
            "data_epoch": data_epoch,
            "source_sequence": 0,
        }
    )


def next_source_chain_hash(
    previous: str,
    event: object,
    source_sequence: int,
) -> str:
    material = {
        "schema_version": SOURCE_CHAIN_SCHEMA_VERSION,
        "previous": previous,
        "source_sequence": source_sequence,
        "event": source_event_payload(event),
    }
    if _is_json_primitive_tree(material):
        encoded = json.dumps(
            material,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return f"sha256:{hashlib.sha256(encoded).hexdigest()}"
    return canonical_sha256(material)


def _is_json_primitive_tree(value: object) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, Mapping):
        return all(
            isinstance(key, str) and _is_json_primitive_tree(child)
            for key, child in value.items()
        )
    if isinstance(value, (list, tuple)):
        return all(_is_json_primitive_tree(child) for child in value)
    return False


__all__ = [
    "SOURCE_CHAIN_SCHEMA_VERSION",
    "initial_source_chain_hash",
    "next_source_chain_hash",
    "source_event_payload",
]
